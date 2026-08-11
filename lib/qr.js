// QR code generation, no dependency and no external service.
//
// Scope is what an artifact URL needs and nothing more: byte mode, error correction level M,
// versions 1 through 20. That covers 666 bytes, where the longest thing anyone points at an
// artifact is a capability link of roughly 300 characters. Byte mode encodes any URL as is,
// so there is no alphanumeric-mode special case to get wrong; level M is the standard default
// and survives a printed code picking up dirt.
//
// The two BCH tables the spec prints (format information, version information) are computed
// here rather than copied, because a mistyped digit in a copied table produces a code that
// looks right and scans as garbage. The block-layout table below cannot be computed and is
// checked against a real decoder in test/qr.test.js.

import zlib from 'node:zlib';
import { ApiError } from './errors.js';

// Per version at level M: error-correction codewords per block, then the block groups as
// [count, data codewords per block]. Two groups where the spec splits a version into blocks of
// two different sizes. Index 0 is version 1.
const BLOCKS_M = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
  [30, [[1, 50], [4, 51]]],
  [22, [[6, 36], [2, 37]]],
  [22, [[8, 37], [1, 38]]],
  [24, [[4, 40], [5, 41]]],
  [24, [[5, 41], [5, 42]]],
  [28, [[7, 45], [3, 46]]],
  [28, [[10, 46], [1, 47]]],
  [26, [[9, 43], [4, 44]]],
  [26, [[3, 44], [11, 45]]],
  [26, [[3, 41], [13, 42]]],
];

// Alignment pattern centre coordinates per version. Version 1 has none.
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

const MAX_VERSION = BLOCKS_M.length;

function dataCapacity(version) {
  const [, groups] = BLOCKS_M[version - 1];
  return groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

// --- GF(256), primitive polynomial 0x11d ---

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Generator polynomial for `degree` error-correction codewords.
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecCodewords(data, count) {
  const gen = generatorPoly(count);
  const rem = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[count - 1] = 0;
    for (let i = 0; i < count; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// --- BCH, for the two information fields ---

function bch(value, poly, polyBits) {
  let v = value;
  while (bitLength(v) >= polyBits) v ^= poly << (bitLength(v) - polyBits);
  return v;
}

function bitLength(v) {
  let n = 0;
  while (v) { n++; v >>>= 1; }
  return n;
}

// 15 bits: 2 for the EC level (M is 00), 3 for the mask, 10 of BCH, all XORed with a fixed
// mask so an all-zero field cannot read as valid.
function formatBits(mask) {
  const data = (0b00 << 3) | mask;
  return ((data << 10) | bch(data << 10, 0b10100110111, 11)) ^ 0b101010000010010;
}

// 18 bits: the version number and 12 of BCH. Only versions 7 and up carry it.
function versionBits(version) {
  return (version << 12) | bch(version << 12, 0b1111100100101, 13);
}

// --- bit stream ---

function encodeData(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);                        // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacity = dataCapacity(version) * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator, short at the very end
  while (bits.length % 8) bits.push(0);

  const out = new Uint8Array(dataCapacity(version));
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out[i / 8] = byte;
  }
  // Pad bytes alternate 0xec and 0x11, per the spec, for the rest of the capacity.
  for (let i = bits.length / 8, alt = 0; i < out.length; i++, alt++) {
    out[i] = alt % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

// Split into blocks, compute EC per block, then interleave both halves the way the spec lays
// them out on the symbol.
function codewords(bytes, version) {
  const [ecPerBlock, groups] = BLOCKS_M[version - 1];
  const data = encodeData(bytes, version);

  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.subarray(at, at + size);
      at += size;
      blocks.push({ data: block, ec: ecCodewords(block, ecPerBlock) });
    }
  }

  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

// --- symbol ---

function newGrid(size) {
  return { size, modules: new Int8Array(size * size).fill(-1) }; // -1 = free
}

function set(grid, r, c, dark) {
  grid.modules[r * grid.size + c] = dark ? 1 : 0;
}

function get(grid, r, c) {
  return grid.modules[r * grid.size + c] === 1 ? 1 : 0;
}

function isFree(grid, r, c) {
  return grid.modules[r * grid.size + c] === -1;
}

function placeFinder(grid, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= grid.size || cc >= grid.size) continue;
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      set(grid, rr, cc, ring !== 2 && ring <= 3);
    }
  }
}

