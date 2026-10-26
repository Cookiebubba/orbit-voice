// "Orbit anywhere": the one interface between Orbit's shared core and the native layer that reads
// and acts on other apps' windows. The core (tools, contexts, helpers) only calls what's exported
// here; Windows backs it with PowerShell/C# helpers in platform/win/, macOS with Orbit's Swift
// helper (platform/mac/, native/mac/OrbitHelper), which speaks the same protocols.
//
// What's in src/platform/: system.js (paths, PATH and process trees: what differs between Windows
// and macOS for Claude Code), this file and focus.js (the window layer), and win/ (the Windows
// helpers: focus.ps1 and uia.ps1 for Orbit anywhere, OrbitAuto.cs for desktop.ps1, and
// uia-interop.ps1, the COM UI Automation interop both share).
//
// Phase 1 is focus: which window is in front, in any app, from window events (no polling).
// Phase 2 adds reading a window's UI Automation tree (scanWindow), for app profiles.
// Phase 3 adds reading its text and selection (uiaRequest 'read' / 'selection') and looking at it
// (captureWindow: a picture plus on-device OCR).

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWERSHELL, createWinFocusTracker } from './win/focus.js';
import { createUiaHost } from './win/uia.js';
import { focus, setFocusBackend } from './focus.js';
import { hasHelper, macAxHost, runHelperOnce, spawnHelper as spawnMacHelper, stopMacAxHost } from './mac/helper.js';

const CAPTURE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win', 'capture.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

export { appName, cleanWindow, createFocusStore, describeWindow, focus, focusBackend, listWindows, setFocusBackend, switchToWindow } from './focus.js';

/** macOS with Orbit's helper in place (the Swift helper stands in for the PowerShell ones). */
const onMac = () => process.platform === 'darwin' && hasHelper();

/**
 * Start following the window in front (the desktop shell calls this). Returns the tracker
 * ({ stop, describe, list, watch }) or null where there's no native helper (unless a test passes
 * `spawnHelper`).
 */
export function startFocusTracking({ spawnHelper = null, onError = () => {}, onWins = () => {}, parentPid = process.pid, store = focus } = {}) {
  if (!spawnHelper && onMac()) spawnHelper = () => spawnMacHelper('focus', [], { parentPid });
  if (process.platform !== 'win32' && !spawnHelper) return null;
  const tracker = createWinFocusTracker({
    onFocus: (w) => store.update(w),
    onSwitching: (on) => store.setSwitching(on),
    onGone: (hwnds) => store.gone(hwnds),
    onWins, // the watched windows (Qubit's) moved: [{ hwnd, min, cloaked, x, y, w, h }]
    onError,
    spawnHelper,
    parentPid,
  });
  tracker.start();
  if (store === focus) setFocusBackend(tracker);
  const stop = tracker.stop;
  tracker.stop = () => {
    stop();
    if (store === focus) setFocusBackend(null);
  };
  return tracker;
}

// ---- UI Automation (one long-lived helper, started on first use) ----
let uiaHost = null;

/**
 * Set up the UI Automation helper (the desktop shell calls this; no process starts until the first
 * request). `spawnHelper` (tests) returns a stand-in for uia.ps1. Returns the host, or null where
 * there's no native helper.
 */
export function startUia({ spawnHelper = null, cacheDir = '', onError = () => {}, parentPid = process.pid } = {}) {
  if (uiaHost !== macAxHost()) uiaHost?.stop();
  uiaHost = null;
  // macOS: the helper's "ax" mode, shared with the Claude desktop driver (src/desktop.js).
  if (!spawnHelper && onMac()) return (uiaHost = macAxHost({ onError }));
  if (process.platform !== 'win32' && !spawnHelper) return null;
  uiaHost = createUiaHost({ spawnHelper, cacheDir, onError, parentPid });
  return uiaHost;
}
export function stopUia() {
  if (uiaHost && uiaHost === macAxHost()) stopMacAxHost();
  else uiaHost?.stop();
  uiaHost = null;
}
/** Tests: use this host (or null). */
export function setUiaHost(host) {
  uiaHost = host || null;
}

/** One request to the UI Automation helper ({ ok: false, error: 'unavailable' } without one). */
export function uiaRequest(op, args = {}, opts = {}) {
  if (!uiaHost) return Promise.resolve({ ok: false, error: 'unavailable', message: 'Reading other apps needs Orbit anywhere turned on (and, on a Mac, Orbit’s helper).' });
  return uiaHost.request(op, args, opts);
}

/** The window's UI Automation tree: { ok, fw, nodes: [{ i, p, t, n, a, c, r, ... }], truncated }. */
export function scanWindow(hwnd, { values = false, maxNodes = 2000 } = {}) {
  return uiaRequest('scan', { hwnd: Math.floor(Number(hwnd)) || 0, values: !!values, maxNodes });
}

// ---- looking at one window (a picture of it, and its text by on-device OCR) ----
let captureImpl = null; // tests: a stand-in for capture.ps1
/** Tests: capture with this function ((hwnd, opts) => result) instead of capture.ps1, or null. */
export function setCaptureImpl(fn) {
  captureImpl = typeof fn === 'function' ? fn : null;
}

/**
 * A picture of one window (Windows: PrintWindow; macOS: ScreenCaptureKit; both work while it's
 * covered), saved as a PNG in the temp folder, with its text read by the system's own on-device OCR
 * (Windows.Media.Ocr / Vision). Resolves { ok, path, w, h, lit, ocr } or { ok: false, error }. The
 * caller deletes the picture when done with it.
 */
export function captureWindow(hwnd, { ocr = true, maxWidth = 1600, timeoutMs = 25_000 } = {}) {
  if (captureImpl) return Promise.resolve(captureImpl(hwnd, { ocr, maxWidth }));
  const out = path.join(os.tmpdir(), `orbit-look-${crypto.randomBytes(8).toString('hex')}.png`);
  if (onMac()) {
    return runHelperOnce(['capture', '--window', String(Math.floor(Number(hwnd)) || 0), '--out', out, '--max-width', String(maxWidth), ...(ocr ? [] : ['--no-ocr'])], { timeoutMs }).then((j) => {
      if (!j?.ok) fs.rm(out, { force: true }, () => {});
      return j?.ok ? j : { ok: false, error: j?.error || 'capture_failed', message: j?.message || 'Orbit could not take a picture of that window.' };
    });
  }
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'unavailable', message: 'Looking at windows works only on Windows and macOS.' });
  return new Promise((resolve) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_SCRIPT, '-Hwnd', String(Math.floor(Number(hwnd)) || 0), '-Out', out, '-MaxWidth', String(maxWidth), ...(ocr ? [] : ['-NoOcr'])], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      let j = null;
      try {
        j = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
      } catch {}
      if (!j) {
        fs.rm(out, { force: true }, () => {});
        return resolve({ ok: false, error: err?.killed ? 'timeout' : 'capture_failed', message: 'Orbit could not take a picture of that window.' });
      }
      resolve(j);
    });
  });
}
