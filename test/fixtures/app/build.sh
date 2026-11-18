#!/usr/bin/env bash
# Rebuilds the app-build fixtures. Needs the Android SDK (aapt2 and a platform android.jar) and
# macOS plutil. The outputs are committed, so tests never run this.
#
#   sample.apk   aapt2 link of manifest.xml: a real binary-XML manifest, no code.
#   sample.aab   the same manifest linked with --proto-format, placed where a bundle keeps it.
#   Info.plist   plutil binary1 of info.xml: the binary plist Xcode writes into an app.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
AAPT="$(ls -d "$SDK"/build-tools/*/aapt2 | sort -V | tail -1)"
JAR="$(ls -d "$SDK"/platforms/android-*/android.jar | sort -V | tail -1)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$AAPT" link -o sample.apk -I "$JAR" --manifest manifest.xml
"$AAPT" link -o "$TMP/proto.apk" -I "$JAR" --manifest manifest.xml --proto-format
mkdir -p "$TMP/aab/base/manifest"
unzip -p "$TMP/proto.apk" AndroidManifest.xml > "$TMP/aab/base/manifest/AndroidManifest.xml"
printf '' > "$TMP/aab/BundleConfig.pb"
rm -f sample.aab
(cd "$TMP/aab" && zip -q -X -r "$OLDPWD/sample.aab" BundleConfig.pb base)

plutil -convert binary1 -o Info.plist info.xml
