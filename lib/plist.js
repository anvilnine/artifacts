// Property list readers for the two formats an iOS build carries.
//
// Xcode writes an app's Info.plist as a binary plist ("bplist00"), and a provisioning profile
// wraps an XML plist inside a CMS signature. Both readers return plain JS values: dict ->
// object, array -> array, string, number, boolean, Date, Buffer for data. They exist so the
// app-build upload can read a bundle id and a version with no dependency and no macOS tool.
//
// Every input here came from an upload, so both readers are bounded: a nesting limit, an object
// count limit, and offsets checked against the buffer before they are read. A file that breaks
// a rule throws PlistError, which the caller turns into a 400.

export class PlistError extends Error {}

const MAX_DEPTH = 64;
const MAX_OBJECTS = 200_000;

// Seconds between the Unix epoch and Apple's reference date, 2001-01-01T00:00:00Z.
const APPLE_EPOCH_S = 978307200;

export function parsePlist(buf) {
  if (!Buffer.isBuffer(buf)) throw new PlistError('plist must be a Buffer');
  if (buf.subarray(0, 8).toString('latin1') === 'bplist00') return parseBinaryPlist(buf);
  return parseXmlPlist(buf.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Binary plist
// ---------------------------------------------------------------------------

function parseBinaryPlist(buf) {
  if (buf.length < 8 + 32) throw new PlistError('binary plist is too short');
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const numObjects = readUInt(buf, trailer + 8, 8);
  const topObject = readUInt(buf, trailer + 16, 8);
  const tableOffset = readUInt(buf, trailer + 24, 8);
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize)) {
    throw new PlistError('binary plist has an invalid trailer');
  }
  if (numObjects > MAX_OBJECTS || topObject >= numObjects) {
    throw new PlistError('binary plist has an invalid object count');
  }
  if (tableOffset + numObjects * offsetSize > trailer) {
    throw new PlistError('binary plist offset table runs past the end of the file');
  }

  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) {
    const off = readUInt(buf, tableOffset + i * offsetSize, offsetSize);
    if (off >= tableOffset) throw new PlistError('binary plist object offset is out of range');
    offsets[i] = off;
  }

  // A count of 0xF means the real count follows as an int object.
  function readCount(pos, low) {
    if (low !== 0xf) return { count: low, start: pos + 1 };
    const marker = buf[pos + 1];
    if (marker >> 4 !== 0x1) throw new PlistError('binary plist has a malformed length');
    const bytes = 1 << (marker & 0xf);
    if (bytes > 8) throw new PlistError('binary plist length is too large');
    const count = readUInt(buf, pos + 2, bytes);
    return { count, start: pos + 2 + bytes };
  }

  function need(pos, len) {
    if (pos < 0 || pos + len > tableOffset) throw new PlistError('binary plist object runs past its table');
  }

  function readRef(pos) {
    need(pos, refSize);
    return readUInt(buf, pos, refSize);
  }

  // `stack` holds the object indexes on the current path, so a reference cycle fails fast
  // instead of recursing until the depth limit.
  function readObject(index, depth, stack) {
    if (depth > MAX_DEPTH) throw new PlistError('binary plist nests too deeply');
    if (index >= numObjects) throw new PlistError('binary plist reference is out of range');
    if (stack.has(index)) throw new PlistError('binary plist contains a reference cycle');
    const pos = offsets[index];
    need(pos, 1);
    const marker = buf[pos];
    const high = marker >> 4;
    const low = marker & 0xf;
    switch (high) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null;
      case 0x1: {
        const bytes = 1 << low;
        need(pos + 1, bytes);
        if (bytes === 8) return Number(buf.readBigInt64BE(pos + 1));
        if (bytes > 8) throw new PlistError('binary plist integer is too large');
        return readUInt(buf, pos + 1, bytes);
      }
      case 0x2: {
        const bytes = 1 << low;
        need(pos + 1, bytes);
        if (bytes === 4) return buf.readFloatBE(pos + 1);
        if (bytes === 8) return buf.readDoubleBE(pos + 1);
        throw new PlistError('binary plist real has an unsupported size');
      }
      case 0x3:
        need(pos + 1, 8);
        return new Date((APPLE_EPOCH_S + buf.readDoubleBE(pos + 1)) * 1000);
      case 0x4: {
        const { count, start } = readCount(pos, low);
        need(start, count);
        return Buffer.from(buf.subarray(start, start + count));
      }
      case 0x5: {
        const { count, start } = readCount(pos, low);
        need(start, count);
        return buf.toString('latin1', start, start + count);
      }
      case 0x6: {
        const { count, start } = readCount(pos, low);
        need(start, count * 2);
        const be = buf.subarray(start, start + count * 2);
        const le = Buffer.alloc(be.length);
        for (let i = 0; i < be.length; i += 2) {
          le[i] = be[i + 1];
          le[i + 1] = be[i];
        }
        return le.toString('utf16le');
      }
      case 0x8: {
        const bytes = low + 1;
        need(pos + 1, bytes);
        return { uid: readUInt(buf, pos + 1, bytes) };
      }
      case 0xa:
      case 0xc: {
        const { count, start } = readCount(pos, low);
        need(start, count * refSize);
        stack.add(index);
        const out = [];
        for (let i = 0; i < count; i++) out.push(readObject(readRef(start + i * refSize), depth + 1, stack));
        stack.delete(index);
        return out;
      }
      case 0xd: {
        const { count, start } = readCount(pos, low);
        need(start, count * 2 * refSize);
        stack.add(index);
        const out = {};
        for (let i = 0; i < count; i++) {
          const key = readObject(readRef(start + i * refSize), depth + 1, stack);
          if (typeof key !== 'string') throw new PlistError('binary plist dictionary key is not a string');
          const value = readObject(readRef(start + (count + i) * refSize), depth + 1, stack);
          // defineProperty, not assignment: a key named "__proto__" would otherwise set the
          // object's prototype instead of storing a value.
          Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
        }
        stack.delete(index);
        return out;
      }
      default:
        throw new PlistError(`binary plist has an unknown object type 0x${marker.toString(16)}`);
    }
  }

  return readObject(topObject, 0, new Set());
}

