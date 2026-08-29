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

// Drop what the conversion left behind. The caller runs this AFTER meta.json names the new type
// and BEFORE flush, so a crash in between leaves the old record whole rather than a listed
// artifact with no body, and git carries the deletions in the same commit as the write.
//
// It lives here rather than inline in server.js so a test can hand it a fake storage and prove
// the deletes are actually issued. No test boots server.js, so an inline loop was provably dead
// weight: neutering it to `for (const key of [])` left both suites green on all five backends.
//
// A delete that fails is logged, not thrown. The write has already landed and meta already names
// the new type, so throwing would turn a successful replace into a 500 the caller would retry.
export async function dropStaleObjects(storage, slug, oldType, newType) {
  const dropped = [];
  for (const key of staleKeys(slug, oldType, newType)) {
    try {
      await storage.delete(key);
      dropped.push(key);
    } catch (err) {
      console.warn(
        `storage: could not drop ${key} after a type change: ${err.message}. ` +
          'The artifact is fine and nothing serves that file. Nothing retries, so remove it by hand.',
      );
    }
  }
  return dropped;
}
