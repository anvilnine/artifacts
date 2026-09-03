#!/usr/bin/env bash
# End-to-end smoke test against a running artifacts-host instance.
# Usage: smoke.sh <base-url> <api-key>
#
# The key has to be the bootstrap key (ARTIFACTS_API_KEY) or an admin session. The MCP scope
# block mints a managed key, and POST /api/keys is admin-only: a managed key cannot manage
# keys, however many scopes it holds. Everything else in this file works with any full key.
set -euo pipefail

BASE=$1
KEY=$2
AUTH="Authorization: Bearer $KEY"
JSON="Content-Type: application/json"
fail() { echo "FAIL: $1" >&2; exit 1; }

expect_code() { # expect_code <expected> <actual> <label>
  [ "$2" = "$1" ] || fail "$3: expected $1, got $2"
  echo "ok: $3 -> $1"
}

# One field of one artifact out of GET /api/artifacts, printed exactly. Empty when the slug is
# not listed or the field is absent, so comparing the value also catches a row that vanished.
# Parsed with node, not grep: a '{' inside a target or a title splits any text scan of the
# payload, and a query string may legitimately carry one.
list_field() { # list_field <slug> <field>
  curl -s "$BASE/api/artifacts" -H "$AUTH" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const row = JSON.parse(s).find((a) => a.slug === process.argv[1]);
      const v = row ? row[process.argv[2]] : undefined;
      process.stdout.write(v === undefined ? "" : String(v));
    });' "$1" "$2"
}

# unauthenticated write -> 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$JSON" -d '{"content":"<h1>x</h1>","type":"html"}')
expect_code 401 "$code" "unauth publish"

# a body body-parser refuses -> 400 that names the format, not a 500. express.json() is in
# strict mode, so a bare `null`, `"x"` or `5` is refused before any route runs. Answering 500
# told the caller "the server broke" for a typo, and a retry loop keyed on 5xx retried a
# request that can never succeed.
for badbody in 'null' '"x"' '5' '{"content":'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" -d "$badbody")
  expect_code 400 "$code" "malformed body refused: $badbody"
done
curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" -d 'null' | grep -qF 'invalid JSON body' \
  || fail "the 400 does not name the problem"
# ...while a body the parser accepts and the route refuses still answers on the route's own
# terms, so the new parser branch did not swallow the messages every other 400 carries
curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" -d '{"type":"html"}' | grep -qF 'content (non-empty string) is required' \
  || fail "a valid body with a bad field lost its own message"
# nothing about the server leaks either way
if curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" -d 'null' | grep -qi 'syntaxerror\|at position\|/data/'; then
  fail "the 400 leaked the parser's internals"
fi
echo "ok: a malformed body answers 400 naming the problem"
# The other half of that handler, a real internal error answering a bare 500 with nothing about
# itself, has no trigger from outside a healthy server: every reachable throw is an ApiError.
# It is covered in test/errors.test.js rather than faked here.

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

# publish html -> 201. Explicit visibility:public because the server default is now
# private; the serve-path assertions below need a publicly viewable artifact.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" -d '{"content":"<h1>smoke</h1>","type":"html","slug":"ci-smoke","visibility":"public"}')
expect_code 201 "$code" "publish html"

# public raw read -> 200 and body contains content
body=$(curl -s "$BASE/a/ci-smoke?raw=1")
echo "$body" | grep -q "<h1>smoke</h1>" || fail "raw artifact body missing content"
echo "ok: raw artifact body served"

# framed view (frame is on by default) -> wrapper embeds the raw artifact in an iframe
body=$(curl -s "$BASE/a/ci-smoke")
echo "$body" | grep -q 'iframe' || fail "framed view missing iframe"
echo "ok: framed view served"

# global config -> defaults to frame enabled + on by default
curl -s "$BASE/api/config" -H "$AUTH" | grep -q '"enabled":true' || fail "config missing enabled:true"
# the dashboard reads baseUrl from here to caption a QR code; without it the caption would
# have to come from /link, which mints a capability token to print a URL
curl -s "$BASE/api/config" -H "$AUTH" | grep -qF "\"baseUrl\":\"$BASE\"" || fail "config missing baseUrl"
echo "ok: config endpoint"

# per-item frame off -> /a/slug serves the bare artifact (no iframe), then reset to inherit
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"frame":false}' > /dev/null
body=$(curl -s "$BASE/a/ci-smoke")
if echo "$body" | grep -q '<iframe'; then fail "frame:false still framed"; fi
echo "$body" | grep -q "<h1>smoke</h1>" || fail "frame:false body missing content"
echo "ok: per-item frame off"
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"frame":null}' > /dev/null
# T2.5.2: the contract the dashboard's Embed snippet and docs/embedding.md rest on. Three things
# have to hold at once for a paste into somebody else's page to work. The artifact sends no
# frame-ancestors and no X-Frame-Options, so a browser lets any page frame it. A frame load with
# no ?raw=1 still gets the bare artifact, because Sec-Fetch-Dest says it is a frame, so an embed
# never stacks a second toolbar. And the toolbar page itself refuses to be framed, which is what
# keeps the unlock prompt (same CSP) out of a page a viewer does not control. Headers go to a
# file rather than a pipe: grep -q exits on the first match and would SIGPIPE curl under pipefail.
embed_hdr=$(mktemp)
curl -s -D "$embed_hdr" -o /dev/null "$BASE/a/ci-smoke?raw=1"
if grep -qi '^x-frame-options' "$embed_hdr"; then fail "an artifact sends X-Frame-Options and cannot be embedded"; fi
if grep -i '^content-security-policy' "$embed_hdr" | grep -qi 'frame-ancestors'; then
  fail "an artifact's CSP names frame-ancestors and cannot be embedded"
fi
curl -s -D "$embed_hdr" -o /dev/null "$BASE/a/ci-smoke"
grep -i '^content-security-policy' "$embed_hdr" | grep -qF "frame-ancestors 'none'" \
  || fail "the viewer toolbar page can be framed"
rm "$embed_hdr"
embed_body=$(mktemp)
curl -s -H 'Sec-Fetch-Dest: iframe' -o "$embed_body" "$BASE/a/ci-smoke"
grep -q '<h1>smoke</h1>' "$embed_body" || fail "a frame load without ?raw=1 did not get the bare artifact"
if grep -q '<iframe' "$embed_body"; then fail "a frame load got the toolbar page and would stack two frames"; fi
rm "$embed_body"
echo "ok: an artifact can be embedded on another site, its toolbar page cannot"

# Writes to one slug run one at a time, and a write now has a ceiling: one that never comes back
# gives the slug back after 30s and answers 503 rather than parking every later write on that
# slug for the life of the process (lib/write-queue.js). A stalled backend cannot be provoked
# from out here, so this covers the half that can be: the queue passes a burst of writes to one
# slug, and the write after the burst still lands.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>queue</h1>","type":"html","slug":"ci-queue","visibility":"public"}' > /dev/null
queued=$(mktemp)
for n in 1 2 3 4 5; do
  curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$BASE/api/artifacts/ci-queue" \
    -H "$AUTH" -H "$JSON" -d "{\"description\":\"queued $n\"}" >> "$queued" &
done
wait
ok_writes=$(grep -c '^200$' "$queued" || true)
[ "$ok_writes" = "5" ] || fail "a queued write did not answer 200: $(tr '\n' ' ' < "$queued")"
rm "$queued"
curl -sf -X PATCH "$BASE/api/artifacts/ci-queue" -H "$AUTH" -H "$JSON" \
  -d '{"description":"after the burst"}' > /dev/null
[ "$(list_field ci-queue description)" = 'after the burst' ] || fail "the write after the burst did not land"
curl -sf -X DELETE "$BASE/api/artifacts/ci-queue" -H "$AUTH" > /dev/null
echo "ok: five writes to one slug, and the one after them, all land"

# source endpoint -> 200
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke/source")
expect_code 200 "$code" "source endpoint"

# disable -> public read 404
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"disabled":true}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke")
expect_code 404 "$code" "disabled artifact"

# re-enable + expire in the past -> 410
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"disabled":false,"expiresAt":"2020-01-01"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke")
expect_code 410 "$code" "expired artifact"

# A browser navigation gets a branded page, not the bare string, and it says expired rather than
# reusing the 404 copy. A reader who lands on a lapsed link needs to know the link was fine.
expired_headers=$(mktemp)
expired_body=$(mktemp)
code=$(curl -s -H 'Accept: text/html' -D "$expired_headers" -o "$expired_body" -w '%{http_code}' "$BASE/a/ci-smoke")
expect_code 410 "$code" "expired artifact page"
grep -qi '^Content-Type: text/html' "$expired_headers" || fail "expired artifact is not HTML"
grep -qi '^Vary: Accept' "$expired_headers" || fail "expired card has no Vary: Accept"
grep -q 'Artifact expired' "$expired_body" || fail "expired page copy missing"
grep -q '<p class="status">410</p>' "$expired_body" || fail "expired page does not show 410"
grep -q 'Artifact unavailable' "$expired_body" && fail "expired page reuses the 404 copy"
rm "$expired_headers"
rm "$expired_body"
echo "ok: branded artifact-expired page"

# ...and everything that is not a navigation keeps the one line it has always had. curl, fetch()
# and an embed send Accept: */*, and 3 kB of HTML in place of "artifact expired" is noise to all
# three. The sub-paths below split the same way; this is the top-level route doing it too.
expired_plain=$(mktemp)
expired_plain_headers=$(mktemp)
code=$(curl -s -D "$expired_plain_headers" -o "$expired_plain" -w '%{http_code}' "$BASE/a/ci-smoke")
expect_code 410 "$code" "expired artifact for a machine"
grep -qi '^Content-Type: text/plain' "$expired_plain_headers" || fail "expired artifact is not plain text for a machine"
grep -qi '^X-Content-Type-Options: nosniff' "$expired_plain_headers" || fail "expired plain body has no nosniff"
grep -qi '^Vary: Accept' "$expired_plain_headers" || fail "expired plain body has no Vary: Accept"
grep -q '^artifact expired$' "$expired_plain" || fail "expired body changed for a machine"
rm "$expired_plain"
rm "$expired_plain_headers"
echo "ok: the expired page splits by Accept"

# a sub-path read keeps the plain body for a machine and gives a person the card. curl sends
# Accept: */*, a browser navigation sends text/html.
curl -s "$BASE/a/ci-smoke/source" | grep -q '^artifact expired$' || fail "expired source body changed for a machine"
card=$(mktemp)
curl -s -H 'Accept: text/html' -o "$card" "$BASE/a/ci-smoke/source"
grep -q 'Artifact expired' "$card" || fail "expired source has no card for a browser"
rm "$card"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: text/html' "$BASE/a/ci-smoke/source")
expect_code 410 "$code" "expired source keeps its status for a browser"
echo "ok: expiry sub-path splits by Accept"

# clear expiry + rename -> new slug serves, old 404
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"expiresAt":null,"slug":"ci-smoke-2"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke-2")
expect_code 200 "$code" "renamed artifact"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke")
expect_code 404 "$code" "old slug gone"

# markdown render config -> defaults present in config
curl -s "$BASE/api/config" -H "$AUTH" | grep -q '"font":"system"' || fail "config missing md.font default"
echo "ok: md config defaults"

# invalid md enum -> 400 (no write happens)
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"md":{"font":"comic"}}')
expect_code 400 "$code" "invalid md.font rejected"

# accepted update -> round-trips through the storage backend and merges rather than
# replaces. Without this the suite only ever proves config READS work: every other
# config assertion here passes against defaults, so a broken write path stays green.
updated=$(curl -s -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"md":{"width":"wide"}}')
echo "$updated" | grep -q '"width":"wide"' || fail "config update did not apply md.width"
echo "$updated" | grep -q '"font":"system"' || fail "config update dropped untouched md.font"
echo "$updated" | grep -q '"enabled":true' || fail "config update dropped untouched frame block"
curl -s "$BASE/api/config" -H "$AUTH" | grep -q '"width":"wide"' || fail "config update did not persist"
echo "ok: config update round-trip + partial merge"
curl -sf -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"md":{"width":"normal"}}' > /dev/null

# publish md -> serve-time render carries the theme bootstrap and rendered body
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"# md smoke\n\nhi","type":"md","slug":"ci-md","visibility":"public"}' > /dev/null
mdbody=$(curl -s "$BASE/a/ci-md?raw=1")
echo "$mdbody" | grep -q '<h1>md smoke</h1>' || fail "md body not rendered"
echo "$mdbody" | grep -q 'artifactTheme' || fail "md shell missing theme bootstrap"
echo "ok: md serve-time render"

# framed md -> navbar theme toggle present; a non-md artifact has none
curl -s "$BASE/a/ci-md" | grep -q 'id="theme"' || fail "framed md missing theme toggle"
if curl -s "$BASE/a/ci-smoke-2" | grep -q 'id="theme"'; then fail "non-md artifact has theme toggle"; fi
echo "ok: md navbar theme toggle"

curl -sf -X DELETE "$BASE/api/artifacts/ci-md" -H "$AUTH" > /dev/null

# --- link previews: description + og:image in the heads the server renders ---
# Two pages carry them, both built per request: the viewer frame (every type) and the md render.
# A raw html view carries nothing, because those bytes are the author's document.
curl -s -X DELETE "$BASE/api/artifacts/ci-preview" -H "$AUTH" > /dev/null
curl -s -X DELETE "$BASE/api/artifacts/ci-preview-md" -H "$AUTH" > /dev/null

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>preview</h1>","type":"html","slug":"ci-preview","visibility":"public","description":"what this page is","ogImage":"https://example.com/preview.png"}')
expect_code 201 "$code" "publish with a description and an image"

framed=$(curl -s "$BASE/a/ci-preview")
printf '%s' "$framed" | grep -qF '<meta name="description" content="what this page is">' \
  || fail "framed view is missing the plain description tag"
printf '%s' "$framed" | grep -qF '<meta property="og:description" content="what this page is">' \
  || fail "framed view is missing og:description"
printf '%s' "$framed" | grep -qF '<meta property="og:image" content="https://example.com/preview.png">' \
  || fail "framed view is missing og:image"
printf '%s' "$framed" | grep -qF '<meta property="og:title" content="ci-preview">' \
  || fail "framed view is missing og:title"
# The canonical link, never the capability link: an unfurl outlives the paste it came from.
printf '%s' "$framed" | grep -qF "<meta property=\"og:url\" content=\"$BASE/a/ci-preview\">" \
  || fail "framed view og:url is not the canonical link"
printf '%s' "$framed" | grep -qF 'content="summary_large_image"' \
  || fail "an artifact with an image did not ask for the large card"
echo "ok: framed view carries the link preview"

# The author's own bytes stay the author's own bytes.
raw=$(curl -s "$BASE/a/ci-preview?raw=1")
if printf '%s' "$raw" | grep -q 'og:'; then fail "raw html view had preview tags spliced into it"; fi
printf '%s' "$raw" | grep -qF '<h1>preview</h1>' || fail "raw html view lost its body"
echo "ok: a raw html view is left alone"

# md renders its own head, so it carries the tags with the frame off, where no frame runs.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"# preview md","type":"md","slug":"ci-preview-md","visibility":"public","description":"a markdown page","frame":false}' > /dev/null \
  || fail "could not publish the md artifact the preview check reads"
mdpreview=$(curl -s "$BASE/a/ci-preview-md")
if printf '%s' "$mdpreview" | grep -q '<iframe'; then fail "the md preview case ran through the frame"; fi
printf '%s' "$mdpreview" | grep -qF '<meta property="og:description" content="a markdown page">' \
  || fail "md render is missing og:description"
printf '%s' "$mdpreview" | grep -qF 'content="summary"' \
  || fail "an artifact with no image did not ask for the plain card"
if printf '%s' "$mdpreview" | grep -q 'og:image'; then fail "md render invented an og:image"; fi
echo "ok: md render carries the link preview"

# A stored value naming a shell slot must not become the target of a later substitution. Before
# the shells were filled in one pass, a description of {{CONTENT}} put the whole rendered markdown
# body, unescaped, inside this attribute, and left the real body slot in the page as literal text.
curl -sf -X PATCH "$BASE/api/artifacts/ci-preview-md" -H "$AUTH" -H "$JSON" \
  -d '{"description":"{{CONTENT}}"}' > /dev/null || fail "could not set the placeholder description"
hijack=$(curl -s "$BASE/a/ci-preview-md")
printf '%s' "$hijack" | grep -qF '<meta name="description" content="{{CONTENT}}">' \
  || fail "a description naming a shell slot was not rendered as itself"
printf '%s' "$hijack" | grep -qF '<h1>preview md</h1>' \
  || fail "a description naming a shell slot ate the page body"
if printf '%s' "$hijack" | grep -q '^{{CONTENT}}$'; then fail "the content slot was left unfilled"; fi
curl -sf -X PATCH "$BASE/api/artifacts/ci-preview-md" -H "$AUTH" -H "$JSON" \
  -d '{"description":"a markdown page"}' > /dev/null
echo "ok: a description naming a shell slot cannot steal it"

# The tags follow the frame, so they reach every type, not only the two published above. A zip
# site also pins the trailing slash in the canonical URL, which no other case here covers.
curl -s -X DELETE "$BASE/api/artifacts/ci-preview-zip" -H "$AUTH" > /dev/null
zip_preview=$(mktemp -d)
printf '<h1>zip preview</h1>' > "$zip_preview/index.html"
(cd "$zip_preview" && zip -q -r site.zip index.html)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/artifacts/zip?slug=ci-preview-zip&visibility=public&description=a%20whole%20site&ogImage=https%3A%2F%2Fexample.com%2Fsite.png" \
  -H "$AUTH" -H 'Content-Type: application/zip' --data-binary @"$zip_preview/site.zip")
expect_code 201 "$code" "zip publish with preview fields on the query string"
zipframed=$(curl -s "$BASE/a/ci-preview-zip/")
printf '%s' "$zipframed" | grep -qF '<meta property="og:description" content="a whole site">' \
  || fail "a zip site's framed view is missing og:description"
printf '%s' "$zipframed" | grep -qF "<meta property=\"og:url\" content=\"$BASE/a/ci-preview-zip/\">" \
  || fail "a zip site's og:url is missing the trailing slash"
# And the query string answers to the same rules the JSON body does.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$BASE/api/artifacts/zip?slug=ci-preview-zip-2&ogImage=%2Frelative.png" \
  -H "$AUTH" -H 'Content-Type: application/zip' --data-binary @"$zip_preview/site.zip")
expect_code 400 "$code" "zip publish with a relative ogImage"
rm -r "$zip_preview"
curl -sf -X DELETE "$BASE/api/artifacts/ci-preview-zip" -H "$AUTH" > /dev/null
echo "ok: a zip site carries the preview, query string included"

