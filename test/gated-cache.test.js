// A private or password artifact is served per viewer by unlock cookie, so its responses tell
// every shared cache to keep out, and so do the two responses that hand out the cookie.
import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';

test('gated artifact responses are private and never stored', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const pub = await srv.api('POST', '/api/artifacts', { slug: 'cache-priv', content: '<p>secret</p>', visibility: 'private', frame: false });
  assert.equal(pub.status, 201);
  const { url } = await pub.json();

  const exchange = await fetch(url, { redirect: 'manual' });
  assert.equal(exchange.status, 302);
  assert.equal(exchange.headers.get('cache-control'), 'no-store');
  const cookie = exchange.headers.get('set-cookie').split(';')[0];

  for (const path of ['/a/cache-priv', '/a/cache-priv?raw=1', '/a/cache-priv/source']) {
    const res = await fetch(`${srv.base}${path}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('cache-control'), 'private, no-store', path);
    assert.match(res.headers.get('vary') || '', /Cookie/, path);
  }

  // Without the cookie, the locked artifact answers exactly like a slug that does not exist.
  for (const path of ['', '?raw=1', '/source', '/x.css']) {
    const locked = await fetch(`${srv.base}/a/cache-priv${path}`);
    const missing = await fetch(`${srv.base}/a/cache-nope${path}`);
    assert.equal(locked.status, 404, path);
    for (const h of ['cache-control', 'vary', 'content-type', 'content-length']) {
      assert.equal(locked.headers.get(h), missing.headers.get(h), `${path} ${h}`);
    }
    assert.equal(await locked.text(), await missing.text(), path);
  }

  // The password unlock that sets the cookie is not stored either.
  assert.equal((await srv.api('POST', '/api/artifacts', { slug: 'cache-pw', content: '<p>x</p>', visibility: 'password', password: 'pw-123456' })).status, 201);
  const unlock = await fetch(`${srv.base}/a/cache-pw/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw-123456' }),
  });
  assert.equal(unlock.status, 200);
  assert.equal(unlock.headers.get('cache-control'), 'no-store');

  // A public artifact keeps the ordinary revalidate-every-time policy.
  assert.equal((await srv.api('POST', '/api/artifacts', { slug: 'cache-pub', content: '<p>p</p>', visibility: 'public', frame: false })).status, 201);
  const open = await fetch(`${srv.base}/a/cache-pub`);
  assert.equal(open.headers.get('cache-control'), 'no-cache');
});
