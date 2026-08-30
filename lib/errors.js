import { UnsafeKeyError } from '../storage/index.js';

// Shared error type for anything that wants to name its own HTTP status. The
// express error handler in server.js matches on `instanceof ApiError` and then
// reads `.status`; every other error falls through to a 500. Attaching a
// `.status` to a plain Error is not enough, so throw this one.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A storage call that did not come back inside the write queue's ceiling. It is the one 5xx
// whose message this repo wrote, so clientFacingError lets it through where it refuses every
// other 5xx. `retryAfter` is seconds, and becomes the Retry-After header: the server is fine,
// that one call is not, and the request is worth making again.
export class StorageTimeoutError extends ApiError {
  constructor(message) {
    super(503, message);
    this.retryAfter = 5;
  }
}

// A body-parser limit in bytes, written the way the docs write it. Every limit this server sets
// is a whole number of kB or MB, so the fraction is only there to keep a hand-edited one honest.
function describeLimit(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} mb`;
  const kb = bytes / 1024;
  return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} kb`;
}

// What the express error handler answers. Returns `{ status, message }` for a request the
// caller can fix, or null when the error belongs to this server and the caller gets a bare 500.
//
// express.json() runs in strict mode, so a body of `null`, `"x"` or `5` never reaches a route:
// body-parser throws before the handler does. Those refusals used to fall through to the 500
// branch, which told a client "the server broke" for a typo and logged a stack trace per
// attempt. A retry loop keyed on 5xx then retried a request that could never succeed.
//
// body-parser builds its errors with http-errors, so each one carries a `status`, an `expose`
// flag and a `type` naming what it refused. Both `status` and `expose` have to agree before any
// message leaves this process: `expose` on its own shows up on errors this repo did not write,
// and a 4xx on its own says nothing about whether the text names an internal path. A 5xx never
// speaks for itself, whatever it is marked.
export function clientFacingError(err) {
  // The local backend's realpath guard refuses a write through a symlinked slug directory. On
  // the serve path serveObject maps that to a 404; on the publish path it had nowhere to go, so
  // an operator whose /data holds a symlinked slug got a bare 500 with nothing in it to act on.
  // 409: the namespace exists and is not something this server will write into. The key is
  // ours, and the message says nothing about the filesystem beyond the slug the caller named.
  if (err instanceof UnsafeKeyError) {
    const slug = String(err.key || '').split('/')[0];
    return {
      status: 409,
      message: slug
        ? `cannot write to "${slug}": that name resolves outside the artifact store on this host. `
          + 'A slug directory that is a symlink is the usual cause. Fix it on the host or publish under another slug.'
        : 'cannot write that key: it resolves outside the artifact store on this host',
    };
  }
  // An ApiError names its own status, and every one this repo throws is a 4xx. The status is
  // checked anyway: nothing stops the next writer from `new ApiError(500, err.message)`, which
  // would hand a caller whatever the failure said about this server's disks or database.
  if (err instanceof StorageTimeoutError) {
    return { status: err.status, message: err.message, retryAfter: err.retryAfter };
  }
  if (err instanceof ApiError) {
    if (!Number.isInteger(err.status) || err.status >= 500) return null;
    return { status: err.status, message: err.message };
  }
  // The limit is ours, so the message says what it was rather than repeating body-parser's
  // "request entity too large", which does not tell the caller what to cut to. The number comes
  // off the error rather than a list written here: four parsers can raise this (10 MB publish
  // JSON, 50 MB zip, 256 kB for a caller who cannot publish, 16 kB on the credential routes),
  // and naming all four told a caller refused at 256 kB to cut to a limit it was already under.
  if (err?.type === 'entity.too.large') {
    const limit = Number(err.limit);
    return {
      status: 413,
      message: Number.isFinite(limit)
        ? `body too large: the limit on this request is ${describeLimit(limit)}`
        : 'body too large',
    };
  }
  // body-parser's text here is whatever JSON.parse said, which points at a byte offset in a
  // body the caller may not have built by hand. Naming what a body has to be is the part they
  // can act on, and it is the accurate half for three of the four shapes that land here:
  // `null`, `5`, `"x"` and `true` are all valid JSON, and what refuses them is strict mode
  // wanting an object or an array.
  if (err?.type === 'entity.parse.failed') {
    return { status: 400, message: 'invalid JSON body: expected a JSON object' };
  }
  const status = err?.status;
  if (
    err?.expose === true &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    typeof err.message === 'string'
  ) {
    return { status, message: err.message };
  }
  return null;
}
