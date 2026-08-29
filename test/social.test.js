// Link-preview metadata: what the two parsers accept and refuse, and what the tag renderer
// puts in a head. Both halves are pure, so nothing here needs a running instance.
//
// The tag renderer is the half worth testing here rather than over HTTP: an assertion on a
// served page has to fish one line out of a whole document, and the escaping cases below would
// each need their own publish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DESCRIPTION_LEN,
  MAX_OG_IMAGE_LEN,
  dropIfRefused,
  parseDescription,
  parseOgImage,
  socialTags,
} from '../lib/social.js';

const CANONICAL = 'https://artifacts.example.com/a/ci-social';

test('a description collapses whitespace and survives the round trip', () => {
  assert.equal(parseDescription('  what   this page is  '), 'what this page is');
  assert.equal(parseDescription('two\nlines'), 'two lines');
  assert.equal(parseDescription(''), '');
  assert.equal(parseDescription(null), '');
});

test('a description is capped after collapsing, not before', () => {
  const long = 'x'.repeat(MAX_DESCRIPTION_LEN + 1);
  assert.throws(() => parseDescription(long), { status: 400 });
  // The case that separates the two rules: 597 chars in, 299 once the runs of whitespace
  // collapse. A build that measured the input would refuse this one.
  const padded = `${'a   '.repeat(149)}b`;
  assert.ok(padded.length > MAX_DESCRIPTION_LEN, 'the input has to be over the cap to prove this');
  assert.equal(parseDescription(padded), `${'a '.repeat(149)}b`);
  // Exactly at the cap passes, and padding that collapses away does not push it over.
  const atCap = 'y'.repeat(MAX_DESCRIPTION_LEN);
  assert.equal(parseDescription(atCap).length, MAX_DESCRIPTION_LEN);
  assert.equal(parseDescription(`  ${atCap}  `).length, MAX_DESCRIPTION_LEN);
  const spaced = `${'z'.repeat(MAX_DESCRIPTION_LEN)}${'\n'.repeat(50)}`;
  assert.equal(parseDescription(spaced).length, MAX_DESCRIPTION_LEN);
});

test('a description must be a string', () => {
  for (const bad of [5, true, {}, ['a']]) {
    assert.throws(() => parseDescription(bad), { status: 400 });
  }
});

