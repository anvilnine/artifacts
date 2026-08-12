// When an artifact has lapsed.
//
// This is here rather than in the smoke suite because the API cannot produce the records that
// matter: parseExpiresAt refuses anything that is not an ISO string on the way in, so a junk
// expiresAt only ever arrives from a hand-edited or restored meta.json. These tests pin what
// each shape means before Date.parse gets a say. The 410 those records serve is proven end to
// end in ci.yml, which plants one in meta.json between two boots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactExpired } from '../lib/expiry.js';

// `false` and `0` are the two that separate this from the shorter `if (!meta.expiresAt)` guard:
// both are falsy, so that version reads them as "no expiry" and the artifact serves forever.
// `12345` and a one-element array are the two Date.parse accepts after stringifying, which is
// why the rule refuses a non-string before it asks.
test('an unreadable expiresAt counts as expired', () => {
  const junk = ['garbage', '2026-13-45', {}, true, false, [], 0, 12345, ['2026-01-01T00:00:00Z'], 'null', ' '];
  for (const value of junk) {
    assert.equal(artifactExpired({ expiresAt: value }), true, `${JSON.stringify(value)} should be expired`);
  }
});

test('no expiry means the artifact never lapses', () => {
  for (const absent of [undefined, null, '']) {
    assert.equal(artifactExpired({ expiresAt: absent }), false, `${String(absent)} should not be expired`);
  }
  assert.equal(artifactExpired({}), false);
});

test('a readable expiresAt is compared against now', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(artifactExpired({ expiresAt: past }), true);
  assert.equal(artifactExpired({ expiresAt: future }), false);
});
