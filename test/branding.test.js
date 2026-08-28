// The branding block on the config endpoint: what it accepts, what it refuses, and the
// promise that an untouched instance keeps rendering exactly what it rendered before.
//
// The refusals matter more than the accepts. Every one of these values lands in HTML a
// viewer loads, and accentColor lands inside a <style> block, where a stray brace ends
// the rule and starts whatever the caller wrote next.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigStore } from '../lib/config.js';
import { parseAccentColor, parseBrandUrl, parseFooterText, parseProductName } from '../lib/branding.js';

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
      logoUrl: 'https://cdn.example.com/logo.svg',
      faviconUrl: '/favicon.ico',
      accentColor: '#0055ff',
      footerText: 'Published with Dropkiln',
    },
  });
  assert.equal(updated.branding.productName, 'Dropkiln');
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

test('brand URLs allow absolute http(s) and root-relative paths only', () => {
  assert.equal(parseBrandUrl('logoUrl', 'https://cdn.example.com/l.svg'), 'https://cdn.example.com/l.svg');
  assert.equal(parseBrandUrl('logoUrl', 'http://localhost:3013/l.svg'), 'http://localhost:3013/l.svg');
  assert.equal(parseBrandUrl('logoUrl', '/assets/l.svg'), '/assets/l.svg');
  assert.equal(parseBrandUrl('logoUrl', ''), '');
  for (const bad of ['data:image/png;base64,AAAA', 'assets/l.svg', '//cdn.example.com/l.svg', 'https://u:p@x.com/l.svg', '/l.svg"><script>']) {
    assert.throws(() => parseBrandUrl('logoUrl', bad), /logoUrl/, `accepted ${bad}`);
  }
});

test('accentColor takes hex and rgb/hsl functions, nothing else', () => {
  for (const good of ['#fff', '#f0502a', '#f0502aff', 'rgb(240, 80, 42)', 'rgba(240,80,42,.35)', 'hsl(14 88% 55%)']) {
    assert.equal(parseAccentColor(good), good, `refused ${good}`);
  }
  for (const bad of ['rebeccapurple', 'var(--x)', 'url(x)', '#12345', 'rgb(1,2,3);color:red', 'expression(1)']) {
    assert.throws(() => parseAccentColor(bad), /accentColor/, `accepted ${bad}`);
  }
});

test('footerText collapses whitespace and refuses markup', () => {
  assert.equal(parseFooterText('  a\n  b  '), 'a b');
  assert.throws(() => parseFooterText('<a href=x>y</a>'), /footerText/);
});
