# REST API

Full HTTP reference, including zip-site deploys. ([← back to README](../README.md))

The `/api/artifacts*` and `/api/config` routes accept **either** an `Authorization: Bearer <key>` (a scoped [managed key](auth.md) or the bootstrap `ARTIFACTS_API_KEY`) **or** a valid admin session cookie (how the dashboard calls them). `/mcp` is bearer-only. Each write route enforces a minimum scope (below). Reads under `/a/` are public unless the artifact's [visibility](#visibility) is set.

```
POST   /api/artifacts        {content, type: html|jsx|tsx|md|redirect, slug?, title?, description?, ogImage?, tags?, project?, expiresAt?, frame?, visibility?, password?} → 201 {slug, url, visibility}   [publish]
POST   /api/artifacts/zip    raw zip body (?slug=&title=&description=&ogImage=&tags=&project=&expiresAt=&visibility=&password=) → 201 {slug, url, files, visibility}   [publish]
PUT    /api/artifacts/:slug  {content, type, title?, description?, ogImage?, tags?, project?, expiresAt?, frame?, visibility?, password?} → {slug, url, visibility}   [publish]
PATCH  /api/artifacts/:slug  {slug?, disabled?, expiresAt?, description?, ogImage?, tags?, project?, frame?, visibility?, password?, rotateToken?} → {slug, url, visibility}   [publish]
DELETE /api/artifacts/:slug                                                  → {deleted}   [full]
GET    /api/artifacts        list (?tag= and/or ?project= to filter)         → [...]   [read]
GET    /api/artifacts/:slug/link  mint a fresh share link, no mutation       → {url, visibility}   [read]
GET    /api/artifacts/:slug/qr    QR code for the canonical URL (?format=svg|png&scale=&margin=) → image   [read]
GET    /api/config                                                           → {frame: {enabled, default}, md: {font, width, size, theme}, baseUrl}   [read]
PUT    /api/config           {frame?: {enabled?, default?}, md?: {font?, width?, size?, theme?}} → updated config   [full]
GET    /a/:slug              rendered artifact, framed when active (public unless private/password)
GET    /a/:slug?k=<token>    capability-link exchange: sets the unlock cookie, 302s to a clean URL (private/password)
GET    /a/:slug?raw=1        bare artifact without the frame
GET    /a/:slug/source       original uploaded source, text/plain (for a redirect, the stored target)
POST   /a/:slug/unlock       {password} → sets a per-slug unlock cookie (password mode only)
```

The `[read|publish|full]` tag on each route is the minimum key scope required (`full` implies `publish` implies `read`). Admin session + managed-key endpoints (`/api/auth/*`, `/api/keys*`) are documented in [Auth & API keys](auth.md).

Semantics:

