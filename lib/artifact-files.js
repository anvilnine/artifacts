// Which storage objects an artifact of each type owns, and what a type change leaves behind.
//
// This lives outside server.js so a unit test can walk every ordered pair of types without a
// server or a storage backend. saveArtifact only ever wrote: a PUT converting html to a redirect
// left index.html and source.html on disk, and the reverse left source.url. Nothing served them,
// because /a/:slug and /a/:slug/source both key off meta.type, so it was at-rest bloat, and on
// the git backend it was bloat that stayed in commit history after the artifact was deleted.

// The extension `source.<ext>` gets per type. /a/:slug/source reads it back.
export const SOURCE_EXT = { html: 'html', jsx: 'jsx', tsx: 'tsx', md: 'md', redirect: 'url' };

// html, jsx and tsx bake an index.html at publish time. md renders per request from source.md
// and a redirect answers with a header, so neither owns one. A zip site is in neither list: its
// files live under site/ and no API path converts a zip to anything (storeArtifact refuses to
// replace one with inline content, storeZipArtifact 409s on a slug that exists), so a zip
// namespace only ever goes away whole, through deleteSlug.
const BAKES_INDEX = new Set(['html', 'jsx', 'tsx']);

// The content objects a stored artifact of this type owns. Never meta.json: the record belongs
// to the artifact, not to the type.
export function ownedKeys(slug, type) {
  const keys = [];
  if (BAKES_INDEX.has(type)) keys.push(`${slug}/index.html`);
  if (SOURCE_EXT[type]) keys.push(`${slug}/source.${SOURCE_EXT[type]}`);
  return keys;
}

// The keys the old type owned that the new type does not. Empty when the type did not change
// and empty on a first publish, where there is no old type.
export function staleKeys(slug, oldType, newType) {
  if (!oldType || oldType === newType) return [];
  const kept = new Set(ownedKeys(slug, newType));
  return ownedKeys(slug, oldType).filter((key) => !kept.has(key));
}
