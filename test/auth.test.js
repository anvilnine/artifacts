// Unit tests for lib/auth.js. No server, no storage backend: createAuthStore takes the
// storage object, so a plain in-memory stub is enough to drive a whole auth record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthStore, AuthFileError, hashKey } from '../lib/auth.js';

const AUTH_KEY = 'auth.json';

// Minimal stand-in for storage/*.js: getBuffer + put + flush is all the auth store calls.
// A string argument is written as-is, so a test can hand over bytes that are not an auth record.
function stubStorage(record) {
  const files = new Map();
  if (typeof record === 'string') files.set(AUTH_KEY, Buffer.from(record));
  else if (record) files.set(AUTH_KEY, Buffer.from(JSON.stringify(record)));
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

// A truncated auth.json (what a crash during saveAuth leaves behind) used to load as a blank
// record: admin gone, both secrets gone, every key gone, and POST /api/auth/setup claimable by
// the next caller, since that route is unauthenticated and gated only on `auth.admin`.
test('a corrupt auth.json fails the boot and is left on disk untouched', async () => {
  const truncated = '{"version":1,"admin":{"username":"real","salt":"aa","passwordHash":"bb"';
  const storage = stubStorage(truncated);

  await assert.rejects(
    () => createAuthStore(storage, { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' }),
    (err) => err instanceof AuthFileError && /not valid JSON/.test(err.message),
  );
  assert.equal(storage.files.get(AUTH_KEY).toString(), truncated);
});

// Valid JSON of the wrong shape reads every field as undefined, which is the same blank record
// by another route.
test('an auth.json that is not a JSON object fails the boot', async () => {
  for (const body of ['[]', '"admin"', 'null', '42']) {
    await assert.rejects(
      () => createAuthStore(stubStorage(body), { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' }),
      (err) => err instanceof AuthFileError && /expected a JSON object/.test(err.message),
      `expected ${body} to be rejected`,
    );
  }
});

// The other half of the rule: no file at all is a new instance and still boots blank.
test('an absent auth.json still boots as a fresh instance', async () => {
  const store = await createAuthStore(stubStorage(null), {
    apiKey: 'bootstrap',
    baseUrl: 'http://localhost:3000',
  });

  assert.equal(store.auth.admin, null);
  assert.deepEqual(store.auth.keys, []);
});

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
