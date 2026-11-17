// The admin session cookie is not enough on its own. Every cookie-authenticated API call must
// carry the session's CSRF token, which a page on the dashboard's origin (an artifact, on a
// single-host install) cannot read: it is only written into `/` on a top-level navigation and
// returned by sign-in. Without this, uploaded HTML served from the same origin could call
// POST /api/keys with the operator's cookie and mint itself a full key.
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';

const ADMIN = { username: 'csrf-admin', password: 'csrf-admin-password' };

async function login(srv) {
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(res.status, 200);
  const { csrf } = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.ok(csrf && typeof csrf === 'string', 'login should return a csrf token');
  return { csrf, cookie };
}

// A GET through node:http, because fetch() writes its own Sec-Fetch-Mode over the one a test
// wants to send.
function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function asSession(srv, { cookie, csrf }, method, route, body, extra = {}) {
  return fetch(`${srv.base}${route}`, {
    method,
    redirect: 'manual',
    headers: {
      Cookie: cookie,
      ...(csrf !== undefined ? { 'X-Artifacts-Csrf': csrf } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('cookie-authenticated API calls need the session CSRF token', async (t) => {
  const srv = await startServer({ ARTIFACTS_ADMIN_USERNAME: ADMIN.username, ARTIFACTS_ADMIN_PASSWORD: ADMIN.password });
  t.after(() => srv.stop());
  const s = await login(srv);
  const bare = { cookie: s.cookie };

  // Reads and writes on every gate: requireAdmin, requireAuth, requireSession.
  assert.equal((await asSession(srv, bare, 'GET', '/api/keys')).status, 401);
  assert.equal((await asSession(srv, { ...bare, csrf: 'nope' }, 'GET', '/api/keys')).status, 401);
  assert.equal((await asSession(srv, s, 'GET', '/api/keys')).status, 200);

  const mint = await asSession(srv, bare, 'POST', '/api/keys', { name: 'stolen', scopes: ['full'] });
  assert.equal(mint.status, 401, 'a key was minted with the cookie alone');
  const keys = await (await asSession(srv, s, 'GET', '/api/keys')).json();
  assert.equal(keys.length, 0);

  assert.equal((await asSession(srv, bare, 'GET', '/api/artifacts')).status, 401);
  assert.equal((await asSession(srv, s, 'GET', '/api/artifacts')).status, 200);
  assert.equal((await asSession(srv, bare, 'POST', '/api/artifacts', { content: '<p>x</p>' })).status, 401);
  assert.equal((await asSession(srv, s, 'POST', '/api/artifacts', { slug: 'csrf-one', content: '<p>x</p>' })).status, 201);
  assert.equal((await asSession(srv, bare, 'GET', '/api/artifacts/csrf-one/link')).status, 401);
  assert.equal((await asSession(srv, bare, 'PUT', '/api/config', {})).status, 401);
  assert.equal(
    (await asSession(srv, bare, 'POST', '/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'another-password' })).status,
    401,
  );

  // The QR image is the one exception: an <img> cannot send a header, and it shows only the
  // canonical URL of a slug the caller already named.
  assert.equal((await asSession(srv, bare, 'GET', '/api/artifacts/csrf-one/qr')).status, 200);

  // Bearer callers are unaffected.
  assert.equal((await srv.api('GET', '/api/keys')).status, 200);

  // The body-size gate does not count the cookie alone as publish authority either: a 300 kB
  // body gets the small parser's 413, not the 10 MB parser and then a 401.
  const big = JSON.stringify({ content: 'x'.repeat(300 * 1024) });
  const res = await fetch(`${srv.base}/api/artifacts`, {
    method: 'POST',
    headers: { Cookie: s.cookie, 'Content-Type': 'application/json' },
    body: big,
  });
  assert.equal(res.status, 413);
  const ok = await fetch(`${srv.base}/api/artifacts`, {
    method: 'POST',
    headers: { Cookie: s.cookie, 'X-Artifacts-Csrf': s.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'csrf-big', content: 'x'.repeat(300 * 1024) }),
  });
  assert.equal(ok.status, 201);
});

test('the dashboard page carries the token only for a top-level navigation', async (t) => {
  const srv = await startServer({ ARTIFACTS_ADMIN_USERNAME: ADMIN.username, ARTIFACTS_ADMIN_PASSWORD: ADMIN.password });
  t.after(() => srv.stop());
  const s = await login(srv);

  const page = async (headers) => {
    const res = await rawGet(`${srv.base}/`, { Cookie: s.cookie, ...headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
    const m = /<meta name="artifacts-csrf" content="([^"]+)">/.exec(res.body);
    return m ? m[1] : null;
  };

  assert.equal(await page({ 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }), s.csrf);
  assert.equal(await page({ 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }), null, 'fetch() read the token');
  assert.equal(await page({ 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' }), null);
  assert.equal(await page({ 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }), null, 'a frame got the token');
  assert.equal(await page({ 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'empty' }), null);

  // Signed out, there is no token to hand out.
  const anon = await rawGet(`${srv.base}/`, { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
  assert.doesNotMatch(anon.body, /<meta name="artifacts-csrf"/);
  // A browser too old to send Sec-Fetch-* still gets a working dashboard.
  assert.equal(/artifacts-csrf" content="([^"]+)"/.exec((await rawGet(`${srv.base}/`, { Cookie: s.cookie })).body)?.[1], s.csrf);
});

test('logout without the token does not sign every device out', async (t) => {
  const srv = await startServer({ ARTIFACTS_ADMIN_USERNAME: ADMIN.username, ARTIFACTS_ADMIN_PASSWORD: ADMIN.password });
  t.after(() => srv.stop());
  const s = await login(srv);

  assert.equal((await asSession(srv, { cookie: s.cookie }, 'POST', '/api/auth/logout')).status, 200);
  assert.equal((await asSession(srv, s, 'GET', '/api/keys')).status, 200, 'a tokenless logout revoked the session');

  assert.equal((await asSession(srv, s, 'POST', '/api/auth/logout')).status, 200);
  assert.equal((await asSession(srv, s, 'GET', '/api/keys')).status, 401, 'logout with the token did not revoke the session');
});
