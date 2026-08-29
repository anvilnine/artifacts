// Pluggable storage layer.
//
// Artifacts are addressed by object *keys* of the shape `<slug>/<relpath>` — e.g.
// `my-slug/meta.json`, `my-slug/index.html`, `my-slug/site/assets/app.css`. Keys mirror
// the original on-disk layout so an existing local `/data` volume needs no migration.
//
// Backends implement the small interface below; business logic (validation, rendering,
// meta shape) stays in server.js and lib/. Selecting a backend loads only that backend's optional
// dependency — a plain `local` install pulls nothing extra.
//
//   interface Storage {
//     getBuffer(key)            -> Buffer | null                 // small reads (meta.json)
//     get(key, { range })       -> { stream, size } | null       // streamed body for serving
//     head(key)                 -> { size } | null               // existence / size, no body
//     put(key, data, { contentType })                            // MUST await a durable, whole-object write
//     listMetas()               -> [{ slug, buffer }]            // every artifact's meta.json
//     move(oldSlug, newSlug)                                     // rename a whole namespace
//     copySlug(srcSlug, dstSlug)                                 // copy a namespace's content objects (NOT meta.json)
//     delete(key)                                                // remove ONE object (never a prefix); a key that is gone is not an error
//     deleteSlug(slug)                                           // remove a whole namespace
//     flush?()                  // optional: durably commit a completed write (git)
//   }
//
// flush() is optional. The app calls `await storage.flush?.()` at the end of each logical
// write (publish / replace / patch / delete), so a backend that batches — the git backend
// coalesces a multi-file write into ONE commit+push — has a single "operation complete"
// signal. Backends that persist per-put (local, s3) don't implement it.
//
// A put replaces the object in one step: a concurrent reader sees either every old byte or
// every new one, never a mix. s3 and the SQL stores get that from a single PUT or upsert;
// local (and git, which reuses it) writes a temp file and renames it. Two writers to one key
// still settle last-writer-wins, so a caller that must not lose a field re-reads inside its
// own serialized write (server.js withMetaChain, which covers publish, replace, zip deploy,
// duplicate, patch and delete in one process, not two replicas sharing one store).
//
// This is about what a concurrent reader sees, not about surviving a power cut: local does not
// fsync the file or its directory before the rename.
//
// Write-ordering contract (crash-consistency without transactions): callers write all
// content objects first and `<slug>/meta.json` LAST as a commit marker, because readMeta
// and listMetas key off meta.json — a namespace with no meta is invisible (404), never
// half-served. deleteSlug removes meta first. See server.js for where this is applied.
//
// The same ordering decides where delete(key) goes: a replace that changes the type drops the
// old type's objects AFTER meta.json names the new one, so a crash mid-conversion leaves the
// old record whole rather than a listed artifact whose body is gone.

// How long one storage call gets to answer. Longer than a healthy call on any of the five
// backends, and shorter than the default client timeout in curl, most HTTP libraries and a
// browser fetch, so a caller waiting on a stalled backend hears a code from this server rather
// than watching its own client give up. The s3 backend puts it on every request it signs, and
// server.js caps a chained write with it, so a call that never comes back gives the slug back
// instead of parking every later write to it. One line to change.
export const STORAGE_TIMEOUT_MS = 30_000;

// A key/segment that fails validation. Callers map this to 404 (it only reaches a backend
// via user-controlled zip sub-paths); it must never surface as a 500.
export class UnsafeKeyError extends Error {}

// NUL, other C0 control chars, and DEL — never legitimate in an artifact key.
const CONTROL_RE = /[\x00-\x1f\x7f]/;

// The single choke-point guard, applied by every backend method on the raw key before it
// is joined to any root. Defense in depth on top of SLUG_RE (server.js) and the zip-ingest
// guards. Segment-based, so `..` can never be smuggled through normalization.
export function assertSafeKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new UnsafeKeyError('empty key');
  }
  if (CONTROL_RE.test(key)) throw new UnsafeKeyError('control character in key');
  if (key.includes('\\')) throw new UnsafeKeyError('backslash in key');
  if (key.startsWith('/')) throw new UnsafeKeyError('absolute key');
  for (const segment of key.split('/')) {
    // Rejects leading/trailing slash and `//` (empty segment) plus `.` / `..`.
    if (segment === '') throw new UnsafeKeyError('empty path segment');
    if (segment === '.' || segment === '..') throw new UnsafeKeyError('relative path segment');
  }
  return key;
}

const BACKENDS = {
  local: () => import('./local.js'),
  s3: () => import('./s3.js'),
  git: () => import('./git.js'),
  postgres: () => import('./postgres.js'),
  sqlite: () => import('./sqlite.js'),
};

// Every method the app calls on a store. A backend that is missing one fails the boot rather
// than the request that first needs it: the type-change cleanup swallows a failed delete on
// purpose (a write that already landed must not 500), so a backend with no delete would warn
// once per conversion forever and never fail a test. flush is left out because it is optional.
const REQUIRED = [
  'getBuffer',
  'get',
  'head',
  'put',
  'listMetas',
  'move',
  'copySlug',
  'delete',
  'deleteSlug',
];

export function assertComplete(name, storage) {
  const missing = REQUIRED.filter((method) => typeof storage?.[method] !== 'function');
  if (missing.length) {
    throw new Error(`storage backend "${name}" is missing: ${missing.join(', ')}`);
  }
  return storage;
}

// Instantiate the configured backend and run its boot check (fail-fast, like the
// ARTIFACTS_API_KEY check) so a misconfigured store crashes at startup, not first request.
export async function createStorage() {
  const name = process.env.STORAGE_BACKEND || 'local';
  const loader = BACKENDS[name];
  if (!loader) {
    const known = Object.keys(BACKENDS).join(', ');
    throw new Error(`unknown STORAGE_BACKEND "${name}" (available: ${known})`);
  }
  let mod;
  try {
    mod = await loader();
  } catch (err) {
    throw new Error(
      `storage backend "${name}" could not be loaded — is its dependency installed? (${err.message})`,
    );
  }
  const storage = assertComplete(name, await mod.create());
  await storage.init?.();
  return storage;
}