# A title reaches og:title. Every other case here has no title, so dropping the title from the
# tag would leave them all green.
curl -sf -X PUT "$BASE/api/artifacts/ci-preview" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>preview</h1>","type":"html","title":"A Real Title"}' > /dev/null \
  || fail "could not set a title on ci-preview"
curl -s "$BASE/a/ci-preview" | grep -qF '<meta property="og:title" content="A Real Title">' \
  || fail "og:title does not carry the stored title"
# Every response stays out of a search index, which is what keeps these tags a preview feature
# rather than an SEO one. The docs say so; nothing asserted it before.
curl -s -D - -o /dev/null "$BASE/a/ci-preview" | grep -qi '^X-Robots-Tag: noindex, nofollow' \
  || fail "a framed page with a preview lost its noindex header"
echo "ok: og:title carries the title, and the page is still noindex"

# A private artifact's og:url is the permanent link, not the capability link it was reached
# through. On a public artifact the two strings are identical, so no case above can tell them
# apart, and pasting a live token into every unfurl is the failure that matters most here.
priv_url=$(curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"# private preview","type":"md","slug":"ci-preview-priv","visibility":"private","description":"a private page"}' \
  | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
case "$priv_url" in
  *'?k='*) ;;
  *) fail "publishing a private artifact returned no capability link ($priv_url)" ;;
esac
# The capability link 302s and sets the per-slug unlock cookie, so the page needs a jar: without
# one the followed request arrives with no cookie and answers 404, the same as a stranger's.
priv_jar=$(mktemp)
curl -s -c "$priv_jar" -o /dev/null "$priv_url"
privpage=$(curl -s -b "$priv_jar" "$BASE/a/ci-preview-priv")
rm "$priv_jar"
printf '%s' "$privpage" | grep -qF "<meta property=\"og:url\" content=\"$BASE/a/ci-preview-priv\">" \
  || fail "a private artifact's og:url is not the bare canonical link"
if printf '%s' "$privpage" | grep -q 'og:url[^>]*k='; then fail "og:url carried a capability token"; fi
curl -sf -X DELETE "$BASE/api/artifacts/ci-preview-priv" -H "$AUTH" > /dev/null
echo "ok: og:url is the permanent link, never the capability link"

# Both fields ride the list, so the dashboard can show what is set without fetching each page.
preview_row=$(curl -s -H "$AUTH" "$BASE/api/artifacts" | tr '{' '\n' | grep '"slug":"ci-preview"' || true)
printf '%s' "$preview_row" | grep -qF '"description":"what this page is"' \
  || fail "list is missing description (row: $preview_row)"
printf '%s' "$preview_row" | grep -qF '"ogImage":"https://example.com/preview.png"' \
  || fail "list is missing ogImage (row: $preview_row)"
echo "ok: the list carries both preview fields"

# A content-only PUT keeps them, the way it keeps tags and project.
curl -sf -X PUT "$BASE/api/artifacts/ci-preview" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>preview 2</h1>","type":"html"}' > /dev/null \
  || fail "could not overwrite ci-preview"
curl -s "$BASE/a/ci-preview" | grep -qF 'content="what this page is"' \
  || fail "a content-only PUT dropped the description"
echo "ok: a content-only PUT keeps the preview"

# '' clears one field and leaves the other alone.
curl -sf -X PATCH "$BASE/api/artifacts/ci-preview" -H "$AUTH" -H "$JSON" -d '{"description":""}' > /dev/null
cleared=$(curl -s "$BASE/a/ci-preview")
if printf '%s' "$cleared" | grep -q 'og:description'; then fail "an empty description did not clear"; fi
printf '%s' "$cleared" | grep -qF 'og:image' || fail "clearing the description also cleared the image"
echo "ok: an empty description clears just that field"

# Refusals. Each one is a 400 rather than a silent drop, so a typo is visible at publish time.
for bad in '{"ogImage":"/preview.png"}' '{"ogImage":"//example.com/p.png"}' \
  '{"ogImage":"javascript:alert(1)"}' '{"ogImage":"data:image/png;base64,AAAA"}' \
  '{"ogImage":"https://alice:s3cret@example.com/p.png"}' '{"ogImage":5}' '{"description":5}'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-preview" \
    -H "$AUTH" -H "$JSON" -d "$bad")
  expect_code 400 "$code" "refused preview field $bad"
done
# 301 chars: one over the cap, checked after whitespace collapses.
long_desc=$(printf 'x%.0s' $(seq 301))
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-preview" \
  -H "$AUTH" -H "$JSON" -d "{\"description\":\"$long_desc\"}")
expect_code 400 "$code" "over-long description"
# And the refusals stored nothing: the image from the publish above is still the one served.
curl -s "$BASE/a/ci-preview" | grep -qF '<meta property="og:image" content="https://example.com/preview.png">' \
  || fail "a refused preview field overwrote the stored one"
echo "ok: preview field validation"

curl -sf -X DELETE "$BASE/api/artifacts/ci-preview" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-preview-md" -H "$AUTH" > /dev/null

# --- a patch the server refuses never moves the artifact ---
# The rename moves storage, so every other field has to be parsed first. The 400 on its own was
# already true before this; what it hid was an artifact that had moved anyway, leaving a row whose
# link was dead and a live URL that appeared in no row.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>halfmove</h1>","type":"html","slug":"ci-halfmove","visibility":"public"}')
expect_code 201 "$code" "publish the rename-refusal artifact"
# One entry per field a patch can set, each carrying a rename the server must not perform.
for bad in '{"slug":"ci-halfmove-2","disabled":"yes"}' '{"slug":"ci-halfmove-2","frame":"on"}' \
  '{"slug":"ci-halfmove-2","expiresAt":"not-a-date"}' '{"slug":"ci-halfmove-2","tags":[5]}' \
  '{"slug":"ci-halfmove-2","project":5}' '{"slug":"ci-halfmove-2","description":5}' \
  '{"slug":"ci-halfmove-2","ogImage":5}' '{"slug":"ci-halfmove-2","visibility":"secret"}' \
  '{"slug":"ci-halfmove-2","visibility":"password"}' '{"slug":"ci-halfmove-2","rotateToken":true}'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-halfmove" \
    -H "$AUTH" -H "$JSON" -d "$bad")
  [ "$code" = 400 ] || fail "refused rename patch $bad: expected 400, got $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-halfmove")
  [ "$code" = 200 ] || fail "$bad: old slug should still serve, got $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-halfmove-2")
  [ "$code" = 404 ] || fail "$bad: new slug should be empty, got $code"
  [ "$(list_field ci-halfmove slug)" = 'ci-halfmove' ] || fail "$bad: the row lost the artifact"
done
echo "ok: a refused patch leaves the artifact at its old slug, one case per field"
# A patch that names a taken slug still answers 409, ahead of any field the server would refuse.
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-halfmove" \
  -H "$AUTH" -H "$JSON" -d '{"slug":"ci-smoke-2","tags":[5]}')
expect_code 409 "$code" "a taken slug wins over a bad field"
# The rename itself still works, so the checks above are not passing on a broken rename.
curl -sf -X PATCH "$BASE/api/artifacts/ci-halfmove" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-halfmove-2","tags":["moved"]}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-halfmove-2")
expect_code 200 "$code" "an accepted rename still moves the artifact"
curl -sf -X DELETE "$BASE/api/artifacts/ci-halfmove-2" -H "$AUTH" > /dev/null

# --- redirects: a real 301 to the stored target, not a JS bounce ---
# %{redirect_url} is curl's parsed Location, so these compare the whole value instead of
# grepping a header line where an unanchored pattern would match a longer target.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/landing?a=1","type":"redirect","slug":"ci-redir","visibility":"public"}')
expect_code 201 "$code" "publish redirect"
redir_headers=$(mktemp)
code=$(curl -s -D "$redir_headers" -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir")
expect_code 301 "$code" "redirect serve"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir")
[ "$loc" = 'https://example.com/landing?a=1' ] || fail "redirect Location wrong: $loc"
grep -qi '^Cache-Control: no-store' "$redir_headers" || fail "redirect is cacheable"
[ "$(grep -ci '^Location:' "$redir_headers")" = 1 ] || fail "redirect did not send exactly one Location"
rm "$redir_headers"
echo "ok: redirect serves 301"

# it is listed like any other artifact (the dashboard renders this payload)
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"slug":"ci-redir"' || fail "redirect not listed"
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"type":"redirect"' || fail "redirect type not listed"
echo "ok: redirect listed"

# the row carries its target, so the dashboard can show where a redirect points without
# fetching /source for every row it renders
[ "$(list_field ci-redir target)" = 'https://example.com/landing?a=1' ] \
  || fail "redirect row is missing its target"
echo "ok: redirect row carries the target"

# the frame never wraps a redirect, and ?raw=1 does not bypass it
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir?raw=1")
expect_code 301 "$code" "redirect raw"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir?raw=1")
[ "$loc" = 'https://example.com/landing?a=1' ] || fail "raw redirect Location wrong: $loc"
# /source shows the normalized target as inert text
src_headers=$(mktemp)
curl -s -D "$src_headers" -o /dev/null "$BASE/a/ci-redir/source"
grep -qi '^Content-Type: text/plain' "$src_headers" || fail "redirect source is not text/plain"
rm "$src_headers"
curl -s "$BASE/a/ci-redir/source" | grep -qF 'https://example.com/landing?a=1' || fail "redirect source missing target"
# a subpath is not a thing for a redirect
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir/anything")
expect_code 404 "$code" "redirect subpath"
echo "ok: redirect ignores frame and raw"

# the target is normalized and trimmed before it is stored, so what serves is not the input
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"  HTTPS://EXAMPLE.COM/Landing?a=1  ","type":"redirect","slug":"ci-redir-norm","visibility":"public"}' > /dev/null
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir-norm")
[ "$loc" = 'https://example.com/Landing?a=1' ] || fail "redirect target not normalized: $loc"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-norm" -H "$AUTH" > /dev/null
echo "ok: redirect target normalized"

# a target carrying JSON punctuation survives the round trip into the list row. Normalization
# percent-encodes braces in the path but leaves them in the query, so this is a target a user
# can really publish.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/p?a={b}&c=\"d\"","type":"redirect","slug":"ci-redir-brace","visibility":"public"}' > /dev/null
[ "$(list_field ci-redir-brace target)" = 'https://example.com/p?a={b}&c=%22d%22' ] \
  || fail "braced redirect target came back wrong: $(list_field ci-redir-brace target)"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-brace" -H "$AUTH" > /dev/null
echo "ok: redirect target with braces round-trips"

# The Location header, the list row and /source all name the same place. The two stored copies of
# the target agree in every state reachable through the API, so this pins the value across the
# three readers rather than proving which copy each one read; the resolution rule itself is
# unit-tested in test/redirect.test.js, where a disagreement can be constructed.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/one-place","type":"redirect","slug":"ci-redir-agree","visibility":"public"}' > /dev/null
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir-agree")
[ "$loc" = 'https://example.com/one-place' ] || fail "redirect Location wrong: $loc"
[ "$(list_field ci-redir-agree target)" = 'https://example.com/one-place' ] || fail "row does not name the target"
# publishing answers with the stored target, which is not always what was sent: the dashboard
# shows the response rather than the box, so a normalized value never has to be guessed at
resp=$(curl -s -X PUT "$BASE/api/artifacts/ci-redir-agree" -H "$AUTH" -H "$JSON" \
  -d '{"content":"  HTTPS://EXAMPLE.COM/One-Place  ","type":"redirect"}')
printf '%s' "$resp" | grep -qF '"target":"https://example.com/One-Place"' \
  || fail "publish response does not carry the stored target: $resp"
curl -sf -X PUT "$BASE/api/artifacts/ci-redir-agree" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/one-place","type":"redirect"}' > /dev/null

# The fallback to source.url for a redirect published before meta carried a target cannot be
# set up through the API (every write now fills meta), so it is covered in test/redirect.test.js
# instead of faked here.

[ "$(curl -s "$BASE/a/ci-redir-agree/source")" = 'https://example.com/one-place' ] \
  || fail "redirect /source disagrees with the Location header"
# a PATCH rebuilds meta, so it has to carry the target forward. Losing it here would blank every
# redirect row on the next rename while the 301 kept working off the body fallback: exactly the
# silent disagreement this change removes.
curl -sf -X PATCH "$BASE/api/artifacts/ci-redir-agree" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-redir-agree-2","tags":["hop"]}' > /dev/null
[ "$(list_field ci-redir-agree-2 target)" = 'https://example.com/one-place' ] || fail "a PATCH dropped the target"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir-agree-2")
[ "$loc" = 'https://example.com/one-place' ] || fail "renamed redirect Location wrong: $loc"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-agree-2" -H "$AUTH" > /dev/null
echo "ok: the 301, the row and /source name one place, through a rename"

# a content-only PUT keeps the title. The dashboard's repoint sends one, and so does the CLI's
# `update` with no --title, so resetting it to the slug quietly deleted the label off the row.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/one","type":"redirect","slug":"ci-redir-title","title":"Launch link","visibility":"public"}' > /dev/null
curl -sf -X PUT "$BASE/api/artifacts/ci-redir-title" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/two","type":"redirect"}' > /dev/null
[ "$(list_field ci-redir-title title)" = 'Launch link' ] || fail "a content-only PUT reset the title"
[ "$(list_field ci-redir-title target)" = 'https://example.com/two' ] || fail "the PUT did not repoint"
# an explicit empty title still clears back to the slug, which is what it meant before
curl -sf -X PUT "$BASE/api/artifacts/ci-redir-title" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/three","type":"redirect","title":""}' > /dev/null
[ "$(list_field ci-redir-title title)" = 'ci-redir-title' ] || fail "an explicit empty title did not clear"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-title" -H "$AUTH" > /dev/null
echo "ok: a content-only PUT keeps the title"

# credentials in a target are refused at publish: the row shows the target, the list API hands
# it to every read-scoped key, and the target host gets them from anyone who scans the code
for creds in 'https://alice:s3cret@example.com/x' 'https://alice@example.com/x'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
    -d "{\"content\":\"$creds\",\"type\":\"redirect\",\"slug\":\"ci-redir-creds\"}")
  expect_code 400 "$code" "redirect target with credentials refused: $creds"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/artifacts/ci-redir" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://alice:s3cret@example.com/x","type":"redirect"}')
expect_code 400 "$code" "repointing at credentials refused"
echo "ok: redirect target credentials refused"

# a redirect pointing at its own slug loops until the visitor's browser gives up. The server
# never follows a target, so nothing amplifies, but the link is dead and only the publisher can
# fix it, so it is refused on the way in. Every shape that reaches the same 301 counts: the bare
# path, the trailing slash, a query, and the other scheme (a proxy terminates TLS and the origin
# behind it answers on the other one).
for self in "$BASE/a/ci-redir-self" "$BASE/a/ci-redir-self/" "$BASE/a/ci-redir-self?x=1"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
    -d "{\"content\":\"$self\",\"type\":\"redirect\",\"slug\":\"ci-redir-self\"}")
  expect_code 400 "$code" "self-referencing redirect refused: $self"
done
curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$BASE/a/ci-redir-self\",\"type\":\"redirect\",\"slug\":\"ci-redir-self\"}" \
  | grep -qF 'cannot point at its own slug' || fail "the self-reference 400 does not say what is wrong"
# a target on this server that reaches a different slug is somebody else's problem, not a loop
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$BASE/a/ci-redir\",\"type\":\"redirect\",\"slug\":\"ci-redir-hop\",\"visibility\":\"public\"}" > /dev/null
# ...and so is repointing an existing one at itself
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/artifacts/ci-redir-hop" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$BASE/a/ci-redir-hop\",\"type\":\"redirect\"}")
expect_code 400 "$code" "repointing a redirect at itself refused"
# the rename closes the same loop with no target changing: ci-redir-hop points at ci-redir, so
# renaming it to ci-redir would be a self-reference if the name were free
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-redir-hop" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-redir-hop-2"}')
expect_code 200 "$code" "a rename away from the target still works"
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$BASE/a/ci-redir-gone\",\"type\":\"redirect\",\"slug\":\"ci-redir-rename\",\"visibility\":\"public\"}" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-redir-rename" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-redir-gone"}')
expect_code 400 "$code" "renaming a redirect onto its own target refused"
[ "$(list_field ci-redir-rename target)" = "$BASE/a/ci-redir-gone" ] || fail "the refused rename moved the artifact anyway"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-rename" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-hop-2" -H "$AUTH" > /dev/null
# a duplicate lands on a slug the caller picks, so a target that was somebody else's problem on
# the original is a loop on the copy. The check runs before any bytes are copied, so the refusal
# leaves nothing behind at the target name.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$BASE/a/ci-redir-dup-dst\",\"type\":\"redirect\",\"slug\":\"ci-redir-dup-src\",\"visibility\":\"public\"}" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/ci-redir-dup-src/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-redir-dup-dst","visibility":"public"}')
expect_code 400 "$code" "duplicating a redirect onto its own target refused"
curl -s -X POST "$BASE/api/artifacts/ci-redir-dup-src/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-redir-dup-dst","visibility":"public"}' \
  | grep -qF 'cannot point at its own slug' || fail "the duplicate 400 does not say what is wrong"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir-dup-dst")
expect_code 404 "$code" "the refused duplicate published the artifact anyway"
# a copy onto any other name is still a copy
curl -sf -X POST "$BASE/api/artifacts/ci-redir-dup-src/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-redir-dup-ok","visibility":"public"}' > /dev/null
[ "$(list_field ci-redir-dup-ok target)" = "$BASE/a/ci-redir-dup-dst" ] || fail "the copy lost its target"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-dup-ok" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-dup-src" -H "$AUTH" > /dev/null
echo "ok: self-referencing redirects refused at publish, repoint, rename and duplicate"

# non-http targets are refused at publish time, so they can never reach a Location header
for bad in 'javascript:alert(1)' 'JaVaScRiPt:alert(1)' 'data:text/html,<script>x</script>' '//evil.example' '/relative/path' 'not a url'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
    -d "{\"content\":\"$bad\",\"type\":\"redirect\",\"slug\":\"ci-redir-bad\"}")
  expect_code 400 "$code" "redirect target rejected: $bad"
done
echo "ok: redirect target scheme allowlist"

# a target carrying CRLF cannot split the response into two headers
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/x\r\nX-Injected: 1","type":"redirect","slug":"ci-redir-crlf","visibility":"public"}' > /dev/null
crlf_headers=$(mktemp)
curl -s -D "$crlf_headers" -o /dev/null "$BASE/a/ci-redir-crlf"
if grep -qi '^X-Injected:' "$crlf_headers"; then fail "redirect target split the response headers"; fi
[ "$(grep -ci '^Location:' "$crlf_headers")" = 1 ] || fail "CRLF target produced more than one Location"
rm "$crlf_headers"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-crlf" -H "$AUTH" > /dev/null
echo "ok: redirect target cannot inject a header"

