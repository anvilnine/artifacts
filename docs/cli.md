# CLI

Everything the API does, from your terminal. ([← back to README](../README.md))

Ships with the repo (`cli.js`, no extra dependencies). Run it via `node cli.js`, or without cloning:

```bash
npx github:anvilnine/artifacts <command>
```

## Configuration

```bash
export ARTIFACTS_URL=https://artifacts.example.com
export ARTIFACTS_API_KEY=...
```

`--url` and `--key` flags override the env vars per invocation. `--key` accepts a scoped [managed key](auth.md) or the bootstrap `ARTIFACTS_API_KEY`; the `keys` subcommands below require the bootstrap admin key.

## Commands

```
artifacts publish <file> [--slug s] [--title t] [--tags a,b] [--project p] [--description d] [--og-image url] [--expires ISO] [--type html|jsx|tsx|md|pdf|redirect] [--frame on|off] [--visibility public|private|password] [--password pw]
artifacts deploy <dir|zip> [--slug s] [--title t] [--tags a,b] [--project p] [--description d] [--og-image url] [--expires ISO] [--visibility public|private|password] [--password pw]
artifacts update <slug> <file> [--title t] [--tags a,b] [--project p] [--description d] [--og-image url] [--type html|jsx|tsx|md|pdf|redirect]
artifacts list [--tag t] [--project p]
artifacts rename <slug> <new-slug>
artifacts disable <slug> | enable <slug>
artifacts frame <slug> <on|off|default>
artifacts pdf <slug> <standard|presentation|minimal|download-on|download-off|default>
artifacts visibility <slug> <public|private|password> [--password pw]
artifacts rotate <slug>          # invalidate every share link already handed out
artifacts expire <slug> <ISO-date|never>
artifacts tag <slug> <a,b,c|none>
artifacts project <slug> <name|none>
artifacts preview <slug> [--description <d|none>] [--og-image <url|none>]
artifacts delete <slug>
artifacts source <slug> [-o file]
artifacts qr <slug> [--png] [--scale n] [--margin n] [-o file]
artifacts config [--frame-enabled true|false] [--frame-default true|false]
                 [--brand-name <text|none>] [--brand-logo <path|data-uri|none>]
                 [--brand-favicon <path|data-uri|none>] [--brand-accent <color|none>]
                 [--brand-footer <text|none>]
artifacts keys list
artifacts keys create <name> [--scopes read,publish,full] [--expires ISO]
artifacts keys revoke <id>
artifacts sweep [--apply]        # host-side cleanup, see Sweep below
```

Type is inferred from the file extension (`.html`, `.jsx`, `.tsx`, `.md`, `.pdf`); pass `--type` to override. `update` always sends a type, so the file you hand it decides what the artifact becomes: pointing it at a `.html` file rewrites an md artifact as an html page and deletes the markdown source. The type on the way in has to match the type you want on the way out, and `--type` says it when the extension does not. An extension the CLI cannot place is an error before anything is sent, so a `.txt` never converts an artifact by accident. A `.pdf` is read as bytes and sent base64-encoded, and `source` writes bytes too, so `artifacts source q3-report -o copy.pdf` gives back the file that went up. A redirect has no extension to infer from, so it needs `--type redirect` and a file holding the target URL: `artifacts publish target.txt --type redirect --slug pricing`. Repoint one the same way with `update`: `artifacts update pricing new-target.txt --type redirect`, which keeps the title and everything else. The target cannot carry a username or password, and cannot point back at the slug it is published under. `keys list` prints how many redirects each key has minted, on keys that have minted any. `deploy` zips a directory for you and posts it to the zip endpoint. `tag` replaces an artifact's tags (`none` clears them); `list --tag` shows only artifacts carrying that tag.

`pdf` sets a PDF artifact's viewer controls, one setting per call: a mode (`standard`, `presentation`, `minimal`), `download-on` / `download-off`, or `default` to reset both. Turning downloads off only removes the viewer's buttons; the file's URL still answers with the bytes. See [PDF](formats.md#pdf).

`qr` prints an SVG of the artifact's permanent URL to stdout, so it pipes into a file or a viewer:
`artifacts qr pricing > pricing.svg`. `-o out.png` writes a PNG (the extension picks the format,
the same way `publish` infers a type), and `--png` says so explicitly; either way a PNG needs
`-o <file>`, because a PNG on a terminal is noise. `--scale` sets pixels per module (1 to 16,
default 8) and `--margin` the quiet zone in modules (0 to 8, default 4).

## Sweep

`artifacts sweep` removes content files no artifact serves any more. A type change used to
write the new type's files and leave the old type's behind, so an install that has been
converting artifacts since before that was fixed still has them on disk: an `index.html` and a
`source.html` under a slug whose `meta.type` is now `md`, and so on. Nothing serves them, they
are copied into every duplicate, and on the git backend they are in every commit.

It is the one verb that does not talk to a running server. It opens the same store the server
uses, so run it on the host with the server's environment:

```bash
DATA_DIR=/data node cli.js sweep                     # prints what it would remove, removes nothing
DATA_DIR=/data node cli.js sweep --apply             # removes it
DATA_DIR=/data node cli.js sweep --apply --older-than 1   # and lower the age floor to 1 hour
# in the container:
docker compose exec app node cli.js sweep --apply
```

Set `STORAGE_BACKEND` and that backend's variables the same way if you are not on the default
local store. Run it once; it is safe to run again, and a second run finds nothing. It reads
each `meta.json` and never writes one, and it only removes keys the artifact's own type does
not own, so a zip site and a record it cannot parse are left alone.

