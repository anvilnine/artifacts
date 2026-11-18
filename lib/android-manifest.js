// AndroidManifest.xml readers for the two encodings an Android build uses.
//
// An APK carries the manifest as Android binary XML (the chunked "AXML" format aapt2 links).
// An AAB carries it as a protocol buffer (aapt2's Resources.proto XmlNode). Both readers return
// the same small tree, { name, attrs, children }, so the field picking in readManifestFields
// does not care which one it came from.
//
// Only what the install page needs is read: the package name, versionName, versionCode, the SDK
// levels, the label when it is a literal string, and the debuggable flag. A label that points at
// a resource is left out rather than resolved, since resolving it means reading resources.arsc.
//
// The input came from an upload, so every offset is checked before it is read and the element
// count is capped. A broken file throws ManifestError, which the caller turns into a 400.

export class ManifestError extends Error {}

const MAX_NODES = 50_000;
const MAX_DEPTH = 64;

// android: attribute resource ids. A release build can strip attribute names from the string
// pool, and the resource map is then the only way to tell versionCode from versionName.
const ATTR_BY_RES_ID = {
  0x01010001: 'label',
  0x01010002: 'icon',
  0x0101000f: 'debuggable',
  0x0101020c: 'minSdkVersion',
  0x01010270: 'targetSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x01010572: 'compileSdkVersion',
};

// ---------------------------------------------------------------------------
// Binary XML (APK)
// ---------------------------------------------------------------------------

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const UTF8_FLAG = 1 << 8;

// Res_value data types this reader understands.
const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

export function parseBinaryXml(buf) {
  const need = (pos, len) => {
    if (pos < 0 || pos + len > buf.length) throw new ManifestError('binary manifest runs past the end of the file');
  };
  need(0, 8);
  if (buf.readUInt16LE(0) !== RES_XML_TYPE) throw new ManifestError('not an Android binary XML file');
  const fileEnd = Math.min(buf.length, buf.readUInt32LE(4));

  let strings = [];
  let resIds = [];
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  let nodes = 0;

  let pos = buf.readUInt16LE(2);
  while (pos + 8 <= fileEnd) {
    const type = buf.readUInt16LE(pos);
    const headerSize = buf.readUInt16LE(pos + 2);
    const size = buf.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > fileEnd) throw new ManifestError('binary manifest has a malformed chunk');

    if (type === RES_STRING_POOL_TYPE) {
      strings = readStringPool(buf, pos, size);
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      const count = (size - headerSize) / 4;
      resIds = [];
      for (let i = 0; i < count; i++) resIds.push(buf.readUInt32LE(pos + headerSize + i * 4));
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      if (++nodes > MAX_NODES) throw new ManifestError('binary manifest has too many elements');
      if (stack.length > MAX_DEPTH) throw new ManifestError('binary manifest nests too deeply');
      const ext = pos + headerSize;
      need(ext, 20);
      const nameIdx = buf.readUInt32LE(ext + 4);
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      const el = { name: strings[nameIdx] ?? '', attrs: {}, children: [] };
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        need(a, 20);
        const attrNameIdx = buf.readUInt32LE(a + 4);
        const rawIdx = buf.readUInt32LE(a + 8);
        const dataType = buf.readUInt8(a + 15);
        const data = buf.readUInt32LE(a + 16);
        const resName = ATTR_BY_RES_ID[resIds[attrNameIdx]];
        const name = resName || strings[attrNameIdx];
        if (!name) continue;
        let value;
        if (dataType === TYPE_STRING) value = strings[data];
        else if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) value = data | 0;
        else if (dataType === TYPE_INT_BOOLEAN) value = data !== 0;
        else if (dataType === TYPE_REFERENCE) value = { ref: data };
        else if (rawIdx !== 0xffffffff) value = strings[rawIdx];
        if (value !== undefined) el.attrs[name] = value;
      }
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    } else if (type === RES_XML_END_ELEMENT_TYPE) {
      if (stack.length > 1) stack.pop();
    }
    pos += size;
  }
  const manifest = root.children[0];
  if (!manifest) throw new ManifestError('binary manifest has no root element');
  return manifest;
}

function readStringPool(buf, pos, size) {
  const count = buf.readUInt32LE(pos + 8);
  const flags = buf.readUInt32LE(pos + 16);
  const stringsStart = buf.readUInt32LE(pos + 20);
  const headerSize = buf.readUInt16LE(pos + 2);
  const end = pos + size;
  if (count > MAX_NODES * 4 || pos + headerSize + count * 4 > end) {
    throw new ManifestError('binary manifest string pool is malformed');
  }
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    let p = pos + stringsStart + buf.readUInt32LE(pos + headerSize + i * 4);
    if (p >= end) { out[i] = ''; continue; }
    if (utf8) {
      // Two lengths, each one or two bytes: UTF-16 units, then UTF-8 bytes.
      p += buf[p] & 0x80 ? 2 : 1;
      let len = buf[p];
      if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[p + 1]; p += 2; } else p += 1;
      out[i] = p + len <= end ? buf.toString('utf8', p, p + len) : '';
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2); p += 4; } else p += 2;
      out[i] = p + len * 2 <= end ? buf.toString('utf16le', p, p + len * 2) : '';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Protocol buffer XML (AAB)
