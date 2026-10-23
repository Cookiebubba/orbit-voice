// macOS builds: make sure sherpa-onnx's native packages for BOTH Mac architectures are in
// node_modules, so `electron-builder --mac` can package an arm64 and an x64 app from one Mac.
//
// npm installs an optional dependency only for the machine it runs on (sherpa-onnx-node lists
// sherpa-onnx-darwin-arm64 and sherpa-onnx-darwin-x64 with "cpu" set), so an Apple silicon Mac gets
// only the arm64 one. This fetches the missing one at the exact version and integrity recorded in
// package-lock.json (npm pack, SHA-512 checked before anything is unpacked) and unpacks it into
// node_modules. package.json and package-lock.json are not touched.
//
//   node scripts/mac-native.mjs            (run by `npm run dist:mac`)
//   node scripts/mac-native.mjs --check    (only report what's there)

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAC_NATIVE = ['sherpa-onnx-darwin-arm64', 'sherpa-onnx-darwin-x64'];

/** { name, version, integrity } for each Mac package, from package-lock.json. */
export function lockedMacPackages(lock) {
  return MAC_NATIVE.map((name) => {
    const entry = lock?.packages?.[`node_modules/${name}`];
    if (!entry?.version || !/^sha512-/.test(entry.integrity || '')) throw new Error(`${name} is missing from package-lock.json`);
    return { name, version: entry.version, integrity: entry.integrity };
  });
}

/** Is this package unpacked in node_modules at that version, with its addon? */
export function installed(root, { name, version }) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    return pkg.version === version && fs.existsSync(path.join(root, 'node_modules', name, 'sherpa-onnx.node'));
  } catch {
    return false;
  }
}

const sri = (file) => `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;

function fetchOne(root, p) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mac-native-'));
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['pack', `${p.name}@${p.version}`, '--pack-destination', tmp, '--silent'], { cwd: tmp, encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(`npm pack ${p.name}@${p.version} failed: ${(r.stderr || '').trim().split('\n').pop()}`);
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`npm pack ${p.name} produced no file`);
    const got = sri(path.join(tmp, tgz));
    if (got !== p.integrity) throw new Error(`${p.name}@${p.version} failed its integrity check (expected the package-lock.json hash)`);
    const unpack = path.join(tmp, 'x');
    fs.mkdirSync(unpack);
    // Relative names, run from the temp folder (GNU tar reads "C:..." as a remote host).
    const t = spawnSync('tar', ['-xzf', tgz, '-C', 'x'], { cwd: tmp, encoding: 'utf8' });
    if (t.status !== 0) throw new Error(`Unpacking ${p.name} failed: ${(t.stderr || '').trim()}`);
    const dest = path.join(root, 'node_modules', p.name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(unpack, 'package'), dest, { recursive: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function ensureMacNative(root = ROOT, { check = false, log = console.log } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  let ok = true;
  for (const p of lockedMacPackages(lock)) {
    if (installed(root, p)) {
      log(`  ok   ${p.name}@${p.version}`);
      continue;
    }
    if (check) {
      log(`  --   ${p.name}@${p.version} not in node_modules`);
      ok = false;
      continue;
    }
    log(`  get  ${p.name}@${p.version} (checked against package-lock.json)`);
    fetchOne(root, p);
    if (!installed(root, p)) throw new Error(`${p.name} still isn't in node_modules`);
  }
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log('sherpa-onnx native packages for macOS:');
    const ok = ensureMacNative(ROOT, { check: process.argv.includes('--check') });
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }
}
