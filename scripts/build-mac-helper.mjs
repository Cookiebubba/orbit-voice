// Builds Orbit's native macOS helper (native/mac/OrbitHelper/*.swift) into
// resources/mac/orbit-helper: one universal binary (arm64 + x86_64) with the Xcode command line
// tools' swiftc. electron-builder ships it in Orbit.app (Contents/Resources/mac/) and signs it with
// the app (hardened runtime). macOS only; elsewhere it says so and does nothing.
//
//   node scripts/build-mac-helper.mjs            both architectures (lipo'd)
//   node scripts/build-mac-helper.mjs --arch arm64   just one (quicker while developing)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'native', 'mac', 'OrbitHelper');
const OUT_DIR = path.join(ROOT, 'resources', 'mac');
const OUT = path.join(OUT_DIR, 'orbit-helper');
// The oldest macOS Orbit's Electron runs on.
const MIN_MACOS = '12.0';

if (process.platform !== 'darwin') {
  console.log('build-mac-helper: macOS only (nothing to do here).');
  process.exit(0);
}

const argArch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : null;
const arches = argArch ? [argArch] : ['arm64', 'x86_64'];
const sources = fs.readdirSync(SRC).filter((f) => f.endsWith('.swift')).sort().map((f) => path.join(SRC, f));
fs.mkdirSync(OUT_DIR, { recursive: true });

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`build-mac-helper: ${cmd} failed (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
};

const parts = [];
for (const arch of arches) {
  const out = path.join(OUT_DIR, `orbit-helper-${arch}`);
  run('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos${MIN_MACOS}`, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit', '-framework', 'Vision', '-o', out, ...sources]);
  parts.push(out);
}
if (parts.length === 1) fs.renameSync(parts[0], OUT);
else {
  run('xcrun', ['lipo', '-create', '-output', OUT, ...parts]);
  for (const p of parts) fs.rmSync(p, { force: true });
}
// Ad-hoc signed so it runs from source; electron-builder re-signs it with the app's identity.
run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'dev.orbit.voice.helper', OUT]);
console.log(`build-mac-helper: ${path.relative(ROOT, OUT)} (${arches.join(' + ')})`);
