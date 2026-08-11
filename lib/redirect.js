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

// Which stored copy of the target the 301 follows. meta.target is the authority; source.url is
// the fallback for a redirect published before meta carried one.
//
// Both copies hold the same string, written by the same call, but as two separate puts. While
// the serve path read the body and the dashboard row read meta, two concurrent PUTs to one slug
// could resolve differently: the row named a destination visitors never got, and a later PATCH
// (rename, tags, visibility) rewrote meta and carried the wrong one forward. meta.json is the
// commit marker in the storage write-ordering contract, so letting it decide keeps the two in
// step, including after a crash between the two puts.
//
// `readSource` is called only when meta has no target, so a normal serve costs no extra read.
// Returns null when neither copy exists, which the caller answers as a 404.
export async function resolveRedirectTarget(meta, readSource) {
  if (typeof meta?.target === 'string' && meta.target !== '') return meta.target;
  const buf = await readSource();
  if (!buf) return null;
  return buf.toString('utf8');
}
