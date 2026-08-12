# Auth & API keys

Two credential types, split by who is calling. ([← back to README](../README.md))

- **Admin session** — a human logs into the dashboard with a username + password. Backed by a signed, HttpOnly session cookie. One admin account per instance.
- **Managed API keys** — scoped bearer tokens for machines (CLI, MCP, scripts). Named, revocable, optionally expiring, with last-used tracking.

The original `ARTIFACTS_API_KEY` still works: it is the all-scope **bootstrap admin bearer** — a break-glass token that authenticates writes, the MCP endpoint, and key management. It is required at boot. Prefer minting scoped managed keys for daily use.

Everything is stored under a reserved `auth.json` object through the same storage backend as your artifacts, so it survives a container restart on every backend (local/s3/git/postgres/sqlite) with no database migration. Passwords are scrypt-hashed; API keys are stored as sha256 hashes with only an `ah_xxxxxxxx…` prefix kept for display — the full token is shown once at creation and is not recoverable.

## First-run setup

On first boot no admin exists. Either:

- Open the dashboard — it shows a one-time **Create admin account** screen (username + password). Whoever creates it is the admin; no second account can be created afterward.
- Or seed it from env before boot:

```bash
ARTIFACTS_ADMIN_USERNAME=admin
ARTIFACTS_ADMIN_PASSWORD=<a strong password>
```

### Seeding the admin from env

Both routes enforce the same two rules:

- Username: 3 to 32 characters from `a-z`, `A-Z`, `0-9`, `.`, `_` and `-`.
- Password: at least 8 characters.

The setup screen answers 400 on a value that breaks either rule. The env seed refuses to start
and prints which rule failed:

```
ARTIFACTS_ADMIN_USERNAME / ARTIFACTS_ADMIN_PASSWORD rejected: password must be at least 8
characters. Refusing to start. ...
```

Nothing is written on that path, so fix the two variables and boot again. The seed only runs
when there is no admin yet, so a stale value in the environment cannot lock you out of an
instance that already has one.

## Scopes

| Scope | Grants |
|---|---|
| `read` | list artifacts, read config, mint a share link, fetch an artifact's QR code, MCP `list_artifacts` |
| `publish` | create / replace / patch artifacts, all MCP mutation tools (implies `read`) |
| `full` | delete, write config, MCP `delete_artifact` (implies `publish`) |

A key carries one or more scopes; its effective level is the highest. Minting, listing, and revoking keys is **not** a scope — it requires the admin session or the bootstrap key. A managed key, even a `full` one, cannot manage keys.

## Managing keys

**Dashboard:** the key icon in the top bar → name it, tick scopes, optional expiry, Create. The full token is shown once (and copied to your clipboard). Revoke or disable from the same list.

**CLI** (needs the bootstrap admin key):

```bash
artifacts keys create laptop-cli --scopes publish
artifacts keys create ci --scopes read,publish --expires 2027-01-01
artifacts keys list
artifacts keys revoke <id>
```

**REST** (admin session cookie or bootstrap bearer):

| Method | Path | Body / result |
|---|---|---|
| `GET` | `/api/keys` | list (no secrets) |
| `POST` | `/api/keys` | `{ name, scopes?, expiresAt? }` → key shown once in `key` |
| `PATCH` | `/api/keys/:id` | `{ disabled: true\|false }` |
| `DELETE` | `/api/keys/:id` | revoke |

A key that answers `401` for no obvious reason may have a broken record in `auth.json`, which a
hand edit or a crash mid-write can leave behind. The server skips a record with no hash or no
scopes and names it at boot:

```
auth.json: ignoring 1 key record(s) with no hash or no scopes ("k_7fa2c1"). Revoke them on the key screen and mint new ones.
```

An `expiresAt` the server cannot read is the second way a record dies quietly. Anything that is
not an ISO date string counts, including a number, an object and a value in the wrong format.
The key answers `401` from that point on, and the key screen shows it as broken with Revoke as
the only action:

```
auth.json: 1 key record(s) carry an expiresAt nothing can read ("k_7fa2c1"). They return 401 from here on.
```

An expiry that has simply passed is not this. It reads back, the key screen prints the date, and
the key stops working for the reason it says.

## A corrupt auth.json

A single broken record is skipped. A file that does not parse at all is different: the server
refuses to start and prints one line.

```
auth.json failed to load: not valid JSON (Unexpected end of JSON input). Refusing to start. ...
```

