// The 100 MB ceiling on a zip site is counted in bytes actually decompressed, not in the sizes the
// archive declares. adm-zip only bounds inflation when the declared size is above 0, so an entry
// that declared 0 inflated without limit: a 50 MB upload of deflated zeros is tens of GB.
import test from 'node:test';
import assert from 'node:assert/strict';

import AdmZip from 'adm-zip';

import { startServer } from './helpers/server.js';

const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// Rewrite the uncompressed size of every entry named `name` to 0, in the central directory and in
// the local header, which is what a hostile archive sends.
function lieAboutSize(buf, name) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 46 <= out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === CEN_SIG) {
      const nameLen = out.readUInt16LE(i + 28);
      if (out.toString('utf8', i + 46, i + 46 + nameLen) === name) out.writeUInt32LE(0, i + 24);
    } else if (sig === LOC_SIG) {
      const nameLen = out.readUInt16LE(i + 26);
      if (out.toString('utf8', i + 30, i + 30 + nameLen) === name) out.writeUInt32LE(0, i + 22);
    }
  }
  return out;
}

test('an entry that declares size 0 still counts against the 100 MB ceiling', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from('<p>hi</p>'));
  zip.addFile('big.txt', Buffer.alloc(110 * 1024 * 1024));
  const body = lieAboutSize(zip.toBuffer(), 'big.txt');
  assert.ok(body.length < 1024 * 1024, 'the fixture should be a small upload');

  const res = await srv.api('POST', '/api/artifacts/zip?slug=zip-bomb', body, { 'Content-Type': 'application/zip' });
  assert.equal(res.status, 400, await res.text());
  const missing = await fetch(`${srv.base}/a/zip-bomb/`);
  assert.equal(missing.status, 404, 'nothing should have been published');
});

test('an ordinary zip site still publishes and serves', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const zip = new AdmZip();
  zip.addFile('site/index.html', Buffer.from('<p>hello zip</p>'));
  zip.addFile('site/a/b.css', Buffer.from('body{color:red}'.repeat(500)));
  zip.addFile('site/raw.txt', Buffer.from('stored'));
  const res = await srv.api('POST', '/api/artifacts/zip?slug=zip-ok&visibility=public', zip.toBuffer(), { 'Content-Type': 'application/zip' });
  assert.equal(res.status, 201, await res.text());
  const page = await fetch(`${srv.base}/a/zip-ok/?raw=1`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /hello zip/);
  const css = await fetch(`${srv.base}/a/zip-ok/a/b.css`);
  assert.equal((await css.text()).length, 'body{color:red}'.length * 500);
});
