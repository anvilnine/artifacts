import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

test('private source needs read access; private frames never offer an unusable share link', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const source = '<p>private fixture</p>';
  const saved = await s.api('POST', '/api/artifacts', { slug: 'test-private', type: 'html', content: source, frame: true });
  assert.equal(saved.status, 201);
  const route = '/api/artifacts/test-private/source';
  assert.equal((await fetch(s.base + route)).status, 401);
  assert.equal((await fetch(s.base + '/a/test-private/source')).status, 404);
  const read = await s.api('GET', route);
  assert.equal(read.status, 200);
  assert.equal(await read.text(), source);
  const { url } = await saved.json();
  const unlock = await fetch(url, { redirect: 'manual' });
  const cookie = unlock.headers.getSetCookie()[0].split(';')[0];
  const frame = await fetch(s.base + '/a/test-private', { headers: { cookie } });
  assert.equal(frame.status, 200);
  const html = await frame.text();
  assert.match(html, /<iframe/);
  assert.doesNotMatch(html, /<button id="copy"/);
});
