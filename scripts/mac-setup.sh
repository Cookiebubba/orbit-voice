#!/bin/bash
# Orbit on a Mac (phase 1): get a fresh checkout ready to run from source and to build.
#
#   bash scripts/mac-setup.sh
#
# Checks Node, installs the app's packages exactly as locked (npm ci), builds the UI, and fetches
# the offline wake-word model (checked against its pinned SHA-256). Then prints how to run and build.
# It changes nothing outside this folder. See docs/MAC.md for what works on a Mac so far.
set -euo pipefail

cd "$(dirname "$0")/.."
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS. On Windows, see the README."
ARCH="$(uname -m)"
MACOS="$(sw_vers -productVersion 2>/dev/null || echo '?')"
say "macOS $MACOS on $ARCH"

# ---- Node.js 20 or later (22 LTS recommended) ----
command -v node >/dev/null 2>&1 || die "Node.js isn't installed. Install Node 22 LTS (https://nodejs.org, or: brew install node@22), then run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $(node -v) is too old: Orbit needs Node 20 or later (22 LTS recommended)."
echo "Node $(node -v), npm $(npm -v)"

# ---- the app's packages, exactly as package-lock.json pins them ----
say "Installing packages (npm ci)"
npm ci --no-audit --no-fund

# The on-device speech engine for Claude voice, for this Mac's architecture.
if [ "$ARCH" = "arm64" ]; then SHERPA=sherpa-onnx-darwin-arm64; else SHERPA=sherpa-onnx-darwin-x64; fi
if [ -f "node_modules/$SHERPA/sherpa-onnx.node" ]; then
  echo "Speech engine: $SHERPA is installed."
else
  echo "Speech engine: $SHERPA is missing; fetching it (checked against package-lock.json)."
  node scripts/mac-native.mjs
fi

# ---- the UI (React, built into public/) ----
say "Building the UI"
npm run build:ui

# ---- the offline wake-word model ("Hey Orbit") ----
say "Fetching the wake-word model"
node scripts/fetch-model.mjs

# ---- Claude Code (for Claude voice, the second brain and web search; optional) ----
say "Claude Code"
if command -v claude >/dev/null 2>&1; then
  echo "Found claude on your PATH. Orbit also looks in ~/.local/bin, Homebrew and the Claude app's own copy."
else
  echo "No claude on your PATH. Grok voice works without it; for Claude voice, the second brain and"
  echo "web search, install Claude Code (https://claude.com/claude-code) or open the Claude app once."
fi

say "Ready."
cat <<'EOF'
Run Orbit from source (macOS asks for the microphone the first time):
  npm run app

Build the Mac apps (unsigned unless a Developer ID is in your keychain), into dist/:
  npm run dist:mac
  -> dist/Orbit-<version>-arm64.dmg / .zip and dist/Orbit-<version>-x64.dmg / .zip, plus latest-mac.yml

Open an unsigned build: right-click Orbit.app -> Open, or
  xattr -dr com.apple.quarantine /Applications/Orbit.app

What works on a Mac so far, and the test checklist: docs/MAC.md
EOF
