// Unit tests for lib/auth.js. No server, no storage backend: createAuthStore takes the
// storage object, so a plain in-memory stub is enough to drive a whole auth record.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthStore,
  AdminSeedError,
  AuthFileError,
  capTtlDays,
  hashKey,
  publicKey,
  SESSION_COOKIE,
  signSession,
} from '../lib/auth.js';

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

// `expiresAt` is the one field on a key record that used to fail open. Date.parse returns NaN
// for anything it cannot read and `NaN <= now` is false, so a hand-edited or restored auth.json
// with junk in that field minted a key that authenticated forever. Same shape as the capability
// token bug in T1.2.12.
test('a key whose expiresAt does not parse is rejected, not treated as never expiring', async () => {
  const junk = [
    ['garbage', 'ak_live_junkstr'],
    [{}, 'ak_live_junkobj'],
    [true, 'ak_live_junkbool'],
    // `false` is the case that separates the real fix from a shorter wrong one. A guard
    // written as `if (!k.expiresAt) return false` reads it as "no expiry" and the key goes
    // back to living forever, with every other case here still green.
    [false, 'ak_live_junkfalse'],
    [[], 'ak_live_junkarr'],
  ];
  const keys = junk.map(([expiresAt, token], i) => ({
    ...goodKey(),
    id: `k_junk${i}`,
    hash: hashKey(token),
    expiresAt,
  }));
  const store = await createAuthStore(stubStorage({ version: 1, keys }), {
    apiKey: 'bootstrap',
    baseUrl: 'http://localhost:3000',
  });

  for (const [expiresAt, token] of junk) {
    assert.equal(
      callGuard(store, 'publish', token).code,
      401,
      `expiresAt ${JSON.stringify(expiresAt)} should not authenticate`,
    );
  }
});

// The absent cases have to keep working, or the fix turns every key without an expiry into an
// expired one. `null` is what parseKeyInput stores when the operator leaves the field empty.
test('a key with no expiresAt still authenticates', async () => {
  const keys = [
    { ...goodKey(), id: 'k_null', hash: hashKey('ak_live_nullexp'), expiresAt: null },
    { ...goodKey(), id: 'k_empty', hash: hashKey('ak_live_emptyexp'), expiresAt: '' },
    { ...goodKey(), id: 'k_absent', hash: hashKey('ak_live_absentexp') },
  ];
  const store = await createAuthStore(stubStorage({ version: 1, keys }), {
    apiKey: 'bootstrap',
    baseUrl: 'http://localhost:3000',
  });

  for (const token of ['ak_live_nullexp', 'ak_live_emptyexp', 'ak_live_absentexp']) {
    assert.equal(callGuard(store, 'publish', token).nexted, true, `${token} should authenticate`);
  }
});

// The bearer path skips a broken record; the key screen has to render it instead, since the
// boot warning tells the operator to go there and revoke it. publicKey used to read k.scopes
// straight through, so GET /api/keys answered 500 and the dashboard threw on scopes.join().
test('publicKey survives a record with no hash and no scopes, and flags it', () => {
  const row = publicKey({ id: 'k_bad', name: 'ci' });

  assert.equal(row.broken, true);
  assert.deepEqual(row.scopes, []);
  assert.equal(row.prefix, '');
  assert.equal(row.id, 'k_bad');
  assert.equal(row.lastUsedAt, null);
});

test('publicKey leaves a healthy record alone and marks it not broken', () => {
  const row = publicKey({ ...goodKey(), lastUsedAt: new Date(0).toISOString() });

  assert.equal(row.broken, false);
  assert.deepEqual(row.scopes, ['publish']);
  assert.equal(row.name, 'good');
  assert.equal(row.prefix, 'ak_live_g');
  assert.equal(row.disabled, false);
});

// Both callers slice the timestamps for display, so a non-string here throws in the browser
// and in `artifacts keys list` instead of in a route, where nothing catches it.
test('publicKey drops timestamps and an id that are not strings', () => {
  const row = publicKey({ id: 7, name: 'ci', expiresAt: 12345, lastUsedAt: {}, createdAt: [] });

  assert.equal(row.id, null);
  assert.equal(row.expiresAt, null);
  assert.equal(row.lastUsedAt, null);
  assert.equal(row.createdAt, null);
});

// A name that is not a string reached the dashboard as "undefined · " in the row title.
test('publicKey names an unnamed record rather than passing undefined through', () => {
  assert.equal(publicKey({ id: 'k_bad' }).name, '(unnamed)');
});

