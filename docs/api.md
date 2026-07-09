# REST API

Full HTTP reference, including zip-site deploys. ([← back to README](../README.md))

All `/api/*` and `/mcp` calls need `Authorization: Bearer $ARTIFACTS_API_KEY`. Reads under `/a/` are public.

```
POST   /api/artifacts        {content, type: html|jsx|tsx|md, slug?, title?, expiresAt?} → 201 {slug, url}
POST   /api/artifacts/zip    raw zip body (?slug=&title=&expiresAt=)         → 201 {slug, url, files}
PUT    /api/artifacts/:slug  {content, type, title?, expiresAt?}             → {slug, url}
PATCH  /api/artifacts/:slug  {slug?, disabled?, expiresAt?}                  → {slug, url}   (rename / disable / expiry)
DELETE /api/artifacts/:slug                                                  → {deleted}
GET    /api/artifacts        list                                            → [{slug, type, title, createdAt, updatedAt}]
GET    /a/:slug              rendered artifact (public)
GET    /a/:slug/source       original uploaded source, text/plain (public)
```

Semantics:

- Body limits: 10 MB JSON, 50 MB zip.
- `POST` with an existing slug → `409` (use `PUT` to update).
- Disabled artifacts return `404`; expired ones (`expiresAt` in the past) return `410`. Both keep their content — re-enable or clear/extend the expiry to serve again.

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

Rename, disable/enable, expiry, and delete all work the same as single-file artifacts. `PUT` (inline content) is refused on zip sites — delete and re-upload instead. The web UI accepts dropped `.zip` files. No MCP tool for zips (binary payload) — agents should use the curl call above or the [CLI](cli.md).
