// Which storage objects an artifact of each type owns, and what a type change leaves behind.
//
// This lives outside server.js so a unit test can walk every ordered pair of types without a
// server or a storage backend. saveArtifact only ever wrote: a PUT converting html to a redirect
// left index.html and source.html on disk, and the reverse left source.url. Nothing served them,
// because /a/:slug and /a/:slug/source both key off meta.type, so it was at-rest bloat that grew
// with every conversion.
//
// What this does NOT do: on the git backend the deletion is a commit like any other, so the old
// bytes stay in history and `git log -p` on the remote still hands them back. A private or
// password artifact's old body is readable to anyone with read access to GIT_REMOTE_URL, exactly
// as it was before. Reclaiming that needs a history rewrite, which is not something a publish
// request gets to do.

// The `source.<ext>` extension each type uses. /a/:slug/source reads it back.
export const SOURCE_EXT = { html: 'html', jsx: 'jsx', tsx: 'tsx', md: 'md', redirect: 'url', pdf: 'pdf' };

// html, jsx and tsx bake an index.html at publish time. md renders per request from source.md,
// a pdf builds its viewer page per request from source.pdf, and a redirect answers with a
// header, so none of those three owns one. A zip site is in neither list: its
// files live under site/ and no API path converts a zip to anything (storeArtifact refuses to
// replace one with inline content, storeZipArtifact 409s on a slug that exists), so a zip
// namespace only ever goes away whole, through deleteSlug.
const BAKES_INDEX = new Set(['html', 'jsx', 'tsx']);

// The content objects a stored artifact of this type owns. Never meta.json: the record belongs
// to the artifact, not to the type.
export function ownedKeys(slug, type) {
  const keys = [];
  if (BAKES_INDEX.has(type)) keys.push(`${slug}/index.html`);
  // hasOwn, not a plain lookup: a hand-edited meta.type of "constructor" or "toString" would
  // otherwise find a function on the prototype and build `source.function Object() {...}` as a
  // key. Nothing would match it, but a delete should not be built from a value off the chain.
  if (Object.hasOwn(SOURCE_EXT, type)) keys.push(`${slug}/source.${SOURCE_EXT[type]}`);
  return keys;
}

// The keys the old type owned that the new type does not. Empty when the type did not change
// and empty on a first publish, where there is no old type.
export function staleKeys(slug, oldType, newType) {
  if (!oldType || oldType === newType) return [];
  const kept = new Set(ownedKeys(slug, newType));
  return ownedKeys(slug, oldType).filter((key) => !kept.has(key));
}

// Every content key a namespace could be holding, whatever its type is now. staleKeys only
// names what the recorded old type owned, so an artifact that collected orphans before that
// cleanup existed (commit 3fa2a31) keeps them for good; this is the wider net the copy prune
// and the sweep need. site/ files are left out: they belong to a zip, and no API path converts
// a zip to anything.
function everyContentKey(slug) {
  const keys = new Set([`${slug}/index.html`]);
  for (const ext of Object.values(SOURCE_EXT)) keys.add(`${slug}/source.${ext}`);
  return [...keys];
}

// The content keys in a namespace that its own type does not own. A type this build does not
// know (zip, or a value somebody hand-edited) answers empty rather than calling every file an
// orphan, which would take a live zip site apart.
export function orphanKeys(slug, type) {
  if (!Object.hasOwn(SOURCE_EXT, type)) return [];
  const kept = new Set(ownedKeys(slug, type));
  return everyContentKey(slug).filter((key) => !kept.has(key));
}

// Ask the backend to remove a list of keys. A delete that fails is logged, not thrown: the
// write it follows has already landed, so throwing would turn a success into a 500 the caller
// would retry. It still tries every key rather than stopping at the first failure.
async function dropEach(storage, keys, why) {
  const dropped = [];
  for (const key of keys) {
    try {
      await storage.delete(key);
      dropped.push(key);
    } catch (err) {
      console.warn(
        `storage: could not drop ${key} ${why}: ${err.message}. ` +
          'The artifact is fine and nothing serves that file. Nothing retries, so remove it by hand.',
      );
    }
  }
  return dropped;
}

