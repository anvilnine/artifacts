// What each shell gets handed for its branding slots.
//
// The first test in every pair is the one that matters: with nothing configured, each slot holds
// the literal that used to sit in the shell file, so the rendered page is byte for byte what it
// was. The second checks that one configured value reaches every slot that should follow it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  frameBrandSlots,
  jsxBrandSlots,
  mdBrandSlots,
  notFoundBrandSlots,
  passwordBrandSlots,
} from '../lib/branding.js';

const here = dirname(fileURLToPath(import.meta.url));
const shellText = (name) => readFileSync(join(here, '..', 'shells', `${name}.html`), 'utf8');

const NONE = { productName: '', logoUrl: '', faviconUrl: '', accentColor: '', footerText: '' };
const brand = (over) => ({ ...NONE, ...over });

test('nothing configured leaves every optional slot empty', () => {
  for (const slots of [
    frameBrandSlots(NONE),
    passwordBrandSlots(NONE),
    notFoundBrandSlots(NONE),
    mdBrandSlots(NONE),
    jsxBrandSlots(NONE),
  ]) {
    assert.equal(slots.FAVICON, '');
    if ('BRAND_STYLE' in slots) assert.equal(slots.BRAND_STYLE, '');
    if ('FOOTER' in slots) assert.equal(slots.FOOTER, '');
    if ('LOGO' in slots) assert.equal(slots.LOGO, '');
    if ('BRAND' in slots) assert.equal(slots.BRAND, '');
  }
});

test('nothing configured keeps the colors the shells shipped with', () => {
  const pw = passwordBrandSlots(NONE);
  assert.equal(pw.ACCENT, '#c73d1d');
  assert.equal(pw.ACCENT_DARK, '#ff7550');
  assert.equal(pw.ERROR, '#c4573e');
  assert.equal(pw.ERROR_DARK, '#e08a72');
  assert.equal(pw.GLOW, 'rgba(240, 80, 42, .08)');
  assert.equal(pw.BTN_BG, '#f0502a');
  assert.equal(pw.BTN_HOVER, '#ff7550');
  assert.equal(pw.BTN_SHADOW, 'rgba(240, 80, 42, .35)');

  const nf = notFoundBrandSlots(NONE);
  assert.equal(nf.ACCENT, '#c73d1d');
  assert.equal(nf.ACCENT_DARK, '#f0502a');
  assert.equal(nf.GLOW, 'rgba(240, 80, 42, .08)');
  assert.match(nf.MARK, /^<svg class="mark"/);

  const md = mdBrandSlots(NONE);
  assert.equal(md.LINK, '#c73d1d');
  assert.equal(md.LINK_DARK, '#ff7550');
  assert.equal(md.CODE, '#7c2413');
  assert.equal(md.CODE_DARK, '#ff9d80');
  assert.equal(md.QUOTE_BORDER, '#2ba3cc');

  assert.equal(jsxBrandSlots(NONE).ERROR, '#c4573e');
});

// A product name names the product, not the thing the product publishes. "Dropkiln unavailable"
// on a dead link reads as "the service is down", and "This Dropkiln is password protected" is not
// a sentence. The noun stays `artifact` and the brand goes where a brand belongs.
test('a product name never becomes the noun for a published item', () => {
  const b = brand({ productName: 'Dropkiln' });
  for (const slots of [passwordBrandSlots, notFoundBrandSlots, frameBrandSlots]) {
    assert.ok(!('PRODUCT_NOUN' in slots(b)), 'PRODUCT_NOUN is gone');
    assert.ok(!('PRODUCT_NAME' in slots(b)), 'PRODUCT_NAME is gone');
  }
  for (const name of ['password', 'not-found', 'frame']) {
    assert.ok(!shellText(name).includes('{{PRODUCT_'), `${name}.html still has a product-name slot`);
  }
  assert.match(shellText('not-found'), /<h1>Artifact unavailable<\/h1>/);
  assert.match(shellText('password'), /<h1>Protected artifact<\/h1>/);
});