# the length cap measures the stored target, not the input. 342 multi-byte characters are
# 356 characters in, well past 2048 once percent-encoded. Checking the input instead would
# publish this and then serve 404 for good.
long=$(printf 'https://example.com/'; for i in $(seq 1 342); do printf 'é'; done)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  --data-binary "$(printf '{"content":"%s","type":"redirect","slug":"ci-redir-long"}' "$long")")
expect_code 400 "$code" "over-long redirect target"
echo "ok: redirect length cap measures the stored target"

# updating the target changes where the 301 points, and it is still a 301
curl -sf -X PUT "$BASE/api/artifacts/ci-redir" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.org/moved","type":"redirect"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir")
expect_code 301 "$code" "redirect serve after update"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir")
[ "$loc" = 'https://example.org/moved' ] || fail "redirect target not updated: $loc"
# the row follows the update, so a dashboard row never shows the old destination
[ "$(list_field ci-redir target)" = 'https://example.org/moved' ] \
  || fail "redirect row still shows the old target"
echo "ok: redirect target update"

# an html artifact converted to a redirect serves the 301, not the index.html left behind
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>was html</h1>","type":"html","slug":"ci-redir-conv","visibility":"public"}' > /dev/null
curl -sf -X PUT "$BASE/api/artifacts/ci-redir-conv" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/converted","type":"redirect"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir-conv")
expect_code 301 "$code" "converted artifact serves the redirect"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir-conv")
[ "$loc" = 'https://example.com/converted' ] || fail "converted redirect Location wrong: $loc"
if curl -s "$BASE/a/ci-redir-conv" | grep -q 'was html'; then fail "converted artifact still serves its old body"; fi
# converting back to html drops the target, so the row cannot claim a destination the
# artifact no longer has. The type check first, so an empty target cannot pass by way of a
# row that is not there at all.
curl -sf -X PUT "$BASE/api/artifacts/ci-redir-conv" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>html again</h1>","type":"html"}' > /dev/null
[ "$(list_field ci-redir-conv type)" = 'html' ] || fail "converted artifact is not listed as html"
[ -z "$(list_field ci-redir-conv target)" ] || fail "an html artifact kept a redirect target"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-conv" -H "$AUTH" > /dev/null
echo "ok: html converted to a redirect"

# T2.1.9: a type change drops the objects the old type owned. The bytes themselves are not
# reachable over HTTP (every serve path keys off meta.type, which is why they sat there
# unnoticed since md shipped), so what this proves is the other half: the cleanup never takes a
# file the new type still needs. Walk one artifact through every type and read it back after
# each hop. test/artifact-files.test.js covers which keys each direction drops, and
# test/storage-local.test.js plus test/storage-sql.test.js cover the delete itself.
convert_to() { # convert_to <type> <content>
  curl -sf -X PUT "$BASE/api/artifacts/ci-conv" -H "$AUTH" -H "$JSON" \
    -d "$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1], type: process.argv[2]}))' "$2" "$1")" > /dev/null \
    || fail "converting to $1 was refused"
  [ "$(list_field ci-conv type)" = "$1" ] || fail "converted artifact is not listed as $1"
}
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>step html</h1>","type":"html","slug":"ci-conv","visibility":"public"}' > /dev/null
convert_to md '# step md'
# md renders inside the frame, so the rendered body is behind ?raw=1 like every other type
curl -s "$BASE/a/ci-conv?raw=1" | grep -q '<h1>step md</h1>' || fail "md conversion lost the rendered body"
[ "$(curl -s "$BASE/a/ci-conv/source")" = '# step md' ] || fail "md conversion lost source.md"
convert_to jsx 'export default () => <p>step jsx</p>'
curl -s "$BASE/a/ci-conv?raw=1" | grep -q 'step jsx' || fail "jsx conversion lost index.html"
curl -s "$BASE/a/ci-conv/source" | grep -q 'step jsx' || fail "jsx conversion lost source.jsx"
# jsx to tsx is the direction where both types bake an index.html and only the extension moves
convert_to tsx 'export default () => <p>step tsx</p>'
curl -s "$BASE/a/ci-conv?raw=1" | grep -q 'step tsx' || fail "tsx conversion lost index.html"
curl -s "$BASE/a/ci-conv/source" | grep -q 'step tsx' || fail "tsx conversion lost source.tsx"
convert_to redirect 'https://example.com/step-redirect'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-conv")
expect_code 301 "$code" "the conversion walk's redirect hop"
[ "$(curl -s "$BASE/a/ci-conv/source")" = 'https://example.com/step-redirect' ] \
  || fail "redirect conversion lost source.url"
# The pdf hop, both ways. A pdf is the one type whose file lives on a sub-path of its own, so
# the direction out of it has to take that path away and the direction into it has to serve it.
# The base64 is inline because the pdf block that holds PDF_B64 runs later in this file.
convert_to pdf 'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMjAwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQxPj5zdHJlYW0KQlQgL0YxIDI0IFRmIDMwIDEwMCBUZCAoc21va2UgcGRmKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU0IDAwMDAwIG4gCjAwMDAwMDAxMDUgMDAwMDAgbiAKMDAwMDAwMDIxNyAwMDAwMCBuIAowMDAwMDAwMzA0IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMzY3CiUlRU9GCg=='
curl -s "$BASE/a/ci-conv?raw=1" | grep -qF 'data="/a/ci-conv/file.pdf#' || fail "pdf conversion lost the viewer page"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-conv/file.pdf")
expect_code 200 "$code" "the conversion walk's pdf hop"
curl -s "$BASE/a/ci-conv/source" | head -c 5 | grep -q '%PDF-' || fail "pdf conversion lost source.pdf"
# Out of pdf: the sub-path goes with it, and the redirect target the hop before is long gone.
convert_to md '# step md again'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-conv/file.pdf")
expect_code 404 "$code" "the pdf sub-path after converting away"
[ "$(curl -s "$BASE/a/ci-conv/source")" = '# step md again' ] || fail "the hop out of pdf lost source.md"
convert_to html '<h1>step html again</h1>'
curl -s "$BASE/a/ci-conv?raw=1" | grep -q 'step html again' || fail "html conversion lost index.html"
curl -s "$BASE/a/ci-conv/source" | grep -q 'step html again' || fail "html conversion lost source.html"
curl -sf -X DELETE "$BASE/api/artifacts/ci-conv" -H "$AUTH" > /dev/null
echo "ok: every type conversion serves the type it was given"

# T2.1.19: a PUT is a replace, and `type` falls back to html when the body leaves it out, so an
# update that omits it converts the artifact and drops the source the old type owned. Z kept the
# behaviour and had the docs say so on every surface that describes a PUT. This is the case that
# keeps that claim honest. The two exceptions refuse instead, and both are covered where their own
# blocks are: a pdf answers 400, a zip site answers 400 on any inline PUT.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"# no type given\n\nhi","type":"md","slug":"ci-notype","visibility":"public"}' > /dev/null
curl -sf -X PUT "$BASE/api/artifacts/ci-notype" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>became html</h1>"}' > /dev/null
[ "$(list_field ci-notype type)" = 'html' ] || fail "a PUT with no type left the md artifact as md"
[ "$(curl -s "$BASE/a/ci-notype/source")" = '<h1>became html</h1>' ] \
  || fail "the converted artifact does not serve the html it was given"
curl -sf -X DELETE "$BASE/api/artifacts/ci-notype" -H "$AUTH" > /dev/null
echo "ok: a PUT with no type converts the artifact to html"

# a copy keeps the target
dupslug=$(curl -s -X POST "$BASE/api/artifacts/ci-redir/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-redir-copy","visibility":"public"}' | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
[ "$dupslug" = "ci-redir-copy" ] || fail "redirect duplicate did not return the new slug"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir-copy")
[ "$loc" = 'https://example.org/moved' ] || fail "duplicated redirect Location wrong: $loc"
[ "$(list_field ci-redir-copy target)" = 'https://example.org/moved' ] \
  || fail "duplicated redirect row is missing its target"
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-copy" -H "$AUTH" > /dev/null
echo "ok: redirect duplicate keeps the target"

# expiry behaves like every other type: 410 once the caller can see it at all
curl -sf -X PATCH "$BASE/api/artifacts/ci-redir" -H "$AUTH" -H "$JSON" \
  -d '{"expiresAt":"2020-01-01T00:00:00.000Z"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir")
expect_code 410 "$code" "expired redirect"
curl -sf -X PATCH "$BASE/api/artifacts/ci-redir" -H "$AUTH" -H "$JSON" -d '{"expiresAt":null}' > /dev/null
echo "ok: expired redirect"

