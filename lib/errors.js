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
  // An ApiError names its own status, and every one this repo throws is a 4xx. The status is
  // checked anyway: nothing stops the next writer from `new ApiError(500, err.message)`, which
  // would hand a caller whatever the failure said about this server's disks or database.
  if (err instanceof ApiError) {
    if (!Number.isInteger(err.status) || err.status >= 500) return null;
    return { status: err.status, message: err.message };
  }
  // Both limits are ours, so the message says what they are rather than repeating
  // body-parser's "request entity too large", which does not tell the caller what to cut to.
  if (err?.type === 'entity.too.large') {
    return {
      status: 413,
      message: 'body too large (10mb json / 50mb zip / 16kb on credential routes)',
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
