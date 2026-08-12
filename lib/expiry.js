// Whether an artifact has lapsed.
//
// This lives outside server.js so a unit test can hand it the shapes an API call cannot make.
// parseExpiresAt refuses anything but an ISO string on the way in, so the values below arrive
// from a hand-edited or restored meta.json, the same surface T1.2.11 and T1.2.20 covered on the
// auth side. CI reaches them the other way, by writing meta.json between two boots.
//
// The rule is keyExpired's, applied to artifact metadata: absent means no expiry, and anything
// present that cannot be read as a date counts as lapsed. Reading NaN as "not expired" is the
// direction that fails open, and it disables the auto-expire lifecycle the README promises for
// every record it touches.
//
// Non-strings are lapsed without asking Date.parse, because Date.parse stringifies first and
// then accepts more than an operator would expect: `12345` reads as the year 12345 and
// `["2026-01-01T00:00:00Z"]` reads as the string inside the array, so both would otherwise keep
// serving forever. Every value this server writes is an ISO string.
export function artifactExpired(meta) {
  const value = meta.expiresAt;
  if (value === undefined || value === null || value === '') return false;
  if (typeof value !== 'string') return true;
  const t = Date.parse(value);
  return Number.isNaN(t) || t <= Date.now();
}