# a private redirect is gated on every serve path: no cookie, no Location anywhere
resp=$(curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/secret","type":"redirect","slug":"ci-redir-priv","visibility":"private"}')
redircap=$(printf '%s' "$resp" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
for path in '' '?raw=1' '/source' '/anything' '?k=not-a-token'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir-priv$path")
  expect_code 404 "$code" "private redirect$path"
  if curl -s -D - -o /dev/null "$BASE/a/ci-redir-priv$path" | grep -qi '^Location:'; then
    fail "private redirect leaked target on $path"
  fi
done
echo "ok: private redirect stays gated"

# its capability link still works: 302 to set the unlock cookie, then the 301
curl -s -c /tmp/redirjar -o /dev/null "$redircap"
code=$(curl -s -b /tmp/redirjar -o /dev/null -w '%{http_code}' "$BASE/a/ci-redir-priv")
expect_code 301 "$code" "unlocked private redirect"
loc=$(curl -s -b /tmp/redirjar -o /dev/null -w '%{redirect_url}' "$BASE/a/ci-redir-priv")
[ "$loc" = 'https://example.com/secret' ] || fail "unlocked redirect Location wrong: $loc"
rm -f /tmp/redirjar
echo "ok: capability link unlocks a private redirect"

curl -sf -X DELETE "$BASE/api/artifacts/ci-redir" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-redir-priv" -H "$AUTH" > /dev/null

# tags: publish with tags -> stored lowercased + deduped
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>tags</h1>","type":"html","slug":"ci-tags","tags":["Demo","ci","demo"]}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"tags":["demo","ci"]' || fail "tags not normalized/stored"
echo "ok: tags stored + normalized"

# invalid tag -> 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>x</h1>","type":"html","tags":["bad tag!"]}')
expect_code 400 "$code" "invalid tag rejected"

# ?tag= filter includes matches and excludes non-matches
curl -s "$BASE/api/artifacts?tag=ci" -H "$AUTH" | grep -q '"ci-tags"' || fail "tag filter missed match"
if curl -s "$BASE/api/artifacts?tag=nope" -H "$AUTH" | grep -q '"ci-tags"'; then fail "tag filter false positive"; fi
echo "ok: tag filter"

# PUT without tags preserves them
curl -sf -X PUT "$BASE/api/artifacts/ci-tags" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>tags v2</h1>","type":"html"}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"tags":["demo","ci"]' || fail "PUT dropped tags"
echo "ok: PUT preserves tags"

# PATCH replaces the whole tag list; empty array clears
curl -sf -X PATCH "$BASE/api/artifacts/ci-tags" -H "$AUTH" -H "$JSON" -d '{"tags":["swapped"]}' > /dev/null
curl -s "$BASE/api/artifacts?tag=swapped" -H "$AUTH" | grep -q '"ci-tags"' || fail "PATCH tags replace failed"
curl -sf -X PATCH "$BASE/api/artifacts/ci-tags" -H "$AUTH" -H "$JSON" -d '{"tags":[]}' > /dev/null
if curl -s "$BASE/api/artifacts?tag=swapped" -H "$AUTH" | grep -q '"ci-tags"'; then fail "PATCH tags clear failed"; fi
echo "ok: PATCH tags replace/clear"
curl -sf -X DELETE "$BASE/api/artifacts/ci-tags" -H "$AUTH" > /dev/null

# project: publish with a project -> stored, case preserved
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>p</h1>","type":"html","slug":"ci-proj","project":"Acme Redesign"}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"project":"Acme Redesign"' || fail "project not stored"
echo "ok: project stored"

# invalid project -> 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>x</h1>","type":"html","project":"bad/name"}')
expect_code 400 "$code" "invalid project rejected"

# internal whitespace collapsed -> single-space name matches
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>w</h1>","type":"html","slug":"ci-proj-ws","project":"Acme  Redesign"}' > /dev/null
curl -s "$BASE/api/artifacts?project=Acme%20Redesign" -H "$AUTH" | grep -q '"ci-proj-ws"' || fail "project whitespace not collapsed"
echo "ok: project whitespace collapsed"
curl -sf -X DELETE "$BASE/api/artifacts/ci-proj-ws" -H "$AUTH" > /dev/null

# non-ASCII project accepted
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>u</h1>","type":"html","slug":"ci-proj-uni","project":"Café"}')
expect_code 201 "$code" "unicode project accepted"
curl -sf -X DELETE "$BASE/api/artifacts/ci-proj-uni" -H "$AUTH" > /dev/null

# ?project= filter includes matches and excludes non-matches
curl -s "$BASE/api/artifacts?project=Acme%20Redesign" -H "$AUTH" | grep -q '"ci-proj"' || fail "project filter missed match"
if curl -s "$BASE/api/artifacts?project=Nope" -H "$AUTH" | grep -q '"ci-proj"'; then fail "project filter false positive"; fi
echo "ok: project filter"

# PUT without project preserves it; PATCH empty string clears it
curl -sf -X PUT "$BASE/api/artifacts/ci-proj" -H "$AUTH" -H "$JSON" -d '{"content":"<h1>p2</h1>","type":"html"}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"project":"Acme Redesign"' || fail "PUT dropped project"
curl -sf -X PATCH "$BASE/api/artifacts/ci-proj" -H "$AUTH" -H "$JSON" -d '{"project":""}' > /dev/null
if curl -s "$BASE/api/artifacts?project=Acme%20Redesign" -H "$AUTH" | grep -q '"ci-proj"'; then fail "PATCH project clear failed"; fi
echo "ok: PUT preserves / PATCH clears project"
curl -sf -X DELETE "$BASE/api/artifacts/ci-proj" -H "$AUTH" > /dev/null

# --- two overlapping PATCHes to one slug: both fields land, meta stays readable ---
# A meta write rewrites the whole record. Before it was serialized, the second writer started
# from a copy taken before the first one landed and put it back without that field, and on the
# local backend the two writes interleaved often enough to leave meta.json unparseable, which
# dropped the artifact from the list and made it 404 on its own DELETE. Five rounds: the
# corruption reproduced in roughly 4 runs out of 10 when it was one round.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>race</h1>","type":"html","slug":"ci-race","visibility":"public"}' > /dev/null
# --max-time on every backgrounded call: a write that never settles would otherwise hang `wait`
# and burn the job's whole timeout instead of failing.
for round in 1 2 3 4 5; do
  curl -sf --max-time 15 -X PATCH "$BASE/api/artifacts/ci-race" -H "$AUTH" -H "$JSON" -d '{"tags":["raced"]}' > /dev/null &
  tags_pid=$!
  curl -sf --max-time 15 -X PATCH "$BASE/api/artifacts/ci-race" -H "$AUTH" -H "$JSON" -d '{"project":"Race"}' > /dev/null &
  proj_pid=$!
  wait "$tags_pid" || fail "concurrent tags PATCH failed on round $round"
  wait "$proj_pid" || fail "concurrent project PATCH failed on round $round"
  [ "$(list_field ci-race tags)" = 'raced' ] || fail "concurrent PATCH lost tags on round $round"
  [ "$(list_field ci-race project)" = 'Race' ] || fail "concurrent PATCH lost project on round $round"
  curl -sf -X PATCH "$BASE/api/artifacts/ci-race" -H "$AUTH" -H "$JSON" -d '{"tags":[],"project":""}' > /dev/null
done
echo "ok: overlapping PATCHes both land"

# the artifact still answers its own routes, which a corrupt meta.json would not
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-race?raw=1")
expect_code 200 "$code" "artifact still served after overlapping PATCHes"

# a replace rebuilds the record from what it read, so it has to read what the PATCH left
for round in 1 2 3; do
  curl -sf --max-time 15 -X PUT "$BASE/api/artifacts/ci-race" -H "$AUTH" -H "$JSON" \
    -d '{"content":"<h1>race v2</h1>","type":"html"}' > /dev/null &
  put_pid=$!
  curl -sf --max-time 15 -X PATCH "$BASE/api/artifacts/ci-race" -H "$AUTH" -H "$JSON" -d '{"tags":["kept"]}' > /dev/null &
  patch_pid=$!
  wait "$put_pid" || fail "concurrent PUT failed on round $round"
  wait "$patch_pid" || fail "concurrent PATCH failed on round $round"
  [ "$(list_field ci-race tags)" = 'kept' ] || fail "a PUT overwrote a concurrent PATCH on round $round"
  curl -sf -X PATCH "$BASE/api/artifacts/ci-race" -H "$AUTH" -H "$JSON" -d '{"tags":[]}' > /dev/null
done
curl -s "$BASE/a/ci-race?raw=1" | grep -q '<h1>race v2</h1>' || fail "the PUT content did not survive"
echo "ok: a PUT and a PATCH at once both land"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/artifacts/ci-race" -H "$AUTH")
expect_code 200 "$code" "artifact still deletable after overlapping writes"

# a DELETE beside a PATCH: whichever wins, the row and the artifact have to agree afterwards
for round in 1 2 3; do
  curl -sf --max-time 15 -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
    -d '{"content":"<h1>gone</h1>","type":"html","slug":"ci-race-del","visibility":"public"}' > /dev/null
  curl -s --max-time 15 -o /dev/null -X DELETE "$BASE/api/artifacts/ci-race-del" -H "$AUTH" &
  del_pid=$!
  curl -s --max-time 15 -o /dev/null -X PATCH "$BASE/api/artifacts/ci-race-del" -H "$AUTH" -H "$JSON" -d '{"tags":["z"]}' &
  patch_pid=$!
  wait "$del_pid"
  wait "$patch_pid"
  listed=$(list_field ci-race-del slug)
  served=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-race-del?raw=1")
  if [ -n "$listed" ] && [ "$served" != "200" ]; then
    fail "round $round left a listed artifact that does not serve ($served)"
  fi
  curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/ci-race-del" -H "$AUTH"
done
echo "ok: a DELETE and a PATCH at once leave no ghost row"

# --- a rename holds the destination too, and two renames that cross do not wait on each other ---
# A rename writes under two names. Holding only the old one let a publish claim the destination
# between the collision check and the move, which answered 500. Exactly one of the pair wins.
rename_code=$(mktemp)
publish_code=$(mktemp)
for round in 1 2 3; do
  curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/ci-ren-src" -H "$AUTH"
  curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/ci-ren-dst" -H "$AUTH"
  curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
    -d '{"content":"<h1>s</h1>","type":"html","slug":"ci-ren-src","visibility":"public"}' > /dev/null
  curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-ren-src" \
    -H "$AUTH" -H "$JSON" -d '{"slug":"ci-ren-dst"}' > "$rename_code" &
  ren_pid=$!
  curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
    -d '{"content":"<h1>d</h1>","type":"html","slug":"ci-ren-dst","visibility":"public"}' > "$publish_code" &
  pub_pid=$!
  wait "$ren_pid"
  wait "$pub_pid"
  pair="$(cat "$rename_code")/$(cat "$publish_code")"
  [ "$pair" = "200/409" ] || [ "$pair" = "409/201" ] || fail "rename raced a publish and answered $pair on round $round"
done
rm "$rename_code"
rm "$publish_code"
echo "ok: a rename and a publish claiming one slug leave exactly one winner"

# two renames that cross. --max-time turns a lock-ordering regression into a failure instead of a
# job that hangs until the runner's own timeout.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>x</h1>","type":"html","slug":"ci-cross-x","visibility":"public"}' > /dev/null
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>y</h1>","type":"html","slug":"ci-cross-y","visibility":"public"}' > /dev/null
curl -s --max-time 15 -o /dev/null -X PATCH "$BASE/api/artifacts/ci-cross-x" -H "$AUTH" -H "$JSON" -d '{"slug":"ci-cross-y"}' &
x_pid=$!
curl -s --max-time 15 -o /dev/null -X PATCH "$BASE/api/artifacts/ci-cross-y" -H "$AUTH" -H "$JSON" -d '{"slug":"ci-cross-x"}' &
y_pid=$!
wait "$x_pid" || fail "a crossed rename never answered (lock ordering)"
wait "$y_pid" || fail "a crossed rename never answered (lock ordering)"
echo "ok: two renames that cross both answer"
curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/ci-cross-x" -H "$AUTH"
curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/ci-cross-y" -H "$AUTH"
curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/ci-ren-src" -H "$AUTH"
curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/ci-ren-dst" -H "$AUTH"

# a slug the caller left out is still a slug the server picks, twice over
first=$(curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>n1</h1>","type":"html","slug":null}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).slug))')
second=$(curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>n2</h1>","type":"html","slug":null}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).slug))')
[ -n "$first" ] && [ -n "$second" ] || fail "a null slug did not publish"
[ "$first" != "$second" ] || fail "a null slug published to one fixed name ($first)"
[ "$first" != "null" ] || fail "a null slug became an artifact called null"
echo "ok: a null slug means the server picks one"
curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/$first" -H "$AUTH"
curl -s -o /dev/null -X DELETE "$BASE/api/artifacts/$second" -H "$AUTH"

# zip site: build a tiny site and deploy it
ZIPDIR=$(mktemp -d)
mkdir -p "$ZIPDIR/site/css"
echo '<!doctype html><link rel="stylesheet" href="css/s.css"><h1>zip smoke</h1>' > "$ZIPDIR/site/index.html"
echo 'h1{color:green}' > "$ZIPDIR/site/css/s.css"
(cd "$ZIPDIR/site" && zip -qr ../site.zip .)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/zip?slug=ci-zip&tags=zipped,site&visibility=public" -H "$AUTH" -H "Content-Type: application/zip" --data-binary @"$ZIPDIR/site.zip")
expect_code 201 "$code" "zip deploy"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip/css/s.css")
expect_code 200 "$code" "zip asset"
curl -s "$BASE/api/artifacts?tag=zipped" -H "$AUTH" | grep -q '"ci-zip"' || fail "zip tags not stored"
echo "ok: zip tags"

# zip site without a 404.html: a miss stays the plain-text not-found
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip/nope.html")
expect_code 404 "$code" "zip miss, no 404.html in zip"
curl -s "$BASE/a/ci-zip/nope.html" | grep -q '^not found$' || fail "zip miss body changed"
zipmiss=$(mktemp)
curl -s -H 'Accept: text/html' -o "$zipmiss" "$BASE/a/ci-zip/nope.html"
grep -q 'Artifact unavailable' "$zipmiss" || fail "zip miss has no card for a browser"
rm "$zipmiss"
echo "ok: zip miss falls back to plain not-found"

# zip site with a 404.html: every miss under the site serves that page, still status 404
mkdir -p "$ZIPDIR/site404/deep"
echo '<!doctype html><h1>zip smoke 404</h1>' > "$ZIPDIR/site404/index.html"
echo '<!doctype html><h1>custom miss page</h1>' > "$ZIPDIR/site404/404.html"
echo '<!doctype html><h1>deep index</h1>' > "$ZIPDIR/site404/deep/index.html"
(cd "$ZIPDIR/site404" && zip -qr ../site404.zip .)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/zip?slug=ci-zip-404&visibility=public" -H "$AUTH" -H "Content-Type: application/zip" --data-binary @"$ZIPDIR/site404.zip")
expect_code 201 "$code" "zip with 404.html deploy"
for miss in nope.html missing/ missing/deeper/index.html; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip-404/$miss")
  expect_code 404 "$code" "custom 404 status ($miss)"
  curl -s "$BASE/a/ci-zip-404/$miss" | grep -q 'custom miss page' || fail "custom 404 body not served ($miss)"
done
echo "ok: zip custom 404 page"

# real paths still win over the 404 page, and 404.html itself is a normal 200 file
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip-404/deep/")
expect_code 200 "$code" "deep index still served"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip-404/deep")
expect_code 200 "$code" "directory without trailing slash still served"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip-404/404.html")
expect_code 200 "$code" "404.html fetched directly"
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip-404" -H "$AUTH" > /dev/null

# duplicate: inline artifact copies content + inherits fields under a new slug
dupresp=$(curl -s -X POST "$BASE/api/artifacts/ci-smoke-2/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-dup","title":"smoke copy","visibility":"public"}')
echo "$dupresp" | grep -q '"ci-dup"' || fail "duplicate did not return new slug"
body=$(curl -s "$BASE/a/ci-dup?raw=1")
echo "$body" | grep -q "<h1>smoke</h1>" || fail "duplicate did not copy content"
echo "ok: duplicate copies inline content"

# duplicate: requesting a slug that already exists -> 409
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/ci-smoke-2/duplicate" \
  -H "$AUTH" -H "$JSON" -d '{"slug":"ci-dup"}')
expect_code 409 "$code" "duplicate to taken slug rejected"

# duplicate: zip site copies its files under the new slug
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/ci-zip/duplicate" \
  -H "$AUTH" -H "$JSON" -d '{"slug":"ci-zip-dup","visibility":"public"}')
expect_code 201 "$code" "zip duplicate"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip-dup/css/s.css")
expect_code 200 "$code" "zip duplicate asset served"

# duplicate: omitted fields inherit from the source (ci-zip has tags zipped,site)
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -q '"ci-zip-dup"' || fail "zip duplicate not listed"
echo "ok: duplicate copies zip site + inherits fields"

# T2.1.19: the other exception to "an omitted type converts the artifact". A zip site is many
# files and a PUT carries one body, so an inline PUT is refused whether or not it names a type,
# and the site keeps serving.
for zipput in '{"content":"<h1>flattened</h1>"}' '{"content":"<h1>flattened</h1>","type":"html"}'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/artifacts/ci-zip" -H "$AUTH" -H "$JSON" -d "$zipput")
  expect_code 400 "$code" "inline PUT on a zip site refused: $zipput"
done
[ "$(list_field ci-zip type)" = 'zip' ] || fail "the refused PUT changed the zip site's type anyway"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip/css/s.css")
expect_code 200 "$code" "a zip asset after the refused PUT"

curl -sf -X DELETE "$BASE/api/artifacts/ci-dup" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip-dup" -H "$AUTH" > /dev/null

# delete both -> 404
curl -sf -X DELETE "$BASE/api/artifacts/ci-smoke-2" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke-2")
expect_code 404 "$code" "deleted artifact"

# --- managed keys: the token is shown once, the scope gate holds, and three ways of
# killing a key all end in 401. Everything here runs on the bootstrap bearer, because
# POST /api/keys is admin-only. ---
resp=$(curl -s -X POST "$BASE/api/keys" -H "$AUTH" -H "$JSON" -d '{"name":"ci-read-key","scopes":["read"]}')
readkey=$(printf '%s' "$resp" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
readid=$(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$readkey" ] || fail "key create returned no key"
[ -n "$readid" ] || fail "key create returned no id"
echo "$resp" | grep -q '"prefix":"ah_' || fail "key create returned no prefix"
if echo "$resp" | grep -q '"hash"'; then fail "key create carried the hash out"; fi
echo "ok: key create shows the token once, with a prefix and no hash"

READAUTH="Authorization: Bearer $readkey"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts" -H "$READAUTH")
expect_code 200 "$code" "read key lists"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$READAUTH" -H "$JSON" \
  -d '{"content":"<h1>nope</h1>","type":"html","slug":"ci-scope-denied"}')
expect_code 403 "$code" "read key cannot publish"

# SECURITY.md says a managed key, even full, must not manage keys.
resp=$(curl -s -X POST "$BASE/api/keys" -H "$AUTH" -H "$JSON" -d '{"name":"ci-full-key","scopes":["full"]}')
fullkey=$(printf '%s' "$resp" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
fullid=$(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$fullkey" ] || fail "full key create returned no key"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/keys" -H "Authorization: Bearer $fullkey")
expect_code 401 "$code" "full managed key cannot list keys"

# A key expired at mint time never authenticates.
resp=$(curl -s -X POST "$BASE/api/keys" -H "$AUTH" -H "$JSON" \
  -d '{"name":"ci-expired-key","scopes":["read"],"expiresAt":"2020-01-01"}')
expkey=$(printf '%s' "$resp" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
expid=$(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$expkey" ] || fail "expired key create returned no key"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts" -H "Authorization: Bearer $expkey")
expect_code 401 "$code" "expired key refused"
curl -sf -X DELETE "$BASE/api/keys/$expid" -H "$AUTH" > /dev/null

# Disable, then re-enable: the gate has to swing both ways or a disable that never took
# would still look green.
curl -sf -X PATCH "$BASE/api/keys/$readid" -H "$AUTH" -H "$JSON" -d '{"disabled":true}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts" -H "$READAUTH")
expect_code 401 "$code" "disabled key refused"
curl -sf -X PATCH "$BASE/api/keys/$readid" -H "$AUTH" -H "$JSON" -d '{"disabled":false}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts" -H "$READAUTH")
expect_code 200 "$code" "re-enabled key works again"

curl -sf -X DELETE "$BASE/api/keys/$readid" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts" -H "$READAUTH")
expect_code 401 "$code" "revoked key refused"
curl -sf -X DELETE "$BASE/api/keys/$fullid" -H "$AUTH" > /dev/null
echo "ok: managed key lifecycle"

# --- how many redirects one key has minted. Nothing caps it: a cap changes what an existing
# key is allowed to do, which is the operator's call. The count is what tells them to make it,
# so a leaked publish-scoped key that starts hosting phishing hops shows as a number that does
# not match what the key is for. ---
key_field() { # key_field <key-id> <field>
  curl -s "$BASE/api/keys" -H "$AUTH" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const row = JSON.parse(s).find((k) => k.id === process.argv[1]);
      const v = row ? row[process.argv[2]] : undefined;
      process.stdout.write(v === undefined ? "" : String(v));
    });' "$1" "$2"
}
resp=$(curl -s -X POST "$BASE/api/keys" -H "$AUTH" -H "$JSON" -d '{"name":"ci-hop-key","scopes":["publish"]}')
hopkey=$(printf '%s' "$resp" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
hopid=$(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$hopkey" ] || fail "hop key create returned no key"
HOPAUTH="Authorization: Bearer $hopkey"
# the create response carries the same fields a list row does, so a client can drop it straight
# into the key list without a second fetch
printf '%s' "$resp" | grep -qF '"redirects":0' || fail "the key create response has no redirects field"
[ "$(key_field "$hopid" redirects)" = "0" ] || fail "a fresh key does not start at 0 redirects"
for n in 1 2 3; do
  curl -sf -X POST "$BASE/api/artifacts" -H "$HOPAUTH" -H "$JSON" \
    -d "{\"content\":\"https://example.com/hop-$n\",\"type\":\"redirect\",\"slug\":\"ci-hop-$n\"}" > /dev/null
done
# a page is not a hop, so it must not move the number
curl -sf -X POST "$BASE/api/artifacts" -H "$HOPAUTH" -H "$JSON" \
  -d '{"content":"<h1>page</h1>","type":"html","slug":"ci-hop-page"}' > /dev/null
[ "$(key_field "$hopid" redirects)" = "3" ] || fail "redirect count wrong: $(key_field "$hopid" redirects)"
# a replace is the same artifact, not a new hop
curl -sf -X PUT "$BASE/api/artifacts/ci-hop-1" -H "$HOPAUTH" -H "$JSON" \
  -d '{"content":"https://example.com/hop-1b","type":"redirect"}' > /dev/null
[ "$(key_field "$hopid" redirects)" = "3" ] || fail "a replace double-counted"
# deleting one takes it off the count, so the number tracks the stored records
curl -sf -X DELETE "$BASE/api/artifacts/ci-hop-3" -H "$AUTH" > /dev/null
[ "$(key_field "$hopid" redirects)" = "2" ] || fail "a delete did not come off the count"
# the bootstrap key names no key, so its redirects land in nobody's total
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/hop-boot","type":"redirect","slug":"ci-hop-boot"}' > /dev/null
[ "$(key_field "$hopid" redirects)" = "2" ] || fail "a bootstrap-key redirect was billed to a managed key"
# a duplicate is a new hop and belongs to whoever made the copy. Billed to nobody, a key could
# mint hops all day through /duplicate while its count stood still.
curl -sf -X POST "$BASE/api/artifacts/ci-hop-1/duplicate" -H "$HOPAUTH" -H "$JSON" \
  -d '{"slug":"ci-hop-copy"}' > /dev/null
[ "$(key_field "$hopid" redirects)" = "3" ] || fail "a duplicate was not billed to the key that made it: $(key_field "$hopid" redirects)"
# a replace by a principal with no key of its own keeps the name already on the record. The
# replace case above uses the key that published, so it never exercised this: here the bootstrap
# key repoints the managed key's hop, which is the first move an operator makes on finding a
# leaked key, and it used to erase the count that showed them the leak.
curl -sf -X PUT "$BASE/api/artifacts/ci-hop-1" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/hop-1c","type":"redirect"}' > /dev/null
[ "$(key_field "$hopid" redirects)" = "3" ] || fail "a bootstrap PUT erased the key's attribution: $(key_field "$hopid" redirects)"
# and the key id never rides out on the artifact list, which every read-scoped key can call
if curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -q '"keyId"'; then fail "the artifact list leaked keyId"; fi
curl -sf -X DELETE "$BASE/api/artifacts/ci-hop-copy" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-hop-boot" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-hop-page" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-hop-2" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-hop-1" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/keys/$hopid" -H "$AUTH" > /dev/null
echo "ok: per-key redirect count"

# --- admin session: the cookie the dashboard runs on. Placed before the login burst below,
# which spends the per-IP failure budget for the next 15 minutes. ---
ADMIN_USER=${ARTIFACTS_ADMIN_USERNAME:-}
ADMIN_PASS=${ARTIFACTS_ADMIN_PASSWORD:-}
if [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASS" ]; then
  hdr=$(curl -s -D - -o /dev/null -c /tmp/sessjar -X POST "$BASE/api/auth/login" -H "$JSON" \
    -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}")
  # The flags are read off the Set-Cookie line itself. Grepping the whole header block would
  # let another header answer for them.
  cookie_line=$(echo "$hdr" | grep -i '^set-cookie: artifacts_session=' || true)
  [ -n "$cookie_line" ] || fail "login set no session cookie"
  echo "$cookie_line" | grep -qi 'httponly' || fail "session cookie is not HttpOnly"
  echo "$cookie_line" | grep -qi 'samesite=strict' || fail "session cookie is not SameSite=Strict"
  echo "$cookie_line" | grep -qi 'path=/' || fail "session cookie is not scoped to Path=/"
  echo "ok: login sets an HttpOnly SameSite=Strict session cookie"

  # No Authorization header on any of these three: the cookie is the whole credential.
  code=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/sessjar "$BASE/api/artifacts")
  expect_code 200 "$code" "session cookie reaches the artifact API"
  code=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/sessjar "$BASE/api/keys")
  expect_code 200 "$code" "session cookie reaches the key API"
  curl -s -b /tmp/sessjar "$BASE/api/auth/session" | grep -q '"authenticated":true' \
    || fail "session endpoint does not see the cookie"
  echo "ok: session endpoint reports the live session"

  # An unknown username and a wrong password must be indistinguishable, which is what the
  # decoy hash in lib/auth.js is for. Two failures, well inside the 10-per-window budget.
  b_unknown=$(curl -s -X POST "$BASE/api/auth/login" -H "$JSON" \
    -d '{"username":"ci-nobody","password":"wrongwrongwrong"}')
  b_wrong=$(curl -s -X POST "$BASE/api/auth/login" -H "$JSON" \
    -d "{\"username\":\"$ADMIN_USER\",\"password\":\"wrongwrongwrong\"}")
  [ "$b_unknown" = "$b_wrong" ] || fail "unknown user and wrong password answer differently"
  # Both bodies being a rate-limit refusal would also compare equal, which would pass this
  # while proving nothing, so name the answer that is supposed to be there.
  echo "$b_wrong" | grep -q 'invalid credentials' || fail "a wrong password did not answer with invalid credentials: $b_wrong"
  echo "ok: unknown user and wrong password answer identically"

  # The cookie value as the browser stores it. Kept so the replay below can send the exact
  # credential a thief would have copied, rather than whatever the jar holds after logout.
  session_token=$(echo "$cookie_line" | sed -E 's/^[Ss]et-[Cc]ookie:[ ]*artifacts_session=([^;]*).*/\1/' | tr -d '\r')
  [ -n "$session_token" ] || fail "could not read the session cookie value"

  curl -s -b /tmp/sessjar -c /tmp/sessjar -o /dev/null -X POST "$BASE/api/auth/logout"
  code=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/sessjar "$BASE/api/keys")
  expect_code 401 "$code" "logout drops the session"

  # The cookie is a signed payload with a 30 day exp and no server-side record, so clearing it
  # in one browser leaves every captured copy live. Logout has to refuse the token itself.
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: artifacts_session=$session_token" "$BASE/api/keys")
  expect_code 401 "$code" "a session token captured before logout is replayed after it"
  echo "ok: logout invalidates the session token, not just the browser cookie"
else
  echo "skip: session cases need ARTIFACTS_ADMIN_USERNAME and ARTIFACTS_ADMIN_PASSWORD in the environment"
fi

# --- DoS liveness: a burst of unauthenticated login POSTs must not stall /healthz ---
# Fire 40 concurrent logins (each triggers scrypt) in the background, then time a healthz.
for i in $(seq 1 40); do
  curl -s -o /dev/null -X POST "$BASE/api/auth/login" -H "$JSON" \
    -d '{"username":"nobody","password":"wrongwrongwrong"}' &
done
start=$(date +%s%N)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/healthz")
end=$(date +%s%N)
wait
expect_code 200 "$code" "healthz responsive under scrypt load"
ms=$(( (end - start) / 1000000 ))
[ "$ms" -lt 2000 ] || fail "healthz took ${ms}ms under load (event loop stalled?)"
echo "ok: healthz stayed responsive (${ms}ms) under 40 concurrent logins"

# --- login rate limiting: the burst above exhausted the per-IP login bucket (10/window),
# so a further failed login must 429 with a Retry-After header. ---
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H "$JSON" \
  -d '{"username":"admin","password":"definitely-wrong"}')
expect_code 429 "$code" "login rate limited after burst"
hdr=$(curl -s -D - -o /dev/null -X POST "$BASE/api/auth/login" -H "$JSON" \
  -d '{"username":"admin","password":"x"}')
echo "$hdr" | grep -qi '^Retry-After:' || fail "429 missing Retry-After header"
echo "ok: login limiter sets Retry-After"

# --- capability links: default is private, tokened URL, no existence leak ---
resp=$(curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>cap secret</h1>","type":"html","slug":"cap-one"}')
capurl=$(printf '%s' "$resp" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
case "$capurl" in
  *'?k='*) echo "ok: default publish is private (tokened url returned)" ;;
  *) fail "default publish not private/tokened: $capurl" ;;
esac

# bare link -> 404 (indistinguishable from a missing artifact)
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/cap-one")
expect_code 404 "$code" "private bare link 404"

# tokened link -> 302 (sets the unlock cookie), does not 200 directly
code=$(curl -s -o /dev/null -w '%{http_code}' "$capurl")
expect_code 302 "$code" "capability link redirects"

# the 302 sets a cookie; a raw read with that cookie serves the body
curl -s -c /tmp/capjar -o /dev/null "$capurl"
body=$(curl -s -b /tmp/capjar "$BASE/a/cap-one?raw=1")
echo "$body" | grep -q 'cap secret' || fail "unlock cookie did not serve raw body"
echo "ok: capability cookie serves the body"

# rotate -> the live cookie is invalidated immediately
curl -sf -X PATCH "$BASE/api/artifacts/cap-one" -H "$AUTH" -H "$JSON" -d '{"rotateToken":true}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/capjar "$BASE/a/cap-one?raw=1")
expect_code 404 "$code" "rotate invalidates live cookie"

# a lapsed artifact mints no link: the dashboard's Copy button calls this route, so a 200 here
# is an operator handing out a URL that answers 410 or 404 on the first click
curl -sf -X PATCH "$BASE/api/artifacts/cap-one" -H "$AUTH" -H "$JSON" -d '{"expiresAt":"2020-01-01"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/artifacts/cap-one/link")
expect_code 410 "$code" "link route refuses an expired artifact"
curl -sf -X PATCH "$BASE/api/artifacts/cap-one" -H "$AUTH" -H "$JSON" -d '{"expiresAt":null}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/artifacts/cap-one/link")
expect_code 200 "$code" "link route mints once the expiry is cleared"

# oracle uniformity: a missing slug and a locked-private slug return identical 404 bodies
b_missing=$(curl -s "$BASE/a/does-not-exist-zzz")
b_locked=$(curl -s "$BASE/a/cap-one")
[ "$b_missing" = "$b_locked" ] || fail "404 bodies differ (existence oracle)"
echo "ok: missing and locked-private return identical 404"

# no secret leak: the list API exposes no token epoch or password material
list=$(curl -s "$BASE/api/artifacts" -H "$AUTH")
if echo "$list" | grep -q 'tokenEpoch'; then fail "tokenEpoch leaked in list"; fi
if echo "$list" | grep -qiE 'passwordhash|passwordsalt'; then fail "password hash leaked in list"; fi
echo "ok: no secret fields in list output"

# --- password mode: prompt, wrong/right unlock, cookie serves ---
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>pw body</h1>","type":"html","slug":"cap-pw","visibility":"password","password":"letmein"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/cap-pw")
expect_code 401 "$code" "password mode shows prompt"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/a/cap-pw/unlock" -H "$JSON" -d '{"password":"nope"}')
expect_code 401 "$code" "password unlock wrong -> 401"
curl -s -c /tmp/pwjar -o /dev/null -X POST "$BASE/a/cap-pw/unlock" -H "$JSON" -d '{"password":"letmein"}'
body=$(curl -s -b /tmp/pwjar "$BASE/a/cap-pw?raw=1")
echo "$body" | grep -q 'pw body' || fail "password unlock cookie did not serve body"
echo "ok: password mode unlock round-trip"

# --- branding: one config change rebrands every shell, no shell file touched ---
# This block writes the config, so it saves what the target already had and puts it back at the
# end, the way the md.width check above does. Two reasons: a self-host that runs the suite
# against its own instance should not come out of it white-labelled as "Smokebrand", and the
# built-in-look assertions below are only true on an instance nobody has branded yet.
brand_before=$(curl -s "$BASE/api/config" -H "$AUTH" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).branding)))')
[ -n "$brand_before" ] || fail "config did not report a branding block"
if [ "$brand_before" = '{"productName":"","logoUrl":"","faviconUrl":"","accentColor":"","footerText":""}' ]; then
  host_branded=no
else
  host_branded=yes
  echo "note: this host is already branded, skipping the built-in-look assertions"
fi

curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"# brand smoke\n\nhi","type":"md","slug":"ci-brand-md","visibility":"public"}' > /dev/null
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"export default function A(){ return <div>brand</div>; }","type":"jsx","slug":"ci-brand-jsx","visibility":"public"}' > /dev/null
if [ "$host_branded" = no ]; then
  curl -s "$BASE/a/ci-brand-md?raw=1" | grep -q -- '--link: #c73d1d' || fail "md page is not on the default link color"
  curl -s "$BASE/a/ci-brand-jsx?raw=1" | grep -qF "'Artifact error: '" || fail "jsx page is not on the default error label"
  if curl -s "$BASE/a/ci-brand-md" | grep -q 'og:site_name'; then fail "og:site_name rendered with no product name set"; fi
  echo "ok: shells render the built-in branding by default"
