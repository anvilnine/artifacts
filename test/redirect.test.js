// Redirect targets: what is accepted on the way in, and which stored copy the 301 follows.
//
// The resolution rule is here rather than in the smoke suite because it cannot be set up
// through the API: every write fills meta.target, so the fallback path is unreachable from
// outside. The parse rules are covered end to end as well; these tests pin the parts a
// request cannot reach and the exact messages a caller gets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRedirectTarget,
  resolveRedirectTarget,
  pointsAtOwnSlug,
  countRedirectsByKey,
  MAX_REDIRECT_TARGET_LEN,
} from '../lib/redirect.js';

test('an absolute http(s) target normalizes and passes', () => {
  assert.equal(parseRedirectTarget('https://example.com/x'), 'https://example.com/x');
  assert.equal(parseRedirectTarget('  HTTPS://EXAMPLE.COM/Landing?a=1  '), 'https://example.com/Landing?a=1');
  assert.equal(parseRedirectTarget('http://example.com'), 'http://example.com/');
});

test('anything that is not http(s) is a 400', () => {
  for (const bad of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>x</script>',
    'file:///etc/passwd', '//evil.example', '/relative/path', 'not a url', '', '   ', undefined, null, 42,
  ]) {
    assert.throws(() => parseRedirectTarget(bad), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /absolute http:\/\/ or https:\/\/ URL/);
      return true;
    }, `${String(bad)} should be refused`);
  }
});

test('the length cap measures the normalized href, not the input', () => {
  // 342 multi-byte characters make a 362-character input that normalizes to 2072, so measuring
  // the input instead would publish this and then serve 404 for good.
  const short = 'https://example.com/' + 'é'.repeat(342);
  assert.equal(short.length, 362);
  assert.ok(short.length < MAX_REDIRECT_TARGET_LEN);
  assert.equal(new URL(short).href.length, 2072);
  assert.throws(() => parseRedirectTarget(short), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /too long/);
    return true;
  });
  // Both sides of the boundary, so the cap cannot drift by one.
  const atLimit = 'https://example.com/' + 'a'.repeat(MAX_REDIRECT_TARGET_LEN - 20);
  assert.equal(parseRedirectTarget(atLimit).length, MAX_REDIRECT_TARGET_LEN);
  assert.throws(() => parseRedirectTarget(atLimit + 'a'), /too long/);
});

test('credentials are refused on the way in and tolerated on the way out', () => {
  // Expected values are literals, not `new URL(creds).href`: computing them with the same
  // normalizer under test would agree with a broken normalizer.
  for (const [creds, served] of [
    ['https://alice:s3cret@example.com/x', 'https://alice:s3cret@example.com/x'],
    ['https://alice@example.com/x', 'https://alice@example.com/x'],
  ]) {
    assert.throws(() => parseRedirectTarget(creds, { publishing: true }), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /cannot carry a username or password/);
      return true;
    }, `${creds} should be refused at publish`);
    // Serve time keeps working: a target stored before this rule existed still redirects
    // rather than turning into a 404 on upgrade.
    assert.equal(parseRedirectTarget(creds), served);
  }
  // Empty credentials are not credentials: URL drops them, so these are ordinary targets.
  assert.equal(parseRedirectTarget('https://:@example.com/x', { publishing: true }), 'https://example.com/x');
  assert.equal(parseRedirectTarget('https://@example.com/x', { publishing: true }), 'https://example.com/x');
});

test('meta decides the target, and the body is only the fallback', async () => {
  let reads = 0;
  const readSource = async () => { reads++; return Buffer.from('https://example.com/from-bytes'); };

  // meta wins, and the body is not even read
  assert.equal(
    await resolveRedirectTarget({ meta: { target: 'https://example.com/from-meta' }, readSource: readSource }),
    'https://example.com/from-meta',
  );
  assert.equal(reads, 0, 'a normal serve should cost no extra read');

  // no target in meta: fall back to the stored body, which is what keeps a redirect published
  // before this field existed working after an upgrade
  assert.equal(await resolveRedirectTarget({ meta: {}, readSource: readSource }), 'https://example.com/from-bytes');
  assert.equal(reads, 1);

  // an empty string is not a target, so it falls through rather than serving nothing
  assert.equal(await resolveRedirectTarget({ meta: { target: '' }, readSource: readSource }), 'https://example.com/from-bytes');
  assert.equal(await resolveRedirectTarget({ meta: { target: 42 }, readSource: readSource }), 'https://example.com/from-bytes');
});

