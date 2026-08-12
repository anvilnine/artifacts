// When an artifact has lapsed.
//
// This is here rather than in the smoke suite because the API cannot produce the records that
// matter: parseExpiresAt refuses anything that is not an ISO string on the way in, so a junk
// expiresAt only ever arrives from a hand-edited or restored meta.json. These tests pin what
// each shape means before Date.parse gets a say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactExpired } from '../lib/expiry.js';

test('an unreadable expiresAt counts as expired', () => {
  for (const junk of ['garbage', '2026-13-45', {}, true, [], 'null', ' ']) {
    assert.equal(artifactExpired({ expiresAt: junk }), true, `${JSON.stringify(junk)} should be expired`);
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
