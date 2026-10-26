// Orbit's native helper on macOS (native/mac/OrbitHelper, built by scripts/build-mac-helper.mjs):
// where it is, starting it in one of its modes, and the one accessibility host (its "ax" mode) that
// Orbit anywhere and the Claude desktop driver share. macOS counts the helper as Orbit for privacy
// permissions (it's Orbit's child), so Orbit's Accessibility and Screen Recording switches cover it.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUiaHost } from '../win/uia.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

/**
 * The helper binary: inside the installed app (Contents/Resources/mac/orbit-helper), else the one
 * built into the repo (resources/mac/orbit-helper). '' when there's none.
 */
export function helperPath({ resourcesPath = process.resourcesPath, exists = fs.existsSync } = {}) {
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'mac', 'orbit-helper'));
  candidates.push(path.join(REPO, 'resources', 'mac', 'orbit-helper'));
  for (const c of candidates) {
    // (Never a path inside app.asar: a binary can't run from there.)
    if (!/app\.asar[\\/]/.test(c) && exists(c)) return c;
  }
  return '';
}

/** Is there a helper to use (macOS with the binary in place)? */
export const hasHelper = (platform = process.platform) => platform === 'darwin' && !!helperPath();

/** Start the helper in a long-lived mode ('ax', 'focus', 'claude-window'), stdio piped. */
export function spawnHelper(mode, extra = [], { parentPid = process.pid } = {}) {
  const bin = helperPath();
  if (!bin) throw new Error('Orbit’s macOS helper is missing (build it with: npm run mac:helper).');
  return spawn(bin, [mode, '--parent-pid', String(parentPid), ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Run the helper once (capture, perms) and parse its one JSON line. */
export function runHelperOnce(args, { timeoutMs = 25_000 } = {}) {
  const bin = helperPath();
  if (!bin) return Promise.resolve({ ok: false, error: 'unavailable', message: 'Orbit’s macOS helper is missing.' });
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      let j = null;
      try {
        j = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
      } catch {}
      resolve(j || { ok: false, error: err?.killed ? 'timeout' : 'helper_failed', message: 'Orbit’s macOS helper did not answer.' });
    });
  });
}

// ---- the shared accessibility host (one "orbit-helper ax" process, started on first use) ----
let axHost = null;
/** The accessibility host (uia.ps1's protocol), created once; null without a helper. */
export function macAxHost({ onError = () => {} } = {}) {
  if (axHost) return axHost;
  if (!hasHelper()) return null;
  axHost = createUiaHost({ spawnHelper: () => spawnHelper('ax'), onError, idleMs: 10 * 60_000, requestMs: 15_000 });
  return axHost;
}
export function stopMacAxHost() {
  axHost?.stop();
  axHost = null;
}
