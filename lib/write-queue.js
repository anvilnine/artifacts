// Serializing the read-modify-write per slug, and the ceiling on how long one may take.
//
// Every meta write rewrites the whole record, so a write that started from a snapshot taken
// before another write landed puts that snapshot back and the other one's field is gone. Two
// PATCHes to one slug did it in one process without any unusual timing, and the dashboard
// sends a one-field PATCH per control. Chain the read-modify-write per slug, the way
// lib/auth.js chains auth.json: each one reloads meta inside the chain, so it changes what
// the backend holds rather than what the request found when it arrived.
//
// This covers one process. Two replicas sharing an s3 or postgres store can still write
// inside the same window and lose a field; what cannot happen any more is the corrupt
// meta.json that took the artifact out of every route, because the object write itself is
// now whole (storage/local.js) or already was (s3, postgres, sqlite).
//
// It lives here rather than inline in server.js because the ceiling is the part worth testing
// and no test boots server.js: a queue that takes a name and a function can be handed a promise
// that never settles.

import { StorageTimeoutError } from './errors.js';

// `ceilingMs` is how long one write gets before the queue gives the slug back. server.js passes
// STORAGE_TIMEOUT_MS (storage/index.js), which is the same number the s3 backend puts on its
// requests; a test passes a few milliseconds.
export function createWriteQueue({ ceilingMs }) {
  const chains = new Map();

  // Race one write against the clock. The work itself cannot be cancelled, so this bounds the
  // wait rather than the call: the slug is released for the next writer and the caller gets an
  // answer instead of watching its own client give up. A write that comes back later still
  // lands, which is why the caller is told to retry rather than told it failed.
  //
  // The clock starts when the write starts, not when it was queued, so a writer standing behind
  // a slow but healthy write is not failed for waiting its turn.
  function capped(slug, work) {
    let timer;
    const ceiling = new Promise((_, reject) => {
      timer = setTimeout(() => {
        console.error(
          `storage: a write to "${slug}" has not answered in ${ceilingMs}ms. The slug is ` +
            'released for the next writer and the caller was told to retry. Check the storage ' +
            'backend: nothing before this logged a stalled call, and reads keep working, so ' +
            'the artifact looks healthy while it cannot be managed.',
        );
        reject(new StorageTimeoutError('the storage backend did not answer in time; retry'));
      }, ceilingMs);
    });
    return Promise.race([work, ceiling]).finally(() => clearTimeout(timer));
  }

  function withMetaChain(slug, run) {
    const prev = chains.get(slug) || Promise.resolve();
    const result = prev.then(() => capped(slug, run()));
    // The chain holds `tail`, which swallows the rejection, so a write that throws (a 404 on a
    // missing slug, a 409 on a taken one, a write that ran out of time) does not stop the next
    // caller from running.
    const tail = result.then(() => {}, () => {});
    chains.set(slug, tail);
    // Drop the entry once nothing is queued behind it, or the map grows one key per slug the
    // process ever wrote.
    tail.then(() => {
      if (chains.get(slug) === tail) chains.delete(slug);
    });
    return result;
  }

  // A rename and a copy write under two names, so they hold both chains. Sorted and
  // de-duplicated first: two renames that cross (a to b while b to a) would otherwise take the
  // two chains in opposite orders and wait on each other forever.
  function withMetaChains(slugs, run) {
    const keys = [...new Set(slugs)].sort();
    return keys.reduceRight((next, key) => () => withMetaChain(key, next), run)();
  }

  return { withMetaChain, withMetaChains };
}
