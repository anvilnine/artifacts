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
