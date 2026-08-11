// Auth — one admin account (session login for the dashboard) plus managed API
// keys (scoped bearer tokens for CLI / MCP). Both live under a reserved key,
// exactly like the config.json key (see lib/config.js), so they persist across a fresh-container
// restart on every backend (local/s3/git/postgres/sqlite) with no schema or
// migration. The bootstrap ARTIFACTS_API_KEY stays valid as an all-scope
// break-glass admin bearer alongside the managed keys.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

import { ApiError } from './errors.js';

const AUTH_KEY = 'auth.json';
// Thrown when auth.json exists but cannot be read as an auth record. server.js catches this
// one by name so the operator gets the recovery line instead of a stack trace.
export class AuthFileError extends Error {
  constructor(detail) {
    super(
      `auth.json failed to load: ${detail}. Refusing to start. Booting from a blank record ` +
        `would drop the admin account, both signing secrets and every managed key, and the ` +
        `first write would overwrite the file for good. The file has not been modified. ` +
        `Restore it from a backup, or move it aside to start over (that means re-running ` +
        `first-run setup and re-minting every key). See docs/auth.md#a-corrupt-authjson.`,
    );
    this.name = 'AuthFileError';
  }
}

// Thrown when ARTIFACTS_ADMIN_USERNAME or ARTIFACTS_ADMIN_PASSWORD would seed an account the
// setup screen refuses to create. Caught by name in server.js, same as AuthFileError. `detail`
// already states the rule that failed, so this only names the variable and the way out.
export class AdminSeedError extends Error {
  constructor(variable, detail) {
    super(
      `${variable} rejected: ${detail}. Refusing to start. The first-run setup screen enforces ` +
        `the same rule, so seeding past it creates an account the dashboard would have turned ` +
        `down. Nothing was written, so fix the variable and boot again. ` +
        `See docs/auth.md#seeding-the-admin-from-env.`,
    );
    this.name = 'AdminSeedError';
  }
}

export const SCOPES = ['read', 'publish', 'full'];
// full implies publish implies read — a caller's effective level is its highest scope.
const SCOPE_RANK = { read: 0, publish: 1, full: 2 };
export const SESSION_COOKIE = 'artifacts_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// lastUsedAt is best-effort telemetry, not audit — throttle the write so a busy
// key does not commit+push on the git backend (or hammer SQL) on every request.
// On multi-replica deploys each replica throttles independently; the value is
// therefore approximate, which is fine for "when was this key last seen".
const LASTUSED_THROTTLE_MS = 5 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

// scrypt is memory-hard and was synchronous, blocking the event loop on the two
// unauthenticated credential routes (login, unlock). Run it on the libuv threadpool
// and cap concurrency so a flood degrades those routes instead of stalling the process.
const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_MAX_CONCURRENT = 2;
const SCRYPT_MAX_QUEUE = 20;
let scryptActive = 0;
const scryptQueue = [];
function withScrypt(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      scryptActive++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          scryptActive--;
          const next = scryptQueue.shift();
          if (next) next();
        });
    };
    if (scryptActive < SCRYPT_MAX_CONCURRENT) return run();
    if (scryptQueue.length >= SCRYPT_MAX_QUEUE) {
      return reject(new ApiError(429, 'server busy — retry shortly'));
    }
    scryptQueue.push(run);
  });
}

// Passwords: scrypt (built-in, memory-hard). Keys: sha256 — API keys are already
// 24 bytes of entropy, so a fast hash is safe and keeps lookup constant-time.
export async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const buf = await withScrypt(() => scryptAsync(password, salt, 64));
  return { salt, passwordHash: buf.toString('hex') };
}

export async function verifyPassword(password, admin) {
  if (typeof password !== 'string' || !admin?.passwordHash || !admin?.salt) return false;
  const hash = await withScrypt(() => scryptAsync(password, admin.salt, 64));
  const stored = Buffer.from(admin.passwordHash, 'hex');
  return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}