// publicKey never returns the hash. The list route is admin-only, but the whole point of
// storing a sha256 is that it does not leave the process.
test('publicKey does not carry the hash out', () => {
  const row = publicKey(goodKey());

  assert.equal(row.hash, undefined);
  assert.equal(JSON.stringify(row).includes(hashKey(GOOD_TOKEN)), false);
});

// CAP_TOKEN_TTL_DAYS used to go through Number(raw || 30). A typo produced NaN days, which
// minted share links that never lapsed; 0 or a negative produced links dead on arrival.
test('capTtlDays falls back to 30 for junk, zero and negatives', () => {
  assert.equal(capTtlDays(undefined), 30);
  assert.equal(capTtlDays(''), 30);
  assert.equal(capTtlDays('thirty'), 30);
  assert.equal(capTtlDays('30d'), 30);
  assert.equal(capTtlDays('0'), 30);
  assert.equal(capTtlDays('-7'), 30);
  assert.equal(capTtlDays('Infinity'), 30);
});

test('capTtlDays keeps a real value', () => {
  assert.equal(capTtlDays('7'), 7);
  assert.equal(capTtlDays('0.5'), 0.5);
  assert.equal(capTtlDays('365'), 365);
});

async function capStore() {
  const store = await createAuthStore(stubStorage({ version: 1, keys: [] }), {
    apiKey: 'bootstrap',
    baseUrl: 'http://localhost:3000',
  });
  const secret = await store.ensureSessionSecret();
  return { store, secret };
}

// The mint-side fix cannot reach a link already handed out. A token minted while the env var
// held junk carries exp: null (NaN survives JSON.stringify as null), and verifyCapToken read
// a missing exp as "no expiry set", so it stayed valid forever.
test('a capability token with no numeric exp is refused', async () => {
  const { store, secret } = await capStore();

  const immortal = signSession({ typ: 'cap', slug: 'cap-one', epoch: 0, exp: null }, secret);
  assert.equal(store.verifyCapToken(immortal, 'cap-one', 0), false);

  const noExp = signSession({ typ: 'cap', slug: 'cap-one', epoch: 0 }, secret);
  assert.equal(store.verifyCapToken(noExp, 'cap-one', 0), false);
});

// The refusal has to leave the normal path alone: a freshly minted token is valid, one past
// its exp is not, and the slug and epoch bindings still hold.
test('a freshly minted capability token still verifies', async () => {
  const { store, secret } = await capStore();

  const fresh = store.signCapToken('cap-one', 0);
  assert.equal(store.verifyCapToken(fresh, 'cap-one', 0), true);
  assert.equal(store.verifyCapToken(fresh, 'cap-two', 0), false);
  assert.equal(store.verifyCapToken(fresh, 'cap-one', 1), false);

  const lapsed = signSession(
    { typ: 'cap', slug: 'cap-one', epoch: 0, exp: Date.now() - 1000 },
    secret,
  );
  assert.equal(store.verifyCapToken(lapsed, 'cap-one', 0), false);
});

async function sessionStore() {
  const store = await createAuthStore(
    stubStorage({
      version: 1,
      admin: { username: 'ci-admin', hash: 'not-checked-here' },
      adminSecret: 'a'.repeat(64),
      keys: [],
    }),
    { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' },
  );
  return { store, secret: store.auth.adminSecret };
}

const sessionReq = (token) => ({ headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } });

// issueSession always stamps a numeric exp, and forging a payload needs adminSecret, so nothing
// reaches this today. It is the session half of the capability-token bug T1.2.12 closed, and it
// reopens the moment the TTL becomes configurable, which is where a junk value would come from.
test('a session payload with no numeric exp is refused', async () => {
  const { store, secret } = await sessionStore();

  for (const payload of [
    { sub: 'ci-admin' },
    { sub: 'ci-admin', exp: null },
    { sub: 'ci-admin', exp: String(Date.now() + 60_000) },
    { sub: 'ci-admin', exp: {} },
  ]) {
    const token = signSession(payload, secret);
    assert.equal(
      store.sessionPrincipal(sessionReq(token)),
      null,
      `exp ${JSON.stringify(payload.exp)} should not resolve`,
    );
  }
});

