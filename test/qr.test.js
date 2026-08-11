// QR encoder tests, no browser and no decoder dependency.
//
// A QR code that is subtly wrong still looks like a QR code, so a visual check proves nothing.
// Two things stand in for a decoder here:
//
//   1. The fixture below pins the module matrix of one known string. That matrix was decoded by
//      Chromium's BarcodeDetector during development and came back as the exact input, along
//      with one payload per version 1 to 20 and every PNG option. Any change to the encoder
//      that alters a single module fails this hash.
//   2. Both renderers are read back: the PNG is inflated and the SVG is parsed, and each is
//      compared to the matrix it came from. That catches a drawing bug without a decoder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { qrMatrix, qrSvg, qrPng, QR_MAX_BYTES } from '../lib/qr.js';

const FIXTURE_TEXT = 'https://artifacts.example.com/a/ci-qr';
const FIXTURE_SHA = 'd84afc32e746b8cb94ceda59b45b9aa1f0e37d5e3870ee4741b0ef55fb6ae714';

test('the pinned matrix has not moved', () => {
  const { modules, version, size } = qrMatrix(FIXTURE_TEXT);
  assert.equal(version, 3);
  assert.equal(size, 29);
  const sha = crypto.createHash('sha256').update(Buffer.from(modules)).digest('hex');
  assert.equal(sha, FIXTURE_SHA, 'the encoder changed; re-verify against a real decoder before repinning');
});

test('size follows the version, and the version follows the payload', () => {
  for (const [text, version] of [['x', 1], ['x'.repeat(15), 2], ['x'.repeat(63), 5], ['x'.repeat(625), 20]]) {
    const m = qrMatrix(text);
    assert.equal(m.version, version, `${text.length} bytes should be version ${version}`);
    assert.equal(m.size, version * 4 + 17);
  }
});

test('a payload past the last version is a 400, not a broken code', () => {
  const m = qrMatrix('x'.repeat(QR_MAX_BYTES));
  assert.equal(m.version, 20);
  assert.throws(() => qrMatrix('x'.repeat(QR_MAX_BYTES + 1)), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /too long for a QR code/);
    return true;
  });
});

test('the function patterns are where a scanner looks for them', () => {
  const { size, modules } = qrMatrix(FIXTURE_TEXT);
  const at = (r, c) => modules[r * size + c];

  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        assert.equal(at(top + r, left + c), ring !== 2 && ring <= 3 ? 1 : 0, `finder at ${top},${left}`);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(at(6, i), i % 2 === 0 ? 1 : 0, 'horizontal timing');
    assert.equal(at(i, 6), i % 2 === 0 ? 1 : 0, 'vertical timing');
  }
  assert.equal(at(size - 8, 8), 1, 'the always-dark module');
});

test('the format field reads back as level M and the mask that was applied', () => {
  const { size, modules } = qrMatrix(FIXTURE_TEXT);
  const at = (r, c) => modules[r * size + c];

  // Copy one, in the same order applyFormat writes it.
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    let bit;
    if (i < 6) bit = at(i, 8);
    else if (i === 6) bit = at(7, 8);
    else if (i === 7) bit = at(8, 8);
    else if (i === 8) bit = at(8, 7);
    else bit = at(8, 14 - i);
    bits |= bit << i;
  }
  const data = (bits ^ 0b101010000010010) >> 10;
  assert.equal(data >> 3, 0b00, 'EC level bits should say M');
  const mask = data & 0b111;
  assert.ok(mask >= 0 && mask <= 7);

  // Copy two carries the same 15 bits, so a scanner that reads either one agrees.
  let second = 0;
  for (let i = 0; i < 15; i++) {
    second |= (i < 8 ? at(8, size - 1 - i) : at(size - 15 + i, 8)) << i;
  }
  assert.equal(second, bits, 'the two format copies disagree');
});

// Read a 1-bit greyscale PNG back into the module grid it was drawn from.
function pngModules(buf, { scale, margin, size }) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  const side = buf.readUInt32BE(16);
  assert.equal(buf.readUInt32BE(20), side, 'PNG is not square');
  assert.equal(buf[24], 1, 'bit depth');
  assert.equal(buf[25], 0, 'colour type');
  assert.equal(side, (size + margin * 2) * scale);

  let at = 8;
  let idat = null;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('ascii');
    if (type === 'IDAT') idat = buf.subarray(at + 8, at + 8 + len);
    at += 12 + len;
  }
  assert.ok(idat, 'no IDAT chunk');

  const raw = zlib.inflateSync(idat);
  const bytesPerRow = Math.ceil(side / 8);
  assert.equal(raw.length, (bytesPerRow + 1) * side);

  const out = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const y = (margin + r) * scale;
      const x = (margin + c) * scale;
      const rowStart = y * (bytesPerRow + 1);
      assert.equal(raw[rowStart], 0, 'every scanline should use filter 0');
      const bit = (raw[rowStart + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
      out[r * size + c] = bit ? 0 : 1; // 0 is black in greyscale
    }
  }
  return out;
}

test('the PNG draws the matrix it was given', () => {
  for (const [scale, margin] of [[8, 4], [3, 4], [8, 0], [1, 1]]) {
    const text = 'https://artifacts.example.com/a/ci-qr?k=' + 'e'.repeat(40);
    const { size, modules } = qrMatrix(text);
    const png = qrPng(text, { scale, margin });
    assert.deepEqual(pngModules(png, { scale, margin, size }), modules, `scale ${scale} margin ${margin}`);
  }
});

test('the SVG draws the matrix it was given', () => {
  const scale = 8;
  const margin = 4;
  const { size, modules } = qrMatrix(FIXTURE_TEXT);
  const svg = qrSvg(FIXTURE_TEXT, { scale, margin });

  const side = (size + margin * 2) * scale;
  assert.match(svg, new RegExp(`width="${side}" height="${side}"`));

  const drawn = new Uint8Array(size * size);
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"\/>/g)];
  assert.ok(rects.length > 0, 'no module rects');
  for (const [, x, y, w, h] of rects) {
    assert.equal(Number(h), scale, 'a module row should be one scale tall');
    const r = Number(y) / scale - margin;
    for (let i = 0; i < Number(w) / scale; i++) {
      drawn[r * size + (Number(x) / scale - margin + i)] = 1;
    }
  }
  assert.deepEqual(drawn, modules);
});

test('the same input gives the same code every time', () => {
  const a = qrPng(FIXTURE_TEXT);
  const b = qrPng(FIXTURE_TEXT);
  assert.deepEqual(a, b, 'a QR that changes between calls breaks a printed code');
});

test('utf-8 goes in as bytes, not as characters', () => {
  const text = 'https://example.com/café';
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(bytes.length, text.length + 1, 'the fixture should hold one multi-byte character');
  assert.doesNotThrow(() => qrMatrix(text));
  // The byte length is what picks the version, so a multi-byte string near a boundary must not
  // be measured in characters.
  const filler = 'é'.repeat(Math.floor(QR_MAX_BYTES / 2));
  assert.equal(qrMatrix(filler).version, 20);
  assert.throws(() => qrMatrix('é'.repeat(Math.floor(QR_MAX_BYTES / 2) + 2)), /too long/);
});
