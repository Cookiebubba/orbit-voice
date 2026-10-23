// "Orbit anywhere": the shared core's entry points (the voice tools and the desktop shell use
// these). Platform-neutral: everything native goes through src/platform/index.js.

import path from 'node:path';
import { getConfigDir } from '../config.js';
import { scanWindow } from '../platform/index.js';
import { createProfileStore, ensureProfile } from './profiles.js';

let store = null;
let storeDir = '';
/** The profile store in <settings folder>/profiles (made on first use, so tests can move the folder). */
export function profileStore() {
  const dir = path.join(getConfigDir(), 'profiles');
  if (!store || storeDir !== dir) {
    store = createProfileStore({ dir });
    storeDir = dir;
  }
  return store;
}

/** The app profile for this window (saved, or built now from one read-only scan). */
export function profileFor(win) {
  if (!win?.hwnd) return Promise.resolve(null);
  return ensureProfile(win, { store: profileStore(), scan: () => scanWindow(win.hwnd) });
}