// The refusal has to leave the normal path alone.
test('a session inside its window resolves and one past it does not', async () => {
  const { store, secret } = await sessionStore();

  const live = store.sessionPrincipal(sessionReq(signSession({ sub: 'ci-admin', exp: Date.now() + 60_000 }, secret)));
  assert.equal(live?.admin, true);
  assert.equal(live?.session, true);

  const lapsed = signSession({ sub: 'ci-admin', exp: Date.now() - 1000 }, secret);
  assert.equal(store.sessionPrincipal(sessionReq(lapsed)), null);

  const wrongUser = signSession({ sub: 'someone-else', exp: Date.now() + 60_000 }, secret);
  assert.equal(store.sessionPrincipal(sessionReq(wrongUser)), null);
});

// Two stores over one storage stub are two replicas over one auth.json: each holds the record
// it read at boot. saveAuth used to write that whole snapshot back, so the second replica to
// write reverted the first replica's change.
async function twoReplicas() {
  const storage = stubStorage({
    version: 1,
    admin: { username: 'admin', salt: 'salt0', passwordHash: 'hash0' },
    sessionSecret: 'session0',
    adminSecret: 'admin0',
    keys: [],
  });
  const opts = { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' };
  const a = await createAuthStore(storage, opts);
  const b = await createAuthStore(storage, opts);
  const stored = () => JSON.parse(storage.files.get(AUTH_KEY).toString());
  return { a, b, stored };
}

test("one replica's write does not revert another replica's password change", async () => {
  const { a, b, stored } = await twoReplicas();

  await a.update((rec) => {
    rec.admin = { username: 'admin', salt: 'salt1', passwordHash: 'hash1' };
    rec.adminSecret = 'admin1';
  });
  // The trigger in production is not an admin action: touchKey refreshes lastUsedAt through
  // this same path, so one ordinary bearer read on the other replica was enough.
  await b.update((rec) => {
    rec.keys.push({ ...goodKey(), id: 'k_from_b' });
  });

  assert.equal(stored().admin.passwordHash, 'hash1');
  assert.equal(stored().adminSecret, 'admin1');
  assert.equal(stored().keys.length, 1);
});

test('a key minted on one replica survives a write on the other', async () => {
  const { a, b, stored } = await twoReplicas();

  await a.update((rec) => {
    rec.keys.push({ ...goodKey(), id: 'k_from_a' });
  });
  await b.update((rec) => {
    rec.keys.push({ ...goodKey(), id: 'k_from_b' });
  });
  // And a revoke on one replica is not undone by the other.
  await a.update((rec) => {
    rec.keys.splice(
      rec.keys.findIndex((k) => k.id === 'k_from_b'),
      1,
    );
  });
  await b.update((rec) => {
    rec.keys[0].lastUsedAt = new Date(0).toISOString();
  });

  assert.deepEqual(
    stored().keys.map((k) => k.id),
    ['k_from_a'],
  );
});

test('two writes issued at once on one replica both land', async () => {
  const { a, stored } = await twoReplicas();

  await Promise.all([
    a.update((rec) => {
      rec.keys.push({ ...goodKey(), id: 'k_one' });
    }),
    a.update((rec) => {
      rec.keys.push({ ...goodKey(), id: 'k_two' });
    }),
  ]);

  assert.deepEqual(
    stored().keys.map((k) => k.id).sort(),
    ['k_one', 'k_two'],
  );
});

// A route that rejects the change (a 404 on an unknown key id, a 409 on a claimed admin)
// throws inside the mutate. That must not write, and must not wedge the write chain.
test('a mutate that throws writes nothing and leaves the next write working', async () => {
  const { a, stored } = await twoReplicas();

  await assert.rejects(() =>
    a.update((rec) => {
      rec.keys.push({ ...goodKey(), id: 'k_never' });
      throw new Error('rejected');
    }),
  );
  assert.deepEqual(stored().keys, []);

  await a.update((rec) => {
    rec.keys.push({ ...goodKey(), id: 'k_after' });
  });
  assert.deepEqual(
    stored().keys.map((k) => k.id),
    ['k_after'],
  );
});

// A replica booting against a backend that already has an admin must not overwrite it: that
// would change the password hash under a live session.
test('the env admin seed leaves an admin another replica already wrote alone', async () => {
  const storage = stubStorage({
    version: 1,
    admin: { username: 'first', salt: 'salt0', passwordHash: 'hash0' },
    sessionSecret: null,
    adminSecret: null,
    keys: [],
  });
  process.env.ARTIFACTS_ADMIN_USERNAME = 'second';
  process.env.ARTIFACTS_ADMIN_PASSWORD = 'second-password';
  try {
    const store = await createAuthStore(storage, {
      apiKey: 'bootstrap',
      baseUrl: 'http://localhost:3000',
    });
    assert.equal(store.auth.admin.username, 'first');
    assert.equal(store.auth.admin.passwordHash, 'hash0');
  } finally {
    delete process.env.ARTIFACTS_ADMIN_USERNAME;
    delete process.env.ARTIFACTS_ADMIN_PASSWORD;
  }
});

// The setup screen enforces an 8-character password and a 3-32 char [a-zA-Z0-9._-] username.
// The env seed went straight to hashPassword, so a 3-character password seeded a real admin
// that the dashboard would have refused to create.
async function seedWith(username, password, record) {
  process.env.ARTIFACTS_ADMIN_USERNAME = username;
  process.env.ARTIFACTS_ADMIN_PASSWORD = password;
  try {
    return await createAuthStore(stubStorage(record || { version: 1, keys: [] }), {
      apiKey: 'bootstrap',
      baseUrl: 'http://localhost:3000',
    });
  } finally {
    delete process.env.ARTIFACTS_ADMIN_USERNAME;
    delete process.env.ARTIFACTS_ADMIN_PASSWORD;
  }
}

test('the env admin seed refuses a password the setup screen would reject', async () => {
  await assert.rejects(
    () => seedWith('admin', 'short'),
    (err) =>
      err instanceof AdminSeedError &&
      /at least 8 characters/.test(err.message) &&
      err.message.startsWith('ARTIFACTS_ADMIN_PASSWORD rejected'),
  );
});

test('the env admin seed refuses a username the setup screen would reject', async () => {
  for (const username of ['ab', 'has space', 'a'.repeat(33), 'semi;colon']) {
    await assert.rejects(
      () => seedWith(username, 'long-enough-password'),
      (err) =>
        err instanceof AdminSeedError &&
        /3-32 chars/.test(err.message) &&
        err.message.startsWith('ARTIFACTS_ADMIN_USERNAME rejected'),
      `username ${JSON.stringify(username)} should be refused`,
    );
  }
});

test('the env admin seed writes nothing when it refuses', async () => {
  const storage = stubStorage({ version: 1, keys: [] });
  process.env.ARTIFACTS_ADMIN_USERNAME = 'admin';
  process.env.ARTIFACTS_ADMIN_PASSWORD = 'short';
  try {
    await assert.rejects(() =>
      createAuthStore(storage, { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' }),
    );
  } finally {
    delete process.env.ARTIFACTS_ADMIN_USERNAME;
    delete process.env.ARTIFACTS_ADMIN_PASSWORD;
  }
  assert.equal(storage.files.has(AUTH_KEY), true);
  assert.equal(JSON.parse(storage.files.get(AUTH_KEY).toString()).admin, undefined);
});

test('the env admin seed still creates an admin that passes both rules', async () => {
  const store = await seedWith('ci-admin', 'ci-admin-password');

  assert.equal(store.auth.admin.username, 'ci-admin');
  assert.equal(typeof store.auth.admin.passwordHash, 'string');
});

// An instance that already has an admin never reads the two variables, so a stale or wrong
// value in the environment must not lock the operator out of a running deployment.
test('a bad env seed does not fail the boot when an admin already exists', async () => {
  const store = await seedWith('ab', 'short', {
    version: 1,
    admin: { username: 'first', salt: 'salt0', passwordHash: 'hash0' },
    keys: [],
  });

  assert.equal(store.auth.admin.username, 'first');
});

// Both secrets are HMAC keys every replica has to agree on. A replica that generated its own
// would reject every share link and admin cookie the others issued.
test('a replica adopts a secret another replica generated', async () => {
  const storage = stubStorage({
    version: 1,
    admin: { username: 'admin', salt: 'salt0', passwordHash: 'hash0' },
    sessionSecret: null,
    adminSecret: null,
    keys: [],
  });
  const opts = { apiKey: 'bootstrap', baseUrl: 'http://localhost:3000' };
  const a = await createAuthStore(storage, opts);
  const b = await createAuthStore(storage, opts);

  const fromA = await a.ensureSessionSecret();
  const fromB = await b.ensureSessionSecret();

  assert.equal(typeof fromA, 'string');
  assert.equal(fromB, fromA);
  assert.equal(JSON.parse(storage.files.get(AUTH_KEY).toString()).sessionSecret, fromA);
});