- Body limits: 10 MB JSON, 50 MB zip.
- `type: "redirect"` publishes a short link instead of a page: `content` is the target, and `GET /a/:slug` answers `301` with `Location: <target>`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The target must be an absolute `http://` or `https://` URL and cannot carry a username or password; anything else is a `400`. What gets stored is the normalized URL, capped at 2048 characters, in `meta.target` (which the 301 follows) and in the artifact body. Redirects are never framed and ignore `?raw=1`, and `GET /a/:slug/source` returns the stored target as `text/plain`. Full behavior, including what an open redirector costs you, in [Redirects](formats.md#redirects).
- `PUT` without `title` keeps the title already stored, the way it keeps `tags` and `project`. Send `"title": ""` to clear it back to the slug.
- A write that stores a redirect answers with `target`, the normalized URL it stored, which is not always the string that was sent.
- QR codes: `GET /api/artifacts/:slug/qr` returns an image of the artifact's canonical URL (`<base>/a/<slug>`, with the trailing slash for a zip site). `format` is `svg` (default) or `png`, `scale` is 1 to 16 pixels per module (default 8) and `margin` is 0 to 8 modules of quiet zone (default 4). Both take digits only: anything else, including a value out of range, is a `400` rather than a silent fallback. Rendering a PNG is the only synchronous CPU on a `read` route, which is what the scale ceiling is for. The code always carries the permanent link, never a capability link: a `?k=` token expires and can be revoked, and a printed code cannot be reissued. A scan of a password artifact lands on the unlock page; a private artifact answers `404` on its bare link, so make it public or password-protected before printing the code. A disabled or expired artifact still has a QR, the same way it still has a share link. Encoding is byte mode at error-correction level M, up to 666 bytes, generated in-process with no external service.
- Link previews: `description` and `ogImage` are what a chat app shows when someone pastes the link. `description` is one line, max 300 characters, with runs of whitespace collapsed to single spaces. `ogImage` must be an absolute `http://` or `https://` URL and cannot carry a username or password, capped at 2048 characters on the normalized URL; another artifact's URL works, a relative path does not, because the chat app fetches the image from its own base. Anything else is a `400`, not a silent drop. `PUT` keeps both when they are omitted, the way it keeps `tags` and `project`; `PATCH` with `""` clears one. Both ride `GET /api/artifacts`. The tags render in the viewer frame and in a markdown page, so an html, jsx or zip artifact carries them only while it is framed, and a redirect stores them and renders nothing. Full rules in [Link previews](formats.md#link-previews).
- `POST` with an existing slug → `409` (use `PUT` to update).
- Disabled artifacts return `404`; expired ones (`expiresAt` in the past) return `410`. Both keep their content — re-enable or clear/extend the expiry to serve again.
- Tags: an array of strings, or one comma-separated string (the only form the zip endpoint's `?tags=` accepts). Each tag must match `[a-z0-9][a-z0-9-]{0,31}`; max 10 per artifact. Input is lowercased and deduplicated. `PATCH` replaces the whole list; an empty list clears it. `PUT` without `tags` keeps the existing ones. Artifacts published before tags existed list as `"tags": []`. In the web UI, tags render as chips — click one to filter the list.
- Project: a single grouping label (one per artifact), distinct from tags. Unicode letters/digits, spaces, and `-` `_` `.`, starting with a letter or digit, max 64 chars; internal whitespace is collapsed and case is preserved. Matching (`?project=` and UI grouping) is **exact and case-sensitive** — `Acme` and `acme` are different projects. `PATCH` sets it; an empty string clears it. `PUT` without `project` keeps the existing one. `GET /api/artifacts?project=<name>` returns only that project's artifacts (an empty `?project=` is ignored, not a filter for "no project"). The web UI groups the list into collapsible sections per project (with a search box across project / title / slug / tags / a redirect's target).

## Viewer frame

`GET /a/:slug` can wrap the artifact in a slim top frame (title + copy-link + hide toggle) that loads the artifact in an iframe. `?raw=1` returns the bare artifact — it's the URL the frame's iframe points at, and the escape hatch for embedding. Redirects are the exception: they are never framed, and `?raw=1` still answers the 301.

Whether an artifact is framed resolves as `config.frame.enabled && (meta.frame ?? config.frame.default)`:

- **`GET/PUT /api/config`** manage the global config: `{frame: {enabled, default}}` (both booleans) plus the four markdown render settings documented in [Markdown render settings](formats.md#markdown-render-settings). `enabled` is the master switch; `default` applies to items with no per-item value. `PUT` accepts a partial `frame` or `md` object and merges it. The optional `FRAME_ENABLED` / `FRAME_DEFAULT` env vars (both default `true` when unset) supply the values while no config has been saved. The server writes nothing on boot. `config.json` appears the first time a `PUT` is accepted, which keeps the git backend from committing on every startup. It is a reserved key in whatever backend you run, landing at `DATA_DIR/artifacts/config.json` on the local one. A `PUT` writes all six fields at once, so once the server has saved it the env vars stop having any effect. Edit that file by hand and the rule is per field: anything missing or invalid falls back to the env var, then to the built-in default.
- **Per item**, the `frame` field on `POST` / `PUT` / `PATCH` is `true` (always framed), `false` (never framed), or — via `PATCH {"frame": null}` — cleared so the item inherits the global default.

`GET /api/config` also returns `baseUrl`, the `BASE_URL` the server builds artifact links from. It is not config and `PUT` ignores it: the dashboard needs it because the origin an operator opens the dashboard on is not always the origin artifact links use.

When the frame is globally disabled or off for an item, `/a/:slug` serves the artifact exactly as `?raw=1` does.

## Visibility

Each artifact has one of three access levels, set with the `visibility` field on `POST` / `PUT` / `PATCH` (and the `set_artifact_visibility` MCP tool / `artifacts visibility` CLI command). **New artifacts default to `private`** (set `DEFAULT_VISIBILITY=public` to restore link-is-access); an overwrite (`PUT`) or `PATCH` with no `visibility` keeps whatever the artifact already had.

- **`public`** — anyone with the unguessable link views it. The returned `url` is the bare `/a/<slug>`.
- **`private`** (default) — viewed through a **capability link**: the write returns `url` with a `?k=<token>` grant. Opening it sets a per-slug unlock cookie and `302`s to a clean URL. Without a valid token or cookie every serve path (`/a/:slug`, `?raw=1`, `/source`, zip assets) returns a byte-identical `404` — no password, no prompt, no existence leak. No per-artifact secret is stored.
- **`password`** — the link plus a shared password. `visibility: "password"` requires a `password` field; the top-level URL returns a prompt that accepts that per-artifact password, sub-resources `404` until unlocked.

The write response is `{ slug, url, visibility }`, plus `target` when the artifact is a redirect — `url` is the tokened capability link for `private`/`password`, the bare link for `public`. Mint a fresh link later without mutating the artifact via `GET /api/artifacts/:slug/link` → `{ url }`.

**Revocation.** `PATCH /api/artifacts/:slug {"rotateToken": true}` bumps a per-artifact epoch, invalidating every issued capability token **and** every live unlock cookie for that slug immediately; it returns a fresh `url`. Capability tokens expire on their own after `CAP_TOKEN_TTL_DAYS` (default 30).

The gate is enforced on all serve paths, so `?raw=1`, `/source`, and zip sub-assets never leak a locked artifact's body. Setting `visibility` to `public` or `private` clears any stored password. Sending `password` alone (while already in password mode) rotates it. The password is stored only as a scrypt hash — `GET /api/artifacts` returns `visibility` and a `hasPassword` boolean, never the hash or the epoch. `POST /a/:slug/unlock` (password mode only) is rate-limited to 10 failures per hour per client IP + slug (`429` with `Retry-After`), and scrypt verification runs off the event loop.

Publish a file:

```bash
jq -n --rawfile c page.html '{content: $c, type: "html"}' | \
  curl -s -X POST https://artifacts.example.com/api/artifacts \
    -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
    -H "Content-Type: application/json" -d @-
```

## Zip sites (multi-file static projects)

`POST /api/artifacts/zip` with the raw zip as the body deploys a whole static site (HTML + CSS + JS + images) under `/a/{slug}/`:

```bash
curl -s -X POST "https://artifacts.example.com/api/artifacts/zip?slug=my-site" \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
  -H "Content-Type: application/zip" \
  --data-binary @site.zip
# {"slug":"my-site","url":"https://artifacts.example.com/a/my-site/","files":12}
```

The archive is validated before anything is stored:

- must contain `index.html` at the root (a single shared top-level folder is stripped automatically, so `zip -r site.zip my-project/` works as-is)
- only static-hostable extensions are allowed (html, css, js/mjs, json, images, fonts, audio/video, pdf, wasm, source maps); anything else is rejected with the offending paths listed
- path traversal (`../`), absolute paths, and symlinks are rejected
- limits: 50 MB zip, 100 MB uncompressed, 2000 files; `__MACOSX/`, `.DS_Store`, `Thumbs.db` are ignored

A `404.html` at the root of the zip becomes the site's not-found page: any miss under `/a/{slug}/` serves it with a 404 status, and sites without one keep the plain-text `not found`. Locked artifacts are unaffected, they return the standard artifact-not-found page on every path. See [formats](formats.md#custom-not-found-page).

Rename, disable/enable, expiry, and delete all work the same as single-file artifacts. `PUT` (inline content) is refused on zip sites — delete and re-upload instead. The web UI accepts dropped `.zip` files. No MCP tool for zips (binary payload) — agents should use the curl call above or the [CLI](cli.md).