fi

curl -sf -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" \
  -d '{"branding":{"productName":"Smokebrand","logoUrl":"/brand/logo.png","faviconUrl":"/brand/f.ico","accentColor":"#0055ff","footerText":"Published with Smokebrand"}}' > /dev/null
curl -s "$BASE/api/config" -H "$AUTH" | grep -q '"productName":"Smokebrand"' || fail "branding did not persist"

body=$(curl -s "$BASE/a/does-not-exist-zzz")
echo "$body" | grep -q '#0055ff' || fail "404 page kept the built-in accent color"
echo "$body" | grep -q 'Published with Smokebrand' || fail "404 page missing the branded footer"
echo "$body" | grep -q '<img class="mark" src="/brand/logo.png"' || fail "404 page kept the built-in mark"
# The product name is the name of the product, not a count noun for what it publishes. A viewer
# on a dead link reads "Artifact unavailable" on every install, branded or not.
echo "$body" | grep -q 'Artifact unavailable' || fail "404 page put the product name where the noun goes"
body=$(curl -s "$BASE/a/cap-pw")
echo "$body" | grep -q '#0055ff' || fail "password page kept the built-in accent color"
echo "$body" | grep -q '<link rel="icon" href="/brand/f.ico">' || fail "password page missing the branded favicon"
echo "$body" | grep -q 'Protected artifact' || fail "password page put the product name where the noun goes"
body=$(curl -s "$BASE/a/ci-brand-md?raw=1")
echo "$body" | grep -q -- '--link: #0055ff' || fail "md page kept the built-in link color"
echo "$body" | grep -q '<link rel="icon" href="/brand/f.ico">' || fail "md page missing the branded favicon"
# html and jsx pages are built once, at publish time, so this one is published after the
# rebrand. An artifact published earlier keeps the branding it was built with until it is
# republished; its frame, being rendered per request, rebrands either way.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"export default function A(){ return <div>brand</div>; }","type":"jsx","slug":"ci-brand-jsx-2","visibility":"public"}' > /dev/null
body=$(curl -s "$BASE/a/ci-brand-jsx-2?raw=1")
echo "$body" | grep -qF '"Smokebrand error: "' || fail "jsx page kept the built-in error label"
echo "$body" | grep -q '<link rel="icon" href="/brand/f.ico">' || fail "jsx page missing the branded favicon"
if [ "$host_branded" = no ]; then
  curl -s "$BASE/a/ci-brand-jsx?raw=1" | grep -qF "'Artifact error: '" || fail "an older jsx page changed under it"
fi
echo "ok: branding rebrands the 404, password, md, jsx and frame shells"

# share-link tags: the site name shows, and the logo stands in for a missing preview image
body=$(curl -s "$BASE/a/ci-brand-md")
echo "$body" | grep -q '<meta property="og:site_name" content="Smokebrand">' || fail "share tags missing og:site_name"
echo "$body" | grep -qF "<meta property=\"og:image\" content=\"$BASE/brand/logo.png\">" || fail "share tags missing the brand logo fallback"
echo "$body" | grep -q 'twitter:card" content="summary_large_image"' || fail "share tags kept the small card with an image set"
echo "$body" | grep -q 'Smokebrand' || fail "frame bar missing the product name"
echo "ok: branding reaches the share-link tags"

# a refused value -> 400 naming the field, and nothing written
out=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"branding":{"accentColor":"red; } body { display: none"}}')
expect_code 400 "$out" "invalid accentColor rejected"
curl -s "$BASE/api/config" -H "$AUTH" | grep -q '"accentColor":"#0055ff"' || fail "a refused branding PUT still wrote"
echo "ok: branding validation"

# a remote logo -> 400. The chrome pages carry `img-src 'self' data:`, so an absolute URL is
# accepted by the API and then refused by the viewer's own browser, and on the 404 that means no
# mark at all, because the logo replaces the built-in one.
out=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"branding":{"logoUrl":"https://cdn.example.com/l.png"}}')
expect_code 400 "$out" "remote logoUrl rejected"
out=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"branding":{"logoUrl":"data:image/svg+xml;base64,AAAA"}}')
expect_code 400 "$out" "inline SVG logoUrl rejected"
out=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"branding":{"accentColor":"rgba(0,0,0,0)"}}')
expect_code 400 "$out" "see-through accentColor rejected"
echo "ok: brand asset and accent policy"

# put back exactly what this host had, rather than clearing five fields it may have set
curl -sf -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d "{\"branding\":$brand_before}" > /dev/null
curl -s "$BASE/api/config" -H "$AUTH" | grep -qF "$brand_before" || fail "branding restore did not put the stored block back"
if [ "$host_branded" = no ]; then
  # not just the wording: a bug that left accentColor set while the copy read right would pass
  # on the copy alone.
  curl -s "$BASE/a/does-not-exist-zzz" | grep -q -- '--accent: #c73d1d' || fail "branding reset did not restore the built-in accent"
  curl -s "$BASE/a/ci-brand-md?raw=1" | grep -q -- '--link: #c73d1d' || fail "branding reset did not restore the built-in md link color"
fi
curl -sf -X DELETE "$BASE/api/artifacts/ci-brand-md" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-brand-jsx" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-brand-jsx-2" -H "$AUTH" > /dev/null
echo "ok: branding reset to the built-in defaults"

curl -sf -X DELETE "$BASE/api/artifacts/cap-one" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/cap-pw" -H "$AUTH" > /dev/null

# --- identity: package.json, server.json, the Dockerfile label and the MCP handshake agree ---
# These drifted apart once. Compare them here so a bump or rename that misses one fails
# CI instead of shipping a wrong version or namespace to MCP clients. Assumes the checkout
# and the instance under test come from the same commit, which holds in CI.
REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
json_field() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]] ?? ""))' "$1" "$2"; }

pkg_version=$(json_field "$REPO_DIR/package.json" version)
[ -n "$pkg_version" ] || fail "package.json has no version field"
server_json_version=$(json_field "$REPO_DIR/server.json" version)
[ "$server_json_version" = "$pkg_version" ] || fail "server.json version '$server_json_version' != package.json '$pkg_version'"
echo "ok: server.json version matches package.json ($pkg_version)"

# The MCP registry reads the Dockerfile label to check who owns the io.github.<ns>
# namespace, so it has to name the same server as server.json.
mcp_id=$(json_field "$REPO_DIR/server.json" name)
[ -n "$mcp_id" ] || fail "server.json has no name field"
grep -qF "LABEL io.modelcontextprotocol.server.name=\"$mcp_id\"" "$REPO_DIR/Dockerfile" \
  || fail "Dockerfile MCP label does not match server.json name '$mcp_id'"
echo "ok: Dockerfile MCP label matches server.json ($mcp_id)"

mcp_init=$(curl -s -X POST "$BASE/mcp" -H "$AUTH" -H "$JSON" -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
# Pull the field out rather than matching the whole serverInfo object, so a future SDK
# that reorders keys or adds a title reports the real mismatch instead of a shape mismatch.
mcp_version=$(printf '%s' "$mcp_init" | sed -n 's/.*"serverInfo":{[^}]*"version":"\([^"]*\)".*/\1/p')
[ -n "$mcp_version" ] || fail "MCP initialize returned no serverInfo version (got: $mcp_init)"
[ "$mcp_version" = "$pkg_version" ] || fail "MCP serverInfo version '$mcp_version' != package.json '$pkg_version'"
echo "ok: MCP serverInfo version matches package.json"

# --- MCP tools: the list matches what server.js registers, and publish/list/tags/delete round-trip ---
# The transport is stateless (sessionIdGenerator: undefined), so each POST stands on its own
# and tools/list needs no initialize before it. Until now the suite only called initialize,
# so a tool that threw on every call still shipped green.
mcp_call_as() { # mcp_call_as <bearer> <id> <method> <params-json>
  curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $1" -H "$JSON" \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$2,\"method\":\"$3\",\"params\":$4}"
}
# The bootstrap key holds every scope, so it can drive any tool. The scope gate is exercised
# further down with a managed key that holds only `read`.
mcp_call() { mcp_call_as "$KEY" "$@"; }
# The SSE frame wraps one JSON object on a `data:` line; the assertions below read the raw
# body, which is enough for presence checks and one field extraction.
mcp_text() { # stdin: an MCP tool result -> stdout: its text content
  sed -n 's/.*"text":"\([^"]*\)".*/\1/p'
}

mcp_tools=$(mcp_call 2 tools/list '{}')
for tool in publish_artifact update_artifact rename_artifact set_artifact_expiry \
  set_artifact_tags set_artifact_project set_artifact_visibility disable_artifact \
  enable_artifact set_artifact_frame list_artifacts delete_artifact; do
  printf '%s' "$mcp_tools" | grep -q "\"name\":\"$tool\"" || fail "MCP tools/list is missing $tool"
done
# Compare the served list against what the checkout registers, the same way the version
# checks above compare the instance against package.json. Catches a tool that was added to
# server.js but never reached the client. A tool going missing is caught by the hard-coded
# list above, not by this count.
# grep -c counts lines and every tool name sits on the same `data:` line, so count
# occurrences instead.
listed_tools=$(printf '%s' "$mcp_tools" | grep -o '"name":"' | wc -l | tr -d ' ' || true)
registered_tools=$(grep -c '^  server.registerTool(' "$REPO_DIR/server.js" || true)
[ "$registered_tools" != 0 ] \
  || fail "no '  server.registerTool(' lines in server.js (did the indentation change?)"
[ "$listed_tools" = "$registered_tools" ] \
  || fail "MCP tools/list served $listed_tools tools, server.js registers $registered_tools"
echo "ok: MCP tools/list serves all $registered_tools registered tools"

# Clear both slugs this block uses before claiming them. An abort anywhere between here and
# the delete at the end leaves ci-mcp published, and MCP publish 409s on a duplicate slug, so
# without this one failed run makes every later run against the same instance fail at the
# line below for an unrelated reason. Both DELETEs tolerate a 404.
curl -s -X DELETE "$BASE/api/artifacts/ci-mcp" -H "$AUTH" > /dev/null
curl -s -X DELETE "$BASE/api/artifacts/ci-mcp-denied" -H "$AUTH" > /dev/null
# Not ci-mcp-default: two assertions in this block grep a list for the bare string
# `ci-mcp`, and a slug carrying it as a prefix satisfies them, so a stale artifact here
# would hold those checks up after ci-mcp itself stopped being published.
curl -s -X DELETE "$BASE/api/artifacts/ci-vis-default" -H "$AUTH" > /dev/null
# Not ci-mcp-redirect either, for the prefix reason above. This one is published over REST
# rather than MCP so the list check below needs no extra tools/call.
curl -s -X DELETE "$BASE/api/artifacts/ci-redir-mcp" -H "$AUTH" > /dev/null

mcp_pub=$(mcp_call 3 tools/call \
  '{"name":"publish_artifact","arguments":{"content":"<h1>mcp</h1>","type":"html","slug":"ci-mcp","visibility":"public"}}')
mcp_url=$(printf '%s' "$mcp_pub" | mcp_text)
# The response is a three-line SSE frame, so flatten it before it goes into a FAIL line
# that someone will read through `grep FAIL` on a CI log.
[ "$mcp_url" = "$BASE/a/ci-mcp" ] \
  || fail "MCP publish_artifact returned '$mcp_url' (got: $(printf '%s' "$mcp_pub" | tr '\n' ' '))"
curl -s "$BASE/a/ci-mcp?raw=1" | grep -q '<h1>mcp</h1>' || fail "MCP publish_artifact served no body"
echo "ok: MCP publish_artifact round-trip"

curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"https://example.com/mcp-target","type":"redirect","slug":"ci-redir-mcp","visibility":"public"}' \
  > /dev/null || fail "could not publish the redirect the list_artifacts field check reads"

mcp_list=$(mcp_call 4 tools/call '{"name":"list_artifacts","arguments":{}}')
printf '%s' "$mcp_list" | grep -q 'ci-mcp' || fail "MCP list_artifacts omits the artifact it just published"
# The tool hands back whatever publicMeta allows, so `target` reaches an agent for a redirect.
# The description is the only place an agent learns that, and it enumerates the fields by hand,
# so a field added to PUBLIC_META_FIELDS goes unmentioned unless something checks. Both halves
# below are needed: the response proves the field ships, the description proves it is named.
# The whole pretty-printed list arrives escaped on one SSE line, hence the same-line pattern.
printf '%s' "$mcp_list" | grep -q 'target[^,]*https://example.com/mcp-target' \
  || fail "MCP list_artifacts omits target for a redirect ($(printf '%s' "$mcp_list" | tr '\n' ' '))"
