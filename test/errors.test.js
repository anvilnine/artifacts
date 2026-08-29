// What the express error handler answers, decided away from express so a test can hand it the
// exact error shapes body-parser throws.
//
// The shapes here are real ones: body-parser builds them with http-errors, which sets `expose`
// from the status. A test that made them up would drift the day body-parser changed, so each
// case names the `type` body-parser stamps on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, StorageTimeoutError, clientFacingError } from '../lib/errors.js';
import { UnsafeKeyError } from '../storage/index.js';

// The error body-parser throws for a body JSON.parse refuses. Strict mode means `null`, `"x"`
// and `5` land here too, not just broken syntax.
function parseFailure() {
  const err = new SyntaxError('Unexpected token x in JSON at position 0');
  err.status = 400;
  err.statusCode = 400;
  err.expose = true;
  err.type = 'entity.parse.failed';
  err.body = 'x';
  return err;
}

test('an ApiError keeps its own status and message', () => {
  assert.deepEqual(clientFacingError(new ApiError(404, 'slug "x" not found')), {
    status: 404,
    message: 'slug "x" not found',
  });
});

test('a body body-parser refuses is a 400 that names the problem', () => {
  const answer = clientFacingError(parseFailure());
  assert.equal(answer.status, 400);
  assert.match(answer.message, /JSON/);
  // `null`, `5`, `"x"` and `true` are all valid JSON, so "invalid JSON" named the wrong thing
  // for three of the four shapes this branch exists for. What refuses them is strict mode
  // wanting an object or an array, which is the part a caller can act on.
  assert.equal(answer.message, 'invalid JSON body: expected a JSON object');
});

test('an ApiError built with a 5xx says nothing about itself either', () => {
  // No route builds one today. The branch above hands back whatever message it is given,
  // whatever the status, so `new ApiError(500, err.message)` would ship an internal string
  // to the caller the day someone writes it.
  assert.equal(clientFacingError(new ApiError(500, '/data/secrets/keys.json is unreadable')), null);
  assert.equal(clientFacingError(new ApiError(503, 'postgres pool exhausted')), null);
  // A status that is not a status cannot reach res.status() either, which throws on it.
  assert.equal(clientFacingError(new ApiError(undefined, 'no status')), null);
  // 4xx keeps working, since that is every ApiError this repo throws.
  assert.deepEqual(clientFacingError(new ApiError(409, 'slug "x" already exists')), {
    status: 409,
    message: 'slug "x" already exists',
  });
});

test('a body past the limit is a 413 naming the limits', () => {
  const err = new Error('request entity too large');
  err.status = 413;
  err.expose = true;
  err.type = 'entity.too.large';
  const answer = clientFacingError(err);
  assert.equal(answer.status, 413);
  assert.match(answer.message, /body too large/);
});

test('an encoding body-parser cannot decode is a 415', () => {
  const err = new Error('unsupported content encoding "br"');
  err.status = 415;
  err.expose = true;
  err.type = 'encoding.unsupported';
  const answer = clientFacingError(err);
  assert.equal(answer.status, 415);
  assert.equal(answer.message, 'unsupported content encoding "br"');
});

test('an internal error says nothing about itself', () => {
  assert.equal(clientFacingError(new Error('ENOENT: /data/secrets/keys.json')), null);
  assert.equal(clientFacingError(undefined), null);
  assert.equal(clientFacingError(null), null);
});

test('a 5xx never speaks for itself, however it is marked', () => {
  const err = new Error('postgres connection string rejected');
  err.status = 500;
  err.expose = true;
  assert.equal(clientFacingError(err), null);
});

test('a 4xx with expose off stays quiet', () => {
  const err = new Error('/data/keys.json is unreadable');
  err.status = 400;
  err.expose = false;
  assert.equal(clientFacingError(err), null);
});

test('a status that is not a number is not a status', () => {
  const err = new Error('nope');
  err.status = '400';
  err.expose = true;
  assert.equal(clientFacingError(err), null);
});

// The one 5xx this handler speaks for. Every other 5xx answers a bare 500, because its message
// can carry whatever a backend said about this server's disks or database; this one is a
// sentence this repo wrote, and the caller needs it to know a retry is worth making.
test('a storage call that ran out of time is a 503 the caller can act on', () => {
  const answer = clientFacingError(new StorageTimeoutError('the storage backend did not answer'));
  assert.equal(answer.status, 503);
  assert.equal(answer.message, 'the storage backend did not answer');
  assert.ok(answer.retryAfter > 0);
});

// A 5xx ApiError that is not the timeout still says nothing.
test('any other 5xx still answers a bare 500', () => {
  assert.equal(clientFacingError(new ApiError(500, '/data/artifacts is full')), null);
  assert.equal(clientFacingError(new ApiError(503, 'the database is gone')), null);
});

// The local backend's realpath guard refuses a write through a symlinked slug directory. The
// serve path maps that to a 404; the publish path had nothing for it, so an operator whose /data
// held a symlinked slug got a bare "internal server error" with nothing in it to act on.
test('a key that resolves outside the store is a 409 naming the slug', () => {
  const answer = clientFacingError(new UnsafeKeyError('"sym/index.html" resolves outside storage root', 'sym/index.html'));
  assert.equal(answer.status, 409);
  assert.match(answer.message, /"sym"/);
  assert.match(answer.message, /symlink/);
  // A key-shape refusal from assertSafeKey carries no key, and still must not become a 500.
  assert.equal(clientFacingError(new UnsafeKeyError('empty key')).status, 409);
});