**Publishing while it runs is safe.** The sweep reads every record up front, so a `PUT` that
converts an artifact after that read used to have it delete the files the new type had just
written, leaving a listed artifact with a `meta.json` and no body. Two things stop that now. A
file is only removed once it is older than 24 hours, which the orphans this verb exists for
always are and a file a conversion just wrote never is; and the record is read again immediately
before each delete, so a conversion that landed mid-run is seen. Anything held back is listed
with the reason, so `--apply` says what it kept as well as what it removed.

`--older-than <hours>` moves that floor, and `--older-than 0` turns it off. Two reasons to reach
for it. One: the orphans are known-old and you want them gone now, on a host nobody is publishing
to. Two: the `sqlite` and `postgres` stores keep no timestamp, so the sweep cannot tell how old a
file is there and keeps everything by default; `--older-than 0` is the only way to sweep those,
and on those two the mid-run re-read is the only guard left, so run it when nothing is publishing.

## API keys

Mint scoped bearer tokens for CLI/MCP clients instead of sharing the bootstrap key. `keys create` prints the full token once (store it) — the server keeps only a hash. `--scopes` defaults to `publish`. See [Auth & API keys](auth.md).

## Link previews

`--description` and `--og-image` set what a chat app or a social card shows when someone pastes the
link. Both take a value on `publish`, `deploy` and `update`, and `artifacts preview <slug>` sets
either one on an artifact that is already up:

```bash
artifacts preview hello --description "Q3 numbers, one page"
artifacts preview hello --og-image https://cdn.example.com/card.png
artifacts preview hello --og-image none        # clear just the image
```

Either flag on its own leaves the other field alone. `none` clears a field, the same word `tag` and
`project` take. The image has to be an absolute `http://` or `https://` URL, and a description is
capped at 300 characters after whitespace collapses. `artifacts list` marks a row `preview` when
either field is set.

Setting a preview that nothing will render prints a warning to stderr:

```
$ artifacts preview hello --description "Q3 numbers, one page"
hello description: Q3 numbers, one page
warning: The frame is off for this artifact, so it serves its file untouched and the preview tags have nowhere to go. Turn the frame on to make the preview show.
```

The value is stored either way, and `artifacts list` still marks the row. The warning says the tags
will not reach a reader until the frame is on for that artifact (`artifacts frame hello on`). An md
or pdf artifact never gets the warning, because the server renders those pages itself and puts the
tags in the head it builds. A redirect gets a different line: it answers `301` with no page, so a
preview never shows for one. Which pages carry the tags is in [formats](formats.md#link-previews).

## Projects

A **project** groups artifacts built for the same thing (one project per artifact, distinct from tags). Set it with `publish --project acme-redesign`, change it with `artifacts project <slug> <name>` (`none` clears it), and list a project with `artifacts list --project acme-redesign`. The web UI groups the published list into collapsible sections per project, with a search box across project / title / slug / tags.

## Viewer frame

Artifacts can render inside a slim top **frame** (title + copy-link + a hide toggle), like Claude/Gemini/ChatGPT artifacts. It's controlled at three levels:

- **Globally** — `artifacts config --frame-enabled true|false` (master switch) and `--frame-default true|false` (default for items with no setting). Run `artifacts config` with no flags to print the current config.

The same verb carries the five branding flags. A flag you leave out is not sent, so one run can set one field without disturbing the rest, and `none` clears a field. A logo or favicon has to be a path on the server or a `data:` image URI: remote URLs are refused, because the viewer pages only load images from their own origin and a hotlinked logo would be a third-party request from every page someone opens. Full field rules in [the API reference](api.md#branding).
- **Per item** — `artifacts frame <slug> on|off|default` (`default` clears the override so the item inherits the global default). `publish --frame on|off` sets it at creation time.

Add `?raw=1` to any artifact URL to view it without the frame (this is the URL the frame's iframe loads).

## Visibility

Each artifact is `private` (the **default** — viewed through a capability `?k=` link, no password), `public` (bare link is access), or `password` (a shared password you hand out). Publish/visibility/deploy print the shareable `url` — a tokened capability link for `private`/`password`, the bare link for `public`. Set it at creation with `publish --visibility public` / `--visibility password --password <pw>`, or change it later with `artifacts visibility <slug> <level> [--password pw]`. `artifacts rotate <slug>` bumps the artifact's epoch, invalidating every link you have already shared, and prints a fresh one. See [visibility](api.md#visibility) for how the gate, capability link, and unlock cookie work.

## Examples

```bash
artifacts publish page.html --slug hello
# https://artifacts.example.com/a/hello

artifacts deploy ./my-site --slug my-site
# https://artifacts.example.com/a/my-site/ (12 files)

artifacts expire hello 2026-12-31T00:00:00Z   # auto-410 after this date
artifacts expire hello never                  # clear expiry

artifacts tag hello demo,report               # replace tags
artifacts list --tag demo                     # only artifacts tagged "demo"

artifacts project hello acme-redesign         # file it under a project
artifacts list --project acme-redesign        # only that project's artifacts

artifacts preview hello --description "Q3 numbers, one page"   # link preview text
artifacts preview hello --og-image none                        # drop the preview image

artifacts config --frame-enabled true --frame-default true   # turn the frame on globally
artifacts config --brand-name Dropkiln --brand-accent '#0055ff'
artifacts config --brand-logo /a/brand-kit/logo.png          # a path here, or a data: URI
artifacts config --brand-footer none                         # clear one field
artifacts frame hello off                                     # no frame for this one artifact
artifacts frame hello default                                 # back to inheriting the default
```