test('an og image must be an absolute http(s) URL and normalizes', () => {
  assert.equal(parseOgImage('https://EXAMPLE.com/a.png'), 'https://example.com/a.png');
  assert.equal(parseOgImage('http://example.com'), 'http://example.com/');
  assert.equal(parseOgImage('  https://example.com/b.png  '), 'https://example.com/b.png');
  assert.equal(parseOgImage(''), '');
  assert.equal(parseOgImage(null), '');
  for (const bad of [
    '/preview.png',
    '//example.com/preview.png',
    'preview.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.throws(() => parseOgImage(bad), { status: 400 }, `accepted ${bad}`);
  }
});

test('an og image cannot carry credentials, the way a redirect target cannot', () => {
  assert.throws(() => parseOgImage('https://alice:s3cret@example.com/a.png'), { status: 400 });
  assert.throws(() => parseOgImage('https://alice@example.com/a.png'), { status: 400 });
});

test('the og image cap measures the normalized href, not the input', () => {
  // One multi-byte char percent-encodes to 9 bytes, so an input under the cap can normalize over
  // it. Measuring the input would store a URL longer than the field allows.
  const padding = 'a'.repeat(MAX_OG_IMAGE_LEN - 40);
  const input = `https://example.com/${padding}${'é'.repeat(10)}.png`;
  assert.ok(input.length <= MAX_OG_IMAGE_LEN, 'the input has to be under the cap to prove this');
  assert.ok(new URL(input).href.length > MAX_OG_IMAGE_LEN, 'and the normalized href over it');
  assert.throws(() => parseOgImage(input), { status: 400 });
});

test('a stored value this build refuses is dropped rather than thrown on', () => {
  // Only reachable for meta an older build or a hand edit wrote, which is why it has no HTTP case.
  assert.equal(dropIfRefused(parseOgImage, '/relative.png'), '');
  assert.equal(dropIfRefused(parseDescription, 'x'.repeat(MAX_DESCRIPTION_LEN + 1)), '');
  // A value this build accepts survives, and an absent one stays absent.
  assert.equal(dropIfRefused(parseOgImage, 'https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(dropIfRefused(parseDescription, undefined), undefined);
});

test('the tags name the canonical url and fall back to the slug for a title', () => {
  const tags = socialTags({ slug: 'ci-social' }, CANONICAL);
  assert.match(tags, /<meta property="og:title" content="ci-social">/);
  assert.match(tags, new RegExp(`<meta property="og:url" content="${CANONICAL}">`));
  assert.match(tags, /<meta property="og:type" content="website">/);
  // No description set, so neither description tag is written at all.
  assert.doesNotMatch(tags, /name="description"/);
  assert.doesNotMatch(tags, /og:description/);
  assert.doesNotMatch(tags, /og:image/);
});

test('a description writes both the plain and the og tag', () => {
  const tags = socialTags({ slug: 'ci-social', description: 'a page about pages' }, CANONICAL);
  assert.match(tags, /<meta name="description" content="a page about pages">/);
  assert.match(tags, /<meta property="og:description" content="a page about pages">/);
});

test('the card type follows whether there is an image', () => {
  const withImage = socialTags(
    { slug: 'ci-social', ogImage: 'https://example.com/p.png' },
    CANONICAL,
  );
  assert.match(withImage, /<meta property="og:image" content="https:\/\/example\.com\/p\.png">/);
  assert.match(withImage, /twitter:card" content="summary_large_image"/);
  const without = socialTags({ slug: 'ci-social' }, CANONICAL);
  assert.match(without, /twitter:card" content="summary"/);
});

test('a title, a description and an image cannot break out of the attribute', () => {
  const tags = socialTags(
    {
      slug: 'ci-social',
      title: '"><script>alert(1)</script>',
      description: 'ends with " and <b>markup</b>',
      ogImage: 'https://example.com/a.png?q="><script>x</script>',
    },
    'https://artifacts.example.com/a/ci-social?"><script>y</script>',
  );
  assert.doesNotMatch(tags, /<script>/);
  assert.doesNotMatch(tags, /<b>/);
  // Every quote inside a value is entity-escaped, so each line is still one whole tag with two
  // attributes and nothing hanging off the end.
  for (const line of tags.split('\n')) {
    assert.match(line, /^<meta (name|property)="[a-z:_]+" content="[^"<>]*">$/, `broke out: ${line}`);
  }
});

// --- branding in the share-link tags ---
// The 404, password and md pages are what a person sees; these tags are what Slack, Discord and
// X see, and they were the one viewer-facing surface with no branding hook at all.

test('no branding leaves the tags exactly as they were', () => {
  const meta = { slug: 'ci-social', title: 'A page' };
  assert.equal(socialTags(meta, CANONICAL, { siteName: '', image: '' }), socialTags(meta, CANONICAL));
});

test('a product name renders og:site_name', () => {
  const tags = socialTags({ slug: 'ci-social' }, CANONICAL, { siteName: 'Dropkiln', image: '' });
  assert.match(tags, /<meta property="og:site_name" content="Dropkiln">/);
});

test('the brand logo is the preview image only when the artifact sets none', () => {
  const brand = { siteName: '', image: 'https://cdn.example.com/logo.png' };
  const fallback = socialTags({ slug: 'ci-social' }, CANONICAL, brand);
  assert.match(fallback, /<meta property="og:image" content="https:\/\/cdn\.example\.com\/logo\.png">/);
  assert.match(fallback, /twitter:card" content="summary_large_image"/);

  const own = socialTags({ slug: 'ci-social', ogImage: 'https://example.com/own.png' }, CANONICAL, brand);
  assert.match(own, /content="https:\/\/example\.com\/own\.png"/);
  assert.doesNotMatch(own, /logo\.png/);
});

test('a site name is escaped on the way into the tag', () => {
  const tags = socialTags({ slug: 'ci-social' }, CANONICAL, { siteName: 'A & "B"', image: '' });
  assert.match(tags, /content="A &amp; &quot;B&quot;">/);
});