test('neither copy present is null, which the caller answers as a 404', async () => {
  assert.equal(await resolveRedirectTarget({ meta: {}, readSource: async () => null }), null);
  assert.equal(await resolveRedirectTarget({ meta: undefined, readSource: async () => null }), null);
  // Buffer.alloc(0) is truthy, so a zero-byte body needs its length checked or it comes back
  // as an empty target instead of nothing.
  assert.equal(await resolveRedirectTarget({ meta: {}, readSource: async () => Buffer.alloc(0) }), null);
});

test('a meta.target this build refuses falls through to the body', async () => {
  const readSource = async () => Buffer.from('https://example.com/still-good');
  for (const junk of ['javascript:alert(1)', '/relative', '   ', 'not a url', 'https://example.com/' + 'a'.repeat(MAX_REDIRECT_TARGET_LEN)]) {
    assert.equal(
      await resolveRedirectTarget({ meta: { target: junk }, readSource: readSource }),
      'https://example.com/still-good',
      `meta.target ${JSON.stringify(junk.slice(0, 24))} should fall through, not 404 the slug`,
    );
  }
  // Both unusable is a 404, not a throw.
  assert.equal(await resolveRedirectTarget({ meta: { target: 'javascript:alert(1)' }, readSource: async () => Buffer.from('data:text/html,x') }), null);
});

test('the resolver returns a parsed target, so a caller cannot ship a raw stored value', async () => {
  assert.equal(
    await resolveRedirectTarget({ meta: { target: '  HTTPS://EXAMPLE.COM/X  ' }, readSource: async () => null }),
    'https://example.com/X',
  );
  // CRLF cannot survive: new URL strips it, so no caller can split a header with a stored value.
  const target = await resolveRedirectTarget({ meta: { target: 'https://example.com/x\r\nX-Injected: 1' }, readSource: async () => null });
  assert.doesNotMatch(target, /[\r\n]/);
});

// --- self-referencing targets, and how many redirects a key has published ---

test('a target pointing at its own slug on this server is a self-reference', () => {
  const base = 'https://links.example.com';
  for (const target of [
    'https://links.example.com/a/hop',
    'https://links.example.com/a/hop/',
    'https://links.example.com/a/hop?x=1',
    'https://links.example.com/a/hop#top',
    // express decodes the slug out of the path, so an encoded one reaches the same artifact
    'https://links.example.com/a/%68op',
    // the scheme is not what makes it this server: a proxy terminates TLS and the origin
    // behind it still answers on the other one
    'http://links.example.com/a/hop',
  ]) {
    assert.equal(pointsAtOwnSlug(target, 'hop', base), true, `${target} should be a self-reference`);
  }
});

test('a target that reaches somewhere else is not a self-reference', () => {
  const base = 'https://links.example.com';
  for (const target of [
    'https://links.example.com/a/other', // another slug, which may not even exist
    'https://links.example.com/a/hop/source', // serves the target as text, no loop
    'https://links.example.com/hop', // not an artifact path
    'https://example.com/a/hop', // another host that happens to use the same layout
    'https://links.example.com:8443/a/hop', // another port is another server
    'not a url',
  ]) {
    assert.equal(pointsAtOwnSlug(target, 'hop', base), false, `${target} should pass`);
  }
});

test('a self-reference check with nothing to compare against refuses nothing', () => {
  assert.equal(pointsAtOwnSlug('https://links.example.com/a/hop', 'hop', ''), false);
  assert.equal(pointsAtOwnSlug('https://links.example.com/a/hop', '', 'https://links.example.com'), false);
  assert.equal(pointsAtOwnSlug('https://links.example.com/a/hop', 'hop', 'not a url'), false);
});

test('redirects are counted per key, and nothing else is', () => {
  const counts = countRedirectsByKey([
    { slug: 'a', type: 'redirect', keyId: 'k1' },
    { slug: 'b', type: 'redirect', keyId: 'k1' },
    { slug: 'c', type: 'redirect', keyId: 'k2' },
    { slug: 'd', type: 'html', keyId: 'k1' }, // not a redirect
    { slug: 'e', type: 'redirect' }, // published by the bootstrap key or a session
    { slug: 'f', type: 'redirect', keyId: 42 }, // a hand edit, not a key id
  ]);
  assert.equal(counts.get('k1'), 2);
  assert.equal(counts.get('k2'), 1);
  assert.equal(counts.get('k3'), undefined);
  assert.equal(counts.size, 2);
});
