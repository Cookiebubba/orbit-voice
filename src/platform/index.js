// "Orbit anywhere": the one interface between Orbit's shared core and the native layer that reads
// and acts on other apps' windows. The core (tools, contexts, helpers) only calls what's exported
// here; Windows backs it with PowerShell/C# helpers in platform/win/, and a Mac helper can slot in
// behind the same calls later. (Not to be confused with src/platform.js: paths, PATH and process
// trees for Claude Code.)
//
// Phase 1 is focus: which window is in front, in any app, from window events (no polling).

import { createWinFocusTracker } from './win/focus.js';
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

