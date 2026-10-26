#!/bin/bash
# Packages a built "Orbit Native.app" (scripts/build-app.sh) for a GitHub release, next to the
# Windows installer:
#
#   dist/Orbit-Native-<version>-<arch>-mac.zip   what the updater downloads (ditto, keeps the signature)
#   dist/Orbit-Native-<version>-<arch>.dmg       what people download to install
#   dist/latest-mac-native.yml                   Orbit Native's update feed (UpdateChecker.feedFile),
#                                                in electron-builder's latest-mac.yml shape
#
#   scripts/package.sh                 package dist/Orbit Native.app as it is
#   ORBIT_NOTARY_PROFILE=<profile> scripts/package.sh
#                                      notarize first (xcrun notarytool, a keychain profile made with
#                                      `xcrun notarytool store-credentials`), then staple the ticket
#
# Refuses a test build (the parity driver allowed) and, when notarizing, anything not signed with a
# Developer ID. Upload all three files to the release.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # mac-swift
APP="$HERE/dist/Orbit Native.app"
DIST="$HERE/dist"
[ -d "$APP" ] || { echo "no $APP: run scripts/build-app.sh first" >&2; exit 1; }

PLIST="$APP/Contents/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
if /usr/libexec/PlistBuddy -c 'Print :OrbitParityAllowed' "$PLIST" >/dev/null 2>&1; then
  echo "this is a test build (OrbitParityAllowed): never ship it; run scripts/build-app.sh without --test" >&2
  exit 1
fi
ARCH="$(lipo -archs "$APP/Contents/MacOS/OrbitNative" | tr ' ' '\n' | sort | paste -sd- -)"
[ "$ARCH" = "arm64-x86_64" ] && ARCH="universal"
[ "$ARCH" = "x86_64" ] && ARCH="x64"
ZIP="$DIST/Orbit-Native-$VERSION-$ARCH-mac.zip"
DMG="$DIST/Orbit-Native-$VERSION-$ARCH.dmg"
YML="$DIST/latest-mac-native.yml"

codesign --verify --deep --strict "$APP"

if [ -n "${ORBIT_NOTARY_PROFILE:-}" ]; then
  if ! codesign -dvv "$APP" 2>&1 | grep -q '^Authority=Developer ID Application'; then
    echo "notarizing needs a Developer ID build: ORBIT_SIGN_ID='Developer ID Application: …' scripts/build-app.sh" >&2
    exit 1
  fi
  echo "== notarize"
  SUBMIT="$DIST/notarize-$VERSION.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$SUBMIT"
  xcrun notarytool submit "$SUBMIT" --keychain-profile "$ORBIT_NOTARY_PROFILE" --wait
  rm -f "$SUBMIT"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
fi

echo "== zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "== dmg"
rm -f "$DMG"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Orbit Native.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Orbit Native $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DMG"
if [ -n "${ORBIT_NOTARY_PROFILE:-}" ]; then
  codesign --force --timestamp --sign "${ORBIT_SIGN_ID:?ORBIT_SIGN_ID: the Developer ID that signed the app}" "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$ORBIT_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

echo "== $(basename "$YML")"
sha() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }
size() { stat -f %z "$1"; }
ZSHA="$(sha "$ZIP")"; DSHA="$(sha "$DMG")"
cat > "$YML" <<EOF
version: $VERSION
files:
  - url: $(basename "$ZIP")
    sha512: $ZSHA
    size: $(size "$ZIP")
  - url: $(basename "$DMG")
    sha512: $DSHA
    size: $(size "$DMG")
path: $(basename "$ZIP")
sha512: $ZSHA
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
EOF

ls -la "$ZIP" "$DMG" "$YML" | awk '{print "   " $5 "  " $NF}'
[ -z "${ORBIT_NOTARY_PROFILE:-}" ] && echo "   (not notarized: Gatekeeper will block it on other Macs; set ORBIT_NOTARY_PROFILE for a release)"
exit 0
