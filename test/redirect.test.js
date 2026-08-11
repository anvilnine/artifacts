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
  // 342 multi-byte characters are 356 characters in and well past 2048 once percent-encoded.
  // Measuring the input would publish this and then serve 404 for good.
  const short = 'https://example.com/' + 'é'.repeat(342);
  assert.ok(short.length < MAX_REDIRECT_TARGET_LEN);
  assert.throws(() => parseRedirectTarget(short), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /too long/);
    return true;
  });
  const atLimit = 'https://example.com/' + 'a'.repeat(MAX_REDIRECT_TARGET_LEN - 20);
  assert.equal(parseRedirectTarget(atLimit).length, MAX_REDIRECT_TARGET_LEN);
});

test('credentials are refused on the way in and tolerated on the way out', () => {
  for (const creds of ['https://alice:s3cret@example.com/x', 'https://alice@example.com/x']) {
    assert.throws(() => parseRedirectTarget(creds, { publishing: true }), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /cannot carry a username or password/);
      return true;
    }, `${creds} should be refused at publish`);
    // Serve time keeps working: a target stored before this rule existed still redirects
    // rather than turning into a 404 on upgrade.
    assert.equal(parseRedirectTarget(creds), new URL(creds).href);
  }
});

test('meta decides the target, and the body is only the fallback', async () => {
  let reads = 0;
  const readSource = async () => { reads++; return Buffer.from('https://example.com/from-bytes'); };

  // meta wins, and the body is not even read
  assert.equal(
    await resolveRedirectTarget({ target: 'https://example.com/from-meta' }, readSource),
    'https://example.com/from-meta',
  );
  assert.equal(reads, 0, 'a normal serve should cost no extra read');

  // no target in meta: fall back to the stored body, which is what keeps a redirect published
  // before this field existed working after an upgrade
  assert.equal(await resolveRedirectTarget({}, readSource), 'https://example.com/from-bytes');
  assert.equal(reads, 1);

  // an empty string is not a target, so it falls through rather than serving nothing
  assert.equal(await resolveRedirectTarget({ target: '' }, readSource), 'https://example.com/from-bytes');
  assert.equal(await resolveRedirectTarget({ target: 42 }, readSource), 'https://example.com/from-bytes');
});

test('neither copy present is null, which the caller answers as a 404', async () => {
  assert.equal(await resolveRedirectTarget({}, async () => null), null);
  assert.equal(await resolveRedirectTarget(undefined, async () => null), null);
  // Buffer.alloc(0) is truthy, so a zero-byte body needs its length checked or it comes back
  // as an empty target instead of nothing.
  assert.equal(await resolveRedirectTarget({}, async () => Buffer.alloc(0)), null);
});

test('a meta.target this build refuses falls through to the body', async () => {
  const readSource = async () => Buffer.from('https://example.com/still-good');
  for (const junk of ['javascript:alert(1)', '/relative', '   ', 'not a url', 'https://example.com/' + 'a'.repeat(MAX_REDIRECT_TARGET_LEN)]) {
    assert.equal(
      await resolveRedirectTarget({ target: junk }, readSource),
      'https://example.com/still-good',
      `meta.target ${JSON.stringify(junk.slice(0, 24))} should fall through, not 404 the slug`,
    );
  }
  // Both unusable is a 404, not a throw.
  assert.equal(await resolveRedirectTarget({ target: 'javascript:alert(1)' }, async () => Buffer.from('data:text/html,x')), null);
});

test('the resolver returns a parsed target, so a caller cannot ship a raw stored value', async () => {
  assert.equal(
    await resolveRedirectTarget({ target: '  HTTPS://EXAMPLE.COM/X  ' }, async () => null),
    'https://example.com/X',
  );
  // CRLF cannot survive: new URL strips it, so no caller can split a header with a stored value.
  const target = await resolveRedirectTarget({ target: 'https://example.com/x\r\nX-Injected: 1' }, async () => null);
  assert.doesNotMatch(target, /[\r\n]/);
});
