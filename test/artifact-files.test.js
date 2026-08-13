// Unit tests for lib/artifact-files.js. No server and no storage backend: the rule is a pure
// function over two type names, so a test can walk every ordered pair of types, which is what
// T2.1.9 asks for with "a case per direction".
import test from 'node:test';
import assert from 'node:assert/strict';

import { dropStaleObjects, ownedKeys, staleKeys, SOURCE_EXT } from '../lib/artifact-files.js';

const TYPES = ['html', 'jsx', 'tsx', 'md', 'redirect'];

// Minimal stand-in for storage/*.js: dropStaleObjects only calls delete, so recording the keys
// it asks for is the whole contract. `fails` makes that delete throw, which is the branch that
// decides whether a failed cleanup can sink a write that already landed.
function stubStorage({ fails = false } = {}) {
  const asked = [];
  return {
    asked,
    async delete(key) {
      asked.push(key);
      if (fails) throw new Error('backend said no');
    },
  };
}

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

// A meta.json edited by hand can carry any string as its type. A plain SOURCE_EXT[type] lookup
// walks the prototype, so "constructor" built `s/source.function Object() { [native code] }`.
test('a type name off the prototype chain builds no key', () => {
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.deepEqual(ownedKeys('s', type), [], type);
    assert.deepEqual(staleKeys('s', type, 'html'), [], `${type} to html`);
  }
});

// The link the rest of the file does not cover: that something actually calls delete. No test
// boots server.js, so while the loop lived inline there it was provably dead weight - replacing
// it with `for (const key of [])` left every unit test and the whole smoke suite green, on all
// five backends, because a stale object is not reachable over HTTP.
test('a conversion asks the backend to drop every stale key', async () => {
  const storage = stubStorage();
  const dropped = await dropStaleObjects(storage, 'conv', 'html', 'redirect');
  assert.deepEqual(storage.asked, ['conv/index.html', 'conv/source.html']);
  assert.deepEqual(dropped, ['conv/index.html', 'conv/source.html']);
});

test('a write that does not change the type asks the backend for nothing', async () => {
  const storage = stubStorage();
  assert.deepEqual(await dropStaleObjects(storage, 'conv', 'md', 'md'), []);
  assert.deepEqual(await dropStaleObjects(storage, 'conv', undefined, 'md'), []);
  assert.deepEqual(storage.asked, []);
});

test('every direction asks for exactly the keys staleKeys names', async () => {
  for (const from of TYPES) {
    for (const to of TYPES) {
      const storage = stubStorage();
      await dropStaleObjects(storage, 'conv', from, to);
      assert.deepEqual(storage.asked, staleKeys('conv', from, to), `${from} to ${to}`);
    }
  }
});

// The write has already landed and meta already names the new type, so a backend that refuses
// the cleanup must not turn a successful replace into a 500 the caller would retry. It still
// tries every key rather than stopping at the first failure.
test('a delete that throws is swallowed and does not stop the rest', async () => {
  const storage = stubStorage({ fails: true });
  const dropped = await dropStaleObjects(storage, 'conv', 'html', 'redirect');
  assert.deepEqual(storage.asked, ['conv/index.html', 'conv/source.html']);
  assert.deepEqual(dropped, []);
});

// A backend that never implemented delete raises "storage.delete is not a function", which the
// same catch swallows. createStorage refuses such a backend at boot; this pins that the write
// path survives it rather than 500ing on every conversion.
test('a backend with no delete does not sink the write', async () => {
  const dropped = await dropStaleObjects({}, 'conv', 'html', 'md');
  assert.deepEqual(dropped, []);
});