It stops because the alternative is worse. Loading a blank record on a parse failure would drop
the admin account, both signing secrets and every managed key, and the next write would overwrite
the file for good. `POST /api/auth/setup` is unauthenticated and allowed whenever no admin exists,
so a blank record also lets the next visitor claim the instance. A truncated file is exactly what
a crash partway through a write leaves behind, so this is a real state, not a hypothetical.

The server does not touch the file, so the bytes on disk are whatever the failed write left.
To recover, pick one:

- **Restore from backup.** `auth.json` sits next to your artifacts on whichever backend you run
  (`DATA_DIR/auth.json` on local, the same prefix on S3, a row on Postgres/SQLite, a committed
  file on git). The git backend keeps history, so `git log` on the data repo has the last good
  copy.
- **Start over.** Move the file aside, then boot. You get the first-run setup screen again, and
  you re-mint every API key. Every capability share link already handed out stops working, since
  the secret that signed them is gone.

Either way, do it on a stopped instance. A running server answers from the copy of the record
it read at boot, so it would keep using the old admin and the old keys until it restarts.

## Auth endpoints (dashboard)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/session` | `{ authenticated, needsSetup }` |
| `POST` | `/api/auth/setup` | create the admin account (only while none exists) |
| `POST` | `/api/auth/login` | `{ username, password }` → sets session cookie |
| `POST` | `/api/auth/logout` | clears the cookie |
| `POST` | `/api/auth/password` | `{ currentPassword, newPassword }` (logged in) |

`POST /api/auth/login` is rate-limited to 10 failures per 15 minutes per client IP (a `429` with `Retry-After` after that); a successful login never consumes budget. Client-IP resolution honors `TRUST_PROXY` — see [rate limiting and the edge](deploy.md#rate-limiting-and-the-edge). Credential routes cap the request body at 16 kB.

A session cookie lasts 30 days from the login that issued it. The expiry is carried in the cookie
itself, so a cookie that does not name one, or names one the server cannot read as a number, is
refused rather than treated as a session with no end. The same rule covers capability links and
unlock cookies.

Changing the password signs out every other admin session on the instance that served the change. The browser making the change gets a fresh cookie and stays signed in, so use it if you think a session cookie leaked. On more than one replica it revokes nothing on its own, and the same goes for revoking a key: see [running multiple replicas](deploy.md#running-multiple-replicas). Capability links for private and password artifacts are signed with a separate secret and keep working; revoke those per artifact with `PATCH {"rotateToken": true}`.

## Using a key

Same as before — send it as a bearer token:

```bash
curl -H "Authorization: Bearer $KEY" https://artifacts.example.com/api/artifacts
```

Give CLI and MCP their own least-privilege keys (e.g. `publish`) so a leaked token can't delete or reconfigure, and revoke them individually without disturbing anything else.

The `/api/artifacts*` and `/api/config` routes accept the **admin session cookie as well as** a bearer key — that is how the dashboard calls them without carrying a token in the browser. `/mcp` stays bearer-only.

## Artifact visibility (a third, per-artifact credential)

Separate from admin/keys, each artifact can be `public`, `private` (the **default**), or `password` — see [Visibility](api.md#visibility). Viewing a gated artifact uses neither the admin session nor an API key.

- **`private`** is viewed through a **capability link**: the artifact's write returns a `?k=<token>` URL. Opening it sets a signed, HttpOnly unlock cookie scoped to `Path=/a/<slug>` and `302`s to a clean URL. No password is involved, so there is no admin-credential prompt on the artifact origin to phish. The token is an HMAC grant (`typ:'cap'`, bound to the slug and a per-artifact epoch) — no per-artifact secret is stored.
- **`password`** validates the artifact's own shared password at `POST /a/:slug/unlock`, which sets the same kind of unlock cookie. Rate-limited to 10 failures per hour per client IP + slug.

Both the capability token and the unlock cookie bind the artifact's epoch, so `PATCH {"rotateToken": true}` (bump the epoch) revokes every issued link **and** every live cookie for that slug on the next request. Absent a rotate, tokens lapse at `CAP_TOKEN_TTL_DAYS` (default 30) and cookies at their 7-day TTL.

A token has to carry an expiry to be accepted. Instances that ran with a non-numeric `CAP_TOKEN_TTL_DAYS` minted links with no usable expiry, and those links used to work forever; they are refused now. Re-share the artifact to hand out a fresh link.
