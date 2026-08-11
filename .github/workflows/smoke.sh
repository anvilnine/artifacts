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
echo "ok: config endpoint"

# per-item frame off -> /a/slug serves the bare artifact (no iframe), then reset to inherit
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"frame":false}' > /dev/null
body=$(curl -s "$BASE/a/ci-smoke")
if echo "$body" | grep -q '<iframe'; then fail "frame:false still framed"; fi
echo "$body" | grep -q "<h1>smoke</h1>" || fail "frame:false body missing content"
echo "ok: per-item frame off"
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"frame":null}' > /dev/null

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

curl -sf -X DELETE "$BASE/api/artifacts/ci-dup" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip-dup" -H "$AUTH" > /dev/null

# delete both -> 404
curl -sf -X DELETE "$BASE/api/artifacts/ci-smoke-2" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke-2")
expect_code 404 "$code" "deleted artifact"

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

mcp_pub=$(mcp_call 3 tools/call \
  '{"name":"publish_artifact","arguments":{"content":"<h1>mcp</h1>","type":"html","slug":"ci-mcp","visibility":"public"}}')
mcp_url=$(printf '%s' "$mcp_pub" | mcp_text)
# The response is a three-line SSE frame, so flatten it before it goes into a FAIL line
# that someone will read through `grep FAIL` on a CI log.
[ "$mcp_url" = "$BASE/a/ci-mcp" ] \
  || fail "MCP publish_artifact returned '$mcp_url' (got: $(printf '%s' "$mcp_pub" | tr '\n' ' '))"
curl -s "$BASE/a/ci-mcp?raw=1" | grep -q '<h1>mcp</h1>' || fail "MCP publish_artifact served no body"
echo "ok: MCP publish_artifact round-trip"

mcp_list=$(mcp_call 4 tools/call '{"name":"list_artifacts","arguments":{}}')
printf '%s' "$mcp_list" | grep -q 'ci-mcp' || fail "MCP list_artifacts omits the artifact it just published"
echo "ok: MCP list_artifacts"

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

# --- MCP scopes: a read-scoped key drives a read tool and is refused by publish and delete ---
# Every call above carries the bootstrap key, which outranks every scope, so nothing above
# reaches requireScope (server.js). Delete that gate outright and the unit tests plus every
# check above here stay green.
mcp_key_resp=$(curl -s -X POST "$BASE/api/keys" -H "$AUTH" -H "$JSON" \
  -d '{"name":"ci-mcp-readonly","scopes":["read"]}')
mcp_read_key=$(printf '%s' "$mcp_key_resp" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
mcp_read_key_id=$(printf '%s' "$mcp_key_resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
# This is the one response on the instance that carries a token in the clear, so scrub it
# before any of it reaches a CI log.
mcp_key_redacted=$(printf '%s' "$mcp_key_resp" | tr '\n' ' ' | sed 's/"key":"[^"]*"/"key":"REDACTED"/')
case "$mcp_read_key" in
  ah_*) ;;
  *) fail "could not mint a read-only key, so the scope gate is untested. POST /api/keys is admin-only, so this needs the bootstrap key rather than a managed one (got: $mcp_key_redacted)" ;;
esac
[ -n "$mcp_read_key_id" ] || fail "minted key has no id, cannot revoke it (got: $mcp_key_redacted)"

# The read key has to work for a read tool, or the two refusals below prove nothing: a key
# that is broken outright would be "refused" by every tool for the wrong reason.
mcp_ro_list=$(mcp_call_as "$mcp_read_key" 6 tools/call '{"name":"list_artifacts","arguments":{}}')
if printf '%s' "$mcp_ro_list" | grep -q '"isError":true'; then
  fail "MCP list_artifacts refused a read-scoped key ($(printf '%s' "$mcp_ro_list" | tr '\n' ' '))"
fi
printf '%s' "$mcp_ro_list" | grep -q 'ci-mcp' \
  || fail "MCP list_artifacts returned no artifacts for a read-scoped key ($(printf '%s' "$mcp_ro_list" | tr '\n' ' '))"
echo "ok: MCP list_artifacts accepts a read-scoped key"

# publish sits one rank above read. The refusal arrives as a tool result carrying isError,
# not as a JSON-RPC error, so a check for '"error"' would never match it.
mcp_denied=$(mcp_call_as "$mcp_read_key" 7 tools/call \
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
mcp_denied_del=$(mcp_call_as "$mcp_read_key" 8 tools/call \
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

mcp_call 9 tools/call '{"name":"delete_artifact","arguments":{"slug":"ci-mcp"}}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-mcp")
expect_code 404 "$code" "MCP delete_artifact"

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
node "$CLI_DIR/cli.js" frame ci-cli-2 off > /dev/null
if curl -s "$BASE/a/ci-cli-2" | grep -q '<iframe'; then fail "cli frame off still framed"; fi
echo "ok: cli frame off"
node "$CLI_DIR/cli.js" project ci-cli-2 web-revamp > /dev/null
node "$CLI_DIR/cli.js" list --project web-revamp | grep -q 'ci-cli-2' || fail "cli project not stored"
node "$CLI_DIR/cli.js" project ci-cli-2 none > /dev/null
if node "$CLI_DIR/cli.js" list --project web-revamp | grep -q 'ci-cli-2'; then fail "cli project clear failed"; fi
echo "ok: cli project"
node "$CLI_DIR/cli.js" deploy "$ZIPDIR/site" --slug ci-cli-zip --visibility public > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-zip/css/s.css")
expect_code 200 "$code" "cli zip deploy"
node "$CLI_DIR/cli.js" delete ci-cli-2 > /dev/null
node "$CLI_DIR/cli.js" delete ci-cli-zip > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-2")
expect_code 404 "$code" "cli delete"

echo "all smoke tests passed"
