// What each shell gets handed for its branding slots.
//
// The first test in every pair is the one that matters: with nothing configured, each slot holds
// the literal that used to sit in the shell file, so the rendered page is byte for byte what it
// was. The second checks that one configured value reaches every slot that should follow it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameBrandSlots,
  jsxBrandSlots,
  mdBrandSlots,
  notFoundBrandSlots,
  passwordBrandSlots,
} from '../lib/branding.js';

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

test('nothing configured keeps the wording the shells shipped with', () => {
  assert.equal(passwordBrandSlots(NONE).PRODUCT_NOUN, 'artifact');
  assert.equal(notFoundBrandSlots(NONE).PRODUCT_NAME, 'Artifact');
});

test('a product name replaces the built-in wording exactly as it was typed', () => {
  const b = brand({ productName: 'Dropkiln' });
  assert.equal(passwordBrandSlots(b).PRODUCT_NOUN, 'Dropkiln');
  assert.equal(notFoundBrandSlots(b).PRODUCT_NAME, 'Dropkiln');
  assert.match(frameBrandSlots(b).BRAND, /Dropkiln/);
  assert.match(frameBrandSlots(b).BRAND_STYLE, /#brand/);
});

test('one accent color takes over every accent role, translucent ones included', () => {
  const b = brand({ accentColor: '#0055ff' });
  const pw = passwordBrandSlots(b);
  assert.equal(pw.ACCENT, '#0055ff');
  assert.equal(pw.ACCENT_DARK, '#0055ff');
  assert.equal(pw.BTN_BG, '#0055ff');
  assert.equal(pw.GLOW, 'color-mix(in srgb, #0055ff 8%, transparent)');
  assert.equal(pw.BTN_SHADOW, 'color-mix(in srgb, #0055ff 35%, transparent)');
  // The error red says "this failed", not "this is our brand", so it stays put.
  assert.equal(pw.ERROR, '#c4573e');

  const md = mdBrandSlots(b);
  assert.equal(md.LINK, '#0055ff');
  assert.equal(md.CODE_DARK, '#0055ff');
  assert.equal(md.QUOTE_BORDER, '#0055ff');
  assert.equal(notFoundBrandSlots(b).ACCENT_DARK, '#0055ff');
});

test('a favicon renders one link tag on every shell', () => {
  const b = brand({ faviconUrl: '/brand/f.ico' });
  for (const slots of [frameBrandSlots(b), passwordBrandSlots(b), notFoundBrandSlots(b), mdBrandSlots(b), jsxBrandSlots(b)]) {
    assert.equal(slots.FAVICON, '\n<link rel="icon" href="/brand/f.ico">');
  }
});

test('a logo replaces the built-in mark and rides in the frame bar', () => {
  const b = brand({ logoUrl: 'https://cdn.example.com/l.svg' });
  assert.match(notFoundBrandSlots(b).MARK, /^<img class="mark" src="https:\/\/cdn\.example\.com\/l\.svg"/);
  assert.match(passwordBrandSlots(b).LOGO, /<img class="brandmark"/);
  assert.match(frameBrandSlots(b).BRAND, /<img/);
});

test('a footer line renders under the two chrome pages', () => {
  const b = brand({ footerText: 'Published with Dropkiln' });
  assert.match(passwordBrandSlots(b).FOOTER, /Published with Dropkiln/);
  assert.match(notFoundBrandSlots(b).FOOTER, /Published with Dropkiln/);
});

test('branding text is escaped on the way into the page', () => {
  const b = brand({ productName: 'A & B', footerText: 'x " y & z' });
  assert.match(notFoundBrandSlots(b).PRODUCT_NAME, /A &amp; B/);
  assert.match(passwordBrandSlots(b).FOOTER, /x &quot; y &amp; z/);
});

test('the frame tooltip and the jsx error label follow the product name', () => {
  assert.equal(frameBrandSlots(NONE).PRODUCT_NOUN, 'artifact');
  assert.equal(jsxBrandSlots(NONE).ERROR_LABEL, "'Artifact error: '");

  const b = brand({ productName: 'Dropkiln' });
  assert.equal(frameBrandSlots(b).PRODUCT_NOUN, 'Dropkiln');
  assert.equal(jsxBrandSlots(b).ERROR_LABEL, '"Dropkiln error: "');
});

test('the jsx error label survives a quote in the product name', () => {
  // It lands inside a script, so it is JSON-quoted rather than HTML-escaped: an &amp; would
  // show up as literal text in the readout.
  assert.equal(jsxBrandSlots(brand({ productName: "O'Brien" })).ERROR_LABEL, '"O\'Brien error: "');
});
