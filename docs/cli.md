# CLI

Everything the API does, from your terminal. ([← back to README](../README.md))

Ships with the repo (`cli.js`, no extra dependencies). Run it via `node cli.js`, or without cloning:

```bash
npx github:kuyazee/artifacts <command>
```

## Configuration

```bash
export ARTIFACTS_URL=https://artifacts.example.com
export ARTIFACTS_API_KEY=...
```

`--url` and `--key` flags override the env vars per invocation.

## Commands

```
artifacts publish <file> [--slug s] [--title t] [--expires ISO] [--type html|jsx|tsx|md]
artifacts deploy <dir|zip> [--slug s] [--title t] [--expires ISO]
artifacts update <slug> <file>
artifacts list
artifacts rename <slug> <new-slug>
artifacts disable <slug> | enable <slug>
artifacts expire <slug> <ISO-date|never>
artifacts delete <slug>
artifacts source <slug> [-o file]
```

Type is inferred from the file extension (`.html`, `.jsx`, `.tsx`, `.md`); pass `--type` to override. `deploy` zips a directory for you and posts it to the zip endpoint.

## Examples

```bash
artifacts publish page.html --slug hello
# https://artifacts.example.com/a/hello

artifacts deploy ./my-site --slug my-site
# https://artifacts.example.com/a/my-site/ (12 files)

artifacts expire hello 2026-12-31T00:00:00Z   # auto-410 after this date
artifacts expire hello never                  # clear expiry
```