export function hashKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Session cookie = base64url(payload).HMAC(payload). Stateless; revocation of the
// admin session is by rotating sessionSecret (password change keeps it, by design).
export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token, secret) {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function hasScope(scopes, required) {
  const rank = Math.max(-1, ...scopes.map((s) => SCOPE_RANK[s] ?? -1));
  return rank >= SCOPE_RANK[required];
}

// True for a key record with the two fields the bearer path reads. A hand-edited auth.json,
// or one half-written by a crash during saveAuth, can hold a record missing either. Without
// this check `Buffer.from(key.hash)` runs for every non-disabled record on every request, so
// a record with no hash 500s every bearer request on the instance. A record with no scopes
// throws later, in hasScope, and takes down only the requests carrying that key.
export function usableKey(k) {
  return !!k && typeof k === 'object' && typeof k.hash === 'string' && Array.isArray(k.scopes);
}

// True when a key record has an expiry that has passed, and also when it has one that cannot
// be read. `Date.parse` answers NaN for junk and `NaN <= Date.now()` is false, so the plain
// comparison this replaces let a record with `expiresAt: "garbage"` authenticate forever. Junk
// only reaches here through a hand-edited or restored auth.json, since parseKeyInput rejects a
// bad expiresAt at mint time. Absent, null and empty still mean "no expiry"; anything else that
// does not parse is treated as expired, which is the direction that fails closed.
export function keyExpired(k) {
  if (k.expiresAt === undefined || k.expiresAt === null || k.expiresAt === '') return false;
  const t = Date.parse(k.expiresAt);
  return Number.isNaN(t) || t <= Date.now();
}

// The key screen renders whatever this returns, and it is the screen an operator opens after
// the boot warning tells them a record is broken. So it has to survive the same records
// usableKey() screens off the bearer path, and say which ones they are: a `broken` record
// authenticates nothing, and the only action worth offering on it is Revoke.
export function publicKey(k) {
  return {
    id: typeof k.id === 'string' ? k.id : null,
    name: typeof k.name === 'string' ? k.name : '(unnamed)',
    prefix: typeof k.prefix === 'string' ? k.prefix : '',
    scopes: Array.isArray(k.scopes) ? k.scopes : [],
    // The three timestamps are ISO strings on any record this server wrote. Both callers
    // slice them for display, so a hand edit that leaves a number here would throw in the
    // dashboard and in `artifacts keys list` rather than in a route.
    createdAt: typeof k.createdAt === 'string' ? k.createdAt : null,
    expiresAt: typeof k.expiresAt === 'string' ? k.expiresAt : null,
    lastUsedAt: typeof k.lastUsedAt === 'string' ? k.lastUsedAt : null,
    disabled: !!k.disabled,
    broken: !usableKey(k),
  };
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    throw new ApiError(400, 'password must be at least 8 characters');
  }
}

export function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new ApiError(400, 'username must be 3-32 chars [a-zA-Z0-9._-]');
  }
}

export function validateCredentials(username, password) {
  validateUsername(username);
  validatePassword(password);
}

export function parseKeyInput(name, scopes, expiresAt) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
    throw new ApiError(400, 'name (1-64 chars) is required');
  }
  let list = scopes;
  if (typeof list === 'string') list = [list];
  if (!Array.isArray(list) || !list.length) list = ['publish'];
  for (const s of list) {
    if (!SCOPES.includes(s)) throw new ApiError(400, `invalid scope "${s}" (read|publish|full)`);
  }
  let exp = null;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
    const t = Date.parse(expiresAt);
    if (Number.isNaN(t)) throw new ApiError(400, 'expiresAt must be an ISO 8601 date string');
    exp = new Date(t).toISOString();
  }
  return { name: name.trim(), scopes: list, expiresAt: exp };
}

const DEFAULT_CAP_TTL_DAYS = 30;

// Read CAP_TOKEN_TTL_DAYS, in days. `Number(raw || 30)` used to hand back NaN for anything
// non-numeric, and NaN is the worst possible answer here: signCapToken minted `exp: NaN`,
// JSON.stringify wrote that as null, and verifyCapToken read a null exp as "no expiry set",
// so every share link issued under a typo lived forever. docs/api.md and SECURITY.md both
// promise these links lapse. 0 and negatives are the mirror image, killing tokens on mint.
// Both fall back to the documented default, loudly, the way lib/config.js treats a bad enum.
export function capTtlDays(raw) {
  if (raw === undefined || raw === '') return DEFAULT_CAP_TTL_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `CAP_TOKEN_TTL_DAYS="${raw}" is not a positive number. ` +
        `Falling back to ${DEFAULT_CAP_TTL_DAYS} days for capability share links.`,
    );
    return DEFAULT_CAP_TTL_DAYS;
  }
  return n;
}

