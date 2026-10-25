#!/bin/bash
# Signs "Orbit Native.app" (inside out: Node, native addons and dylibs, the helper, then the app) with
# the hardened runtime.
#
# Identity: $ORBIT_SIGN_ID if set (e.g. a Developer ID), else the self-signed "Orbit Native Dev"
# identity in ~/orbit-swift-dev/signing (a stable designated requirement, so the Accessibility,
# Screen Recording and Microphone switches survive rebuilds), else ad-hoc ("-": grants then reset on
# every build). The dev keychain is on the user's search list only while signing.
set -euo pipefail
APP="${1:?usage: sign.sh path/to/App.app}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENT_NODE="$HERE/Resources/node.entitlements"
ENT_APP="$HERE/Resources/app.entitlements"

ID="${ORBIT_SIGN_ID:-}"
DEV="$HOME/orbit-swift-dev/signing"
KC="$DEV/orbit-native.keychain-db"
LOGIN="$HOME/Library/Keychains/login.keychain-db"
RESTORE=0
if [ -z "$ID" ] && [ -f "$KC" ] && [ -f "$DEV/cert.pem" ]; then
  ID="$(openssl x509 -in "$DEV/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"
  # Exactly the user's list as it was, plus ours (each path one argument, never re-split).
  ORIG=()
  while IFS= read -r line; do
    line="$(echo "$line" | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')"
    [ -n "$line" ] && ORIG+=("$line")
  done < <(security list-keychains -d user)
  [ ${#ORIG[@]} -eq 0 ] && ORIG=("$LOGIN")
  restore() { security list-keychains -d user -s "${ORIG[@]}"; }
  trap restore EXIT
  RESTORE=1
  security list-keychains -d user -s "${ORIG[@]}" "$KC"
  security unlock-keychain -p "$(cat "$DEV/kc.pw")" "$KC"
fi
[ -z "$ID" ] && ID="-"

# A Developer ID build gets a secure timestamp (notarization needs one); dev and ad-hoc builds don't.
TS="--timestamp=none"
[ -n "${ORBIT_SIGN_ID:-}" ] && TS="--timestamp"
sign() { codesign --force "$TS" --options runtime --sign "$ID" "$@"; }

# Native code inside the core and the app's Frameworks first.
while IFS= read -r -d '' f; do sign "$f" >/dev/null; done < <(find "$APP/Contents/Frameworks" -name '*.dylib' -type f -print0 2>/dev/null)
while IFS= read -r -d '' f; do sign "$f" >/dev/null; done < <(find "$APP/Contents/Resources/core" \( -name '*.node' -o -name '*.dylib' \) -type f -print0)
[ -f "$APP/Contents/Resources/core/resources/mac/orbit-helper" ] && sign --identifier dev.orbit.voice.native.helper "$APP/Contents/Resources/core/resources/mac/orbit-helper"
sign --identifier dev.orbit.voice.native.node --entitlements "$ENT_NODE" "$APP/Contents/Resources/node/bin/node"
sign --identifier dev.orbit.voice.native --entitlements "$ENT_APP" "$APP"
codesign --verify --deep --strict "$APP"
echo "signed with ${ID:0:12}"