function placeFunctionPatterns(grid, version) {
  const n = grid.size;
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, n - 7);
  placeFinder(grid, n - 7, 0);

  for (let i = 8; i < n - 8; i++) {
    set(grid, 6, i, i % 2 === 0);
    set(grid, i, 6, i % 2 === 0);
  }

  const centres = ALIGNMENT[version - 1];
  for (const r of centres) {
    for (const c of centres) {
      // The three corners already hold finder patterns.
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(grid, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  set(grid, n - 8, 8, true); // the one module that is always dark

  // Reserve the format areas so data placement skips them; the values land later.
  for (let i = 0; i < 9; i++) {
    if (isFree(grid, 8, i)) set(grid, 8, i, false);
    if (isFree(grid, i, 8)) set(grid, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (isFree(grid, 8, n - 1 - i)) set(grid, 8, n - 1 - i, false);
    if (isFree(grid, n - 1 - i, 8)) set(grid, n - 1 - i, 8, false);
  }

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      set(grid, Math.floor(i / 3), n - 11 + (i % 3), bit);
      set(grid, n - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }
}

// Two modules wide, bottom to top then top to bottom, skipping the vertical timing column.
function placeData(grid, bytes) {
  const n = grid.size;
  let bit = 0;
  const nextBit = () => {
    const byte = bytes[bit >> 3];
    const value = byte === undefined ? 0 : (byte >> (7 - (bit & 7))) & 1;
    bit++;
    return value;
  };
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the timing column is not part of the data path
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (isFree(grid, r, c)) set(grid, r, c, nextBit());
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0,
  (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0,
];

function penalty(grid) {
  const n = grid.size;
  let score = 0;

  // Rule 1: runs of five or more of the same colour, both directions.
  for (let i = 0; i < n; i++) {
    for (const row of [true, false]) {
      let run = 1;
      let prev = row ? get(grid, i, 0) : get(grid, 0, i);
      for (let j = 1; j < n; j++) {
        const v = row ? get(grid, i, j) : get(grid, j, i);
        if (v === prev) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          prev = v;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = get(grid, r, c);
      if (v === get(grid, r, c + 1) && v === get(grid, r + 1, c) && v === get(grid, r + 1, c + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules on either side.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 11 <= n; j++) {
      let rowA = true; let rowB = true; let colA = true; let colB = true;
      for (let k = 0; k < 11; k++) {
        const rv = get(grid, i, j + k);
        const cv = get(grid, j + k, i);
        if (rv !== A[k]) rowA = false;
        if (rv !== B[k]) rowB = false;
        if (cv !== A[k]) colA = false;
        if (cv !== B[k]) colB = false;
      }
      if (rowA) score += 40;
      if (rowB) score += 40;
      if (colA) score += 40;
      if (colB) score += 40;
    }
  }

  // Rule 4: how far the dark share sits from half.
  let dark = 0;
  for (let i = 0; i < grid.modules.length; i++) if (grid.modules[i] === 1) dark++;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

function applyFormat(grid, mask) {
  const n = grid.size;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // Copy one: down the left of the top-left finder, then across its bottom.
    if (i < 6) set(grid, i, 8, bit);
    else if (i === 6) set(grid, 7, 8, bit);
    else if (i === 7) set(grid, 8, 8, bit);
    else if (i === 8) set(grid, 8, 7, bit);
    else set(grid, 8, 14 - i, bit);
    // Copy two: along the bottom-left, then the top-right.
    if (i < 8) set(grid, 8, n - 1 - i, bit);
    else set(grid, n - 15 + i, 8, bit);
  }
}

// The module matrix for `text`. 1 is a dark module. Callers render it; nothing here knows
// about pixels.
export function qrMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = BLOCKS_M.findIndex((_, i) => dataCapacity(i + 1) >= bytes.length + (i + 1 < 10 ? 2 : 3)) + 1;
  if (version === 0) {
    throw new ApiError(400, `too long for a QR code (${bytes.length} bytes, limit ${dataCapacity(MAX_VERSION) - 3})`);
  }

  const data = codewords(bytes, version);
  const base = newGrid(version * 4 + 17);
  placeFunctionPatterns(base, version);
  placeData(base, data);

  // The function patterns are fixed, so mask selection copies the symbol per mask and keeps
  // the lowest-penalty one, which is what the spec asks for.
  const reserved = new Int8Array(base.modules.length);
  const fresh = newGrid(base.size);
  placeFunctionPatterns(fresh, version);
  for (let i = 0; i < reserved.length; i++) reserved[i] = fresh.modules[i] === -1 ? 0 : 1;

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = { size: base.size, modules: Int8Array.from(base.modules) };
    for (let r = 0; r < grid.size; r++) {
      for (let c = 0; c < grid.size; c++) {
        if (!reserved[r * grid.size + c] && MASKS[mask](r, c)) {
          grid.modules[r * grid.size + c] ^= 1;
        }
      }
    }
    applyFormat(grid, mask);
    const score = penalty(grid);
    if (!best || score < best.score) best = { score, grid };
  }

  return { size: best.grid.size, version, modules: Uint8Array.from(best.grid.modules) };
}

// One <rect> per dark run, so the file stays small and every viewer renders it the same.
export function qrSvg(text, { scale = 8, margin = 4 } = {}) {
  const { size, modules } = qrMatrix(text);
  const side = (size + margin * 2) * scale;
  const parts = [];
  for (let r = 0; r < size; r++) {
    let run = 0;
    for (let c = 0; c <= size; c++) {
      const dark = c < size && modules[r * size + c] === 1;
      if (dark) { run++; continue; }
      if (run) {
        const x = (margin + c - run) * scale;
        const y = (margin + r) * scale;
        parts.push(`<rect x="${x}" y="${y}" width="${run * scale}" height="${scale}"/>`);
        run = 0;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">`
    + `<rect width="${side}" height="${side}" fill="#ffffff"/>`
    + `<g fill="#000000">${parts.join('')}</g></svg>`;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// 1-bit greyscale PNG: one bit per module, so even a large code stays a few hundred bytes.
export function qrPng(text, { scale = 8, margin = 4 } = {}) {
  const { size, modules } = qrMatrix(text);
  const side = (size + margin * 2) * scale;
  const bytesPerRow = Math.ceil(side / 8);
  const raw = Buffer.alloc((bytesPerRow + 1) * side, 0);

  for (let y = 0; y < side; y++) {
    const rowStart = y * (bytesPerRow + 1) + 1;
    raw.fill(0xff, rowStart, rowStart + bytesPerRow); // start light, clear the dark modules
    const r = Math.floor(y / scale) - margin;
    if (r < 0 || r >= size) continue;
    for (let x = 0; x < side; x++) {
      const c = Math.floor(x / scale) - margin;
      if (c < 0 || c >= size) continue;
      if (modules[r * size + c] !== 1) continue;
      raw[rowStart + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 1;  // bit depth
  ihdr[9] = 0;  // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const QR_MAX_BYTES = dataCapacity(MAX_VERSION) - 3;