mcp_list_meta=$(printf '%s' "$mcp_tools" | tr '{' '\n' | grep '"name":"list_artifacts"' || true)
printf '%s' "$mcp_list_meta" | grep -q 'target' \
  || fail "the list_artifacts description does not name target, which the response carries ($mcp_list_meta)"
curl -s -X DELETE "$BASE/api/artifacts/ci-redir-mcp" -H "$AUTH" > /dev/null
echo "ok: MCP list_artifacts, including target for a redirect"

# A mutating tool past publish. tools/list serves only the metadata passed to
# server.registerTool, so the count check above passes for a tool whose handler throws on
# every call. Before this, publish_artifact and list_artifacts were the only handlers CI ran.
# The tag is read back over the REST API, a different code path from the one that claims to
# have set it, so the tool's own result text is not what the check rests on.
mcp_tagged=$(mcp_call 5 tools/call \
  '{"name":"set_artifact_tags","arguments":{"slug":"ci-mcp","tags":["ci-mcp-tag"]}}')
if printf '%s' "$mcp_tagged" | grep -q '"isError":true'; then
  fail "MCP set_artifact_tags errored ($(printf '%s' "$mcp_tagged" | tr '\n' ' '))"
fi
mcp_tag_filter=$(curl -s -H "$AUTH" "$BASE/api/artifacts?tag=ci-mcp-tag")
printf '%s' "$mcp_tag_filter" | grep -q '"slug":"ci-mcp"' \
  || fail "MCP set_artifact_tags did not tag ci-mcp (call: $(printf '%s' "$mcp_tagged" | tr '\n' ' ') / filter: $mcp_tag_filter)"
echo "ok: MCP set_artifact_tags round-trip"

# publish_artifact's own description tells an agent what an omitted visibility does and what
# kind of URL comes back. Every MCP publish above passes visibility explicitly, so both claims
# were unchecked over this transport. Read the stored visibility back over REST rather than
# trusting the tool's result text, the same way the tags check does. Assumes the shipped
# DEFAULT_VISIBILITY, as the REST capability-link block already does, so both failures name it.
mcp_default=$(mcp_call 6 tools/call \
  '{"name":"publish_artifact","arguments":{"content":"<h1>mcp default</h1>","type":"html","slug":"ci-vis-default"}}')
mcp_default_url=$(printf '%s' "$mcp_default" | mcp_text)
case "$mcp_default_url" in
  *'?k='*) ;;
  *) fail "MCP publish with no visibility returned an untokened url '$mcp_default_url' (is DEFAULT_VISIBILITY=public on this instance?)" ;;
esac
# Pull the one row out before it can reach a FAIL line. The tags check above gets a single
# artifact back because it filters on `?tag=`; there is no per-slug GET, so filter here instead
# of pasting every slug, title and tag on the instance into a CI log.
mcp_default_row=$(curl -s -H "$AUTH" "$BASE/api/artifacts" | tr '{' '\n' | grep '"slug":"ci-vis-default"' || true)
printf '%s' "$mcp_default_row" | grep -q '"visibility":"private"' \
  || fail "MCP publish with no visibility did not store private (row: $mcp_default_row) (is DEFAULT_VISIBILITY=public on this instance?)"
echo "ok: MCP publish with no visibility is private and returns a tokened url"
mcp_call 7 tools/call '{"name":"delete_artifact","arguments":{"slug":"ci-vis-default"}}' > /dev/null
# Checked against the authenticated list, not against /a/ci-vis-default. A private artifact's
# bare URL is 404 whether or not it still exists (that indistinguishability is the point of
# the visibility gate), so a serve-path check here would pass on a delete that did nothing.
curl -s -H "$AUTH" "$BASE/api/artifacts" | grep -q '"slug":"ci-vis-default"' \
  && fail "MCP delete_artifact left ci-vis-default on the instance"
echo "ok: MCP delete_artifact removes a private artifact"

# --- MCP scopes: a read-scoped key drives a read tool and is refused by publish and delete ---
# Every call above carries the bootstrap key, which outranks every scope, so nothing above
# reaches requireScope (server.js). Delete that gate outright and the unit tests plus every
# check above here stay green.
mcp_key_resp=$(curl -s -X POST "$BASE/api/keys" -H "$AUTH" -H "$JSON" \
  -d '{"name":"ci-mcp-readonly","scopes":["read"]}')
mcp_read_key=$(printf '%s' "$mcp_key_resp" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
mcp_read_key_id=$(printf '%s' "$mcp_key_resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
# This carries a bearer key in the clear, the one credential on the instance, so scrub it
# before any of it reaches a CI log.
mcp_key_redacted=$(printf '%s' "$mcp_key_resp" | tr '\n' ' ' | sed 's/"key":"[^"]*"/"key":"REDACTED"/')
case "$mcp_read_key" in
  ah_*) ;;
  *) fail "could not mint a read-only key, so the scope gate is untested. POST /api/keys is admin-only, so this needs the bootstrap key rather than a managed one (got: $mcp_key_redacted)" ;;
esac
[ -n "$mcp_read_key_id" ] || fail "minted key has no id, cannot revoke it (got: $mcp_key_redacted)"

# The read key has to work for a read tool, or the two refusals below prove nothing: a key
# that is broken outright would be "refused" by every tool for the wrong reason.
mcp_ro_list=$(mcp_call_as "$mcp_read_key" 8 tools/call '{"name":"list_artifacts","arguments":{}}')
if printf '%s' "$mcp_ro_list" | grep -q '"isError":true'; then
  fail "MCP list_artifacts refused a read-scoped key ($(printf '%s' "$mcp_ro_list" | tr '\n' ' '))"
fi
printf '%s' "$mcp_ro_list" | grep -q 'ci-mcp' \
  || fail "MCP list_artifacts returned no artifacts for a read-scoped key ($(printf '%s' "$mcp_ro_list" | tr '\n' ' '))"
echo "ok: MCP list_artifacts accepts a read-scoped key"

# publish sits one rank above read. The refusal arrives as a tool result carrying isError,
# not as a JSON-RPC error, so a check for '"error"' would never match it.
mcp_denied=$(mcp_call_as "$mcp_read_key" 9 tools/call \
  '{"name":"publish_artifact","arguments":{"content":"<h1>denied</h1>","type":"html","slug":"ci-mcp-denied","visibility":"public"}}')
printf '%s' "$mcp_denied" | grep -q '"isError":true' \
  || fail "MCP publish_artifact accepted a read-scoped key ($(printf '%s' "$mcp_denied" | tr '\n' ' '))"
# The scope name arrives inside JSON, so its quotes are backslash-escaped in this body.
printf '%s' "$mcp_denied" | grep -q 'lacks the .*publish.* scope' \
  || fail "MCP publish refusal did not name the missing scope ($(printf '%s' "$mcp_denied" | tr '\n' ' '))"
# A refusal message does not prove the write was skipped, so check the slug too.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-mcp-denied")
expect_code 404 "$code" "scope-refused publish"

# delete needs `full`. A read key is refused by `publish` and by `full` alike, so the check
# on the message is what separates them: name the wrong scope here and this goes red, which
# is what stops delete_artifact's gate from being quietly downgraded to publish.
mcp_denied_del=$(mcp_call_as "$mcp_read_key" 10 tools/call \
  '{"name":"delete_artifact","arguments":{"slug":"ci-mcp"}}')
printf '%s' "$mcp_denied_del" | grep -q '"isError":true' \
  || fail "MCP delete_artifact accepted a read-scoped key ($(printf '%s' "$mcp_denied_del" | tr '\n' ' '))"
printf '%s' "$mcp_denied_del" | grep -q 'lacks the .*full.* scope' \
  || fail "MCP delete refusal did not name the full scope ($(printf '%s' "$mcp_denied_del" | tr '\n' ' '))"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-mcp")
expect_code 200 "$code" "scope-refused delete"
echo "ok: MCP scope gate refuses publish and delete from a read-scoped key"

curl -sf -X DELETE "$BASE/api/keys/$mcp_read_key_id" -H "$AUTH" > /dev/null \
  || fail "could not revoke the read-only MCP key ($mcp_read_key_id)"

mcp_call 11 tools/call '{"name":"delete_artifact","arguments":{"slug":"ci-mcp"}}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-mcp")
expect_code 404 "$code" "MCP delete_artifact"

# --- QR codes ---
# The encoder itself is proven in test/qr.test.js, against a matrix a real decoder read back.
# What is checked here is the wiring: that the route answers, that it encodes the artifact's
# canonical URL and not something else, and that its options are validated. Comparing the
# served bytes against a locally generated code is what pins the encoded URL, since bash has
# no QR decoder.
qr_local() { # qr_local <url> [scale] [margin]
  node -e 'import("'"$REPO_DIR"'/lib/qr.js").then(({ qrSvg }) => process.stdout.write(qrSvg(process.argv[1], { scale: Number(process.argv[2]), margin: Number(process.argv[3]) })))' \
    "$1" "${2:-8}" "${3:-4}"
}
qr_local_png() { # qr_local_png <url> [scale] [margin]
  node -e 'import("'"$REPO_DIR"'/lib/qr.js").then(({ qrPng }) => process.stdout.write(qrPng(process.argv[1], { scale: Number(process.argv[2]), margin: Number(process.argv[3]) })))' \
    "$1" "${2:-8}" "${3:-4}"
}

curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>qr</h1>","type":"html","slug":"ci-qr","visibility":"public"}' > /dev/null

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts/ci-qr/qr")
expect_code 401 "$code" "unauth qr"

qr_headers=$(mktemp)
qr_body=$(mktemp)
code=$(curl -s -D "$qr_headers" -o "$qr_body" -w '%{http_code}' "$BASE/api/artifacts/ci-qr/qr" -H "$AUTH")
expect_code 200 "$code" "qr svg"
grep -qi '^Content-Type: image/svg+xml' "$qr_headers" || fail "qr svg content-type"
grep -qi '^Content-Disposition: inline; filename="ci-qr.svg"' "$qr_headers" || fail "qr svg filename"
head -c 4 "$qr_body" | grep -q '<svg' || fail "qr svg body is not an svg"
diff <(qr_local "$BASE/a/ci-qr") "$qr_body" > /dev/null || fail "qr does not encode $BASE/a/ci-qr"
rm "$qr_headers"
echo "ok: qr svg encodes the canonical url"

# a zip site's canonical URL carries the trailing slash, and the QR has to agree
curl -sf -X POST "$BASE/api/artifacts/zip?slug=ci-qr-zip&visibility=public" -H "$AUTH" \
  -H "Content-Type: application/zip" --data-binary @"$ZIPDIR/site.zip" > /dev/null
diff <(qr_local "$BASE/a/ci-qr-zip/") <(curl -s "$BASE/api/artifacts/ci-qr-zip/qr" -H "$AUTH") > /dev/null \
  || fail "zip qr does not encode the trailing-slash url"
curl -sf -X DELETE "$BASE/api/artifacts/ci-qr-zip" -H "$AUTH" > /dev/null
echo "ok: zip qr encodes the trailing-slash url"

# scale and margin reach the renderer
diff <(qr_local "$BASE/a/ci-qr" 3 0) <(curl -s "$BASE/api/artifacts/ci-qr/qr?scale=3&margin=0" -H "$AUTH") > /dev/null \
  || fail "qr scale/margin ignored"
echo "ok: qr scale and margin"

png_headers=$(mktemp)
png_body=$(mktemp)
code=$(curl -s -D "$png_headers" -o "$png_body" -w '%{http_code}' "$BASE/api/artifacts/ci-qr/qr?format=png" -H "$AUTH")
expect_code 200 "$code" "qr png"
grep -qi '^Content-Type: image/png' "$png_headers" || fail "qr png content-type"
grep -qi '^Content-Disposition: inline; filename="ci-qr.png"' "$png_headers" || fail "qr png filename"
[ "$(head -c 8 "$png_body" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || fail "qr png is not a png"
# byte-for-byte, so the PNG path is pinned to the same URL and options as the SVG path. A
# signature check alone passes even when scale and margin never reach the renderer.
diff <(qr_local_png "$BASE/a/ci-qr") "$png_body" > /dev/null || fail "qr png does not encode $BASE/a/ci-qr"
diff <(qr_local_png "$BASE/a/ci-qr" 3 0) <(curl -s "$BASE/api/artifacts/ci-qr/qr?format=png&scale=3&margin=0" -H "$AUTH") > /dev/null \
  || fail "qr png ignores scale/margin"
rm "$png_headers" "$png_body"
echo "ok: qr png"

# the image is inert: it is the first /api route to answer with a document a browser could
# execute, so it carries the headers that say not to
qr_headers2=$(mktemp)
curl -s -D "$qr_headers2" -o /dev/null "$BASE/api/artifacts/ci-qr/qr" -H "$AUTH"
grep -qi '^Content-Security-Policy:' "$qr_headers2" || fail "qr svg has no CSP"
grep -qi '^X-Content-Type-Options: nosniff' "$qr_headers2" || fail "qr svg can be sniffed"
rm "$qr_headers2"
echo "ok: qr svg is served inert"

# every option is validated rather than quietly falling back to a default. 0x10, 1e1 and a
# padded value all coerce through Number(), and the extended query parser turns scale[]=8
# into an array that coerces too, so the check is digits-only.
for bad in 'format=gif' 'format=SVG' 'scale=0' 'scale=17' 'scale=2.5' 'scale=abc' 'scale=0x10' 'scale=1e1' 'scale%5B%5D=8' 'margin=-1' 'margin=9'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts/ci-qr/qr?$bad" -H "$AUTH")
  expect_code 400 "$code" "qr rejects $bad"
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts/does-not-exist-zzz/qr" -H "$AUTH")
expect_code 404 "$code" "qr for a missing artifact"
echo "ok: qr option validation"

# a disabled or expired artifact still has a QR, the same way it still has a share link. The
# code is for a slug you own, not proof the slug serves today.
curl -sf -X PATCH "$BASE/api/artifacts/ci-qr" -H "$AUTH" -H "$JSON" -d '{"disabled":true}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-qr")
expect_code 404 "$code" "disabled artifact does not serve"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/artifacts/ci-qr/qr" -H "$AUTH")
expect_code 200 "$code" "disabled artifact still has a qr"
curl -sf -X PATCH "$BASE/api/artifacts/ci-qr" -H "$AUTH" -H "$JSON" -d '{"disabled":false}' > /dev/null
rm "$qr_body"
curl -sf -X DELETE "$BASE/api/artifacts/ci-qr" -H "$AUTH" > /dev/null
echo "ok: qr for a disabled artifact"

# --- pdf artifacts: the file, the viewer page, and the download link ---
# One real one-page PDF, base64 the way the API takes it. Inline rather than generated, so
# this block needs no PDF tooling on the runner.
PDF_B64='JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMjAwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQxPj5zdHJlYW0KQlQgL0YxIDI0IFRmIDMwIDEwMCBUZCAoc21va2UgcGRmKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU0IDAwMDAwIG4gCjAwMDAwMDAxMDUgMDAwMDAgbiAKMDAwMDAwMDIxNyAwMDAwMCBuIAowMDAwMDAwMzA0IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMzY3CiUlRU9GCg=='
PDF_DIR=$(mktemp -d)
printf '%s' "$PDF_B64" | base64 -d > "$PDF_DIR/tiny.pdf" 2>/dev/null || \
  printf '%s' "$PDF_B64" | base64 -D > "$PDF_DIR/tiny.pdf"
head -c 5 "$PDF_DIR/tiny.pdf" | grep -q '%PDF-' || fail "the smoke fixture did not decode to a pdf"

curl -s -X DELETE "$BASE/api/artifacts/ci-pdf" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$PDF_B64\",\"type\":\"pdf\",\"slug\":\"ci-pdf\",\"title\":\"Smoke PDF\",\"visibility\":\"public\"}")
expect_code 201 "$code" "publish pdf"

# The file itself: same bytes back, served as a pdf and byte-rangeable like any other object.
pdf_headers=$(mktemp)
curl -s -D "$pdf_headers" -o "$PDF_DIR/served.pdf" "$BASE/a/ci-pdf/file.pdf" > /dev/null
grep -qi '^Content-Type: application/pdf' "$pdf_headers" || fail "pdf file is not application/pdf"
cmp -s "$PDF_DIR/tiny.pdf" "$PDF_DIR/served.pdf" || fail "pdf bytes came back changed"
rm "$pdf_headers"
echo "ok: pdf bytes round-trip"

# The viewer page, which is what a visit to the artifact gets. It never carries the bytes,
# only the two URLs that do.
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF 'data="/a/ci-pdf/file.pdf#' || fail "pdf viewer does not embed the file"
printf '%s' "$raw" | grep -qF 'href="/a/ci-pdf/file.pdf?download=1"' || fail "pdf viewer has no download link"
printf '%s' "$raw" | grep -qF 'Smoke PDF' || fail "pdf viewer is missing the title"
curl -s "$BASE/a/ci-pdf" | grep -q '<iframe' || fail "a pdf is not framed like every other type"
echo "ok: pdf viewer page"

# The direct-download variant, and /source, which hands over the file that was uploaded.
dl_headers=$(mktemp)
curl -s -D "$dl_headers" -o "$PDF_DIR/dl.pdf" "$BASE/a/ci-pdf/file.pdf?download=1" > /dev/null
grep -qi '^Content-Disposition: attachment; filename="ci-pdf.pdf"' "$dl_headers" \
  || fail "?download=1 is not an attachment"
cmp -s "$PDF_DIR/tiny.pdf" "$PDF_DIR/dl.pdf" || fail "the download variant changed the bytes"
curl -s -D "$dl_headers" -o "$PDF_DIR/src.pdf" "$BASE/a/ci-pdf/source" > /dev/null
grep -qi '^Content-Type: application/pdf' "$dl_headers" || fail "pdf source is not application/pdf"
cmp -s "$PDF_DIR/tiny.pdf" "$PDF_DIR/src.pdf" || fail "pdf source changed the bytes"
rm "$dl_headers"
echo "ok: pdf download and source"

# A pdf owns exactly one sub-path, so nothing else under the slug resolves.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf/anything-else")
expect_code 404 "$code" "pdf subpath"

# A body that is not a PDF is refused at publish time, whatever it decoded from.
notpdf=$(printf '<h1>not a pdf</h1>' | base64 | tr -d '\n')
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$notpdf\",\"type\":\"pdf\",\"slug\":\"ci-pdf-bad\"}")
expect_code 400 "$code" "a pdf body that is not a pdf"

# So is a body that starts like a PDF and then stops. Half an upload passes the magic number,
# so the %%EOF marker in the tail is what catches it; without that check both of these stored
# with a 201 and rendered nothing.
half=$(printf '%s' "$PDF_B64" | cut -c1-60)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$half\",\"type\":\"pdf\",\"slug\":\"ci-pdf-cut\"}")
expect_code 400 "$code" "a pdf body that stops halfway"
err=$(curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$half\",\"type\":\"pdf\",\"slug\":\"ci-pdf-cut\"}")
printf '%s' "$err" | grep -q 'truncated' || fail "a truncated pdf does not say so: $err"

