# Deploying

How to run artifacts on your own infrastructure. ([← back to README](../README.md))

## docker compose (recommended)

```bash
git clone https://github.com/anvilnine/artifacts && cd artifacts
cp .env.example .env   # set ARTIFACTS_API_KEY and BASE_URL
docker compose up -d
```

Compose reads `.env` from the project directory. You can also pass the variables inline instead:

```bash
ARTIFACTS_API_KEY=$(openssl rand -hex 32) BASE_URL=https://artifacts.example.com docker compose up -d
```

## docker

```bash
docker run -d -p 3000:3000 -v artifacts-data:/data \
  -e ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
  -e BASE_URL=https://artifacts.example.com \
  ghcr.io/anvilnine/artifacts:latest
```

## bare node

```bash
npm ci
ARTIFACTS_API_KEY=$(openssl rand -hex 32) BASE_URL=https://artifacts.example.com node server.js
```

Or keep the configuration in a file: `cp .env.example .env`, edit it, then `npm run dev` (uses Node's built-in `--env-file`).

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `ARTIFACTS_API_KEY` | yes | — | Bootstrap admin bearer — all-scope break-glass key; also mints [managed keys](auth.md) |
| `ARTIFACTS_ADMIN_USERNAME` | no | — | Seed the admin account on first boot (else use the dashboard setup screen) |
| `ARTIFACTS_ADMIN_PASSWORD` | no | — | Password for the seeded admin account |
| `BASE_URL` | recommended | `http://localhost:3000` | Public origin in returned URLs; an `https://` value marks the session cookie `Secure` |
| `STORAGE_BACKEND` | no | `local` | Storage backend: `local`, `s3`, `git`, `postgres`, or `sqlite` |
| `DATA_DIR` | no | `/data` | `local` backend only — directory of plain files |
| `PORT` | no | `3000` | Listen port |
| `TRUST_PROXY` | no | `none` | Client-IP source for rate limiting: `none` (socket address), `cloudflare` (`CF-Connecting-IP`), or `xff` (last hop of `X-Forwarded-For`). See the security note below. |
| `DEFAULT_VISIBILITY` | no | `private` | Visibility for a new artifact when the caller gives none: `private` or `public`. Ships `private` (opt in to public). |
| `CAP_TOKEN_TTL_DAYS` | no | `30` | Lifetime of a capability share link (`?k=` token) for `private`/`password` artifacts. |

Day-to-day, give CLI and MCP clients scoped [managed API keys](auth.md) rather than the bootstrap key. Auth state (the admin account, two HMAC secrets, and the managed keys) persists under a reserved `auth.json` object through the storage backend, so it survives a restart on any backend that is itself durable (see [storage backends](#storage-backends)) with no migration. Like the frame config, it is loaded once at boot and cached in memory.

The two secrets are separate on purpose, and neither is written at boot:

- `adminSecret` signs the admin session cookie. It is generated the first time a session is issued, which is the first login or completing the dashboard setup screen.
- `sessionSecret` signs capability links (`?k=`) and the per-slug unlock cookies. It is generated at whichever comes first: completing the dashboard setup screen, or the first `private` or `password` publish.

Keeping them apart is what lets a password change sign out every admin session without breaking share links that are already out there.

`auth.json` holds both secrets, the admin password hash and salt, and a sha256 of every managed key, so treat it as a secret file. On the `local` backend it is `${DATA_DIR}/artifacts/auth.json`, written mode `0644`; `chmod 600` it and give it to the user the server runs as. The server does not tighten the mode for you.

### Running multiple replicas

Only `s3` and `postgres` can back a fleet. `local` and `sqlite` are single-host, and the `git` backend is single-writer by design ([git](#git-commit-every-change-to-a-git-remote)).

Do two things before the replicas start: set `ARTIFACTS_ADMIN_USERNAME` and `ARTIFACTS_ADMIN_PASSWORD` on every one of them, and make sure both HMAC secrets already exist in `auth.json`. Skip either and the fleet breaks a different way.

The env seed closes the setup screen. An instance with no admin serves an unauthenticated one-time `POST /api/auth/setup` that hands whoever calls it a full-scope admin session. Each replica decides that from its own memory, so a replica that has not seen an admin will accept a second setup and overwrite the account that already exists. Seeding from env makes every replica answer `409`.

The secrets have to pre-exist because a replica reads `auth.json` once at boot and never sees a secret written after it started. Log in on replica A before replica B has ever seen `adminSecret`, and B answers `401` to that cookie until it restarts. The env seed does not help here: it writes the account with both secrets still `null`.

Two ways to get the secrets in place:

- Boot one instance, complete setup or log in once, and publish one private artifact. That writes both. Then start the rest.
- Write them yourself before the first boot. On the `local` backend:

```bash
mkdir -p "$DATA_DIR/artifacts"
printf '{"version":1,"admin":null,"sessionSecret":"%s","adminSecret":"%s","keys":[]}\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$DATA_DIR/artifacts/auth.json"
chmod 600 "$DATA_DIR/artifacts/auth.json"
```

Generate each secret with `openssl rand -hex 32`, as above. A literal placeholder pasted from a document is a published secret, and nothing validates the field: a 4-character value is accepted as an HMAC key.

That block writes a whole `auth.json`, so use it only on a deployment that has never booted. Where one already has an admin or managed keys, edit the two secret fields in place; the block would delete both. On s3 the same object is `${S3_PREFIX}auth.json` in the bucket. On `postgres` it is a row rather than a file, so use the boot-once route there.

Check it took. A wrong path or a JSON typo is swallowed on load, and the instance boots looking healthy with both secrets `null` again, so read the object back and confirm both fields are non-null before starting the fleet.

### Changing a password or a key on a fleet

Stop every replica first. Change the credential on one. Start the rest.

That order is not a nicety. Each replica holds the whole auth record in memory and writes all of it back on any change, so the last writer wins over the entire object rather than over the field it touched. A replica running since before the change reverts it on its next write, and an ordinary authenticated read is enough to trigger one, because a key's `lastUsedAt` is refreshed through the same write path. Reproduced on two replicas over one `DATA_DIR`: a password change on A, one authenticated read on B, and the file is back to A's old `adminSecret`; after a restart the old password logs in and the new one is refused. The same clobber deletes a key minted on another replica and turns a disabled key back on, because those live in the same object.

The same load-once rule bites in both directions while a fleet is live, which is why the stop-first order matters:

- A managed key minted on one replica answers `401` everywhere else until each replica restarts. A key you revoke or disable on one replica keeps working everywhere else until each replica restarts.
- A password change rotates `adminSecret` only on the replica that served it. A stolen session cookie stays valid, with full admin scope, on every other replica for the rest of its 30-day life, and the old password itself still logs in there while the new one is refused. A password change on a live fleet revokes nothing by itself.

There is no zero-downtime version of this. A rolling restart leaves old and new replicas disagreeing, and the old ones can write their stale snapshot back over the change. To recover a fleet already in this state: stop every replica, read `auth.json` out of the backend and confirm both secrets are non-null, start one replica and confirm a login works, then start the rest.

Capability links are unaffected by all of it. They are signed with `sessionSecret` and checked against per-artifact state that is read from storage on every request, so `PATCH {"rotateToken": true}` does take effect across a fleet immediately.

The global config behaves like the auth record, for the same reason. See [storage backends](#storage-backends).

## Storage backends

By default artifacts are plain files under `DATA_DIR` — back up that directory and you have
backed up everything. This works great when the disk is durable (a mounted Docker volume, a
persistent PaaS disk).

On hosts where a restart reprovisions a **fresh container or VM with no attached volume**
(Fly Machines without a volume, Cloud Run, Heroku dynos, some free PaaS tiers), local disk is
wiped and artifacts are lost. Set `STORAGE_BACKEND=s3` to store them in a durable, external
S3-compatible bucket instead; the app then holds no local state and artifacts survive any
restart.

The global config (`GET`/`PUT /api/config`), covering the viewer frame and the markdown render
settings, is stored through the same backend, so it is as durable as your artifacts. It is loaded
once at boot and cached in memory; a running process picks up its own `PUT /api/config`
immediately, but if you run **multiple replicas** against a shared backend, other replicas apply a
runtime config change only after they restart.

`FRAME_ENABLED`/`FRAME_DEFAULT` and the `MD_*` vars set a fleet-wide default only while no config
has been saved. The first accepted `PUT` writes all six fields to the backend, and every replica
then reads those on restart and ignores the env vars. To change a saved setting across a fleet,
`PUT` it rather than editing env.

### S3 (and S3-compatible: R2, B2, MinIO, Spaces, Wasabi, GCS interop)

```bash
STORAGE_BACKEND=s3 \
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com \
S3_REGION=us-east-1 \
S3_BUCKET=my-artifacts \
S3_ACCESS_KEY_ID=... \
S3_SECRET_ACCESS_KEY=... \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
node server.js
```

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `S3_ENDPOINT` | yes | — | S3 API endpoint (e.g. `https://<accountid>.r2.cloudflarestorage.com` for R2) |
| `S3_BUCKET` | yes | — | Bucket name |
| `S3_ACCESS_KEY_ID` | yes | — | Access key |
| `S3_SECRET_ACCESS_KEY` | yes | — | Secret key |
| `S3_REGION` | no | `us-east-1` | Region (use `auto` for R2) |
| `S3_PREFIX` | no | — | Key prefix within the bucket, e.g. `artifacts/` |

The `aws4fetch` dependency is optional and only loaded when `STORAGE_BACKEND=s3`; a plain
`local` install never pulls it. The server runs a quick write/delete probe against the bucket
at startup and **refuses to boot** if it is unreachable or misconfigured, rather than coming
up empty.

> **Security — the bucket MUST be private.** Artifacts are always served *through* this app,
> so their hardening headers, `noindex`, and expiry/disable checks apply. A public bucket (or a
> browser-facing CDN/presigned URL) would bypass all of that and expose every artifact — see
> [SECURITY.md](../SECURITY.md). The bucket also holds `auth.json`, so a public one hands out
> both signing secrets and the admin password hash. Never make the bucket or its objects public.

### git (commit every change to a git remote)

Stores each artifact as files in a git repository and pushes every change to a remote
(GitHub, GitLab, Gitea, self-hosted). On boot the server clones/pulls the remote into a local
working copy, so a fresh container rehydrates from the remote. A nice side effect: full version
history of every artifact.

```bash
STORAGE_BACKEND=git \
GIT_REMOTE_URL=https://github.com/you/artifacts-store.git \
GIT_TOKEN=ghp_xxx \
GIT_BRANCH=main \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
node server.js
```

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `GIT_REMOTE_URL` | yes | — | `https://…` repo URL. **Must not contain credentials** (rejected at boot) |
| `GIT_TOKEN` | for private repos | — | Access token, sent only via the auth callback — never in the URL or logs |
| `GIT_USERNAME` / `GIT_PASSWORD` | alt. to token | — | Basic-auth alternative to `GIT_TOKEN` |
| `GIT_BRANCH` | no | `main` | Branch to read and write |
| `GIT_WORK_DIR` | no | `DATA_DIR` or `/data/git` | Local working-copy directory |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | no | `artifacts-host` / `artifacts@localhost` | Commit identity |

`isomorphic-git` is an optional dependency loaded only when `STORAGE_BACKEND=git` — it is pure
JavaScript (no `git` binary, no shell), so a slug or filename can never be run as a command.

> **Security & operational notes.**
> - **The remote MUST be private.** A public repo makes every artifact browsable and indexable
>   on the host, defeating unguessable slugs, `noindex`, and expiry/disable — see
>   [SECURITY.md](../SECURITY.md). `auth.json` is staged and pushed like any other object, so
>   the remote also carries both signing secrets, the admin password hash, and every managed
>   key's hash, and keeps them in history after a rotation.
> - **Single writer.** Run exactly one instance against a given branch. The git backend pushes
>   on every change; two concurrent writers would produce non-fast-forward rejections. A failed
>   push surfaces as a 5xx (the publish is not reported as durable).
> - Credentials come only from `GIT_TOKEN` / `GIT_USERNAME` / `GIT_PASSWORD` and are scrubbed
>   from error logs; a `GIT_REMOTE_URL` containing `user:pass@` is rejected at startup.
> - Binary assets in zip sites accumulate in git history; use a dedicated repo you can prune.

### Postgres

Stores each object as a row (blobs in a `bytea` column). Handy where you already run
Postgres — Railway, Render, Fly, Supabase, Neon all offer it in a click — and, being an
external server, it survives a fresh container with no local disk.

```bash
STORAGE_BACKEND=postgres \
DATABASE_URL=postgres://user:pass@host:5432/artifacts \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
node server.js
```

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `PGSSLMODE` | no | (TLS on) | Set `disable` for a local/non-TLS server |
| `PG_POOL_MAX` | no | `8` | Max pooled connections |

The `pg` dependency is optional and loaded only when `STORAGE_BACKEND=postgres`. The table is
created automatically on first boot; a failed connection refuses to start.

### SQLite

Stores everything in a single SQLite file with transactional writes — a nice portable option.

```bash
STORAGE_BACKEND=sqlite SQLITE_PATH=/data/artifacts.db \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) node server.js
```

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `SQLITE_PATH` | no | `${DATA_DIR}/artifacts.db` | Database file |

Uses Node's built-in `node:sqlite` — **no extra dependency**. Note that, like `local`, an
SQLite file is only as durable as the disk it sits on: it does **not** by itself survive a host
that wipes local storage on restart (use s3 / git / postgres for that, or replicate the file
with e.g. [Litestream](https://litestream.io)).

### Migrating local → S3

Because S3 object keys mirror the on-disk layout, no special tooling is needed — copy the
existing files up, then switch the backend:

```bash
aws s3 sync ./data/artifacts s3://my-artifacts        # or: rclone sync, for R2/B2/etc.
# then set STORAGE_BACKEND=s3 and the S3_* vars and restart
```

## Any Dockerfile PaaS

Works on Coolify, CapRover, Dokploy, Railway, and similar: expose port `3000`, mount a volume at `/data`, set the two env vars. A health endpoint exists at `GET /healthz`.

Note for Coolify specifically: the `node:22-slim` image has no `curl`/`wget`, so leave Coolify's container healthcheck **disabled** — enabling it marks the container unhealthy and blocks routing. Use `/healthz` from an external monitor instead.

## Deployment rule (security)

Uploaded HTML executes on the origin it is served from — that's the product. Serve **artifacts** (`/a/…`) from a **dedicated origin that serves nothing else**. The dashboard/API sets an admin session cookie; keeping artifacts on a separate origin ensures uploaded pages can never ride that cookie to call `/api/*`. Artifact responses never set the dashboard session cookie (the only cookie they set is a slug-scoped unlock cookie for gated artifacts). See [SECURITY.md](../SECURITY.md) for the full model.

## Rate limiting and the edge

The app rate-limits its two unauthenticated credential routes (`POST /api/auth/login`,
`POST /a/:slug/unlock`) in memory: 10 failures per window per client IP, failures only.
This is defense-in-depth, not a substitute for an edge limiter — run one.

**Behind cloudflared (recommended).** Every request reaches the origin from loopback, so
set `TRUST_PROXY=cloudflare` to key limits on `CF-Connecting-IP`. This is safe **only
because the tunnel is the sole ingress** — the origin has no open ports, so no client can
forge the header. If you ever expose the origin off-tunnel, this header becomes
attacker-controlled and per-IP limiting collapses; treat "cloudflared is the only path"
as a hard requirement. Add a Cloudflare WAF rate-limit rule on `/api/auth/login` and
`/a/*/unlock` as the primary layer.

**Behind a plain reverse proxy** (Traefik/Coolify without a CDN): set `TRUST_PROXY=xff`
only if the proxy strips inbound `X-Forwarded-For` and appends the real client — otherwise
leave it `none`.

**Threadpool.** Password hashing (scrypt) runs on the libuv threadpool, capped at 2
concurrent. The `local` and `sqlite` storage backends also use that pool for filesystem
work; if you see auth latency under load, raise `UV_THREADPOOL_SIZE` (e.g. `8`).
