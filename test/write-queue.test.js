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
// and duplicate on that slug for the life of the process, and nothing logged it. The ceiling
// answers that caller and logs the slug. What it must not do is hand the slug over while the
// stalled write is still running, which the first version did: see the test below this one.
test('a write that has not come back answers 503, and the next write waits for it', async () => {
  const queue = createWriteQueue({ ceilingMs: 20 });
  let release;
  const stalled = queue.withMetaChain('s', () => new Promise((r) => { release = r; }));
  await assert.rejects(stalled, (err) => err instanceof StorageTimeoutError);
  let ran = false;
  const next = queue.withMetaChain('s', async () => { ran = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, false, 'the next write ran while the stalled one was still in flight');
  release();
  await next;
  assert.equal(ran, true, 'the next write never ran after the stalled one came back');
});

// A meta write rewrites the whole record. The queue used to build its chain tail from the race
// rather than from the call, so the slug came free at the ceiling, a later write landed, and the
// stalled write then put back the snapshot it had read before the timeout. visibility,
// passwordHash and tokenEpoch all live in that snapshot, so a flip to private or a token
// rotation could come back undone with a 200 on it.
test('a write that timed out cannot revert a write that landed after it', async () => {
  const queue = createWriteQueue({ ceilingMs: 20 });
  let record = { visibility: 'public', tokenEpoch: 0 };
  let release;
  const stalled = queue.withMetaChain('s', async () => {
    const snapshot = { ...record };
    await new Promise((r) => { release = r; });
    record = { ...snapshot, note: 'the stalled write landed' };
  });
  await assert.rejects(stalled, (err) => err instanceof StorageTimeoutError);
  const rotate = queue.withMetaChain('s', async () => {
    record = { ...record, visibility: 'private', tokenEpoch: 1 };
  });
  release();
  await rotate;
  assert.equal(record.visibility, 'private');
  assert.equal(record.tokenEpoch, 1);
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

// The two-name form used to cap every step, which started the outer slug's clock before the
// inner slug's queue wait. A rename standing behind two healthy writes on the second name was
// answered 503 without either of those writes going near the ceiling, and then landed anyway a
// moment after the caller had been told to retry.
test('a two-name write is not failed for waiting its turn on the second name', async () => {
  const queue = createWriteQueue({ ceilingMs: 60 });
  const busy = [
    queue.withMetaChain('b', () => new Promise((r) => setTimeout(r, 40))),
    queue.withMetaChain('b', () => new Promise((r) => setTimeout(r, 40))),
  ];
  assert.equal(await queue.withMetaChains(['a', 'b'], async () => 'renamed'), 'renamed');
  await Promise.all(busy);
});

// And the ceiling still has to fire when the work itself is what stalls, whichever name it
// runs under.
test('a two-name write still hears 503 when its own call stalls', async () => {
  const queue = createWriteQueue({ ceilingMs: 20 });
  const hung = queue.withMetaChains(['a', 'b'], never);
  await assert.rejects(hung, (err) => err instanceof StorageTimeoutError);
});

// The ceiling used to be set up inside the chain step, so it only ran once the step started. A
// caller whose own write was running got its 503; a caller queued behind a wedged write never
// started, so it heard nothing at all. server.js sets no server.timeout, so that socket stays
// open for the life of the process, and the 503 the write in front got tells its caller to
// retry into the same silence.
test('a caller queued behind a write that never comes back hears the same 503', async () => {
  const queue = createWriteQueue({ ceilingMs: 20 });
  const wedged = queue.withMetaChain('s', never);
  let ran = false;
  const queued = queue.withMetaChain('s', async () => { ran = true; return 'ok'; });
  await assert.rejects(wedged, (err) => err instanceof StorageTimeoutError);
  await assert.rejects(queued, (err) => err instanceof StorageTimeoutError);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, false, 'the queued write ran after its caller was told to retry');
});

// Same for a rename, which holds two names and can be stuck behind a wedged write on either.
test('a rename queued behind a write that never comes back hears the same 503', async () => {
  const queue = createWriteQueue({ ceilingMs: 20 });
  const wedged = queue.withMetaChain('b', never);
  const rename = queue.withMetaChains(['a', 'b'], async () => 'renamed');
  await assert.rejects(wedged, (err) => err instanceof StorageTimeoutError);
  await assert.rejects(rename, (err) => err instanceof StorageTimeoutError);
});

// Only a stalled storage call travels down the queue. A 404 on a missing slug or a 409 on a
// taken one belongs to the caller that made it: the slug came free straight after, so the next
// writer runs and gets its own answer.
test('an ordinary failure does not travel down the queue', async () => {
  const queue = createWriteQueue({ ceilingMs: 1000 });
  const failed = queue.withMetaChain('s', async () => { throw new Error('slug "x" already exists'); });
  const behind = queue.withMetaChain('s', async () => 'ok');
  await assert.rejects(failed, /already exists/);
  assert.equal(await behind, 'ok');
});
