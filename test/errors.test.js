// What the express error handler answers, decided away from express so a test can hand it the
// exact error shapes body-parser throws.
//
// The shapes here are real ones: body-parser builds them with http-errors, which sets `expose`
// from the status. A test that made them up would drift the day body-parser changed, so each
// case names the `type` body-parser stamps on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, clientFacingError } from '../lib/errors.js';

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
