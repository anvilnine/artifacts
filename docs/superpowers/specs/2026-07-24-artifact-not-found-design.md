# Artifact not found page

Date: 2026-07-24
Status: approved design, ready for implementation plan

## Goal

Replace the plain-text `artifact not found` response with a branded 404 page that
matches the Anvil Nine Molten Steel UI, while preserving the current security rule:
every unavailable artifact response has the same status, body, and behavior.

## Scope

- Apply one HTML page through the existing `notFound(res)` helper in `server.js`.
- Keep HTTP status `404`.
- Match existing public shells: forged-steel dark mode, light mode, Archivo headings,
  Inter body text, sharp card geometry, a restrained molten glow, and a subtle grid.
- Follow the OS color scheme by default. Honor the existing `artifactTheme` local-storage
  override when it is `light` or `dark`.
- Use only first-party inline HTML, CSS, and the existing font loading convention. No
  network request, form, artifact metadata, dashboard link, or client-side API call.

## Non-goals

- Do not distinguish missing, disabled, private, malformed, or expired-but-locked artifacts.
- Do not add recovery controls or a link search field.
- Do not alter password-gate, expired-artifact, dashboard, or artifact-frame behavior.

## User experience

The page centers a compact status card within the existing public-shell visual language:

```
              [ anvil mark ]

             Artifact unavailable
  This link may be wrong, disabled, or no longer
  available. Check the link or ask its sender.
```

`404` appears as a quiet technical label, not the main message. The page gives a recipient
next steps without claiming which unavailable state occurred. There is no CTA because this
artifact origin may not host the dashboard and a recovery control could imply an artifact exists.

## Technical design

1. Add `shells/not-found.html`, based on the theme structure in `shells/password.html`.
   It contains fixed copy and no template values.
2. Add a module-startup shell read and `buildNotFoundHtml()` helper beside existing shell
   builders in `server.js`.
3. Change `notFound(res)` to send `buildNotFoundHtml()` as HTML with status 404. Apply the
   same first-party restrictive `FRAME_CSP`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, and `Cache-Control: no-cache` headers used by the
   password gate.
4. Keep every existing `return notFound(res)` call untouched. This preserves one response
   shape for misses and locked private artifacts.

## Accessibility and motion

- Use semantic `main`, heading, and paragraph elements.
- Maintain AA contrast with current brand tokens in both themes.
- Do not introduce animation. The page remains stable under reduced-motion preferences.
- Set `color-scheme` so browser controls and system rendering agree with theme choice.

## Verification

1. Add a smoke assertion that a missing public artifact returns HTTP 404, HTML content type,
   and `Artifact unavailable` text.
2. Run the complete smoke suite: `bash .github/workflows/smoke.sh http://localhost:3000 test`.
3. Manually load a missing `/a/<slug>` URL in light and dark system modes, then with
   `localStorage.artifactTheme` set to `light` and `dark`.
4. Verify a locked private artifact renders the same 404 page and status as a missing one.

## Files

- `shells/not-found.html`
- `server.js`
- `.github/workflows/smoke.sh`
