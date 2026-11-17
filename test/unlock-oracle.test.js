// POST /a/:slug/unlock must not say whether a slug exists. A missing slug, a disabled artifact,
// a private one and a public one all answer the same status and body as a wrong password on a
// password artifact, so the route cannot confirm a guessed private slug.
import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';

test('the unlock route answers missing, disabled, private and public slugs alike', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  for (const [slug, extra] of [
    ['oracle-private', { visibility: 'private' }],
    ['oracle-public', { visibility: 'public' }],
    ['oracle-disabled', { visibility: 'private' }],
    ['oracle-password', { visibility: 'password', password: 'right-password' }],
  ]) {
    const res = await srv.api('POST', '/api/artifacts', { slug, content: '<p>x</p>', ...extra });
    assert.equal(res.status, 201, await res.text());
  }
  const dis = await srv.api('PATCH', '/api/artifacts/oracle-disabled', { disabled: true });
  assert.equal(dis.status, 200);

  const unlock = async (slug) => {
    const res = await fetch(`${srv.base}/a/${slug}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    return { status: res.status, body: await res.text() };
  };

  const wrong = await unlock('oracle-password');
  assert.equal(wrong.status, 401);
  for (const slug of ['oracle-missing', 'oracle-private', 'oracle-public', 'oracle-disabled', 'Not_A_Slug']) {
    assert.deepEqual(await unlock(slug), wrong, `${slug} answered differently from a wrong password`);
  }

  const right = await fetch(`${srv.base}/a/oracle-password/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'right-password' }),
  });
  assert.equal(right.status, 200);
});