// ---------------------------------------------------------------------------
//
// Field numbers from frameworks/base/tools/aapt2/Resources.proto:
//   XmlNode      { XmlElement element = 1; string text = 2; }
//   XmlElement   { string namespace_uri = 2; string name = 3; repeated XmlAttribute attribute = 4;
//                  repeated XmlNode child = 5; }
//   XmlAttribute { string name = 2; string value = 3; uint32 resource_id = 5; Item compiled_item = 6; }
//   Item         { String str = 2; Primitive prim = 7; Reference ref = 1; }
//   Primitive    { int32 int_decimal_value = 6; uint32 int_hexadecimal_value = 7; bool boolean_value = 8; }

function readFields(buf, start, end) {
  const fields = [];
  let p = start;
  const varint = () => {
    let n = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (p >= end) throw new ManifestError('protobuf manifest is truncated');
      const b = buf[p++];
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) return n;
      mul *= 128;
    }
    throw new ManifestError('protobuf manifest has an overlong varint');
  };
  while (p < end) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) fields.push({ field, value: varint() });
    else if (wire === 2) {
      const len = varint();
      if (p + len > end) throw new ManifestError('protobuf manifest field runs past its message');
      fields.push({ field, start: p, end: p + len });
      p += len;
    } else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else throw new ManifestError(`protobuf manifest uses unsupported wire type ${wire}`);
  }
  return fields;
}

export function parseProtoXml(buf) {
  let nodes = 0;
  const str = (f) => buf.toString('utf8', f.start, f.end);

  function readItem(start, end) {
    for (const f of readFields(buf, start, end)) {
      if (f.field === 2 && f.start !== undefined) {
        const s = readFields(buf, f.start, f.end).find((x) => x.field === 1 && x.start !== undefined);
        return s ? str(s) : '';
      }
      if (f.field === 7 && f.start !== undefined) {
        for (const p of readFields(buf, f.start, f.end)) {
          if (p.field === 6 || p.field === 7) return p.value | 0;
          if (p.field === 8) return p.value !== 0;
        }
      }
      if (f.field === 1 && f.start !== undefined) return { ref: true };
    }
    return undefined;
  }

  function readElement(start, end, depth) {
    if (++nodes > MAX_NODES) throw new ManifestError('protobuf manifest has too many elements');
    if (depth > MAX_DEPTH) throw new ManifestError('protobuf manifest nests too deeply');
    const el = { name: '', attrs: {}, children: [] };
    for (const f of readFields(buf, start, end)) {
      if (f.start === undefined) continue;
      if (f.field === 3) el.name = str(f);
      else if (f.field === 4) {
        let name = '';
        let raw;
        let resId;
        let compiled;
        for (const a of readFields(buf, f.start, f.end)) {
          if (a.field === 2 && a.start !== undefined) name = str(a);
          else if (a.field === 3 && a.start !== undefined) raw = str(a);
          else if (a.field === 5 && a.start === undefined) resId = a.value;
          else if (a.field === 6 && a.start !== undefined) compiled = readItem(a.start, a.end);
        }
        const key = ATTR_BY_RES_ID[resId] || name;
        if (!key) continue;
        // compiled_item is the typed value; `value` is the source text, which is what a
        // versionCode written as "18" keeps when nothing compiled it.
        const value = compiled !== undefined ? compiled : raw;
        if (value !== undefined) el.attrs[key] = value;
      } else if (f.field === 5) {
        const child = readFields(buf, f.start, f.end).find((x) => x.field === 1 && x.start !== undefined);
        if (child) el.children.push(readElement(child.start, child.end, depth + 1));
      }
    }
    return el;
  }

  const top = readFields(buf, 0, buf.length).find((f) => f.field === 1 && f.start !== undefined);
  if (!top) throw new ManifestError('protobuf manifest has no root element');
  return readElement(top.start, top.end, 0);
}

// ---------------------------------------------------------------------------
// Field picking
// ---------------------------------------------------------------------------

function asInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function asText(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function readManifestFields(manifest) {
  if (!manifest || manifest.name !== 'manifest') throw new ManifestError('the manifest root element is not <manifest>');
  const pkg = asText(manifest.attrs.package);
  if (!pkg) throw new ManifestError('the manifest has no package name');
  const usesSdk = manifest.children.find((c) => c.name === 'uses-sdk');
  const application = manifest.children.find((c) => c.name === 'application');
  return {
    id: pkg,
    version: asText(manifest.attrs.versionName) ?? (manifest.attrs.versionName != null ? String(manifest.attrs.versionName) : undefined),
    build: asInt(manifest.attrs.versionCode),
    minSdk: asInt(usesSdk?.attrs.minSdkVersion),
    targetSdk: asInt(usesSdk?.attrs.targetSdkVersion),
    name: asText(application?.attrs.label),
    debuggable: application?.attrs.debuggable === true,
  };
}
