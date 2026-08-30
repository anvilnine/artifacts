// Unit tests for lib/artifact-files.js. No server and no storage backend: the rule is a pure
// function over two type names, so a test can walk every ordered pair of types, which is what
// T2.1.9 asks for with "a case per direction".
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dropOrphanObjects,
  dropStaleObjects,
  orphanKeys,
  ownedKeys,
  staleKeys,
  sweepOrphans,
  SOURCE_EXT,
} from '../lib/artifact-files.js';

const TYPES = ['html', 'jsx', 'tsx', 'md', 'redirect', 'pdf'];

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
  // A pdf is served straight from its stored bytes and its viewer page is built per request,
  // so it owns the source object and nothing else.
  assert.deepEqual(ownedKeys('s', 'pdf'), ['s/source.pdf']);
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

// The invariant, walked across all thirty ordered pairs: what the conversion drops plus what
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

// A namespace that collected orphans before the type-change cleanup landed, plus the store
// calls a sweep makes: which artifacts exist, which keys are really there, and a delete.
// `age` is how old every file in the store is, in hours. The default is a week, which is what
// the orphans this verb exists for actually are: left behind by a conversion that ran before the
// cleanup existed. A test that wants a file the sweep must refuse to touch passes a small one.
function memStore(namespaces, { age = 24 * 7, mtime = true } = {}) {
  const files = new Set();
  const metas = new Map();
  for (const [slug, { type, keys }] of Object.entries(namespaces)) {
    const record = type === 'unreadable' ? 'half a record' : JSON.stringify({ slug, type });
    metas.set(slug, Buffer.from(record));
    for (const name of keys) files.add(`${slug}/${name}`);
  }
  return {
    files,
    metas,
    async listMetas() {
      return [...metas].map(([slug, buffer]) => ({ slug, buffer }));
    },
    async getBuffer(key) {
      const [slug, name] = key.split('/');
      return name === 'meta.json' ? metas.get(slug) || null : null;
    },
    async head(key) {
      if (!files.has(key)) return null;
      // A store that cannot say how old a file is leaves mtime off, the way the sql backends do.
      return mtime ? { size: 1, mtime: Date.now() - age * 3_600_000 } : { size: 1 };
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

test('orphanKeys names every content key the type does not own', () => {
  assert.deepEqual(orphanKeys('s', 'md').sort(), [
    's/index.html',
    's/source.html',
    's/source.jsx',
    's/source.pdf',
    's/source.tsx',
    's/source.url',
  ]);
  // html owns both of the two it would otherwise be asked about.
  assert.ok(!orphanKeys('s', 'html').includes('s/index.html'));
  assert.ok(!orphanKeys('s', 'html').includes('s/source.html'));
});

// A zip serves out of site/ and no API path converts it, so a sweep that treated its files as
// orphans would take a live site apart. Same for a record this build cannot read.
test('orphanKeys says nothing about a type it does not know', () => {
  assert.deepEqual(orphanKeys('s', 'zip'), []);
  assert.deepEqual(orphanKeys('s', undefined), []);
  assert.deepEqual(orphanKeys('s', 'constructor'), []);
});

// Half one: copySlug carries every content object under the namespace, orphans included, so a
// duplicate of an artifact converted before the cleanup existed starts life holding dead bytes.
test('a duplicate is pruned to what its type owns', async () => {
  const storage = stubStorage();
  const dropped = await dropOrphanObjects(storage, 'copy', 'md');
  assert.deepEqual(storage.asked.sort(), orphanKeys('copy', 'md').sort());
  assert.deepEqual(dropped.sort(), orphanKeys('copy', 'md').sort());
  const zip = stubStorage();
  assert.deepEqual(await dropOrphanObjects(zip, 'copy', 'zip'), []);
  assert.deepEqual(zip.asked, []);
});

// Half two: the one-shot cleanup for installs that already have orphans on disk.
test('a sweep names what it would remove and removes nothing until asked', async () => {
  const store = memStore({
    old: { type: 'md', keys: ['meta.json', 'index.html', 'source.html', 'source.md'] },
    fine: { type: 'html', keys: ['meta.json', 'index.html', 'source.html'] },
  });
  const { found, removed } = await sweepOrphans(store);
  assert.deepEqual(found.sort(), ['old/index.html', 'old/source.html']);
  assert.deepEqual(removed, []);
  assert.ok(store.files.has('old/index.html'));
  assert.ok(store.files.has('old/source.html'));
});

test('a sweep with apply removes them, and a second run finds nothing', async () => {
  const store = memStore({
    old: { type: 'md', keys: ['meta.json', 'index.html', 'source.html', 'source.md'] },
  });
  const first = await sweepOrphans(store, { apply: true });
  assert.deepEqual(first.removed.sort(), ['old/index.html', 'old/source.html']);
  assert.deepEqual(first.kept, []);
  assert.deepEqual([...store.files].sort(), ['old/meta.json', 'old/source.md']);
  assert.deepEqual((await sweepOrphans(store, { apply: true })).found, []);
});

test('a sweep leaves a zip site and a record it cannot read alone', async () => {
  const store = memStore({
    site: { type: 'zip', keys: ['meta.json', 'index.html', 'site/index.html'] },
    broken: { type: 'unreadable', keys: ['meta.json', 'index.html', 'source.url'] },
  });
  assert.deepEqual((await sweepOrphans(store, { apply: true })).found, []);
  assert.equal(store.files.size, 6);
});

// The one that bit: sweepOrphans reads every meta up front, so a PUT that converted an artifact
// between that read and the delete had the sweep remove the files the NEW type owns. An md
// artifact converted to html mid-sweep ended up a lone meta.json, still listed, body gone for
// good. The age floor is what makes that impossible: the files a conversion just wrote are new.
test('a sweep will not touch a file young enough to be a live conversion', async () => {
  const store = memStore(
    { fresh: { type: 'md', keys: ['meta.json', 'index.html', 'source.html', 'source.md'] } },
    { age: 0.5 },
  );
  const { found, removed, kept } = await sweepOrphans(store, { apply: true });
  assert.deepEqual(found.sort(), ['fresh/index.html', 'fresh/source.html']);
  assert.deepEqual(removed, []);
  assert.equal(kept.length, 2);
  assert.match(kept[0].why, /under the age floor/);
  assert.equal(store.files.size, 4);
});

// The floor is a default, not a rule: an operator who knows what they are looking at can drop it.
test('--older-than 0 turns the age floor off', async () => {
  const store = memStore(
    { fresh: { type: 'md', keys: ['meta.json', 'index.html', 'source.html', 'source.md'] } },
    { age: 0.5 },
  );
  const { removed } = await sweepOrphans(store, { apply: true, minAgeMs: 0 });
  assert.deepEqual(removed.sort(), ['fresh/index.html', 'fresh/source.html']);
});

// The sqlite and postgres stores keep no timestamp, so head() cannot say how old a file is.
// Guessing "old enough" there is the race again, so the sweep keeps the file and says why.
test('a store that cannot report a file age keeps its orphans', async () => {
  const store = memStore(
    { old: { type: 'md', keys: ['meta.json', 'index.html', 'source.md'] } },
    { mtime: false },
  );
  const { removed, kept } = await sweepOrphans(store, { apply: true });
  assert.deepEqual(removed, []);
  assert.match(kept[0].why, /does not report a file age/);
  assert.match(kept[0].why, /--older-than 0/);
});

// Cheap insurance behind the age floor: the record is read again right before the delete, so a
// conversion that landed since listMetas is seen rather than assumed away.
test('a sweep re-reads the record and skips a slug that changed type mid-run', async () => {
  const store = memStore({
    turned: { type: 'md', keys: ['meta.json', 'index.html', 'source.html', 'source.md'] },
  });
  const realHead = store.head.bind(store);
  store.head = async (key) => {
    // The conversion lands between the walk's read of meta.json and the delete.
    store.metas.set('turned', Buffer.from(JSON.stringify({ slug: 'turned', type: 'html' })));
    return realHead(key);
  };
  const { removed, kept } = await sweepOrphans(store, { apply: true, minAgeMs: 0 });
  assert.deepEqual(removed, []);
  assert.match(kept[0].why, /changed type to "html"/);
  assert.ok(store.files.has('turned/index.html'));
  assert.ok(store.files.has('turned/source.html'));
});
