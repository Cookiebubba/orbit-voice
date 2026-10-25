#!/bin/bash
# Fetches Vosk's macOS library (alphacep/vosk-api v0.3.42, universal) into mac-swift/.vendor/vosk for
# Orbit Native's "Hey Orbit" (the same Vosk the Electron build runs as WebAssembly), checked against a
# pinned SHA-256. Its install name becomes @rpath/libvosk.dylib so the app finds it in Frameworks.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HERE/.vendor/vosk"
URL="https://github.com/alphacep/vosk-api/releases/download/v0.3.42/vosk-osx-0.3.42.zip"
SHA="65395f196c9d0583d79949142b25560acaf9c295f36284e18433097f3adb0ea1"
[ -f "$DIR/libvosk.dylib" ] && { echo "vosk ok"; exit 0; }
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sfL -o "$TMP/vosk.zip" "$URL"
GOT="$(shasum -a 256 "$TMP/vosk.zip" | cut -d' ' -f1)"
[ "$GOT" = "$SHA" ] || { echo "vosk: checksum mismatch ($GOT)" >&2; exit 1; }
unzip -q -o "$TMP/vosk.zip" -d "$TMP"
cp "$TMP/vosk-osx-0.3.42/libvosk.dylib" "$DIR/libvosk.dylib"
install_name_tool -id @rpath/libvosk.dylib "$DIR/libvosk.dylib"
codesign --force --sign - "$DIR/libvosk.dylib" >/dev/null 2>&1
echo "vosk: $DIR/libvosk.dylib"
