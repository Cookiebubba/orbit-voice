#!/bin/bash
# Builds "Orbit Native.app" into mac-swift/dist/: the Swift app (release), an embedded Node, Orbit's
# Node core (src/, the built UI in public/, production node_modules, the wake-word model, the
# sidecar) and the macOS helper, then signs it (scripts/sign.sh).
#
#   scripts/build-app.sh            a normal build
#   scripts/build-app.sh --test     the same, with the parity driver allowed (OrbitParityAllowed in
#                                   Info.plist). Never ship this one.
#   scripts/build-app.sh --debug    a debug Swift build (faster to compile)
#
# Needs: Xcode, node on PATH (its binary is embedded), `npm ci` and `npm run build:ui` done at the
# repo root, and `node scripts/fetch-model.mjs` for the wake-word model.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # mac-swift
ROOT="$(cd "$HERE/.." && pwd)"             # the repo
TEST=0; CONFIG=release
for a in "$@"; do
  case "$a" in
    --test) TEST=1 ;;
    --debug) CONFIG=debug ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

NAME="Orbit Native"
BUNDLE_ID="dev.orbit.voice.native"
VERSION="$(node -p "require('$ROOT/package.json').version")"
APP="$HERE/dist/$NAME.app"
NODE_BIN="$(command -v node)"

[ -d "$ROOT/public" ] || { echo "build the UI first: npm run build:ui" >&2; exit 1; }
[ -d "$ROOT/node_modules/ws" ] || { echo "run npm ci at the repo root first" >&2; exit 1; }

echo "== vosk"
"$HERE/scripts/fetch-vosk.sh"

echo "== swift build ($CONFIG)"
(cd "$HERE" && swift build -c "$CONFIG" --product OrbitNative)
BIN="$(cd "$HERE" && swift build -c "$CONFIG" --show-bin-path)/OrbitNative"

echo "== bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/OrbitNative"
# Vosk for "Hey Orbit" (OrbitWake). sherpa-onnx's library is the core's copy (rpath into core/node_modules).
mkdir -p "$APP/Contents/Frameworks"
cp "$HERE/.vendor/vosk/libvosk.dylib" "$APP/Contents/Frameworks/"
cp "$ROOT/build/icon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/assets/trayTemplate.png" "$ROOT/assets/trayTemplate@2x.png" "$ROOT/assets/icon.png" "$APP/Contents/Resources/"
[ -d "$HERE/Resources/app" ] && cp -R "$HERE/Resources/app/." "$APP/Contents/Resources/"
# Qubit for the launcher's hero: his engine and director, unchanged, in ui/src's layout.
HERO="$APP/Contents/Resources/hero-src"
mkdir -p "$HERO/vendor/avatars" "$HERO/hero" "$HERO/qubit"
cp "$ROOT/ui/src/vendor/avatars/orbit-nav.js" "$ROOT/ui/src/vendor/avatars/qubit-engine.js" "$HERO/vendor/avatars/"
cp "$ROOT/ui/src/hero/hero.js" "$HERO/hero/"
cp "$ROOT/ui/src/qubit/director.js" "$HERO/qubit/"

# The embedded Node (only the binary: the core needs no npm).
mkdir -p "$APP/Contents/Resources/node/bin"
cp "$NODE_BIN" "$APP/Contents/Resources/node/bin/node"

# The core, laid out like the repo so its relative paths hold (PROJECT_ROOT = core/).
CORE="$APP/Contents/Resources/core"
mkdir -p "$CORE/mac-swift" "$CORE/resources"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$CORE/"
rsync -a --exclude 'selftest.js' --exclude '*.ps1' --exclude '*.cs' "$ROOT/src/" "$CORE/src/"
rsync -a "$ROOT/public/" "$CORE/public/"
rsync -a --exclude '*.test.mjs' "$HERE/sidecar/" "$CORE/mac-swift/sidecar/"
[ -d "$ROOT/resources/models" ] && rsync -a "$ROOT/resources/models/" "$CORE/resources/models/" || echo "   (no wake-word model: node scripts/fetch-model.mjs)"
# The macOS helper (orbit-mac's native/mac/OrbitHelper), when this branch has it.
if [ -d "$ROOT/native/mac/OrbitHelper" ]; then
  mkdir -p "$CORE/resources/mac"
  xcrun swiftc -O -target arm64-apple-macos14 -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit -framework Vision \
    -o "$CORE/resources/mac/orbit-helper" "$ROOT"/native/mac/OrbitHelper/*.swift
fi
# Production dependencies only: ws, sherpa-onnx (this Mac's architecture). Not electron, not the updater.
mkdir -p "$CORE/node_modules"
for dep in ws sherpa-onnx-node "sherpa-onnx-darwin-$(uname -m | sed s/x86_64/x64/)"; do
  [ -d "$ROOT/node_modules/$dep" ] && rsync -a "$ROOT/node_modules/$dep" "$CORE/node_modules/"
done

echo "== Info.plist"
PARITY=""
[ "$TEST" = 1 ] && PARITY="  <key>OrbitParityAllowed</key><true/>"
# A test build also carries the parity suite's page probes (avatar.eval).
[ "$TEST" = 1 ] && mkdir -p "$APP/Contents/Resources/parity-probes" && cp "$ROOT"/parity/probes/*.js "$APP/Contents/Resources/parity-probes/"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>OrbitNative</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSMicrophoneUsageDescription</key><string>Orbit listens so you can talk to Grok or Claude, and for the offline “Hey Orbit” wake word. Your voice goes only to the voice you chose, and only while a conversation is on.</string>
  <key>NSAccessibilityUsageDescription</key><string>Orbit uses Accessibility to read and drive the Claude app window: typing your prompts, pressing Send and answering its cards.</string>
  <key>NSAppleEventsUsageDescription</key><string>Orbit uses this to type your prompts into the Claude app and press Send for you.</string>
  <key>NSScreenCaptureUsageDescription</key><string>Orbit looks at a window only when you ask it to.</string>
$PARITY
</dict>
</plist>
EOF

echo "== sign"
"$HERE/scripts/sign.sh" "$APP"
du -sh "$APP" | awk '{print "== done: " $1}'
echo "$APP"
