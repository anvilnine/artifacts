// The branding block on the config endpoint: what it accepts, what it refuses, and the
// promise that an untouched instance keeps rendering exactly what it rendered before.
//
// The refusals matter more than the accepts. Every one of these values lands in HTML a
// viewer loads, and accentColor lands inside a <style> block, where a stray brace ends
// the rule and starts whatever the caller wrote next.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigStore } from '../lib/config.js';
import {
  MAX_BRAND_URL_LEN,
  brandingErrorField,
  brandingPatchFromFlags,
  parseAccentColor,
  parseBrandUrl,
  parseFooterText,
  parseProductName,
} from '../lib/branding.js';

function memStorage() {
  const files = new Map();
  return {
    files,
    async getBuffer(key) {
      const v = files.get(key);
      return v === undefined ? null : Buffer.from(v);
    },
    async put(key, body) {
      files.set(key, typeof body === 'string' ? body : body.toString('utf8'));
    },
  };
}

async function rejects(fn, field) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.status, 400, `expected 400, got ${err.status}`);
    assert.match(err.message, new RegExp(field.replace('.', '\\.')));
    return true;
  });
}

test('a fresh instance reports an empty branding block', async () => {
  const config = await createConfigStore(memStorage());
  assert.deepEqual(config.current.branding, {
    productName: '',
    logoUrl: '',
    faviconUrl: '',
    accentColor: '',
    footerText: '',
  });
});

test('a full branding block round-trips and persists', async () => {
  const storage = memStorage();
  const config = await createConfigStore(storage);
  const updated = await config.update({
    branding: {
      productName: 'Dropkiln',
      logoUrl: '/a/brand/logo.png',
      faviconUrl: '/favicon.ico',
      accentColor: '#0055ff',
      footerText: 'Published with Dropkiln',
    },
  });
  assert.equal(updated.branding.productName, 'Dropkiln');
  assert.equal(updated.branding.logoUrl, '/a/brand/logo.png');
  assert.equal(updated.branding.faviconUrl, '/favicon.ico');
  assert.equal(config.current.branding.accentColor, '#0055ff');

  const reloaded = await createConfigStore(storage);
  assert.equal(reloaded.current.branding.footerText, 'Published with Dropkiln');
});

test('branding merges per field and leaves frame and md alone', async () => {
  const config = await createConfigStore(memStorage());
  await config.update({ branding: { productName: 'Dropkiln' } });
  const after = await config.update({ branding: { accentColor: '#0055ff' } });
  assert.equal(after.branding.productName, 'Dropkiln');
  assert.equal(after.branding.accentColor, '#0055ff');
  assert.equal(after.frame.enabled, true);
  assert.equal(after.md.font, 'system');
});

test('an empty string clears a branding field back to the built-in look', async () => {
  const config = await createConfigStore(memStorage());
  await config.update({ branding: { productName: 'Dropkiln' } });
  const after = await config.update({ branding: { productName: '' } });
  assert.equal(after.branding.productName, '');
});

test('the update route refuses every bad branding value with a 400 naming the field', async () => {
  const config = await createConfigStore(memStorage());
  await rejects(() => config.update({ branding: { productName: '<b>hi</b>' } }), 'branding.productName');
  await rejects(() => config.update({ branding: { productName: 'x'.repeat(41) } }), 'branding.productName');
  await rejects(() => config.update({ branding: { productName: 42 } }), 'branding.productName');
  await rejects(() => config.update({ branding: { logoUrl: 'javascript:alert(1)' } }), 'branding.logoUrl');
  await rejects(() => config.update({ branding: { faviconUrl: '//evil.example.com/f.ico' } }), 'branding.faviconUrl');
  await rejects(() => config.update({ branding: { accentColor: 'red; } body { display: none' } }), 'branding.accentColor');
  await rejects(() => config.update({ branding: { footerText: 'x'.repeat(161) } }), 'branding.footerText');
  await rejects(() => config.update({ branding: { footerText: '<script>x</script>' } }), 'branding.footerText');
});

test('a bad value in a hand-edited config.json falls back to the default, field by field', async () => {
  const storage = memStorage();
  await storage.put('config.json', JSON.stringify({
    branding: { productName: 'Dropkiln', accentColor: 'not-a-color', logoUrl: 'javascript:alert(1)' },
  }));
  const config = await createConfigStore(storage);
  assert.equal(config.current.branding.productName, 'Dropkiln');
  assert.equal(config.current.branding.accentColor, '');
  assert.equal(config.current.branding.logoUrl, '');
});

