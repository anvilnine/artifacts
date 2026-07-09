# Deploying

How to run artifacts on your own infrastructure. ([← back to README](../README.md))

## docker compose (recommended)

```bash
git clone https://github.com/kuyazee/artifacts && cd artifacts
ARTIFACTS_API_KEY=$(openssl rand -hex 32) BASE_URL=https://artifacts.example.com docker compose up -d
```

## docker

```bash
docker run -d -p 3000:3000 -v artifacts-data:/data \
  -e ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
  -e BASE_URL=https://artifacts.example.com \
  ghcr.io/kuyazee/artifacts:latest
```

## bare node

```bash
npm ci
ARTIFACTS_API_KEY=$(openssl rand -hex 32) BASE_URL=https://artifacts.example.com node server.js
```

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `ARTIFACTS_API_KEY` | yes | — | Bearer token for all writes and the MCP endpoint |
| `BASE_URL` | recommended | `http://localhost:3000` | Public origin used in returned URLs |
| `DATA_DIR` | no | `/data` | Where artifacts are stored (plain files) |
| `PORT` | no | `3000` | Listen port |

## Any Dockerfile PaaS

Works on Coolify, CapRover, Dokploy, Railway, and similar: expose port `3000`, mount a volume at `/data`, set the two env vars. A health endpoint exists at `GET /healthz`.

Note for Coolify specifically: the `node:22-slim` image has no `curl`/`wget`, so leave Coolify's container healthcheck **disabled** — enabling it marks the container unhealthy and blocks routing. Use `/healthz` from an external monitor instead.

## Deployment rule (security)

Uploaded HTML executes on this origin — that's the product. Host the service on a **dedicated subdomain that serves nothing else and never sets cookies**. See [SECURITY.md](../SECURITY.md) for the full security model.