// Drop what the conversion left behind. The caller runs this AFTER meta.json names the new type
// and BEFORE flush, so a crash in between leaves the old record whole rather than a listed
// artifact with no body, and git carries the deletions in the same commit as the write.
//
// It lives here rather than inline in server.js so a test can hand it a fake storage and prove
// the deletes are actually issued. No test boots server.js, so an inline loop was provably dead
// weight: neutering it to `for (const key of [])` left both suites green on all five backends.
export function dropStaleObjects(storage, slug, oldType, newType) {
  return dropEach(storage, staleKeys(slug, oldType, newType), 'after a type change');
}

// Prune a fresh copy to what its type owns. copySlug carries every content object under the
// source namespace and prunes nothing, so duplicating an artifact that already held orphans
// minted a brand-new namespace carrying dead bytes on day one, and on the git backend committed
// them. The caller runs this after copySlug and before the copy's meta.json.
export function dropOrphanObjects(storage, slug, type) {
  return dropEach(storage, orphanKeys(slug, type), 'while pruning a copy');
}

// How old an orphan has to be before a sweep will remove it.
//
// The orphans this verb exists for are historical: a conversion left them behind before the
// T2.1.9 cleanup existed, so they are days or months old. A file caught in a live conversion is
// seconds old. Without the floor the two are indistinguishable, and they were: the sweep reads
// every meta up front, so a PUT that converted an artifact between the read and the delete had
// the sweep delete the files the NEW type owns, leaving a listed artifact with a lone meta.json
// and no body at all. An age floor makes that structurally impossible rather than merely
// unlikely, because the file a conversion just wrote is new.
export const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// Read a slug's type again, straight from the store.
async function currentType(storage, slug) {
  try {
    const buf = await storage.getBuffer(`${slug}/meta.json`);
    if (!buf) return null;
    return JSON.parse(buf.toString('utf8')).type;
  } catch {
    return null;
  }
}

function ageWords(ms) {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m old`;
  if (hours < 48) return `${hours.toFixed(1)}h old`;
  return `${Math.round(hours / 24)}d old`;
}

// The one-shot cleanup for an install that already has orphans on disk, run from
// `node cli.js sweep`. Walks every artifact, asks the store which of the keys its type does not
// own are really there, and removes them when `apply` is set. Safe to run more than once: a
// second run finds nothing. It reads meta.json and never writes it, so it cannot damage a
// record.
//
// Two guards stand between a candidate key and the delete, and both only matter when `apply` is
// set. The age floor above is the one that closes the race. The second is cheap insurance: the
// slug's meta is read again immediately before the delete, so a conversion that landed since
// listMetas is seen rather than assumed away.
//
// Returns `{ found, removed, kept }`. `found` is every orphan the walk saw, in the order it saw
// them. `removed` is what the deletes actually took. `kept` is one `{ key, why }` per orphan a
// guard held back, so the operator can read why a file the dry run named is still there.
export async function sweepOrphans(storage, { apply = false, minAgeMs = SWEEP_MIN_AGE_MS } = {}) {
  const found = [];
  const removed = [];
  const kept = [];
  const now = Date.now();
  for (const { slug, buffer } of await storage.listMetas()) {
    let type;
    try {
      type = JSON.parse(buffer.toString('utf8')).type;
    } catch {
      // A record this build cannot read says nothing about which files are dead, so the whole
      // namespace is left alone.
      continue;
    }
    for (const key of orphanKeys(slug, type)) {
      const info = await storage.head(key);
      if (!info) continue;
      found.push(key);
      if (!apply) continue;
      if (minAgeMs > 0) {
        if (typeof info.mtime !== 'number') {
          kept.push({
            key,
            why: 'this store does not report a file age, so the sweep cannot tell a historical '
              + 'orphan from a file a conversion just wrote. Pass --older-than 0 to remove it anyway',
          });
          continue;
        }
        const age = now - info.mtime;
        if (age < minAgeMs) {
          kept.push({ key, why: `${ageWords(age)}, under the age floor` });
          continue;
        }
      }
      // The record may have changed type since listMetas read it, which is exactly the case the
      // age floor is here for. Reading it again costs one small get per orphan and catches a
      // conversion that landed inside this run.
      const fresh = await currentType(storage, slug);
      if (fresh !== type) {
        kept.push({ key, why: `the artifact changed type to "${fresh}" while the sweep was running` });
        continue;
      }
      await storage.delete(key);
      removed.push(key);
    }
  }
  if (removed.length) await storage.flush?.();
  return { found, removed, kept };
}