test('productName keeps plain text and trims it', () => {
  assert.equal(parseProductName('  Dropkiln  '), 'Dropkiln');
  assert.equal(parseProductName('Acme & Co'), 'Acme & Co');
  assert.equal(parseProductName(null), '');
  assert.equal(parseProductName(''), '');
});

// A brand asset is same-origin or inline. The chrome pages carry `img-src 'self' data:`, so an
// absolute URL used to be accepted here and then refused by the viewer's own browser, and on the
// 404 that meant no mark at all, because the logo replaces the built-in one.
test('brand URLs allow a same-origin path or an inline image, nothing remote', () => {
  assert.equal(parseBrandUrl('logoUrl', '/assets/l.png'), '/assets/l.png');
  assert.equal(parseBrandUrl('logoUrl', '/a/brand/logo.png'), '/a/brand/logo.png');
  assert.equal(parseBrandUrl('logoUrl', 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(parseBrandUrl('logoUrl', ''), '');
  for (const bad of [
    'https://cdn.example.com/l.png',
    'http://localhost:3013/l.png',
    'assets/l.png',
    '//cdn.example.com/l.png',
    'https://u:p@x.com/l.png',
    '/l.png"><script>',
  ]) {
    assert.throws(() => parseBrandUrl('logoUrl', bad), /logoUrl/, `accepted ${bad}`);
  }
});

// An SVG runs script, and nothing on this branch sanitizes one. T2.2.3 and T2.6.10 both name it.
test('brand URLs refuse an inline SVG and every non-image data URI', () => {
  for (const bad of [
    'data:image/svg+xml;base64,AAAA',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'data:text/html;base64,AAAA',
    'data:image/png,AAAA',
    'data:image/png;base64,AA*AA',
  ]) {
    assert.throws(() => parseBrandUrl('logoUrl', bad), /logoUrl/, `accepted ${bad}`);
  }
  for (const good of ['png', 'jpeg', 'webp', 'gif']) {
    assert.equal(
      parseBrandUrl('faviconUrl', `data:image/${good};base64,AAAA`),
      `data:image/${good};base64,AAAA`,
    );
  }
});

test('brand URLs hold a small inline image and refuse a big one', () => {
  const body = 'A'.repeat(MAX_BRAND_URL_LEN - 'data:image/png;base64,'.length);
  assert.equal(parseBrandUrl('logoUrl', `data:image/png;base64,${body}`).length, MAX_BRAND_URL_LEN);
  assert.throws(() => parseBrandUrl('logoUrl', `data:image/png;base64,${body}A`), /too long/);
});

test('accentColor takes hex and rgb/hsl functions, nothing else', () => {
  for (const good of ['#fff', '#f0502a', '#f0502aff', 'rgb(240, 80, 42)', 'rgba(240,80,42,1)', 'hsl(14 88% 55%)', 'hsl(14deg 88% 55% / 100%)']) {
    assert.equal(parseAccentColor(good), good, `refused ${good}`);
  }
  for (const bad of ['rebeccapurple', 'var(--x)', 'url(x)', '#12345', 'rgb(1,2,3);color:red', 'expression(1)']) {
    assert.throws(() => parseAccentColor(bad), /accentColor/, `accepted ${bad}`);
  }
});

// The old allowlist checked the characters inside the parentheses, not the shape. Every one of
// these returned a 200 and then voided the declaration it landed in: served with `rgb(--)` the
// unlock button computes the UA grey and the body loses its dot grid, because one bad layer
// takes the whole `background-image` down with it.
test('accentColor refuses a color function with the wrong argument shape', () => {
  for (const bad of ['rgb(--)', 'rgb(,,,,)', 'hsl(+)', 'rgba(1,2)', 'hsl(1/2/3/4/5)', 'rgb(1 2 3 4 5)', 'rgb()', 'rgba(1,2,3,4,5)']) {
    assert.throws(() => parseAccentColor(bad), /accentColor/, `accepted ${bad}`);
  }
});

// A see-through accent is invisible: every link, inline code span and blockquote rule computes to
// nothing, and color-mix multiplies the accent's own alpha, so the 8% glow off a 0.3 accent lands
// at 0.024 opacity.
test('accentColor has to be fully opaque', () => {
  for (const bad of ['#0000', '#00000000', 'rgba(0,0,0,0)', 'rgba(29,78,216,.3)', 'hsla(220,90%,50%,0.3)', 'hsl(220 90% 50% / 30%)']) {
    assert.throws(() => parseAccentColor(bad), /opaque/, `accepted ${bad}`);
  }
});

// docs/api.md lists #rgba as accepted, so the message has to say so too.
test('the accentColor message names every hex shape it takes', () => {
  assert.throws(() => parseAccentColor('rebeccapurple'), /#rgb, #rgba, #rrggbb, #rrggbbaa/);
});

test('footerText collapses whitespace and refuses markup', () => {
  assert.equal(parseFooterText('  a\n  b  '), 'a b');
  assert.throws(() => parseFooterText('<a href=x>y</a>'), /footerText/);
});

// The case that decides whether an upgrade is invisible: a config.json written before this block
// existed has no `branding` key at all. The test above it writes a config that is nothing BUT a
// branding key, which is the opposite case.
test('a config saved before branding existed upgrades to an empty branding block', async () => {
  const storage = memStorage();
  await storage.put('config.json', JSON.stringify({
    frame: { enabled: false, default: false },
    md: { font: 'serif', width: 'wide', size: 'large', theme: 'dark' },
  }));
  const config = await createConfigStore(storage);
  assert.deepEqual(config.current.branding, {
    productName: '',
    logoUrl: '',
    faviconUrl: '',
    accentColor: '',
    footerText: '',
  });
  assert.equal(config.current.frame.enabled, false);
  assert.equal(config.current.md.font, 'serif');
  assert.equal(config.current.md.width, 'wide');
});

// .env.example promises a valid BRAND_* var supplies the value and an invalid one is logged and
// ignored rather than stopping the boot. Nothing pinned that until now.
test('BRAND_ env vars supply the values, and a bad one warns and is ignored', async () => {
  const before = { ...process.env };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    process.env.BRAND_PRODUCT_NAME = 'Dropkiln';
    process.env.BRAND_FOOTER_TEXT = 'Published with Dropkiln';
    process.env.BRAND_ACCENT_COLOR = 'rebeccapurple';
    const config = await createConfigStore(memStorage());
    assert.equal(config.current.branding.productName, 'Dropkiln');
    assert.equal(config.current.branding.footerText, 'Published with Dropkiln');
    assert.equal(config.current.branding.accentColor, '');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /BRAND_ACCENT_COLOR/);
  } finally {
    console.warn = realWarn;
    for (const key of ['BRAND_PRODUCT_NAME', 'BRAND_FOOTER_TEXT', 'BRAND_ACCENT_COLOR']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

// ---------------------------------------------------------------------------
// The two operator surfaces: the CLI's flags and the message the dashboard puts
// next to a field.
// ---------------------------------------------------------------------------

test('the cli flags map onto the five branding fields', () => {
  assert.deepEqual(
    brandingPatchFromFlags({
      'brand-name': 'Dropkiln',
      'brand-logo': '/brand/logo.png',
      'brand-favicon': '/brand/f.ico',
      'brand-accent': '#0055ff',
      'brand-footer': 'Published with Dropkiln',
    }),
    {
      productName: 'Dropkiln',
      logoUrl: '/brand/logo.png',
      faviconUrl: '/brand/f.ico',
      accentColor: '#0055ff',
      footerText: 'Published with Dropkiln',
    },
  );
});

test('a flag nobody passed stays out of the patch, so the other four survive a save', () => {
  assert.deepEqual(brandingPatchFromFlags({}), {});
  assert.deepEqual(brandingPatchFromFlags({ 'brand-accent': '#0055ff' }), { accentColor: '#0055ff' });
  assert.deepEqual(brandingPatchFromFlags(undefined), {});
});

test('none clears a field, the way every other cli verb spells unset', () => {
  assert.deepEqual(
    brandingPatchFromFlags({ 'brand-name': 'none', 'brand-footer': 'none' }),
    { productName: '', footerText: '' },
  );
});

test('a refused value names its own field, so a form can put the message next to it', () => {
  const bad = [
    [() => parseProductName('<b>'), 'productName'],
    [() => parseProductName('x'.repeat(41)), 'productName'],
    [() => parseFooterText('y'.repeat(161)), 'footerText'],
    [() => parseBrandUrl('logoUrl', 'https://cdn.example.com/l.png'), 'logoUrl'],
    [() => parseBrandUrl('faviconUrl', 'data:image/svg+xml;base64,AAAA'), 'faviconUrl'],
    [() => parseAccentColor('red; } body { display: none'), 'accentColor'],
  ];
  for (const [call, field] of bad) {
    assert.throws(call, (err) => {
      assert.equal(err.status, 400);
      assert.equal(brandingErrorField(err.message), field);
      return true;
    });
  }
});

test('a message that names no branding field reads as a whole-form error', () => {
  assert.equal(brandingErrorField('forbidden'), null);
  assert.equal(brandingErrorField(''), null);
  assert.equal(brandingErrorField(undefined), null);
});
