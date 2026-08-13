// Unit tests for lib/artifact-files.js. No server and no storage backend: the rule is a pure
// function over two type names, so a test can walk every ordered pair of types, which is what
// T2.1.9 asks for with "a case per direction".
import test from 'node:test';
import assert from 'node:assert/strict';

import { ownedKeys, staleKeys, SOURCE_EXT } from '../lib/artifact-files.js';

const TYPES = ['html', 'jsx', 'tsx', 'md', 'redirect'];

test('each type owns the objects the serve path reads back', () => {
  assert.deepEqual(ownedKeys('s', 'html'), ['s/index.html', 's/source.html']);
  assert.deepEqual(ownedKeys('s', 'jsx'), ['s/index.html', 's/source.jsx']);
  assert.deepEqual(ownedKeys('s', 'tsx'), ['s/index.html', 's/source.tsx']);
  // md renders at serve time from source.md and a redirect answers with a header, so neither
  // bakes an index.html.
  assert.deepEqual(ownedKeys('s', 'md'), ['s/source.md']);
  assert.deepEqual(ownedKeys('s', 'redirect'), ['s/source.url']);
});

test('a write that does not change the type drops nothing', () => {
  for (const type of TYPES) {
    assert.deepEqual(staleKeys('s', type, type), [], `${type} to ${type}`);
  }
});

test('a first publish has no old type, so it drops nothing', () => {
  for (const type of TYPES) {
    assert.deepEqual(staleKeys('s', undefined, type), [], `new ${type}`);
  }
});

// The invariant, walked across all twenty ordered pairs: what the conversion drops plus what
// the new type owns covers everything the old type owned, and nothing the new type still needs
// is on the drop list.
test('every direction drops exactly what the new type stops using', () => {
  for (const from of TYPES) {
    for (const to of TYPES) {
      if (from === to) continue;
      const label = `${from} to ${to}`;
      const stale = staleKeys('s', from, to);
      const kept = ownedKeys('s', to);
      for (const key of stale) {
        assert.ok(!kept.includes(key), `${label} would drop ${key}, which ${to} still serves`);
      }
      for (const key of ownedKeys('s', from)) {
        assert.ok(
          stale.includes(key) || kept.includes(key),
          `${label} leaves ${key} behind with nothing serving it`,
        );
      }
    }
  }
});

test('the named directions match what the item filed', () => {
  // html to redirect: the baked page and the html source both stop being read.
  assert.deepEqual(staleKeys('s', 'html', 'redirect'), ['s/index.html', 's/source.html']);
  // redirect back to html: the target file goes, index.html is written fresh.
  assert.deepEqual(staleKeys('s', 'redirect', 'html'), ['s/source.url']);
  // md to html: the markdown goes, index.html appears for the first time.
  assert.deepEqual(staleKeys('s', 'md', 'html'), ['s/source.md']);
  // html to md: the baked page goes because md renders per request.
  assert.deepEqual(staleKeys('s', 'html', 'md'), ['s/index.html', 's/source.html']);
  // jsx to tsx: both bake an index.html, so only the extension changes.
  assert.deepEqual(staleKeys('s', 'jsx', 'tsx'), ['s/source.jsx']);
});

test('meta.json survives every conversion', () => {
  for (const from of TYPES) {
    for (const to of TYPES) {
      assert.ok(
        !staleKeys('s', from, to).includes('s/meta.json'),
        `${from} to ${to} would delete the record`,
      );
    }
  }
});

// A zip site is never a conversion source: storeArtifact refuses to replace one with inline
// content, and storeZipArtifact 409s on a slug that already exists. Nothing here should invent
// a delete for a type it has no extension for.
test('a type with no source extension drops nothing', () => {
  assert.equal(SOURCE_EXT.zip, undefined);
  assert.deepEqual(staleKeys('s', 'zip', 'html'), []);
  assert.deepEqual(ownedKeys('s', 'zip'), []);
});