function readUInt(buf, pos, bytes) {
  if (pos < 0 || pos + bytes > buf.length) throw new PlistError('binary plist read runs past the end of the file');
  let n = 0;
  for (let i = 0; i < bytes; i++) n = n * 256 + buf[pos + i];
  if (!Number.isSafeInteger(n)) throw new PlistError('binary plist integer is too large');
  return n;
}

// ---------------------------------------------------------------------------
// XML plist
// ---------------------------------------------------------------------------

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e] ?? m;
  });
}

// A small tokenizer over the subset of XML a plist uses. It reads tags and the text between
// them; comments, the prolog and the DOCTYPE are skipped.
function parseXmlPlist(text) {
  const tokens = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[2]) tokens.push({ close: m[1] === '/', name: m[2], self: m[3] === '/' });
    else if (m[4] !== undefined) {
      if (m[4].trim()) tokens.push({ text: m[4] });
    }
    if (tokens.length > MAX_OBJECTS * 2) throw new PlistError('XML plist is too large');
  }

  let i = 0;
  const next = () => tokens[i++];

  function readText(name) {
    const t = tokens[i];
    let value = '';
    if (t && t.text !== undefined) {
      value = decodeEntities(t.text);
      i++;
    }
    const end = next();
    if (!end || !end.close || end.name !== name) throw new PlistError(`XML plist <${name}> is not closed`);
    return value;
  }

  function readValue(depth) {
    if (depth > MAX_DEPTH) throw new PlistError('XML plist nests too deeply');
    const t = next();
    if (!t || t.close || t.text !== undefined) throw new PlistError('XML plist is malformed');
    if (t.self) {
      if (t.name === 'true') return true;
      if (t.name === 'false') return false;
      if (t.name === 'dict') return {};
      if (t.name === 'array') return [];
      if (t.name === 'string') return '';
      throw new PlistError(`XML plist has an unexpected <${t.name}/>`);
    }
    switch (t.name) {
      case 'string':
        return readText('string');
      case 'integer': {
        const n = Number(readText('integer').trim());
        if (!Number.isFinite(n)) throw new PlistError('XML plist integer is not a number');
        return n;
      }
      case 'real':
        return Number(readText('real').trim());
      case 'date': {
        const d = new Date(readText('date').trim());
        if (Number.isNaN(d.getTime())) throw new PlistError('XML plist date is invalid');
        return d;
      }
      case 'data':
        return Buffer.from(readText('data').replace(/\s+/g, ''), 'base64');
      case 'true':
      case 'false': {
        const end = next();
        if (!end || !end.close || end.name !== t.name) throw new PlistError(`XML plist <${t.name}> is not closed`);
        return t.name === 'true';
      }
      case 'array': {
        const out = [];
        while (tokens[i] && !(tokens[i].close && tokens[i].name === 'array')) out.push(readValue(depth + 1));
        if (!tokens[i]) throw new PlistError('XML plist <array> is not closed');
        i++;
        return out;
      }
      case 'dict': {
        const out = {};
        while (tokens[i] && !(tokens[i].close && tokens[i].name === 'dict')) {
          const k = next();
          if (k.name !== 'key' || k.close) throw new PlistError('XML plist dictionary is missing a <key>');
          const key = k.self ? '' : readText('key');
          const value = readValue(depth + 1);
          Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
        }
        if (!tokens[i]) throw new PlistError('XML plist <dict> is not closed');
        i++;
        return out;
      }
      default:
        throw new PlistError(`XML plist has an unexpected <${t.name}>`);
    }
  }

  const root = next();
  if (!root || root.name !== 'plist' || root.close) throw new PlistError('not a plist: no <plist> root element');
  if (root.self) return null;
  return readValue(0);
}

// The XML plist inside a provisioning profile. The profile is a CMS (PKCS#7) signed blob and
// the payload sits in it unencrypted, so slicing from the XML prolog to the closing tag gets it
// without a CMS parser.
export function extractEmbeddedPlist(buf) {
  const text = buf.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>', start);
  if (start === -1 || end === -1) throw new PlistError('no XML plist found in the provisioning profile');
  return parseXmlPlist(buf.subarray(start, end + '</plist>'.length).toString('utf8'));
}

// ---------------------------------------------------------------------------
// XML plist writer, for the iOS install manifest
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c]};`);
}

function writeValue(value, indent) {
  const pad = '\t'.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}<array/>`;
    return `${pad}<array>\n${value.map((v) => writeValue(v, indent + 1)).join('\n')}\n${pad}</array>`;
  }
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (typeof value === 'number') return `${pad}<integer>${Math.trunc(value)}</integer>`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return `${pad}<dict/>`;
    const body = keys
      .map((k) => `${pad}\t<key>${escapeXml(k)}</key>\n${writeValue(value[k], indent + 1)}`)
      .join('\n');
    return `${pad}<dict>\n${body}\n${pad}</dict>`;
  }
  return `${pad}<string>${escapeXml(value)}</string>`;
}

export function writeXmlPlist(value) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n${writeValue(value, 0)}\n</plist>\n`;
}
