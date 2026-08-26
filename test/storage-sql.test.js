// Unit tests for the SQL-backed stores, driven through sqlite. node:sqlite ships with the Node
// >=22 this project already requires, so this runs with no external service. postgres.js hands
// makeSqlStore the same operations against the same one-table schema, so the shared core these
// tests drive is the same code postgres runs. postgres's own SQL is not: `DELETE FROM artifacts
// WHERE key = $1` (storage/postgres.js) only ever runs under the CI backend matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { create } from '../storage/sqlite.js';

async function tmpStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-sqlite-'));
  process.env.SQLITE_PATH = path.join(dir, 'artifacts.db');
  return create();
}

test('delete removes one object and leaves the rest of the namespace alone', async () => {
  const store = await tmpStore();
  await store.put('conv/meta.json', '{"slug":"conv"}');
  await store.put('conv/index.html', '<h1>was html</h1>');
  await store.put('conv/source.html', '<h1>was html</h1>');
  await store.delete('conv/source.html');
  assert.equal(await store.getBuffer('conv/source.html'), null);
  assert.equal(await store.head('conv/source.html'), null);
  assert.equal((await store.getBuffer('conv/index.html')).toString('utf8'), '<h1>was html</h1>');
  assert.deepEqual(
    (await store.listMetas()).map((m) => m.slug),
    ['conv'],
  );
});

test('deleting an object that is not there is not an error', async () => {
  const store = await tmpStore();
  await store.put('conv/meta.json', '{"slug":"conv"}');
  await store.delete('conv/source.url');
  await store.delete('never-published/source.md');
  assert.equal((await store.listMetas()).length, 1);
});

// The prefix operations use range predicates so a key is never read as a LIKE pattern. A
// single-key delete takes an equality match, so the same worry does not apply, but a key that
// looks like a pattern must still hit only itself.
test('delete matches one key exactly', async () => {
  const store = await tmpStore();
  await store.put('conv/a%b.html', 'percent');
  await store.put('conv/a_b.html', 'underscore');
  await store.put('conv/axb.html', 'literal');
  await store.delete('conv/a_b.html');
  assert.equal(await store.getBuffer('conv/a_b.html'), null);
  assert.equal((await store.getBuffer('conv/a%b.html')).toString('utf8'), 'percent');
  assert.equal((await store.getBuffer('conv/axb.html')).toString('utf8'), 'literal');
});

test('delete refuses a key that escapes the namespace', async () => {
  const store = await tmpStore();
  await assert.rejects(() => store.delete('../outside.json'));
  await assert.rejects(() => store.delete('/etc/passwd'));
});

test('deleteSlug still takes the whole namespace', async () => {
  const store = await tmpStore();
  await store.put('conv/meta.json', '{"slug":"conv"}');
  await store.put('conv/site/index.html', 'site');
  await store.put('conv-two/meta.json', '{"slug":"conv-two"}');
  await store.deleteSlug('conv');
  assert.equal(await store.getBuffer('conv/site/index.html'), null);
  assert.deepEqual(
    (await store.listMetas()).map((m) => m.slug),
    ['conv-two'],
  );
});
