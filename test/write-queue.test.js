// Unit tests for lib/write-queue.js. The queue is what serializes a read-modify-write per slug,
// and what it does with a storage call that never comes back. Nothing here boots server.js: the
// queue takes a function and a name, so a test can hand it a promise that never settles.
import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageTimeoutError } from '../lib/errors.js';
import { createWriteQueue } from '../lib/write-queue.js';

const never = () => new Promise(() => {});

test('writes to one slug run one at a time', async () => {
  const queue = createWriteQueue({ ceilingMs: 1000 });
  const order = [];
  const first = queue.withMetaChain('s', async () => {
    order.push('first in');
    await new Promise((r) => setTimeout(r, 20));
    order.push('first out');
  });
  const second = queue.withMetaChain('s', async () => {
    order.push('second in');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first in', 'first out', 'second in']);
});

// The item: before the ceiling, a put that never settled parked every later PATCH, PUT, DELETE
// and duplicate on that slug for the life of the process, and nothing logged it.
test('a write that never comes back frees the slug for the next writer', async () => {
  const queue = createWriteQueue({ ceilingMs: 20 });
  const hung = queue.withMetaChain('s', never);
  await assert.rejects(hung, (err) => err instanceof StorageTimeoutError);
  let ran = false;
  await queue.withMetaChain('s', async () => {
    ran = true;
  });
  assert.equal(ran, true, 'the write after the hung one never ran');
});

// 503 with a Retry-After, not a 500: the server is fine, that one storage call is not, and the
// request is worth retrying, which a 500 does not say.
test('the caller hears 503 and how long to wait', async () => {
  const queue = createWriteQueue({ ceilingMs: 20 });
  await assert.rejects(queue.withMetaChain('s', never), (err) => {
    assert.equal(err.status, 503);
    assert.ok(err.retryAfter > 0);
    assert.match(err.message, /storage/);
    return true;
  });
});

// The ceiling covers the call, not the wait for the slug: a queue behind a slow-but-healthy
// write must not fail the writers standing in line.
test('the ceiling starts when the write starts, not when it is queued', async () => {
  const queue = createWriteQueue({ ceilingMs: 40 });
  const slow = queue.withMetaChain('s', () => new Promise((r) => setTimeout(r, 30)));
  const behind = queue.withMetaChain('s', async () => 'ok');
  await slow;
  assert.equal(await behind, 'ok');
});

test('two slugs do not wait on each other', async () => {
  const queue = createWriteQueue({ ceilingMs: 1000 });
  let other = false;
  const hung = queue.withMetaChain('a', never);
  await queue.withMetaChain('b', async () => {
    other = true;
  });
  assert.equal(other, true);
  hung.catch(() => {});
});

// A rename and a copy hold both names. Two crossing renames must take the two chains in the
// same order or they wait on each other forever.
test('a write under two names takes them in a stable order', async () => {
  const queue = createWriteQueue({ ceilingMs: 1000 });
  const seen = [];
  await Promise.all([
    queue.withMetaChains(['b', 'a'], async () => {
      seen.push('one');
      await new Promise((r) => setTimeout(r, 10));
    }),
    queue.withMetaChains(['a', 'b'], async () => {
      seen.push('two');
    }),
  ]);
  assert.deepEqual(seen, ['one', 'two']);
});
