// The operator's own console reads the branding block, the same way every viewer-facing shell
// already does.
//
// The first test is the one that matters: with nothing configured, the page is byte for byte the
// page that shipped, so a self-host that never sets branding sees no change at all. The rest
// check that one configured value reaches the surface it belongs to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fillShell } from '../lib/shells.js';
import { dashboardBrandSlots, dashboardFavicon } from '../lib/branding.js';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
const FIXTURE = readFileSync(join(here, 'fixtures', 'dashboard-default.html'), 'utf8');

const NONE = { productName: '', logoUrl: '', faviconUrl: '', accentColor: '', footerText: '' };
const brand = (over) => ({ ...NONE, ...over });
const render = (b) => fillShell(PAGE, dashboardBrandSlots(b));

test('an unbranded dashboard is byte for byte the page that shipped', () => {
  assert.equal(render(NONE), FIXTURE);
});

test('the rendered page never leaves a slot behind', () => {
  for (const b of [NONE, brand({ productName: 'Dropkiln', logoUrl: '/l.png', faviconUrl: '/f.png', accentColor: '#0055ff' })]) {
    assert.doesNotMatch(render(b), /\{\{[A-Z_]+\}\}/);
  }
});

test('a product name becomes the tab title, the lock heading and the wordmark', () => {
  const html = render(brand({ productName: 'Dropkiln' }));
  assert.match(html, /<title>Dropkiln<\/title>/);
  assert.match(html, /<h1>Dropkiln<\/h1>/);
  assert.match(html, /<span class="wordmark">Dropkiln<\/span>/);
  assert.doesNotMatch(html, /<title>artifacts<\/title>/);
});

test('a product name is escaped, never dropped into the page raw', () => {
  const html = render(brand({ productName: 'A&B' }));
  assert.match(html, /<title>A&amp;B<\/title>/);
  assert.doesNotMatch(html, /<title>A&B<\/title>/);
});

test('a logo replaces both anvil marks and gets a size rule so it is not squashed', () => {
  const html = render(brand({ logoUrl: '/a/brand/logo.png' }));
  const imgs = html.match(/<img class="mark" src="\/a\/brand\/logo\.png" alt="">/g) || [];
  assert.equal(imgs.length, 2, 'the lock card and the header both take the logo');
  assert.doesNotMatch(html, /<svg class="mark"/);
  assert.match(html, /img\.mark \{[^}]*object-fit: contain/);
});

test('a favicon becomes a link tag, and no favicon leaves the head alone', () => {
  assert.match(render(brand({ faviconUrl: '/f.png' })), /<link rel="icon" href="\/f\.png">/);
  assert.doesNotMatch(render(NONE), /rel="icon"/);
});

test('one accent takes over every accent role the console has', () => {
  const html = render(brand({ accentColor: '#0055ff' }));
  assert.match(html, /--molten: #0055ff;/);
  assert.match(html, /--rose: color-mix\(in srgb, #0055ff 70%, white\);/);
  assert.match(html, /--rose-tint: color-mix\(in srgb, #0055ff 14%, transparent\);/);
  assert.match(html, /--molten-deep: color-mix\(in srgb, #0055ff 80%, black\);/);
});

// The button and the checkbox glyph both draw in --espresso on a --molten fill. --espresso is
// #0b0d0f, which reads 1.00:1 on a near-black accent: an invisible label on a valid color.
test('the button label follows the accent instead of staying forge-dark', () => {
  const dark = render(brand({ accentColor: '#101010' }));
  assert.match(dark, /button \{ color: #ffffff; \}/);
  const light = render(brand({ accentColor: '#ffdd00' }));
  assert.match(light, /button \{ color: #0b0d0f; \}/);
});

test('nothing configured adds no style block at all', () => {
  assert.equal(dashboardBrandSlots(NONE).BRAND_STYLE, '');
});

// ---------------------------------------------------------------------------
// /favicon.ico, which anything can ask for without reading the page's head first
// ---------------------------------------------------------------------------

test('no branded favicon keeps the empty answer the route has always given', () => {
  assert.equal(dashboardFavicon(NONE), null);
});

test('a path favicon is a redirect, and it cannot leave this origin', () => {
  assert.deepEqual(dashboardFavicon(brand({ faviconUrl: '/a/brand/f.png' })), {
    redirect: '/a/brand/f.png',
  });
});

test('an inline favicon is decoded and served as its own type', () => {
  const png = Buffer.from('hello favicon');
  const got = dashboardFavicon(brand({ faviconUrl: `data:image/png;base64,${png.toString('base64')}` }));
  assert.equal(got.contentType, 'image/png');
  assert.equal(got.body.toString(), 'hello favicon');
});

test('anything the parser would not have accepted answers empty rather than guessing', () => {
  assert.equal(dashboardFavicon(brand({ faviconUrl: 'data:image/svg+xml;base64,AAAA' })), null);
  assert.equal(dashboardFavicon(brand({ faviconUrl: 'https://cdn.example.com/f.png' })), null);
});