# The direct-download switch takes a truthy value. A bare or falsy one used to attach, which
# made ?download=0 mean "yes, download".
for q in 'download=' 'download=0' 'download=false'; do
  dl_headers=$(mktemp)
  curl -s -D "$dl_headers" -o /dev/null "$BASE/a/ci-pdf/file.pdf?$q"
  if grep -qi '^Content-Disposition' "$dl_headers"; then fail "?$q sent an attachment"; fi
  rm "$dl_headers"
done
echo "ok: only a truthy ?download attaches"

# /source is the one source route served as its own type rather than forced to text/plain, so
# it carries the same headers the file route does.
src_headers=$(mktemp)
curl -s -D "$src_headers" -o /dev/null "$BASE/a/ci-pdf/source"
grep -qi '^Content-Security-Policy:' "$src_headers" || fail "pdf source carries no CSP"
grep -qi '^X-Content-Type-Options: nosniff' "$src_headers" || fail "pdf source is not nosniff"
rm "$src_headers"
echo "ok: pdf source headers"

# The visibility gate covers the new sub-path: a private pdf leaks neither page nor bytes.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$PDF_B64\",\"type\":\"pdf\",\"slug\":\"ci-pdf-priv\",\"visibility\":\"private\"}" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-priv/file.pdf")
expect_code 404 "$code" "private pdf file without a token"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-priv/source")
expect_code 404 "$code" "private pdf source without a token"
# A wrong token is the same 404, not a hint that the slug exists.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-priv/file.pdf?k=notatoken")
expect_code 404 "$code" "private pdf file with a wrong token"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-priv/source?k=notatoken")
expect_code 404 "$code" "private pdf source with a wrong token"
curl -sf -X DELETE "$BASE/api/artifacts/ci-pdf-priv" -H "$AUTH" > /dev/null

# Every other gate covers the same two sub-paths. Locked before expired, so a password
# artifact past its date still answers 404 rather than leaking that it is there at all.
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$PDF_B64\",\"type\":\"pdf\",\"slug\":\"ci-pdf-pw\",\"visibility\":\"password\",\"password\":\"letmein\"}" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-pw/file.pdf")
expect_code 404 "$code" "password pdf file before unlocking"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-pw/source")
expect_code 404 "$code" "password pdf source before unlocking"
curl -sf -X DELETE "$BASE/api/artifacts/ci-pdf-pw" -H "$AUTH" > /dev/null

curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$PDF_B64\",\"type\":\"pdf\",\"slug\":\"ci-pdf-gate\",\"visibility\":\"public\"}" > /dev/null
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf-gate" -H "$AUTH" -H "$JSON" -d '{"disabled":true}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-gate/file.pdf")
expect_code 404 "$code" "disabled pdf file"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-gate/source")
expect_code 404 "$code" "disabled pdf source"
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf-gate" -H "$AUTH" -H "$JSON" \
  -d '{"disabled":false,"expiresAt":"2020-01-01"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-gate/file.pdf")
expect_code 410 "$code" "expired pdf file"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf-gate/source")
expect_code 410 "$code" "expired pdf source"
curl -sf -X DELETE "$BASE/api/artifacts/ci-pdf-gate" -H "$AUTH" > /dev/null
echo "ok: pdf visibility gate"

# --- pdf controls: three viewer modes, and the download toggle ---
# The default is the standard viewer: our toolbar, and the browser's own controls untouched.
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF "mode-standard" || fail "a fresh pdf is not in standard mode"
printf '%s' "$raw" | grep -qF 'id="download"' || fail "standard mode has no download button"
if printf '%s' "$raw" | grep -qF 'toolbar=0'; then fail "standard mode hides the browser toolbar"; fi
# The bar is still in the markup and still holds both buttons: unframed it is the only one on
# the page. The shell removes it only after it finds it is inside the viewer frame.
printf '%s' "$raw" | grep -qF 'id="bar"' || fail "standard mode lost its bar unframed"
printf '%s' "$raw" | grep -qF 'id="open"' || fail "standard mode lost its open button"
printf '%s' "$raw" | grep -qF "framed && '1'" || fail "standard mode does not drop its bar when framed"

curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":{"mode":"minimal"}}' > /dev/null
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF "mode-minimal" || fail "minimal mode did not take"
if printf '%s' "$raw" | grep -qF 'id="bar"'; then fail "minimal mode still renders our toolbar"; fi
# With our bar gone and downloads on, the browser's own toolbar is the only way left to the
# file, so minimal leaves it alone. The block further down covers that both ways.
if printf '%s' "$raw" | grep -qF 'toolbar=0'; then fail "minimal mode hides the browser toolbar too"; fi

curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":{"mode":"presentation"}}' > /dev/null
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF "mode-presentation" || fail "presentation mode did not take"
printf '%s' "$raw" | grep -qF 'id="fullscreen"' || fail "presentation mode has no full-screen button"
printf '%s' "$raw" | grep -qF 'view=Fit&' || fail "presentation mode does not fit a whole page"
# T2.2.6: framed standard mode drops our bar, because the frame's bar above and the browser's
# toolbar below already carry everything it held. The shell decides that at load time, so what
# the server sends is the switch. presentation keeps its bar for the full-screen button.
printf '%s' "$raw" | grep -qF "framed && ''" || fail "presentation mode gives up its bar"

# T2.2.5: the browser's toolbar is the page counter and the prev/next of a deck, so presentation
# leaves it up and only asks the side panel to go. Nothing here can build its own: an <object>
# holding a PDF exposes no current page.
if printf '%s' "$raw" | grep -qF 'toolbar=0'; then fail "presentation mode has no page navigation"; fi
printf '%s' "$raw" | grep -qF 'navpanes=0' || fail "presentation mode keeps the side panel"
echo "ok: pdf modes"

# A patch names one key and leaves the other alone, and the row carries both.
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":{"download":false}}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"pdf":{"mode":"presentation","download":false}' \
  || fail "the pdf row does not carry its settings"
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF "mode-presentation" || fail "a download patch reset the mode"
if printf '%s' "$raw" | grep -qF 'id="download"'; then fail "downloads off still shows a download button"; fi
if printf '%s' "$raw" | grep -qF 'id="open"'; then fail "downloads off still shows an open button"; fi
# The one combination that cannot have both: downloads off works by taking the browser's toolbar
# away, and that toolbar is also the page counter. The download setting wins, and formats.md
# says so rather than leaving it to be discovered.
printf '%s' "$raw" | grep -qF 'toolbar=0' || fail "presentation with downloads off kept the browser toolbar"
# Viewer-level only, and the docs say so: the bytes are still one URL away.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf/file.pdf")
expect_code 200 "$code" "the file with downloads off"

# null hands the artifact back to the defaults, the way {"frame": null} does.
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":null}' > /dev/null
[ -z "$(list_field ci-pdf pdf)" ] || fail "pdf:null did not clear the stored settings"
curl -s "$BASE/a/ci-pdf?raw=1" | grep -qF "mode-standard" || fail "pdf:null did not restore the standard viewer"
echo "ok: pdf download toggle and reset"

# Values the server does not understand are a 400, not a silent drop.
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" \
  -d '{"pdf":{"mode":"slides"}}')
expect_code 400 "$code" "an unknown pdf mode"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" \
  -d '{"pdf":{"toolbar":false}}')
expect_code 400 "$code" "an unknown pdf setting"
# Settings on an artifact with no viewer page are refused rather than stored and ignored.
curl -s -X DELETE "$BASE/api/artifacts/ci-pdf-nothtml" -H "$AUTH" > /dev/null
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>not a pdf</h1>","type":"html","slug":"ci-pdf-nothtml"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/artifacts/ci-pdf-nothtml" -H "$AUTH" -H "$JSON" \
  -d '{"pdf":{"mode":"minimal"}}')
expect_code 400 "$code" "pdf settings on an html artifact"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/artifacts/ci-pdf-nothtml" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>still not a pdf</h1>","type":"html","pdf":{"mode":"minimal"}}')
expect_code 400 "$code" "pdf settings on an html publish"
curl -sf -X DELETE "$BASE/api/artifacts/ci-pdf-nothtml" -H "$AUTH" > /dev/null
# Set at publish time too, not only by a later patch.
curl -s -X DELETE "$BASE/api/artifacts/ci-pdf-modes" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$PDF_B64\",\"type\":\"pdf\",\"slug\":\"ci-pdf-modes\",\"visibility\":\"public\",\"pdf\":{\"mode\":\"minimal\",\"download\":false}}")
expect_code 201 "$code" "publish a pdf with viewer settings"
curl -s "$BASE/a/ci-pdf-modes?raw=1" | grep -qF "mode-minimal" || fail "publish-time pdf settings did not take"
curl -sf -X DELETE "$BASE/api/artifacts/ci-pdf-modes" -H "$AUTH" > /dev/null
echo "ok: pdf settings validation"

# A bar of ours with nothing in it is not drawn. standard + downloads off has no buttons left,
# and inside the frame the title is already in the frame's bar, so what rendered was a 44px
# empty strip. minimal is the other way round: our bar is gone, so the browser's own toolbar
# has to stay or downloads-on has no way to reach the file.
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" \
  -d '{"pdf":{"mode":"standard","download":false}}' > /dev/null
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
if printf '%s' "$raw" | grep -qF 'id="bar"'; then fail "an empty pdf toolbar is still rendered"; fi
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" \
  -d '{"pdf":{"mode":"minimal","download":true}}' > /dev/null
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
if printf '%s' "$raw" | grep -qF 'toolbar=0'; then fail "minimal with downloads on hides the browser toolbar"; fi
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":null}' > /dev/null
echo "ok: no empty pdf toolbar, and minimal keeps the browser's"

# The toolbar buttons name themselves. Under 480px the CSS drops the label text, which takes it
# out of the accessible name, and the glyph is all a screen reader had left.
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF 'aria-label="Open the PDF in a new tab"' || fail "the Open button has no accessible name"
printf '%s' "$raw" | grep -qF 'aria-label="Download the PDF"' || fail "the Download button has no accessible name"
# The open parameters are joined with "&", which has to be escaped inside an attribute.
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":{"mode":"presentation"}}' > /dev/null
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF 'file.pdf#view=Fit&amp;navpanes=0' || fail "the embed url is not escaped"
printf '%s' "$raw" | grep -qF 'aria-label="Show the document full screen"' || fail "the Full screen button has no accessible name"
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":null}' > /dev/null
echo "ok: pdf toolbar accessible names and escaping"

# The <object>'s fallback: what a browser that will not render a PDF shows, and what the shell's
# probe swaps in when a browser takes the type and paints nothing. With downloads off there are
# no links to offer, so the markup says that instead of shipping the URLs the toggle removed.
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF 'id="fallback"' || fail "the pdf viewer has no fallback"
printf '%s' "$raw" | grep -qF '>Open the PDF</a>' || fail "the fallback has no open link"
printf '%s' "$raw" | grep -qF '>Download the PDF</a>' || fail "the fallback has no download link"
printf '%s' "$raw" | grep -qF "this.dataset.loaded" || fail "the fallback probe is missing"
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":{"download":false}}' > /dev/null
raw=$(curl -s "$BASE/a/ci-pdf?raw=1")
printf '%s' "$raw" | grep -qF 'id="fallback"' || fail "downloads off dropped the fallback itself"
if printf '%s' "$raw" | grep -qF '>Open the PDF</a>'; then fail "downloads off kept the fallback open link"; fi
if printf '%s' "$raw" | grep -qF '>Download the PDF</a>'; then fail "downloads off kept the fallback download link"; fi
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":null}' > /dev/null
echo "ok: pdf object fallback"

# A PUT replaces the bytes, and a PUT that names no type is refused rather than converting the
# artifact to html and deleting the file: for every other type the caller still holds the source,
# and for this one the bytes are gone.
curl -sf -X PUT "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" \
  -d "{\"content\":\"$PDF_B64\",\"type\":\"pdf\",\"title\":\"Smoke PDF replaced\"}" > /dev/null
[ "$(list_field ci-pdf title)" = 'Smoke PDF replaced' ] || fail "a pdf PUT did not replace the artifact"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf/file.pdf")
expect_code 200 "$code" "the file after a pdf PUT"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>silently html</h1>"}')
expect_code 400 "$code" "a pdf PUT with no type"
[ "$(list_field ci-pdf type)" = 'pdf' ] || fail "the refused PUT changed the type anyway"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-pdf/file.pdf")
expect_code 200 "$code" "the file after the refused PUT"
echo "ok: pdf put and the no-type refusal"

# A copy of a pdf gets its own bytes and keeps the source's viewer settings, and takes an
# override in the body the way every other setting on the endpoint does. A value the server
# does not understand is a 400 here too, not a 201 that quietly kept the source's.
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" \
  -d '{"pdf":{"mode":"presentation","download":false}}' > /dev/null
curl -s -X DELETE "$BASE/api/artifacts/ci-pdf-copy" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/ci-pdf/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-pdf-copy","visibility":"public"}')
expect_code 201 "$code" "duplicate a pdf"
[ "$(list_field ci-pdf-copy type)" = 'pdf' ] || fail "the copy is not listed as a pdf"
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"pdf":{"mode":"presentation","download":false}' \
  || fail "the copy did not keep the source's viewer settings"
curl -s -D "$PDF_DIR/copy.h" -o "$PDF_DIR/copy.pdf" "$BASE/a/ci-pdf-copy/file.pdf" > /dev/null
grep -qi '^Content-Type: application/pdf' "$PDF_DIR/copy.h" || fail "the copy does not serve its own file"
cmp -s "$PDF_DIR/tiny.pdf" "$PDF_DIR/copy.pdf" || fail "the copy's bytes came back changed"
curl -sf -X DELETE "$BASE/api/artifacts/ci-pdf-copy" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/ci-pdf/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-pdf-copy2","pdf":{"mode":"bogus"}}')
expect_code 400 "$code" "duplicate with a pdf mode the server does not know"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/ci-pdf/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-pdf-copy2","pdf":{"mode":"minimal"},"visibility":"public"}')
expect_code 201 "$code" "duplicate with a pdf override"
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"pdf":{"mode":"minimal","download":false}' \
  || fail "the duplicate override did not take"
curl -sf -X DELETE "$BASE/api/artifacts/ci-pdf-copy2" -H "$AUTH" > /dev/null
curl -sf -X PATCH "$BASE/api/artifacts/ci-pdf" -H "$AUTH" -H "$JSON" -d '{"pdf":null}' > /dev/null
echo "ok: duplicate a pdf"

curl -sf -X DELETE "$BASE/api/artifacts/ci-pdf" -H "$AUTH" > /dev/null
rm -r "$PDF_DIR"

# --- dashboard: the served shell parses and still lines up with its own markup ---
# Nothing else in CI loads `/`, so a broken inline script in public/index.html used to
# ship green. No browser here; see the header of dashboard-check.mjs for what that
# leaves uncovered.
node "$(dirname "$0")/dashboard-check.mjs" "$BASE"

# CLI round-trip (cli.js lives next to this checkout; skipped when deps absent,
# e.g. the container-smoke job which doesn't run npm ci)
CLI_DIR=$REPO_DIR
if [ ! -d "$CLI_DIR/node_modules" ]; then
  echo "skip: cli smoke (no node_modules)"
  echo "all smoke tests passed"
  exit 0
fi
export ARTIFACTS_URL=$BASE ARTIFACTS_API_KEY=$KEY
echo '<h1>cli smoke</h1>' > "$ZIPDIR/cli.html"
url=$(node "$CLI_DIR/cli.js" publish "$ZIPDIR/cli.html" --slug ci-cli --tags cli,smoke --visibility public)
[ "$url" = "$BASE/a/ci-cli" ] || fail "cli publish: unexpected url $url"
node "$CLI_DIR/cli.js" list --tag cli | grep -q 'ci-cli' || fail "cli --tags not stored"
node "$CLI_DIR/cli.js" tag ci-cli none > /dev/null
if node "$CLI_DIR/cli.js" list --tag cli | grep -q 'ci-cli'; then fail "cli tag clear failed"; fi
echo "ok: cli publish + tags"
node "$CLI_DIR/cli.js" rename ci-cli ci-cli-2 > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-2")
expect_code 200 "$code" "cli rename"
node "$CLI_DIR/cli.js" config | grep -q '"enabled"' || fail "cli config get"
echo "ok: cli config"

# branding from the cli. One flag at a time: the other four have to survive, because the server
# merges a partial branding object and the cli only sends the flags it was given.
node "$CLI_DIR/cli.js" config --brand-name 'CLI Brand' --brand-footer 'Published with CLI Brand' > /dev/null
node "$CLI_DIR/cli.js" config --brand-accent '#0055ff' > /dev/null
cfg=$(node "$CLI_DIR/cli.js" config)
echo "$cfg" | grep -q '"productName": "CLI Brand"' || fail "cli --brand-name did not land"
echo "$cfg" | grep -q '"footerText": "Published with CLI Brand"' || fail "cli --brand-footer did not land"
echo "$cfg" | grep -q '"accentColor": "#0055ff"' || fail "cli --brand-accent did not land"
# the accent save left the name and footer alone
node "$CLI_DIR/cli.js" config --brand-name none > /dev/null
cfg=$(node "$CLI_DIR/cli.js" config)
echo "$cfg" | grep -q '"productName": ""' || fail "cli --brand-name none did not clear"
echo "$cfg" | grep -q '"footerText": "Published with CLI Brand"' || fail "clearing one field cleared another"
# a remote logo is refused by the same rule the dashboard states: same origin or inline only
if node "$CLI_DIR/cli.js" config --brand-logo https://cdn.example.com/l.png > /dev/null 2>&1; then
  fail "cli accepted a hotlinked logo"
fi
node "$CLI_DIR/cli.js" config --brand-logo /a/brand/logo.png > /dev/null
node "$CLI_DIR/cli.js" config | grep -q '"logoUrl": "/a/brand/logo.png"' || fail "cli --brand-logo path refused"
# put it all back the way the branding block was before this section ran
node "$CLI_DIR/cli.js" config --brand-name none --brand-logo none --brand-favicon none \
  --brand-accent none --brand-footer none > /dev/null
echo "ok: cli branding flags"

# the dashboard reads the server's refusal and puts it under the field it names, so the message
# has to keep opening with `branding.<field>`.
msg=$(curl -s -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"branding":{"logoUrl":"https://cdn.example.com/l.png"}}')
echo "$msg" | grep -q 'branding.logoUrl' || fail "a refused branding value no longer names its field"
echo "ok: a branding refusal names its field"

