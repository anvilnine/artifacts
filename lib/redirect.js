// Where a redirect artifact points: validating a target on the way in, and deciding which
// stored copy wins on the way out.
//
// This lives outside server.js so both halves can be tested without a running instance. The
// resolution rule in particular is not reachable through the API: every write fills meta.target,
// so the only way to exercise the fallback is to call this directly.

import { ApiError } from './errors.js';

// Longest target a redirect artifact may store, measured on the normalized URL.
export const MAX_REDIRECT_TARGET_LEN = 2048;

// The target of a redirect artifact, normalized. Checked again at serve time before it
// reaches a Location header, so a target that got past this (hand-edited storage, a file
// written by an older build) still cannot ship a non-http scheme to a viewer. That makes
// the length check run twice on the same string, so it measures the normalized href and
// not the input: percent-encoding can multiply a short input several times over, and a
// value that passed here but failed there would publish 201 and then serve 404 forever.
//
// `publishing` adds the checks that only make sense on the way in. A target already on disk
// keeps serving whatever it holds: refusing it at serve time would take a working redirect off
// the air on an upgrade, and that rule is about what a target costs its owner, not about what
// is safe to put in a Location header.
export function parseRedirectTarget(value, { publishing = false } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, 'content must be an absolute http:// or https:// URL for a redirect');
  }
  // The scheme allowlist is the point of this function: a stored `javascript:` or `data:`
  // target would turn a Location header into script execution on the viewer's click.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'content must be an absolute http:// or https:// URL for a redirect');
  }
  // Credentials in the target would show in the dashboard row, come back from the list API to
  // every read-scoped key, and reach the target host from anyone who scans or copies the link.
  // A redirect is a public hop, so there is no version of this that keeps them secret.
  if (publishing && (url.username || url.password)) {
    throw new ApiError(400, 'a redirect target cannot carry a username or password: strip the credentials before the host');
  }
  if (url.href.length > MAX_REDIRECT_TARGET_LEN) {
    throw new ApiError(
      400,
      `redirect target too long (${url.href.length} > ${MAX_REDIRECT_TARGET_LEN} characters once normalized)`,
    );
  }
  return url.href;
}

// Which stored copy of the target wins. meta.target is the authority; the artifact's source.url
// body is the fallback for a redirect published before meta carried one.
//
// Both copies hold the same string, written by the same call, but as two separate puts. While
// the serve path read the body and the dashboard row read meta, two concurrent PUTs to one slug
// could resolve differently: the row named a destination visitors never got, and a later PATCH
// (rename, tags, visibility) rewrote meta and carried the wrong one forward. meta.json is the
// commit marker in the storage write-ordering contract, so letting it decide keeps the two in
// step, including after a crash between the two puts.
//
// Every candidate is parsed before it is returned, and a candidate that fails falls through to
// the next: a meta.target that no longer parses (hand-edited storage, a value written by a build
// with different rules) then serves from the body instead of turning the slug into a permanent
// 404 with a working target sitting next to it.
//
// `readSource` is called only when meta has no usable target, so a normal serve costs no extra
// read. Returns null when no copy parses, which the caller answers as a 404.
//
// Named arguments on purpose: with two positional ones, swapping them at a call site would make
// the body authoritative again, and every test here would still pass because they call this
// directly. A named object cannot be wired backwards.
export async function resolveRedirectTarget({ meta, readSource }) {
  if (typeof meta?.target === 'string') {
    try {
      return parseRedirectTarget(meta.target);
    } catch {
      // unusable, so fall through to the body
    }
  }

  const buf = await readSource();
  // A zero-byte source.url is not a target: Buffer.alloc(0) is truthy, so this needs the length.
  if (!buf || buf.length === 0) return null;
  try {
    return parseRedirectTarget(buf.toString('utf8'));
  } catch {
    return null;
  }
}

// Does this target point back at the slug that is publishing it? A self-referencing redirect
// answers its own 301 with itself, so the visitor's browser hops until it hits its own limit
// and shows an error page. The server never follows a target, so nothing here amplifies, but
// nothing caught it either: the publisher found out from a browser, not from the API.
//
// "Points back" means this server's own /a/<slug> for this slug. The comparison is on the host
// (name and port) rather than the whole origin, because a proxy terminates TLS and the origin
// behind it still answers on the other scheme, so an http target for an https BASE_URL is the
// same loop. The path segment is decoded first: express decodes it out of the URL, so
// /a/%68op reaches the artifact named hop.
//
// What this does not catch: two artifacts pointing at each other, and a target on another host
// that redirects back here. Both need a lookup this publish does not have, and neither is what
// a typo produces.
export function pointsAtOwnSlug(target, slug, baseUrl) {
  if (!slug || !baseUrl) return false;
  let self;
  let url;
  try {
    self = new URL(baseUrl);
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.host !== self.host) return false;
  // Only the bare artifact path answers the 301. /a/<slug>/source serves the target as text
  // and every other subpath is a 404, so neither loops.
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false; // a path that will not decode reaches no artifact
  }
  return decoded === `/a/${slug}`;
}

// How many redirects each managed key has published, keyed by key id. GET /api/keys hands this
// to the operator next to the key's other facts, so a leaked publish-scoped key that has
// started minting phishing hops shows up as a count that does not match what the key is for.
//
// Nothing is capped. A cap changes what an existing key is allowed to do, which is the
// self-hoster's call, and a count they can see is what tells them to make it.
//
// Only artifacts carrying a keyId count, so redirects published by the bootstrap key or from a
// dashboard session are in nobody's total. A keyId that is not a string is a hand edit and
// matches no key, so it is left out rather than drawn as a row nothing owns.
export function countRedirectsByKey(metas) {
  const counts = new Map();
  for (const meta of metas) {
    if (meta?.type !== 'redirect') continue;
    if (typeof meta.keyId !== 'string' || !meta.keyId) continue;
    counts.set(meta.keyId, (counts.get(meta.keyId) || 0) + 1);
  }
  return counts;
}
