// "Orbit anywhere": the one interface between Orbit's shared core and the native layer that reads
// and acts on other apps' windows. The core (tools, contexts, helpers) only calls what's exported
// here; Windows backs it with PowerShell/C# helpers in platform/win/, and a Mac helper can slot in
// behind the same calls later. (Not to be confused with src/platform.js: paths, PATH and process
// trees for Claude Code.)
//
// Phase 1 is focus: which window is in front, in any app, from window events (no polling).
// Phase 2 adds reading a window's UI Automation tree (scanWindow), for app profiles.

import { createWinFocusTracker } from './win/focus.js';
import { createUiaHost } from './win/uia.js';
import { focus, setFocusBackend } from './focus.js';

export { appName, cleanWindow, createFocusStore, describeWindow, focus, focusBackend, listWindows, setFocusBackend } from './focus.js';

/**
 * Start following the window in front (the desktop shell calls this). Returns the tracker
 * ({ stop, describe, list }) or null where there's no native helper (macOS for now, unless a test
 * passes `spawnHelper`).
 */
export function startFocusTracking({ spawnHelper = null, onError = () => {}, parentPid = process.pid, store = focus } = {}) {
  if (process.platform !== 'win32' && !spawnHelper) return null;
  const tracker = createWinFocusTracker({
    onFocus: (w) => store.update(w),
    onSwitching: (on) => store.setSwitching(on),
    onGone: (hwnds) => store.gone(hwnds),
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
  uiaHost?.stop();
  uiaHost = null;
  if (process.platform !== 'win32' && !spawnHelper) return null;
  uiaHost = createUiaHost({ spawnHelper, cacheDir, onError, parentPid });
  return uiaHost;
}
export function stopUia() {
  uiaHost?.stop();
  uiaHost = null;
}
/** Tests: use this host (or null). */
export function setUiaHost(host) {
  uiaHost = host || null;
}

/** One request to the UI Automation helper ({ ok: false, error: 'unavailable' } without one). */
export function uiaRequest(op, args = {}, opts = {}) {
  if (!uiaHost) return Promise.resolve({ ok: false, error: 'unavailable', message: 'Reading other apps works only on Windows for now.' });
  return uiaHost.request(op, args, opts);
}

/** The window's UI Automation tree: { ok, fw, nodes: [{ i, p, t, n, a, c, r, ... }], truncated }. */
export function scanWindow(hwnd, { values = false, maxNodes = 2000 } = {}) {
  return uiaRequest('scan', { hwnd: Math.floor(Number(hwnd)) || 0, values: !!values, maxNodes });
}

