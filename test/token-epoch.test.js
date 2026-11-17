// A capability link that was revoked stays revoked. Two ways used to bring one back:
//   - rotate, then public, then private: going public deleted the epoch and going private seeded
//     it at 0 again, which is the epoch every link minted before the rotate carries;
//   - delete, then publish again on the same slug: the new artifact started at epoch 0 too, so a
//     link to the deleted artifact opened the new one. A zip site can only be redeployed that way.
import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';

async function linkFor(srv, slug) {
  const res = await srv.api('GET', `/api/artifacts/${slug}/link`);
  assert.equal(res.status, 200);
  return (await res.json()).url;
}

// 302 with a cookie when the token is accepted, the flat 404 when it is not.
async function opens(url) {
  const res = await fetch(url, { redirect: 'manual' });
  return res.status === 302;
}

test('a rotated link stays dead after a public and private round trip', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const pub = await srv.api('POST', '/api/artifacts', { slug: 'epoch-trip', content: '<p>x</p>', visibility: 'private' });
  assert.equal(pub.status, 201);
  const old = await linkFor(srv, 'epoch-trip');
  assert.ok(await opens(old), 'a fresh link should open');

  assert.equal((await srv.api('PATCH', '/api/artifacts/epoch-trip', { rotateToken: true })).status, 200);
  assert.equal(await opens(old), false, 'rotate did not revoke the link');

  assert.equal((await srv.api('PATCH', '/api/artifacts/epoch-trip', { visibility: 'public' })).status, 200);
  assert.equal((await srv.api('PATCH', '/api/artifacts/epoch-trip', { visibility: 'private' })).status, 200);
  assert.equal(await opens(old), false, 'a public and private round trip brought a revoked link back');

  // The same trip through a PUT replace.
  assert.equal((await srv.api('PUT', '/api/artifacts/epoch-trip', { content: '<p>y</p>', visibility: 'public' })).status, 200);
  assert.equal((await srv.api('PUT', '/api/artifacts/epoch-trip', { content: '<p>z</p>', visibility: 'private' })).status, 200);
  assert.equal(await opens(old), false, 'a replace round trip brought a revoked link back');
  assert.ok(await opens(await linkFor(srv, 'epoch-trip')), 'a link minted now should open');
});

test('a link to a deleted artifact does not open a new one on the same slug', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  assert.equal((await srv.api('POST', '/api/artifacts', { slug: 'epoch-reuse', content: '<p>old</p>', visibility: 'private' })).status, 201);
  const old = await linkFor(srv, 'epoch-reuse');
  assert.ok(await opens(old));

  assert.equal((await srv.api('DELETE', '/api/artifacts/epoch-reuse')).status, 200);
  assert.equal((await srv.api('POST', '/api/artifacts', { slug: 'epoch-reuse', content: '<p>new</p>', visibility: 'private' })).status, 201);
  assert.equal(await opens(old), false, 'the old link opened the artifact that replaced it');

  // The unlock cookie the old link set is refused as well.
  const first = await fetch(old, { redirect: 'manual' });
  assert.equal(first.status, 404);
});

test('a renamed artifact does not hand its link to a new artifact on the old slug', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  assert.equal((await srv.api('POST', '/api/artifacts', { slug: 'epoch-move', content: '<p>a</p>', visibility: 'private' })).status, 201);
  const old = await linkFor(srv, 'epoch-move');
  assert.equal((await srv.api('PATCH', '/api/artifacts/epoch-move', { slug: 'epoch-moved' })).status, 200);
  assert.equal((await srv.api('POST', '/api/artifacts', { slug: 'epoch-move', content: '<p>b</p>', visibility: 'private' })).status, 201);
  assert.equal(await opens(old), false, 'the old link opened the new artifact on the reused slug');
});