// The store owns the auth record and the two secrets. Everything above this line is
// stateless and exported on its own; the store returns only what needs the record, the
// secrets, or the boot-time settings. `apiKey` is the bootstrap ARTIFACTS_API_KEY;
// `baseUrl` decides whether cookies get the Secure flag. Matches createConfigStore:
// env is read when the store is built, not at import.
export async function createAuthStore(storage, { apiKey, baseUrl }) {
  const ADMIN_USERNAME = process.env.ARTIFACTS_ADMIN_USERNAME;
  const ADMIN_PASSWORD = process.env.ARTIFACTS_ADMIN_PASSWORD;
  // Lifetime of a capability share link (?k=<token>). The token is what the operator
  // copies for a private/password artifact; it exchanges for a slug-scoped unlock cookie.
  const CAP_TOKEN_TTL_MS = capTtlDays(process.env.CAP_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000;

  // Two independent HMAC secrets. sessionSecret signs capability links and per-slug unlock
  // cookies (long-lived, shared with readers); adminSecret signs the admin session cookie
  // only. Keeping them apart is what lets a password change rotate admin sessions without
  // invalidating every share link that is already out in the world.
  //
  // A blank record is how a fresh instance starts, so it cannot double as the answer to a
  // file that failed to parse (a truncated write from a crash mid-saveAuth looks exactly
  // like that). Booting blank loses the admin, both secrets and every key, and the next
  // write erases the original. It is also an unauthenticated takeover: POST /api/auth/setup
  // is gated only on `auth.admin`, so a blank record hands the instance to whoever asks
  // first. Only an absent file means "new instance"; anything else fails the boot.
  async function loadAuth() {
    const buf = await storage.getBuffer(AUTH_KEY);
    if (!buf) return { version: 1, admin: null, sessionSecret: null, adminSecret: null, keys: [] };
    let raw;
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      throw new AuthFileError(`not valid JSON (${err.message})`);
    }
    // Valid JSON of the wrong shape reads every field as undefined, which is the same blank
    // record by another route.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AuthFileError(`expected a JSON object, found ${Array.isArray(raw) ? 'an array' : typeof raw}`);
    }
    return {
      version: 1,
      admin: raw.admin || null,
      sessionSecret: raw.sessionSecret || null,
      adminSecret: raw.adminSecret || null,
      keys: Array.isArray(raw.keys) ? raw.keys : [],
    };
  }

  const auth = await loadAuth();

  // resolveApiKey skips these, so they cannot take the instance down. Name them once at boot
  // anyway: a bearer 401 is logged nowhere, so without this line a key that stopped working
  // looks like a client problem.
  const badKeys = auth.keys
    .map((k, i) => (usableKey(k) ? null : k?.id || `entry ${i}`))
    .filter(Boolean);
  if (badKeys.length) {
    console.warn(
      `auth.json: ignoring ${badKeys.length} key record(s) with no hash or no scopes ` +
        `(${badKeys.join(', ')}). Those keys return 401 until you delete or re-create them.`,
    );
  }

  // Every write reloads auth.json and changes what the backend holds, not the copy this
  // process booted with. The old saveAuth serialized the whole in-memory record, so on s3 or
  // postgres, where replicas share one auth.json, a replica that had been up since before a
  // change wrote its stale snapshot back over it. That took no unusual timing: touchKey
  // refreshes lastUsedAt through the same path, so one ordinary bearer read on replica B
  // reverted a password change made on replica A, deleted a key minted there, and turned a
  // disabled key back on.
  //
  // Read-then-write is not atomic and none of these backends offers compare-and-set, so two
  // replicas writing inside the same window can still lose one change. What goes away is the
  // much larger window that used to last as long as a process stayed up. Within one process
  // the chain below serializes writes, so two requests here cannot interleave.
  let writeChain = Promise.resolve();
  function update(mutate) {
    const applyUpdate = async () => {
      const stored = await loadAuth();
      // A mutate that throws (a 404 on a key id, a 409 on a claimed admin) never reaches the
      // put, so a rejected change leaves the stored record alone.
      const result = await mutate(stored);
      await storage.put(AUTH_KEY, JSON.stringify(stored, null, 2), {
        contentType: 'application/json',
      });
      await storage.flush?.();
      // `auth` is this process's read cache. Refresh it so the next request sees the write,
      // including whatever another replica had already put there. This swaps auth.keys for a
      // fresh array, so a key object a request is already holding (resolveApiKey hands one to
      // touchKey) is detached from the record afterwards. Nothing reads it past that point,
      // and touchKey looks its record up by id rather than by reference for this reason.
      Object.assign(auth, stored);
      return result;
    };
    const run = writeChain.then(applyUpdate, applyUpdate);
    // A failed write must not poison the chain for the next caller.
    writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // Seed the single admin account from env on first boot (skips the setup screen).
  // Like config.json, auth.json is otherwise created lazily — never written on a
  // plain boot with nothing to persist.
  if (!auth.admin && ADMIN_USERNAME && ADMIN_PASSWORD) {
    // The setup screen runs these two on the same fields, through validateCredentials. Skipping
    // them here seeded accounts the dashboard would have refused, and the operator found out at
    // the login screen. Checked one at a time so the error can name the variable to go fix.
    for (const [variable, value, check] of [
      ['ARTIFACTS_ADMIN_USERNAME', ADMIN_USERNAME, validateUsername],
      ['ARTIFACTS_ADMIN_PASSWORD', ADMIN_PASSWORD, validatePassword],
    ]) {
      try {
        check(value);
      } catch (err) {
        throw new AdminSeedError(variable, err.message);
      }
    }
    const seeded = { username: ADMIN_USERNAME, ...(await hashPassword(ADMIN_PASSWORD)) };
    const created = await update((a) => {
      // Another replica booting against the same backend may have seeded it already. Theirs
      // stands: overwriting it would change the password hash under a live session.
      if (a.admin) return false;
      a.admin = seeded;
      return true;
    });
    if (created) console.log(`admin account "${ADMIN_USERNAME}" created from env`);
  }

  // A throwaway credential with a real scrypt hash, used to verify a login for an unknown
  // username. Without it the route returns immediately on a username miss and takes ~100ms
  // on a hit, which tells an attacker the admin's username. Built once at boot so the first
  // wrong-username request is not itself the slow one.
  const DECOY_ADMIN = await hashPassword(crypto.randomBytes(32).toString('hex'));

  // The HMAC secret that signs capability links and unlock cookies — generated + persisted
  // the first time one is issued, never baked into a boot-time write.
  async function ensureSessionSecret() {
    if (auth.sessionSecret) return auth.sessionSecret;
    return update((a) => {
      // Take the stored one if another replica generated it first. Two replicas holding
      // different sessionSecrets reject each other's share links and unlock cookies.
      if (!a.sessionSecret) a.sessionSecret = crypto.randomBytes(32).toString('hex');
      return a.sessionSecret;
    });
  }

  // The HMAC secret for admin session cookies. An instance upgrading from a single-secret
  // auth.json has none yet, so it is generated on first use — which signs out any admin
  // session issued before the upgrade. Share links are unaffected.
  async function ensureAdminSecret() {
    if (auth.adminSecret) return auth.adminSecret;
    return update((a) => {
      // Same reason as sessionSecret: a replica that minted its own would reject every admin
      // cookie the others issued.
      if (!a.adminSecret) a.adminSecret = crypto.randomBytes(32).toString('hex');
      return a.adminSecret;
    });
  }

  async function issueSession(res, username) {
    const secret = await ensureAdminSecret();
    const token = signSession({ sub: username, exp: Date.now() + SESSION_TTL_MS }, secret);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: baseUrl.startsWith('https'),
      sameSite: 'strict',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  // Resolve a valid admin session cookie to a principal, or null.
  function sessionPrincipal(req) {
    const payload = verifySession(readCookie(req, SESSION_COOKIE), auth.adminSecret);
    if (!payload) return null;
    if (typeof payload.exp === 'number' && payload.exp <= Date.now()) return null;
    if (!auth.admin || payload.sub !== auth.admin.username) return null;
    return { admin: true, scopes: SCOPES, session: true };
  }

  // Bootstrap key = all-scope admin bearer; else a managed key matched by sha256,
  // rejected if disabled or expired. Returns the principal (with the mutable key
  // record, for lastUsedAt) or null.
  function resolveApiKey(token) {
    if (!token) return null;
    const a = Buffer.from(token);
    const b = Buffer.from(apiKey);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { admin: true, scopes: SCOPES, keyId: null, key: null };
    }
    const h = Buffer.from(hashKey(token));
    for (const key of auth.keys) {
      if (!usableKey(key)) continue;
      if (key.disabled) continue;
      const kh = Buffer.from(key.hash);
      if (kh.length !== h.length || !crypto.timingSafeEqual(kh, h)) continue;
      if (keyExpired(key)) return null;
      return { admin: false, scopes: key.scopes, keyId: key.id, key };
    }
    return null;
  }

  function touchKey(key) {
    if (!key) return;
    const now = Date.now();
    const last = key.lastUsedAt ? Date.parse(key.lastUsedAt) : 0;
    if (now - last < LASTUSED_THROTTLE_MS) return;
    const stamp = new Date(now).toISOString();
    // Stamp the in-memory record first so the throttle holds even while the write is in
    // flight; the write then finds the record by id in whatever the backend currently holds.
    key.lastUsedAt = stamp;
    update((a) => {
      const record = a.keys.find((k) => k?.id === key.id);
      if (record) record.lastUsedAt = stamp;
    }).catch((err) => console.error('lastUsedAt persist failed:', err));
  }

  // Machine callers (REST / CLI / MCP): Bearer token meeting a minimum scope.
  function requireApiKey(scope) {
    return (req, res, next) => {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const principal = resolveApiKey(token);
      if (!principal) return res.status(401).json({ error: 'unauthorized' });
      if (!hasScope(principal.scopes, scope)) {
        return res.status(403).json({ error: `forbidden: requires "${scope}" scope` });
      }
      req.principal = principal;
      touchKey(principal.key);
      next();
    };
  }

  // Artifact/config endpoints: an admin session cookie (dashboard, all scopes) OR a
  // bearer key (CLI/MCP/REST, scoped). Unifies the two callers on one gate — the
  // browser dropped its bearer for the session cookie, so a bearer-only guard would
  // 401 the dashboard.
  function requireAuth(scope) {
    return (req, res, next) => {
      let principal = sessionPrincipal(req);
      if (!principal) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        principal = resolveApiKey(token);
      }
      if (!principal) return res.status(401).json({ error: 'unauthorized' });
      if (!hasScope(principal.scopes, scope)) {
        return res.status(403).json({ error: `forbidden: requires "${scope}" scope` });
      }
      req.principal = principal;
      touchKey(principal.key); // no-op for session principals (no .key)
      next();
    };
  }

  // Dashboard-only endpoints: a valid admin session cookie.
  function requireSession(req, res, next) {
    const principal = sessionPrincipal(req);
    if (!principal) return res.status(401).json({ error: 'unauthorized' });
    req.principal = principal;
    next();
  }

  // Key-management endpoints: admin session cookie OR the bootstrap admin bearer
  // (so the CLI can mint keys). Managed keys — even full-scope — cannot manage keys.
  function requireAdmin(req, res, next) {
    const session = sessionPrincipal(req);
    if (session) {
      req.principal = session;
      return next();
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(token);
    const b = Buffer.from(apiKey);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      req.principal = { admin: true, scopes: SCOPES, keyId: null };
      return next();
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Capability token carried in the share URL (?k=…). Keyed on the session secret like the
  // session/unlock cookies, but typ:'cap' keeps the three token kinds non-interchangeable.
  // No per-artifact secret is stored — nothing sensitive can leak through the list API.
  function signCapToken(slug, epoch, ttlMs = CAP_TOKEN_TTL_MS) {
    return signSession({ typ: 'cap', slug, epoch, exp: Date.now() + ttlMs }, auth.sessionSecret);
  }

  function verifyCapToken(token, slug, epoch) {
    const p = verifySession(token, auth.sessionSecret);
    if (!p || p.typ !== 'cap' || p.slug !== slug || p.epoch !== epoch) return false;
    // Every token this server mints carries a numeric exp, so anything else is refused
    // rather than trusted. Tokens minted while CAP_TOKEN_TTL_DAYS held junk carry null
    // there, and reading that as "no expiry set" is what kept them alive; correcting the
    // env var does not reach a token that is already out in the world, but this does.
    return typeof p.exp === 'number' && p.exp > Date.now();
  }

  return {
    // The auth record this process read, and its read cache. Routes read it directly and
    // change it only through update(), which merges against the stored copy. Nothing outside
    // this module writes auth.json, so a replica cannot push a stale snapshot over another's.
    auth,
    DECOY_ADMIN,
    update,
    ensureSessionSecret,
    issueSession,
    sessionPrincipal,
    requireApiKey,
    requireAuth,
    requireSession,
    requireAdmin,
    signCapToken,
    verifyCapToken,
  };
}
