# artifacts

Self-hosted, Claude-style artifact publishing. POST HTML / a React component / Markdown / a zipped
static site, get back an unguessable URL on your own domain. One container, single admin account, no
database by default (plain files under `/data`); optional S3 / git / Postgres / SQLite backends. No
build step, Node >= 22. The end-to-end suite is `bash .github/workflows/smoke.sh <url> <key>`; unit
tests run with `npm test`.

Read the [README](README.md) and `docs/` before working on a feature.

## Domains

This product is being renamed to **Dropkiln** (`docs/superpowers/plans/backlogs/backlog-6-rebrand.md`).
Both domains are bought and both now resolve through Cloudflare nameservers on the Anvil Nine
Cloudflare account, as of 2026-08-06:

- `dropkiln.com` = company and product: marketing, docs, blog, dashboard at `app.dropkiln.com`,
  email. Cookies live here.
- `dropkiln.app` = user content only: tenant sites and artifacts at `<name>.dropkiln.app`. Wildcard,
  Cloudflare for SaaS custom hostnames, and the routing Worker all attach to this zone. Never set a
  dashboard cookie here.

Backlog 6 T6.1.1 said `anvilnine.com` would stay off Cloudflare. That is no longer true; all five
Anvil Nine zones are on the one account now. Nothing about the `.com` / `.app` split changes.

Current state worth knowing before you plan anything DNS-shaped: both apexes have proxied A records
pointing at an origin that is down, so `https://dropkiln.com` returns **522**. Neither zone has a
DMARC record, so the T6.1.2 parking task (null MX + SPF + DMARC on both) is still open. Org-level
table: `../docs/domains.md`.

## Writing docs (README, docs/, PR bodies, comments)

Follow the org-wide prose rules in the parent `anvilnine/CLAUDE.md`.

Repo-specific check: before committing a README change, run `grep -n "—\|–" README.md` and confirm
it returns nothing.
