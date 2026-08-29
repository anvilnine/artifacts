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

// How long a whole chained write gets before the caller is told to retry.
//
// This is not the per-call storage deadline. STORAGE_TIMEOUT_MS (storage/index.js) is what the
// s3 backend puts on one signed request; what the queue holds is an entire handler, and a zip
// deploy is one handler that writes every file in the archive. A 2000 file site measured 2.5 s
// on a local SSD, which is 2000 sequential puts; at an ordinary s3 round trip of 30 to 80 ms the
// same deploy is 60 to 160 s. Passing the per-call number here answered those 503 while the
// extraction kept running in the background with the slug already released, and since meta.json
// is written last, the retry found nothing and started a second extraction into the same
// namespace. Three minutes clears the longest publish this server can be asked to make.
//
// On s3 a single stalled call still fails at STORAGE_TIMEOUT_MS, so this is the backstop for a
// whole handler rather than the thing that catches one bad request. On the local backend, where
// nothing times out a call, a wedged disk now holds a slug for three minutes instead of thirty
// seconds. Reads are unaffected either way.
export const WRITE_CEILING_MS = 180_000;

// `ceilingMs` is how long one write gets before the queue gives the slug back. server.js passes
// WRITE_CEILING_MS; a test passes a few milliseconds.
export function createWriteQueue({ ceilingMs }) {
  const chains = new Map();

  // Race one write against the clock. The work itself cannot be cancelled, so this bounds what
  // the caller waits for and nothing else: the caller gets an answer instead of watching its own
  // client give up, and a write that comes back later still lands, which is why the caller is
  // told to retry rather than told it failed. The slug is NOT handed to the next writer here.
  // It stays held until the real call settles, because a write that landed underneath a stalled
  // one was then overwritten by it, snapshot and all.
  //
  // The clock starts when the write starts, not when it was queued, so a writer standing behind
  // a slow but healthy write is not failed for waiting its turn. What answers the writers queued
  // behind a write that never comes back is `inherit` below, not this clock.
  function capped(slug, work) {
    let timer;
    const ceiling = new Promise((_, reject) => {
      timer = setTimeout(() => {
        console.error(
          `storage: a write to "${slug}" has not answered in ${ceilingMs}ms. That caller and ` +
            'everyone queued behind it were told to retry, and those retries queue behind that ' +
            'write rather than landing under it. Check the storage backend: nothing before ' +
            'this logged a stalled call, and reads keep working, so the artifact looks healthy ' +
            'while it cannot be managed.',
        );
        reject(new StorageTimeoutError('the storage backend did not answer in time; retry'));
      }, ceilingMs);
    });
    return Promise.race([work, ceiling]).finally(() => clearTimeout(timer));
  }

  // The answer the last caller to queue on each slug is waiting on, and whether it has been
  // given yet. Dropped as soon as that caller is answered and nobody has queued behind it, or
  // the map grows one key per slug the process ever wrote.
  const fronts = new Map();

  // You are answered no later than the caller in front of you. A write past the ceiling is still
  // holding the slug and may never come back, so everyone queued behind it hears the same 503 at
  // the same moment instead of waiting on a call with no clock left on it. Any other failure (a
  // 404 on a missing slug, a 409 on a taken one) is that caller's own business and does not
  // travel down the queue, so this returns a promise that never settles for those.
  function inherit(promise) {
    return promise.then(
      () => new Promise(() => {}),
      (err) => {
        if (err instanceof StorageTimeoutError) throw err;
        return new Promise(() => {});
      },
    );
  }

  // Register this caller as the one at the head of every slug it holds, and give it the answer of
  // whoever is still waiting in front of it. A caller that arrives after the one in front was
  // answered inherits nothing and queues normally, which is what makes the retry the 503 asks for
  // land behind the stalled write rather than bounce straight back off it.
  function queueAnswer(slugs, caller) {
    const ahead = slugs.map((s) => fronts.get(s)).filter((f) => f && !f.settled);
    const promise = ahead.length
      ? Promise.race([caller, ...ahead.map((f) => inherit(f.promise))])
      : caller;
    const state = { settled: false, promise };
    const mark = () => {
      state.settled = true;
      for (const s of slugs) if (fronts.get(s) === state) fronts.delete(s);
    };
    promise.then(mark, mark);
    for (const s of slugs) fronts.set(s, state);
    return state;
  }

  // Call `run` and hand back a promise whatever it does, so a function that throws on the spot
  // is a rejection like any other rather than a caller that never hears back.
  function start(run) {
    try {
      return Promise.resolve(run());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // Queue `run` behind whatever this slug already has in flight. The promise the chain holds
  // settles when `run` settles, never when the caller gave up: releasing the slug at the ceiling
  // let the next write land underneath a call that was still running, and that call then rewrote
  // the whole record from the snapshot it read before the timeout. A flip to private, a token
  // rotation, a password change: all of them came back undone, with a 200 on the write that
  // lost. Returns the real call's promise.
  function chainOn(slug, run) {
    const prev = chains.get(slug) || Promise.resolve();
    const started = prev.then(() => start(run));
    // The chain holds `tail`, which swallows the rejection, so a write that throws (a 404 on a
    // missing slug, a 409 on a taken one, a write that ran out of time) does not stop the next
    // caller from running.
    const tail = started.then(() => {}, () => {});
    chains.set(slug, tail);
    // Drop the entry once nothing is queued behind it, or the map grows one key per slug the
    // process ever wrote.
    tail.then(() => {
      if (chains.get(slug) === tail) chains.delete(slug);
    });
    return started;
  }

  // One slug: queue the write, and cap what the caller waits on. The cap is set up inside the
  // chain step, so the clock starts when the write starts rather than when it was queued. That
  // left the caller queued behind a wedged write with no answer at all: its step never started,
  // so its clock never ran, and server.js sets no server.timeout, so the socket sat open for the
  // life of the process. Measured at ceilingMs 200: the wedged write got its 503, the two
  // callers queued behind it were still pending after 1500ms. queueAnswer is what covers them.
  function withMetaChain(slug, run) {
    let answer;
    const caller = new Promise((resolve, reject) => { answer = { resolve, reject }; });
    const state = queueAnswer([slug], caller);
    chainOn(slug, () => {
      // Already answered means this caller inherited the 503 of a write that stopped the queue
      // moving. It has been told to retry, and nothing of its write has run yet, so dropping it
      // here is what keeps the retry from landing the same change twice.
      if (state.settled) return undefined;
      const work = start(run);
      capped(slug, work).then(answer.resolve, answer.reject);
      return work;
    }).catch(() => {});
    return state.promise;
  }

  // A rename and a copy write under two names, so they hold both chains. Sorted and
  // de-duplicated first: two renames that cross (a to b while b to a) would otherwise take the
  // two chains in opposite orders and wait on each other forever.
  //
  // Only the innermost step is capped. Capping every step started the outer slug's clock before
  // the inner slug's queue wait, so a rename standing behind two healthy writes on the second
  // name was answered 503 at the ceiling without either write going near it, and then landed
  // anyway a moment later.
  function withMetaChains(slugs, run) {
    const keys = [...new Set(slugs)].sort();
    const inner = keys[keys.length - 1];
    let answer;
    const caller = new Promise((resolve, reject) => { answer = { resolve, reject }; });
    // Both names, so a wedged write on either one answers this caller instead of parking it.
    const state = queueAnswer(keys, caller);
    const innermost = () => {
      if (state.settled) return undefined;
      const work = start(run);
      capped(inner, work).then(answer.resolve, answer.reject);
      return work;
    };
    keys.reduceRight((next, key) => () => chainOn(key, next), innermost)().catch(() => {});
    return state.promise;
  }

  return { withMetaChain, withMetaChains };
}
