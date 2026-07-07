# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/kuyazee/artifacts/security/advisories/new) — do not open a public issue. You should get a response within a few days.

## Security model (what is and isn't a bug)

This service intentionally executes uploaded HTML/JS in the visitor's browser — that's the product. The boundaries that **are** enforced:

- **Writes require the bearer key.** Any way to create, modify, or delete artifacts without `ARTIFACTS_API_KEY` is a vulnerability.
- **Reads are gated by unguessable slugs.** Any way to enumerate or list artifacts without the key is a vulnerability.
- **The filesystem is contained.** Path traversal out of an artifact's directory (via URLs or zip contents) is a vulnerability.
- **Artifacts must not be indexable** (`X-Robots-Tag`, `robots.txt`).

Not vulnerabilities:

- Uploaded content doing arbitrary things *within its own page* (that's by design — deploy on a dedicated subdomain that serves nothing else and sets no cookies, as the README instructs).
- Issues requiring possession of the API key.
