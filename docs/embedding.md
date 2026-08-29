# Embedding an artifact

Put a published artifact inside another page. ([← back to README](../README.md))

## The snippet

```html
<iframe src="https://artifacts.example.com/a/hello?raw=1"
        title="Q3 numbers" width="100%" height="600" style="border:0" loading="lazy"></iframe>
```

The dashboard writes that tag for you: open the `⋯` menu on any row and pick **Embed**. The dialog
holds the whole tag, a Copy button, and a link that opens exactly what the frame will load, so you
can check the page before you paste it anywhere. A redirect has no Embed item, because a redirect
answers `301` with no page of its own.

Set `width` and `height` to whatever the host page needs. Nothing here measures the artifact and
resizes the frame for you, so a page taller than the frame scrolls inside it.

## The URL to use

`/a/<slug>?raw=1` is the artifact with no viewer toolbar around it. A zip site keeps its trailing
slash first: `/a/<slug>/?raw=1`.

`?raw=1` is belt and braces rather than strictly required. A frame load sends
`Sec-Fetch-Dest: iframe`, which the server already answers with the bare page, so an embed of the
plain `/a/<slug>` works in every current browser. A browser that does not send that header would
get the toolbar page instead, and the toolbar page refuses to be framed (below), so the embed would
come up empty for those readers and nobody else. `?raw=1` removes that whole class of report.

The link keeps working after a `PUT`: the slug is the address, and the frame reloads the new
content on the next view.

## Only a public artifact can be embedded

| Visibility | In someone else's frame |
|---|---|
| `public` | Renders. |
| `private` | A `404`, shown as an empty frame. |
| `password` | Nothing. The unlock page refuses to be framed. |

A `?k=` capability link in the `src` does not rescue a private artifact. The token exchange sets a
per-slug unlock cookie, that cookie is `SameSite=Lax`, and a browser will not set or send a
same-site cookie inside another site's frame. So the exchange runs, the cookie is dropped, and the
redirect lands on a `404`.

The password case is deliberate. `shells/password.html` is served with `frame-ancestors 'none'`,
which stops anyone putting your password prompt inside a page they control and reading what a
viewer types. Switch the artifact to `public` if it is meant to be embedded, and use the
capability link for the private one.

## What the server sends

The artifact body itself carries no `frame-ancestors` and no `X-Frame-Options`, so any site may
frame a public artifact. There is no per-artifact embed allowlist yet, so an artifact you make
public is one anybody can put in their own page. That is the same reach the bare link already
gives them, but a frame does it under their branding, so it is worth knowing before you flip a
client's artifact to public.

Two pages the server renders itself do refuse framing, both with `frame-ancestors 'none'`:

- The viewer toolbar page (`shells/frame.html`), which also covers the `404` and `410` cards. This
  is why an embed points at `?raw=1`.
- The unlock prompt (`shells/password.html`).

Everything the server serves also carries `X-Robots-Tag: noindex, nofollow`, embedded or not.

The artifact's own [Content Security Policy](api.md) travels with it into the frame, so an
embedded artifact loads scripts from the same handful of CDNs it loads them from on its own URL.
Embedding widens nothing.

## Checking one before you ship it

```bash
curl -sI "https://artifacts.example.com/a/hello?raw=1" | grep -i 'frame\|content-security'
```

An embeddable artifact prints a `Content-Security-Policy` with no `frame-ancestors` in it, and no
`X-Frame-Options` line at all. The end-to-end suite checks the same contract under
`ok: an artifact can be embedded on another site`.
