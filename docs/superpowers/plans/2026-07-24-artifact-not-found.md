# Artifact Not Found Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every artifact-unavailable 404 as an Anvil Nine branded HTML page without changing security behavior.

**Architecture:** `notFound(res)` remains the single response gate. It sends one fixed shell loaded at startup, so missing, disabled, and locked-private artifacts share byte-identical HTML. The shell owns its theme CSS and reads only the existing local theme preference.

**Tech Stack:** Node.js 22, Express, static HTML/CSS, Bash smoke test, curl.

## Global Constraints

- Keep HTTP status `404` and identical body behavior across all existing `notFound(res)` callers.
- Use no dependencies, API calls, artifact metadata, dashboard link, or form.
- Support OS light/dark preference plus `localStorage.artifactTheme` values `light` and `dark`.
- Use existing Molten Steel colors and public-shell typography conventions.
- Preserve first-party restrictive response headers and `Cache-Control: no-cache`.

---

### Task 1: Prove branded missing-page contract

**Files:**
- Modify: `.github/workflows/smoke.sh: after unauthenticated publish assertion`

**Interfaces:**
- Consumes: unauthenticated `GET /a/does-not-exist-zzz`.
- Produces: smoke assertion for `404`, `text/html`, and `Artifact unavailable`.

- [ ] **Step 1: Write failing smoke assertion**

Add after the unauthenticated-publish assertion:

```bash
# missing artifact -> branded HTML 404
notfound_headers=$(mktemp)
notfound_body=$(mktemp)
code=$(curl -s -D "$notfound_headers" -o "$notfound_body" -w '%{http_code}' "$BASE/a/does-not-exist-zzz")
expect_code 404 "$code" "missing artifact"
grep -qi '^Content-Type: text/html' "$notfound_headers" || fail "missing artifact is not HTML"
grep -q 'Artifact unavailable' "$notfound_body" || fail "missing artifact page copy missing"
rm "$notfound_headers"
rm "$notfound_body"
echo "ok: branded artifact-not-found page"
```

- [ ] **Step 2: Run smoke test before implementation**

Run:

```bash
bash .github/workflows/smoke.sh http://localhost:3000 test
```

Expected: fail at `missing artifact is not HTML`, because `notFound(res)` currently sends plain text.

### Task 2: Add shared unavailable-artifact shell

**Files:**
- Create: `shells/not-found.html`
- Modify: `server.js:497-500`, `server.js:656-658`, `server.js:688-692`

**Interfaces:**
- Consumes: no input; fixed page content.
- Produces: `buildNotFoundHtml(): string` and branded `notFound(res)` response.

- [ ] **Step 1: Create fixed shell**

Create `shells/not-found.html` with semantic `main`, a `404` eyebrow, heading `Artifact unavailable`, and this exact paragraph:

```html
<p>This link may be wrong, disabled, or no longer available. Check the link or ask its sender.</p>
```

Use `shells/password.html` theme shape: `#0b0d0f` forge background, `#101317` card,
`#242b33` border, `#edeae4` heading, `#9da3a9` body, `#f0502a` molten accent, Archivo
heading, Inter body, low-opacity molten radial glow, and 12px grid. Add an inline bootstrap
that reads `localStorage.getItem('artifactTheme')` and sets `data-theme` only for `light` or
`dark`. Do not add links, buttons, request-dependent text, or animation.

- [ ] **Step 2: Load and render shell**

Add alongside the existing shell constants:

```js
const NOT_FOUND_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'not-found.html'), 'utf8');
```

Add alongside the existing page builders:

```js
function buildNotFoundHtml() {
  return NOT_FOUND_SHELL;
}
```

Replace the existing `notFound` body with:

```js
function notFound(res) {
  return res.status(404).set({
    'Content-Security-Policy': FRAME_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  }).type('html').send(buildNotFoundHtml());
}
```

- [ ] **Step 3: Run smoke test after implementation**

Run:

```bash
bash .github/workflows/smoke.sh http://localhost:3000 test
```

Expected: complete with `all smoke tests passed`.

- [ ] **Step 4: Verify security response equality**

The smoke suite's existing `oracle uniformity` assertion compares a missing slug and a locked-private slug. Confirm it reports `ok: missing and locked-private return identical 404`.

- [ ] **Step 5: Commit implementation**

```bash
git add server.js shells/not-found.html .github/workflows/smoke.sh docs/superpowers/plans/2026-07-24-artifact-not-found.md
git commit -m "feat: brand artifact not-found page"
```
