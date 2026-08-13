// Unit tests for storage/local.js. createAt roots a store at any directory, so a fresh temp
// dir is enough to drive the real filesystem paths (the git backend uses the same code).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAt } from '../storage/local.js';

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-local-'));
  return { root, store: await createAt(root) };
}

// Two records of different lengths. A write that interleaves with another one leaves bytes
// from both, which JSON.parse refuses; that is exactly the shape that took an artifact's
// meta.json out of the list and made it 404 on its own DELETE.
function record(tag, pad) {
  return JSON.stringify({ slug: 'race', tag, filler: tag.repeat(pad) }, null, 2);
}
const SHORT = record('a', 2000);
const LONG = record('bb', 40000);

test('put stores the bytes it was given', async () => {
  const { store } = await tmpStore();
  await store.put('race/meta.json', SHORT);
  const buf = await store.getBuffer('race/meta.json');
  assert.equal(buf.toString('utf8'), SHORT);
});

test('overlapping puts to one key never leave a torn object', async () => {
  const { store } = await tmpStore();
  await store.put('race/meta.json', SHORT);
  for (let round = 0; round < 20; round++) {
    await Promise.all([
      store.put('race/meta.json', LONG),
      store.put('race/meta.json', SHORT),
    ]);
    const text = (await store.getBuffer('race/meta.json')).toString('utf8');
    assert.doesNotThrow(
      () => JSON.parse(text),
      `round ${round} read a half-written object (${text.length} bytes)`,
    );
    assert.ok(text === SHORT || text === LONG, `round ${round} read neither whole record`);
  }
});

test('a put leaves no scratch file behind', async () => {
  const { root, store } = await tmpStore();
  await store.put('race/meta.json', SHORT);
  await Promise.all([store.put('race/meta.json', LONG), store.put('race/meta.json', SHORT)]);
  const entries = await fs.readdir(path.join(root, 'race'));
  assert.deepEqual(entries, ['meta.json']);
});

// The scratch file is written, then the rename fails: a directory sitting at the target path
// makes it EISDIR. Handing put() unwritable bytes instead would throw in argument validation
// before anything was created, so the cleanup branch would never run and the test would pass
// against a put that leaks every scratch file it writes.
test('a put that cannot land leaves the stored object alone and cleans up', async () => {
  const { root, store } = await tmpStore();
  await fs.mkdir(path.join(root, 'busy', 'meta.json'), { recursive: true });
  await assert.rejects(() => store.put('busy/meta.json', SHORT));
  assert.deepEqual(await fs.readdir(path.join(root, 'busy')), ['meta.json']);
});

// An operator who ran the `chmod 600` docs/deploy.md asks for keeps it. writeFile truncated the
// object in place and left the mode alone; a rename brings a new inode, and handing auth.json
// back at 0644 would undo that hardening on the next ordinary write.
test('a put keeps the mode the object already had', async () => {
  const { root, store } = await tmpStore();
  await store.put('race/meta.json', SHORT);
  const abs = path.join(root, 'race', 'meta.json');
  await fs.chmod(abs, 0o600);
  await store.put('race/meta.json', LONG);
  assert.equal((await fs.stat(abs)).mode & 0o777, 0o600);
});

test('delete removes one object and leaves the rest of the namespace alone', async () => {
  const { root, store } = await tmpStore();
  await store.put('conv/meta.json', SHORT);
  await store.put('conv/index.html', '<h1>was html</h1>');
  await store.put('conv/source.html', '<h1>was html</h1>');
  await store.delete('conv/source.html');
  assert.deepEqual((await fs.readdir(path.join(root, 'conv'))).sort(), ['index.html', 'meta.json']);
  assert.equal(await store.getBuffer('conv/source.html'), null);
  assert.equal((await store.getBuffer('conv/meta.json')).toString('utf8'), SHORT);
});

// A conversion runs the same delete on every backend, and the object may already be gone (an
// artifact published before the type owned that file). A throw there would turn a write that
// already landed into a 500.
test('deleting an object that is not there is not an error', async () => {
  const { store } = await tmpStore();
  await store.put('conv/meta.json', SHORT);
  await store.delete('conv/source.url');
  await store.delete('never-published/source.md');
});

test('delete refuses a key that escapes the namespace', async () => {
  const { store } = await tmpStore();
  await assert.rejects(() => store.delete('../outside.json'));
  await assert.rejects(() => store.delete('/etc/passwd'));
});

test('a scratch file a crash left behind is swept at startup and never copied', async () => {
  const { root, store } = await tmpStore();
  await store.put('race/meta.json', SHORT);
  const stray = path.join(root, 'race', '.meta.json.0e4b1c2d-1111-4222-8333-444455556666.tmp');
  await fs.writeFile(stray, SHORT);
  await store.copySlug('race', 'copy');
  assert.deepEqual(await fs.readdir(path.join(root, 'copy')), []);
  await createAt(root); // a restart
  assert.deepEqual(await fs.readdir(path.join(root, 'race')), ['meta.json']);
});
