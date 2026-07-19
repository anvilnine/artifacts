# flutter-demo

A minimal [Flutter](https://flutter.dev) **web** app showing how to host a Flutter
SPA on a self-hosted **artifacts** instance.

Artifacts serves zipped static sites under **`/a/<slug>/`**. A stock `flutter build web`
does not work there for three reasons; this project addresses all of them so the build is
**fully self-contained** (no CDN, no cross-origin fetches):

1. **Subpath base href** — build with `--base-href /a/<slug>/`. Flutter's default
   `<base href="/">` otherwise loads `main.dart.js` and assets from the domain root and 404s.
2. **Local engine** — build with `--no-web-resources-cdn` so the CanvasKit/skwasm engine is
   served from the artifact instead of `gstatic.com` (which the server's CSP blocks).
3. **Bundled font** — [`pubspec.yaml`](./pubspec.yaml) bundles a text font that
   [`lib/main.dart`](./lib/main.dart) sets as the app default (`fontFamily`), so the engine
   doesn't need to fetch its Roboto fallback from Google Fonts.

> The `<slug>` you build for must match the `<slug>` you deploy to.

## Build & deploy

```bash
flutter pub get
flutter build web --base-href /a/flutter-demo/ --no-web-resources-cdn
```

Deploy the build output with the [CLI](../../docs/cli.md) (from this directory):

```bash
export ARTIFACTS_URL=https://artifacts.example.com
export ARTIFACTS_API_KEY=your-key
artifacts deploy ./build/web --slug flutter-demo
# https://artifacts.example.com/a/flutter-demo/ (N files)
```

## Viewer frame

By default the host wraps every artifact in a slim [viewer frame](../../docs/formats.md#viewer-frame)
(a toolbar over an iframe). Flutter runs fine inside it, but for an edge-to-edge full-screen app
you can bypass the frame — append `?raw=1` to the URL, or turn it off for this artifact:

```bash
artifacts frame flutter-demo off   # serve it bare; `on` or `default` re-enables
```

## Routing (SPA deep links)

This demo uses Flutter's default **hash** URL strategy (`/#/…`), which needs no server-side
fallback — every deep link is served by the same `index.html`. If you switch to
`usePathUrlStrategy()` (clean `/route` URLs), a hard refresh on a sub-route would 404, because the
host serves files literally and has no SPA rewrite. Stick with hash routing on this host, or keep
navigation client-side.

## Using a different slug

```bash
flutter build web --base-href /a/my-app/ --no-web-resources-cdn
artifacts deploy ./build/web --slug my-app
```

## Font note

The bundled font here is Liberation Sans (copied from the build environment as a stand-in). Swap
`assets/fonts/AppFont-*.ttf` for any text font you have the rights to redistribute (e.g. download
Roboto or Inter and drop the `.ttf` files in place).