test('a product name reaches the frame chip and nothing else on the frame', () => {
  const b = brand({ productName: 'Dropkiln' });
  assert.match(frameBrandSlots(b).BRAND, /Dropkiln/);
  assert.match(frameBrandSlots(b).BRAND_STYLE, /#brand/);
});

test('one accent color takes over every accent role, translucent ones included', () => {
  const b = brand({ accentColor: '#0055ff' });
  const pw = passwordBrandSlots(b);
  assert.equal(pw.ACCENT, '#0055ff');
  assert.equal(pw.BTN_BG, '#0055ff');
  assert.equal(pw.GLOW, 'color-mix(in srgb, #0055ff 8%, transparent)');
  assert.equal(pw.BTN_SHADOW, 'color-mix(in srgb, #0055ff 35%, transparent)');
  // The error red says "this failed", not "this is our brand", so it stays put.
  assert.equal(pw.ERROR, '#c4573e');

  const md = mdBrandSlots(b);
  assert.equal(md.LINK, '#0055ff');
  assert.equal(md.QUOTE_BORDER, '#0055ff');
});

// Every shell carries a light/dark pair for its accent because a pair is needed: #1d4ed8 reads
// 6.70:1 on white and 2.90:1 on the #0b0d0f dark card. Reusing one value for both slots means no
// value works in both themes, so the dark slot is lightened off the same accent.
test('the dark slots lighten the accent instead of reusing it', () => {
  const b = brand({ accentColor: '#1d4ed8' });
  const lighter = 'color-mix(in srgb, #1d4ed8 70%, white)';
  assert.equal(passwordBrandSlots(b).ACCENT_DARK, lighter);
  assert.equal(notFoundBrandSlots(b).ACCENT_DARK, lighter);
  const md = mdBrandSlots(b);
  assert.equal(md.LINK_DARK, lighter);
  assert.equal(md.CODE_DARK, lighter);
});

// #f0502a reads 5.46:1 against the hardcoded #0b0d0f label, so the default passes. #1d4ed8 reads
// 2.90:1 and #0b0d0f against itself reads 1.00:1, an invisible label on a perfectly valid accent.
test('the unlock button picks a label that reads on the accent', () => {
  assert.equal(passwordBrandSlots(NONE).BTN_FG, '#0b0d0f');
  assert.equal(passwordBrandSlots(brand({ accentColor: '#ffe600' })).BTN_FG, '#0b0d0f');
  assert.equal(passwordBrandSlots(brand({ accentColor: '#1d4ed8' })).BTN_FG, '#ffffff');
  assert.equal(passwordBrandSlots(brand({ accentColor: '#0b0d0f' })).BTN_FG, '#ffffff');
  assert.equal(passwordBrandSlots(brand({ accentColor: 'hsl(220 90% 30%)' })).BTN_FG, '#ffffff');
});

// BTN_BG and BTN_HOVER both returned the accent, so hovering the button changed nothing but the
// shadow. The shell shipped with a visibly lighter hover and it should keep one.
test('the unlock button keeps a hover that differs from its background', () => {
  const pw = passwordBrandSlots(brand({ accentColor: '#1d4ed8' }));
  assert.notEqual(pw.BTN_HOVER, pw.BTN_BG);
  assert.equal(pw.BTN_HOVER, 'color-mix(in srgb, #1d4ed8 80%, white)');
});

test('a favicon renders one link tag on every shell', () => {
  const b = brand({ faviconUrl: '/brand/f.ico' });
  for (const slots of [frameBrandSlots(b), passwordBrandSlots(b), notFoundBrandSlots(b), mdBrandSlots(b), jsxBrandSlots(b)]) {
    assert.equal(slots.FAVICON, '\n<link rel="icon" href="/brand/f.ico">');
  }
});

test('a logo replaces the built-in mark and rides in the frame bar', () => {
  const b = brand({ logoUrl: '/a/brand/l.png' });
  assert.match(notFoundBrandSlots(b).MARK, /^<img class="mark" src="\/a\/brand\/l\.png"/);
  assert.match(passwordBrandSlots(b).LOGO, /<img class="brandmark"/);
  assert.match(frameBrandSlots(b).BRAND, /<img/);
});

// A 600x60 wordmark is an ordinary input. With height set and width auto it renders 10x its
// height, which at a 390px viewport pushed the frame's own buttons off screen and squeezed the
// artifact title to nothing.
test('every brand logo is capped so a wide wordmark cannot push the page sideways', () => {
  const b = brand({ logoUrl: '/a/brand/l.png' });
  for (const style of [
    frameBrandSlots(b).BRAND_STYLE,
    passwordBrandSlots(b).BRAND_STYLE,
    notFoundBrandSlots(b).BRAND_STYLE,
  ]) {
    assert.match(style, /max-width:/);
    assert.match(style, /object-fit: contain/);
  }
});

// Three strings in the bar with no hierarchy, and #brand refuses to shrink, so at 390px the
// operator's wordmark keeps every pixel and the viewer's document title truncates.
test('the frame bar drops the product name when a logo is there to carry the brand', () => {
  const both = frameBrandSlots(brand({ productName: 'Dropkiln', logoUrl: '/a/brand/l.png' }));
  assert.match(both.BRAND, /<img/);
  assert.ok(!both.BRAND.includes('Dropkiln'), 'the name repeats the logo');

  const nameOnly = frameBrandSlots(brand({ productName: 'Dropkiln' }));
  assert.match(nameOnly.BRAND, /Dropkiln/);
  assert.match(nameOnly.BRAND_STYLE, /@media \(max-width: 560px\)/);
});

test('a footer line renders under the two chrome pages', () => {
  const b = brand({ footerText: 'Published with Dropkiln' });
  assert.match(passwordBrandSlots(b).FOOTER, /Published with Dropkiln/);
  assert.match(notFoundBrandSlots(b).FOOTER, /Published with Dropkiln/);
});

// Both cards align everything else left, so the footer should not be centered on one of them.
test('the footer aligns the same way on both chrome pages', () => {
  const b = brand({ footerText: 'Published with Dropkiln' });
  assert.ok(!passwordBrandSlots(b).BRAND_STYLE.includes('text-align: center'));
  assert.ok(!notFoundBrandSlots(b).BRAND_STYLE.includes('text-align: center'));
});

// The 404's description is styled by `p:last-child`. Appending the footer paragraph after it
// takes that rule away: 14px goes to 16px, muted goes to full foreground, and the copy rewraps.
test('a footer does not restyle the 404 description', () => {
  const style = notFoundBrandSlots(brand({ footerText: 'Published with Dropkiln' })).BRAND_STYLE;
  assert.match(style, /font-size: 14px/);
  assert.match(style, /color: var\(--muted\)/);
  assert.match(style, /line-height: 1\.55/);
});

test('branding text is escaped on the way into the page', () => {
  const b = brand({ productName: 'A & B', footerText: 'x " y & z' });
  assert.match(frameBrandSlots(b).BRAND, /A &amp; B/);
  assert.match(passwordBrandSlots(b).FOOTER, /x &quot; y &amp; z/);
});

test('the jsx error label follows the product name', () => {
  assert.equal(jsxBrandSlots(NONE).ERROR_LABEL, "'Artifact error: '");
  assert.equal(jsxBrandSlots(brand({ productName: 'Dropkiln' })).ERROR_LABEL, '"Dropkiln error: "');
});

test('the jsx error label survives a quote in the product name', () => {
  // It lands inside a script, so it is JSON-quoted rather than HTML-escaped: an &amp; would
  // show up as literal text in the readout.
  assert.equal(jsxBrandSlots(brand({ productName: "O'Brien" })).ERROR_LABEL, '"O\'Brien error: "');
});
