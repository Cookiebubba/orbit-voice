#!/bin/sh
# Builds OverlayDemo and wraps it in a minimal .app (so `open -n -g` runs it in the logged-in GUI
# session): .build/OverlayDemo.app. Developer use only. Ad-hoc signed.
set -e
cd "$(dirname "$0")/.."
swift build --product OverlayDemo "$@"
BIN="$(swift build --product OverlayDemo --show-bin-path "$@")/OverlayDemo"
APP=.build/OverlayDemo.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/OverlayDemo"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.orbit.overlaydemo</string>
  <key>CFBundleName</key><string>OverlayDemo</string>
  <key>CFBundleExecutable</key><string>OverlayDemo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "$PWD/$APP"
