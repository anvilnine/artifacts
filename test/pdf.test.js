// PDF artifacts: what the publish path accepts as a body, and what the viewer shell is told
// to do with it.
//
// This lives outside server.js for the reason lib/redirect.js does: no test boots the server,
// so the rules a caller actually hits (the base64 decode, the magic-number check, the size cap)
// are only provable when they sit in a module a test can import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfContent, PDF_MAX_BYTES } from '../lib/pdf.js';

// A real one-page PDF, small enough to inline. Built by hand with correct xref offsets, so
// a browser opens it rather than falling back to its own repair pass.
const TINY_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMjAwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQxPj5zdHJlYW0KQlQgL0YxIDI0IFRmIDMwIDEwMCBUZCAoc21va2UgcGRmKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU0IDAwMDAwIG4gCjAwMDAwMDAxMDUgMDAwMDAgbiAKMDAwMDAwMDIxNyAwMDAwMCBuIAowMDAwMDAwMzA0IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMzY3CiUlRU9GCg==';

test('a base64 body decodes to the exact bytes that were sent', () => {
  const buf = parsePdfContent(TINY_PDF_B64);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('base64'), TINY_PDF_B64);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('a data: URL wrapper and wrapped lines both decode', () => {
  const wanted = parsePdfContent(TINY_PDF_B64);
  assert.deepEqual(parsePdfContent(`data:application/pdf;base64,${TINY_PDF_B64}`), wanted);
  // A base64 file written by `base64 file.pdf` comes back with newlines every 76 characters.
  const wrapped = TINY_PDF_B64.match(/.{1,76}/g).join('\n');
  assert.deepEqual(parsePdfContent(wrapped), wanted);
  assert.deepEqual(parsePdfContent(`  ${TINY_PDF_B64}  `), wanted);
});

test('bytes that are not a PDF are refused', () => {
  // The decode is lenient (Node drops characters that are not base64), so the magic number is
  // what actually decides. Anything that is not a PDF lands here, whatever it decoded from.
  for (const bad of [
    Buffer.from('<h1>hello</h1>').toString('base64'),
    Buffer.from('PK a zip, not a pdf').toString('base64'),
    'not base64 at all',
  ]) {
    assert.throws(() => parsePdfContent(bad), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /%PDF-/);
      return true;
    }, `${bad.slice(0, 20)} should be refused`);
  }
});

test('an empty or non-string body is refused', () => {
  for (const bad of ['', '    ', undefined, null, 42, {}]) {
    assert.throws(() => parsePdfContent(bad), (err) => {
      assert.equal(err.status, 400);
      return true;
    }, `${String(bad)} should be refused`);
  }
});

test('the size cap is measured on the decoded bytes, not the base64', () => {
  // Base64 is 4 bytes per 3, so a body one byte over the cap is well under the JSON body
  // limit that would otherwise catch it. Measuring the encoded string instead would refuse
  // PDFs a quarter smaller than the documented cap.
  const head = Buffer.from('%PDF-1.4\n');
  const tooBig = Buffer.concat([head, Buffer.alloc(PDF_MAX_BYTES - head.length + 1, 0x20)]);
  assert.equal(tooBig.length, PDF_MAX_BYTES + 1);
  assert.throws(() => parsePdfContent(tooBig.toString('base64')), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /too large/);
    return true;
  });

  const justUnder = tooBig.subarray(0, PDF_MAX_BYTES);
  assert.equal(parsePdfContent(justUnder.toString('base64')).length, PDF_MAX_BYTES);
});
