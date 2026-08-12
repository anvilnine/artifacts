// Whether an artifact has lapsed.
//
// This lives outside server.js so the shapes a request cannot produce can still be tested:
// parseExpiresAt refuses anything but an ISO string on the way in, so the values this guards
// against arrive from a hand-edited or restored meta.json, the same surface T1.2.11 and T1.2.20
// covered on the auth side.
//
// The rule is keyExpired's, applied to artifact metadata: absent means no expiry, and anything
// present that Date.parse cannot read counts as lapsed. Reading NaN as "not expired" is the
// direction that fails open, and it disables the auto-expire lifecycle the README promises for
// every record it touches.
export function artifactExpired(meta) {
  const value = meta.expiresAt;
  if (value === undefined || value === null || value === '') return false;
  const t = Date.parse(value);
  return Number.isNaN(t) || t <= Date.now();
}