# the settings panel ships the five inputs and an error slot per field.
#
# The console is ~113 kB, and this script runs under `set -o pipefail`. `curl | grep -q` on a
# body that big is a race: grep matches, exits, and curl dies of SIGPIPE with 141, which
# pipefail then reads as a failed check. Every page-sized assertion below fetches once into a
# file and greps the file, which is also 16 fewer requests.
console=$(mktemp)
curl -s -o "$console" "$BASE/"
for id in brandName brandLogo brandFavicon brandAccent brandFooter brandAccentPick; do
  grep -q "id=\"$id\"" "$console" || fail "settings panel has no $id input"
done
for id in brandErrProductName brandErrLogoUrl brandErrFaviconUrl brandErrAccentColor brandErrFooterText; do
  grep -q "id=\"$id\"" "$console" || fail "settings panel has no $id error slot"
done
echo "ok: settings panel branding inputs"

# the console reads the same block every viewer page does. Unbranded first: the built-in mark,
# the built-in title, and the empty favicon answer the route has always given.
curl -s -o "$console" "$BASE/"
grep -q '<title>artifacts</title>' "$console" || fail "unbranded console lost its title"
grep -q '<svg class="mark"' "$console" || fail "unbranded console lost the built-in mark"
if grep -q 'rel="icon"' "$console"; then fail "unbranded console invented a favicon"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/favicon.ico")
expect_code 204 "$code" "unbranded favicon.ico"
curl -sf -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" \
  -d '{"branding":{"productName":"Consolebrand","logoUrl":"/a/ci-brand-logo/logo.png","faviconUrl":"/a/ci-brand-logo/f.png","accentColor":"#0055ff"}}' > /dev/null
curl -s -o "$console" "$BASE/"
grep -q '<title>Consolebrand</title>' "$console" || fail "console title is not branded"
grep -q '<h1>Consolebrand</h1>' "$console" || fail "lock heading is not branded"
grep -q '<span class="wordmark">Consolebrand</span>' "$console" || fail "wordmark is not branded"
grep -q '<link rel="icon" href="/a/ci-brand-logo/f.png">' "$console" || fail "console favicon tag missing"
grep -q '<img class="mark" src="/a/ci-brand-logo/logo.png"' "$console" || fail "console mark is not the logo"
if grep -q '<svg class="mark"' "$console"; then fail "the built-in mark survived a logo"; fi
grep -q -- '--molten: #0055ff;' "$console" || fail "console accent did not land"
# the well-known path follows the branding too, for anything that does not read the head first
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/favicon.ico")
expect_code 302 "$code" "branded favicon.ico redirects"
curl -s -D - -o /dev/null "$BASE/favicon.ico" | grep -qi '^location: /a/ci-brand-logo/f.png' \
  || fail "branded favicon.ico points somewhere else"
# an inline favicon is decoded rather than redirected
curl -sf -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" \
  -d '{"branding":{"faviconUrl":"data:image/png;base64,aGVsbG8="}}' > /dev/null
curl -s -D - -o /dev/null "$BASE/favicon.ico" | grep -qi '^content-type: image/png' \
  || fail "an inline favicon is not served as an image"
curl -s "$BASE/favicon.ico" | grep -q '^hello$' || fail "inline favicon bytes did not decode"
# back to unbranded, and the console is the page it was before any of this
curl -sf -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" \
  -d '{"branding":{"productName":"","logoUrl":"","faviconUrl":"","accentColor":"","footerText":""}}' > /dev/null
curl -s -o "$console" "$BASE/"
grep -q '<title>artifacts</title>' "$console" || fail "console did not go back to unbranded"
grep -q '<svg class="mark"' "$console" || fail "the built-in mark did not come back"
rm "$console"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/favicon.ico")
expect_code 204 "$code" "favicon.ico back to empty"
echo "ok: the console follows the branding block"
node "$CLI_DIR/cli.js" frame ci-cli-2 off > /dev/null
if curl -s "$BASE/a/ci-cli-2" | grep -q '<iframe'; then fail "cli frame off still framed"; fi
echo "ok: cli frame off"
node "$CLI_DIR/cli.js" project ci-cli-2 web-revamp > /dev/null
node "$CLI_DIR/cli.js" list --project web-revamp | grep -q 'ci-cli-2' || fail "cli project not stored"
node "$CLI_DIR/cli.js" project ci-cli-2 none > /dev/null
if node "$CLI_DIR/cli.js" list --project web-revamp | grep -q 'ci-cli-2'; then fail "cli project clear failed"; fi
echo "ok: cli project"
# link preview: both fields on publish, then the preview verb on an existing slug. The served
# page is the check, since that is the only place the tags actually have to appear.
url=$(node "$CLI_DIR/cli.js" publish "$ZIPDIR/cli.html" --slug ci-cli-og --visibility public \
  --description 'set from the cli' --og-image https://example.com/cli.png)
[ "$url" = "$BASE/a/ci-cli-og" ] || fail "cli publish with preview fields: unexpected url $url"
curl -s "$BASE/a/ci-cli-og" | grep -qF '<meta name="description" content="set from the cli">' \
  || fail "cli --description not stored"
curl -s "$BASE/a/ci-cli-og" | grep -qF '<meta property="og:image" content="https://example.com/cli.png">' \
  || fail "cli --og-image not stored"
node "$CLI_DIR/cli.js" list | grep 'ci-cli-og' | grep -q 'preview' || fail "cli list does not flag a preview"
node "$CLI_DIR/cli.js" update ci-cli-og "$ZIPDIR/cli.html" --description 'set from cli update' > /dev/null
curl -s "$BASE/a/ci-cli-og" | grep -qF '<meta name="description" content="set from cli update">' \
  || fail "cli update --description not stored"
node "$CLI_DIR/cli.js" preview ci-cli-og --description 'edited by the preview verb' > /dev/null
curl -s "$BASE/a/ci-cli-og" | grep -qF '<meta name="description" content="edited by the preview verb">' \
  || fail "cli preview --description did not land"
# The image is untouched by a description-only edit, which is the whole point of one PATCH per field.
curl -s "$BASE/a/ci-cli-og" | grep -qF 'https://example.com/cli.png' || fail "cli preview dropped the image"
node "$CLI_DIR/cli.js" preview ci-cli-og --description none --og-image none > /dev/null
if curl -s "$BASE/a/ci-cli-og" | grep -q 'og:image'; then fail "cli preview none did not clear the image"; fi
if node "$CLI_DIR/cli.js" list | grep 'ci-cli-og' | grep -q 'preview'; then fail "cli list still flags a cleared preview"; fi
# No flag at all is a usage error, not a PATCH that changes nothing.
if node "$CLI_DIR/cli.js" preview ci-cli-og > /dev/null 2>&1; then fail "cli preview with no flag should fail"; fi
# A value the server refuses comes back as its 400, relayed rather than swallowed.
if node "$CLI_DIR/cli.js" preview ci-cli-og --og-image /relative.png > /dev/null 2>&1; then
  fail "cli preview --og-image /relative.png should fail"
fi
node "$CLI_DIR/cli.js" delete ci-cli-og > /dev/null
echo "ok: cli link preview"

# A preview on an artifact nothing will render it for: the value is stored, and the operator is
# told on the way out rather than finding out from a chat app that shows nothing. The warning
# goes to stderr, so `2>&1 >/dev/null` here keeps stderr and drops the url on stdout.
echo '# cli preview smoke' > "$ZIPDIR/cli.md"
warn=$(node "$CLI_DIR/cli.js" publish "$ZIPDIR/cli.html" --slug ci-prev-off --visibility public \
  --frame off --description 'set with the frame off' 2>&1 >/dev/null)
echo "$warn" | grep -q '^warning: ' || fail "no warning for a preview with the frame off"
echo "$warn" | grep -q 'frame is off' || fail "the warning does not say why"
# stored all the same: a warning is not a refusal
node "$CLI_DIR/cli.js" list | grep 'ci-prev-off' | grep -q 'preview' || fail "the warned preview did not store"
# and it is telling the truth: nothing renders the tags with the frame off
prev=$(mktemp)
curl -s -o "$prev" "$BASE/a/ci-prev-off"
if grep -q 'og:description' "$prev"; then fail "an unframed html carried preview tags after all"; fi
# turn the frame on and the same set goes quiet, because now the tags are really there
node "$CLI_DIR/cli.js" frame ci-prev-off on > /dev/null
warn=$(node "$CLI_DIR/cli.js" preview ci-prev-off --description 'now framed' 2>&1 >/dev/null)
[ -z "$warn" ] || fail "still warning after the frame went on: $warn"
curl -s -o "$prev" "$BASE/a/ci-prev-off"
grep -q 'og:description' "$prev" || fail "a framed html carries no preview tags"
# md and pdf are pages the server renders, so they carry the tags with the frame off and are
# never warned about
warn=$(node "$CLI_DIR/cli.js" publish "$ZIPDIR/cli.md" --slug ci-prev-md --visibility public \
  --frame off --description 'md with the frame off' 2>&1 >/dev/null)
[ -z "$warn" ] || fail "md was warned about a preview it does carry: $warn"
curl -s -o "$prev" "$BASE/a/ci-prev-md"
grep -q 'og:description' "$prev" || fail "an unframed md lost its preview tags"
# $PDF_DIR is cleaned up by the time this runs, so decode the fixture again next to the others
printf '%s' "$PDF_B64" | base64 -d > "$ZIPDIR/prev.pdf" 2>/dev/null || \
  printf '%s' "$PDF_B64" | base64 -D > "$ZIPDIR/prev.pdf"
warn=$(node "$CLI_DIR/cli.js" publish "$ZIPDIR/prev.pdf" --slug ci-prev-pdf --visibility public \
  --frame off --description 'pdf with the frame off' 2>&1 >/dev/null)
[ -z "$warn" ] || fail "pdf was warned about a preview it does carry: $warn"
curl -s -o "$prev" "$BASE/a/ci-prev-pdf"
grep -q 'og:description' "$prev" || fail "an unframed pdf lost its preview tags"
# a redirect has no page at all, and says so in its own words rather than blaming the frame
printf 'https://example.com/' > "$ZIPDIR/cli-redirect.url"
node "$CLI_DIR/cli.js" publish "$ZIPDIR/cli-redirect.url" --slug ci-prev-red --type redirect \
  --visibility public > /dev/null
warn=$(node "$CLI_DIR/cli.js" preview ci-prev-red --description 'never shows' 2>&1 >/dev/null)
echo "$warn" | grep -q '301' || fail "a redirect preview is not warned about as a redirect"
if echo "$warn" | grep -q 'frame is off'; then fail "a redirect was blamed on the frame"; fi
rm -f "$prev"
for s in ci-prev-off ci-prev-md ci-prev-pdf ci-prev-red; do
  curl -sf -X DELETE "$BASE/api/artifacts/$s" -H "$AUTH" > /dev/null
done
echo "ok: an unreachable link preview is warned about, not silently dropped"
diff <(qr_local "$BASE/a/ci-cli-2") <(node "$CLI_DIR/cli.js" qr ci-cli-2) > /dev/null \
  || fail "cli qr printed something other than the server's svg"
diff <(qr_local "$BASE/a/ci-cli-2" 3 0) <(node "$CLI_DIR/cli.js" qr ci-cli-2 --scale 3 --margin 0) > /dev/null \
  || fail "cli qr does not pass --scale/--margin through"
node "$CLI_DIR/cli.js" qr ci-cli-2 --png -o "$ZIPDIR/cli-qr.png" > /dev/null
[ "$(head -c 8 "$ZIPDIR/cli-qr.png" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || fail "cli qr --png is not a png"
# -o out.png means a PNG even without --png, the way publish infers a type from the extension
node "$CLI_DIR/cli.js" qr ci-cli-2 -o "$ZIPDIR/cli-qr-2.png" > /dev/null
[ "$(head -c 8 "$ZIPDIR/cli-qr-2.png" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || fail "cli qr -o *.png wrote an svg"
node "$CLI_DIR/cli.js" qr ci-cli-2 -o "$ZIPDIR/cli-qr.svg" > /dev/null
head -c 4 "$ZIPDIR/cli-qr.svg" | grep -q '<svg' || fail "cli qr -o *.svg is not an svg"
# a PNG on a terminal is noise, so the CLI refuses rather than spraying bytes
if node "$CLI_DIR/cli.js" qr ci-cli-2 --png > /dev/null 2>&1; then fail "cli qr --png without -o should fail"; fi
# a bad option is the server's 400, relayed rather than swallowed
if node "$CLI_DIR/cli.js" qr ci-cli-2 --scale 99 > /dev/null 2>&1; then fail "cli qr --scale 99 should fail"; fi
echo "ok: cli qr"
node "$CLI_DIR/cli.js" deploy "$ZIPDIR/site" --slug ci-cli-zip --visibility public \
  --description 'a zip from the cli' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-zip/css/s.css")
expect_code 200 "$code" "cli zip deploy"
curl -s "$BASE/a/ci-cli-zip/" | grep -qF '<meta name="description" content="a zip from the cli">' \
  || fail "cli deploy --description not stored"
node "$CLI_DIR/cli.js" delete ci-cli-2 > /dev/null
node "$CLI_DIR/cli.js" delete ci-cli-zip > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-2")
expect_code 404 "$code" "cli delete"

# The CLI infers pdf from the extension, sends the file base64-encoded, and reads `source`
# back as bytes rather than text.
printf '%s' "$PDF_B64" | base64 -d > "$ZIPDIR/tiny.pdf" 2>/dev/null || \
  printf '%s' "$PDF_B64" | base64 -D > "$ZIPDIR/tiny.pdf"
node "$CLI_DIR/cli.js" publish "$ZIPDIR/tiny.pdf" --slug ci-cli-pdf --visibility public > /dev/null
node "$CLI_DIR/cli.js" source ci-cli-pdf -o "$ZIPDIR/cli.pdf" > /dev/null
cmp -s "$ZIPDIR/tiny.pdf" "$ZIPDIR/cli.pdf" || fail "cli round-trip changed the pdf bytes"
node "$CLI_DIR/cli.js" list | grep 'ci-cli-pdf' | grep -q 'pdf' || fail "cli list does not show the pdf type"
node "$CLI_DIR/cli.js" pdf ci-cli-pdf presentation > /dev/null
curl -s "$BASE/a/ci-cli-pdf?raw=1" | grep -qF 'mode-presentation' || fail "cli pdf presentation did not take"
node "$CLI_DIR/cli.js" pdf ci-cli-pdf download-off > /dev/null
if curl -s "$BASE/a/ci-cli-pdf?raw=1" | grep -qF 'id="download"'; then fail "cli pdf download-off did not take"; fi
node "$CLI_DIR/cli.js" pdf ci-cli-pdf default > /dev/null
curl -s "$BASE/a/ci-cli-pdf?raw=1" | grep -qF 'mode-standard' || fail "cli pdf default did not reset"
if node "$CLI_DIR/cli.js" pdf ci-cli-pdf slides > /dev/null 2>&1; then fail "cli pdf slides should fail"; fi
node "$CLI_DIR/cli.js" delete ci-cli-pdf > /dev/null
echo "ok: cli pdf"

# --- publish rate limit (T2.2.4) ---
# Body parsing runs before routing, so a large JSON body is buffered before requireAuth sees
# the request. Measured on a fresh process: 40 concurrent 9.33 MB bodies with no Authorization
# header took RSS from 42 MB to 551 MB, every one of them answering 401. The publish routes now
# cap how many large bodies one client IP can send per minute, checked above the parser, so a
# caller past the budget costs a header read and nothing else.
#
# Last in the file on purpose: the flood spends this IP's large-body budget for the rest of the
# minute, and everything above publishes from the same address.
bigbody=$(mktemp)
node -e 'process.stdout.write(JSON.stringify({content:"x".repeat(400000),type:"html"}))' > "$bigbody"
floodcodes=$(mktemp)
floodheaders=$(mktemp)
floodbody=$(mktemp)

# The gate used to key on the method, and body-parser has no method filter: it reads a body from
# any request that carries one and matches the content type. So a GET with a body skipped the
# gate and got the 10 MB parser, and 40 concurrent 9 MB bodies to GET /healthz with no credential
# at all took RSS from 89,280 KB to 580,960 KB. The healthcheck endpoint, unauthenticated.
code=$(curl -s -o "$floodbody" -w '%{http_code}' -X GET "$BASE/healthz" -H "$JSON" \
  --data-binary "@$bigbody")
expect_code 413 "$code" "a GET carrying a body is capped like any other body"
# and the 413 names the limit that applied, not the 10 MB one this caller was already under
grep -q 'the limit on this request is 256 kb' "$floodbody" \
  || fail "the 413 does not name the limit that applied: $(cat "$floodbody")"
echo "ok: the 413 names the limit that actually applied"

# A read key is the weakest credential an operator can issue. It gets the same small parser: it
# cannot publish, so it has no use for a 10 MB buffer, and it used to get one and then a 403.
resp=$(curl -s -X POST "$BASE/api/keys" -H "$AUTH" -H "$JSON" -d '{"name":"ci-flood-read","scopes":["read"]}')
floodreadkey=$(printf '%s' "$resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))')
floodreadid=$(printf '%s' "$resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$JSON" \
  -H "Authorization: Bearer $floodreadkey" --data-binary "@$bigbody")
expect_code 413 "$code" "a read-scope key gets the small parser, not the publish-sized one"
curl -sf -X DELETE "$BASE/api/keys/$floodreadid" -H "$AUTH" > /dev/null

for n in $(seq 1 25); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/artifacts" -H "$JSON" \
    --data-binary "@$bigbody" >> "$floodcodes" &
done
wait
refused=$(grep -c '^429$' "$floodcodes" || true)
[ "$refused" -gt 0 ] || fail "an unauthenticated flood of large bodies was never refused: $(sort "$floodcodes" | uniq -c | tr '\n' ' ')"
echo "ok: an unauthenticated flood of large bodies is refused ($refused of 25 answered 429)"
# and the refusal says when to come back
curl -s -D "$floodheaders" -o /dev/null -X POST "$BASE/api/artifacts" -H "$JSON" \
  --data-binary "@$bigbody"
grep -qi '^Retry-After:' "$floodheaders" || fail "the 429 does not say when to retry"
echo "ok: the publish 429 carries Retry-After"
# And the budget counts a GET the same way, so the flood cannot come back through a method the
# gate does not look at. This IP has already spent it, so one request is enough to show it.
code=$(curl -s -o /dev/null -w '%{http_code}' -X GET "$BASE/healthz" -H "$JSON" \
  --data-binary "@$bigbody")
expect_code 429 "$code" "a GET with a large body spends the same budget"
# A normal publish is a few kB and never touches the budget, even now that this IP has spent it.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>after the flood</h1>","type":"html","slug":"ci-flood","visibility":"public"}')
expect_code 201 "$code" "an ordinary publish after the flood"
curl -sf -X DELETE "$BASE/api/artifacts/ci-flood" -H "$AUTH" > /dev/null
rm "$bigbody" "$floodcodes" "$floodheaders" "$floodbody"

echo "all smoke tests passed"
