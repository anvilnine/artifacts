// Every backend has to answer the whole interface in storage/index.js, and createStorage now
// checks that at boot. The check earns its keep because the type-change cleanup swallows a failed
// delete on purpose (a write that already landed must not 500), so a backend missing the method
// would warn once per conversion forever and never fail anything.
//
// Coverage split: local and sqlite are built for real here. postgres shares its whole surface with
// sqlite through makeSqlStore, so a stub driver covers it. s3 and git need a bucket and a remote,
// so neither is built on a laptop; CI boots all five, and since createStorage runs the check on
// every boot, an incomplete s3 or git fails there rather than serving.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertComplete } from '../storage/index.js';
import { createAt } from '../storage/local.js';
import { create as createSqlite } from '../storage/sqlite.js';
import { makeSqlStore } from '../storage/sqlstore.js';

const METHODS = [
  'getBuffer',
  'get',
  'head',
  'put',
  'listMetas',
  'move',
  'copySlug',
  'delete',
  'deleteSlug',
];

function completeStub() {
  return Object.fromEntries(METHODS.map((m) => [m, () => {}]));
}

test('assertComplete names every method a backend is missing', () => {
  assert.throws(
    () => assertComplete('stub', { put() {}, get() {} }),
    /storage backend "stub" is missing: getBuffer, head, listMetas, move, copySlug, delete, deleteSlug/,
  );
  assert.throws(() => assertComplete('stub', null), /missing/);
});

// A property that is present but not callable is missing as far as the app is concerned: the
// write path would reach it and throw TypeError, which the cleanup's catch would swallow.
test('a method that is not a function counts as missing', () => {
  assert.throws(() => assertComplete('stub', { ...completeStub(), delete: true }), /missing: delete/);
});

test('the check accepts a store that answers all of it', () => {
  const stub = completeStub();
  assert.equal(assertComplete('stub', stub), stub);
});

// If a method is added to the interface and not to this list, the list is the thing that is
// stale, so prove the two agree rather than trusting the copy.
test('this file lists the same methods the contract requires', () => {
  const short = completeStub();
  delete short.delete;
  assert.throws(() => assertComplete('stub', short), /missing: delete/);
  for (const method of METHODS) {
    const one = completeStub();
    delete one[method];
    assert.throws(() => assertComplete('stub', one), new RegExp(`missing: ${method}`), method);
  }
});

test('local answers the whole contract', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-contract-'));
  assertComplete('local', await createAt(root));
});

test('sqlite answers the whole contract', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-contract-'));
  process.env.SQLITE_PATH = path.join(dir, 'artifacts.db');
  assertComplete('sqlite', await createSqlite());
});

// postgres and sqlite both return makeSqlStore(driver), so the wrapper is the whole surface
// either of them exposes. A driver that answers everything proves the wrapper does too.
test('the shared SQL wrapper answers the whole contract', () => {
  const driver = {
    kind: 'stub',
    get: () => null,
    size: () => null,
    put: () => {},
    listMetas: () => [],
    move: () => {},
    copySlug: () => {},
    delete: () => {},
    deleteSlug: () => {},
    init: () => {},
  };
  assertComplete('postgres', makeSqlStore(driver));
});
