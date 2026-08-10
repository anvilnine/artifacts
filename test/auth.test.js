// Unit tests for lib/auth.js. No server, no storage backend: createAuthStore takes the
// storage object, so a plain in-memory stub is enough to drive a whole auth record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthStore, hashKey } from '../lib/auth.js';

const AUTH_KEY = 'auth.json';

// Minimal stand-in for storage/*.js: getBuffer + put + flush is all the auth store calls.
function stubStorage(record) {
  const files = new Map();
  if (record) files.set(AUTH_KEY, Buffer.from(JSON.stringify(record)));
  return {
    files,
    async getBuffer(key) {
      return files.get(key) || null;
    },
    async put(key, body) {
      files.set(key, Buffer.from(body));
    },
    async flush() {},
  };
}

function fakeReq(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

// Captures what the middleware answered: a status + body, or the fact that it called next().
function fakeRes() {
  const out = { code: null, body: null };
  return {
    out,
    status(code) {
      out.code = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    },
  };
}

// Runs requireApiKey and reports what it answered: the status and body it sent, or the fact
// that it called next(). A regression here throws, which node:test reports as a failure.
function callGuard(store, scope, token) {
  const res = fakeRes();
  let nexted = false;
  store.requireApiKey(scope)(fakeReq(token), res, () => {
    nexted = true;
  });
  return { ...res.out, nexted };
}

const GOOD_TOKEN = 'ak_live_goodkey';

function goodKey() {
  return {
    id: 'k_good',
    name: 'good',
    prefix: 'ak_live_g',
    hash: hashKey(GOOD_TOKEN),
    scopes: ['publish'],
    createdAt: new Date(0).toISOString(),
  };
}

// A record missing `hash` used to reach Buffer.from(undefined) inside resolveApiKey and
// throw ERR_INVALID_ARG_TYPE, which 500s every bearer request on the instance, not just
// the one carrying the bad key.
test('a key record with no hash is skipped and the caller gets 401', async () => {
  const store = await createAuthStore(
    stubStorage({ version: 1, keys: [{ id: 'k_bad', name: 'bad', scopes: ['publish'] }, goodKey()] }),
    { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' },
  );

  assert.deepEqual(callGuard(store, 'publish', 'ak_live_unknown'), {
    code: 401,
    body: { error: 'unauthorized' },
    nexted: false,
  });
  assert.equal(callGuard(store, 'publish', GOOD_TOKEN).nexted, true);
});

// Same shape, other field: an absent `scopes` threw on .map inside hasScope once the
// hash matched.
test('a key record with no scopes is skipped and the caller gets 401', async () => {
  const store = await createAuthStore(
    stubStorage({
      version: 1,
      keys: [{ id: 'k_bad', name: 'bad', hash: hashKey('ak_live_scopeless') }, goodKey()],
    }),
    { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' },
  );

  assert.deepEqual(callGuard(store, 'publish', 'ak_live_scopeless'), {
    code: 401,
    body: { error: 'unauthorized' },
    nexted: false,
  });
  assert.equal(callGuard(store, 'publish', GOOD_TOKEN).nexted, true);
});

// A hand-edited file can leave a null or a bare string in the array. key.disabled on
// null throws before any of the field checks run.
test('a null or string entry in keys is skipped and the caller gets 401', async () => {
  const store = await createAuthStore(
    stubStorage({ version: 1, keys: [null, 'ak_live_oops', goodKey()] }),
    { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' },
  );

  assert.equal(callGuard(store, 'publish', 'ak_live_unknown').code, 401);
  assert.equal(callGuard(store, 'publish', GOOD_TOKEN).nexted, true);
});

// The bootstrap ARTIFACTS_API_KEY is matched before the managed-key loop, so it answers even
// when every record in the file is garbage. This one is green with or without the skip; it
// guards the order of the two comparisons, not the skip itself.
test('the bootstrap key is matched before the managed-key loop', async () => {
  const store = await createAuthStore(stubStorage({ version: 1, keys: [{ id: 'k_bad' }] }), {
    apiKey: 'bootstrap',
    baseUrl: 'http://localhost:3000',
  });

  assert.equal(callGuard(store, 'full', 'bootstrap').nexted, true);
});

// The skip has to leave the other two reasons for a 401 alone, and it has to leave a plain
// valid key sitting next to them alone as well.
test('disabled and expired keys are still rejected, a valid one is not', async () => {
  const disabled = { ...goodKey(), id: 'k_disabled', disabled: true };
  const expired = {
    ...goodKey(),
    id: 'k_expired',
    hash: hashKey('ak_live_expired'),
    expiresAt: new Date(0).toISOString(),
  };
  const valid = { ...goodKey(), id: 'k_valid', hash: hashKey('ak_live_valid') };
  const store = await createAuthStore(
    stubStorage({ version: 1, keys: [disabled, expired, valid] }),
    { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' },
  );

  assert.equal(callGuard(store, 'publish', GOOD_TOKEN).code, 401);
  assert.equal(callGuard(store, 'publish', 'ak_live_expired').code, 401);
  assert.equal(callGuard(store, 'publish', 'ak_live_valid').nexted, true);
});
