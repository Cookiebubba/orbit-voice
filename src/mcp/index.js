// Orbit's one MCP manager ("Orbit anywhere", phase 9), with its pins in <settings folder>/mcp,
// OAuth tokens in the encrypted store the desktop shell provides (DPAPI through Electron's
// safeStorage; only in memory without it), and sign-in pages opened in the user's browser.

import path from 'node:path';
import { getConfigDir } from '../config.js';
import { createMcpManager } from './manager.js';
import { createOAuth } from './oauth.js';
import { createPinStore } from './pins.js';

let tokenStore = (() => {
  const m = new Map();
  return { get: (k) => m.get(k) || null, set: (k, v) => (v ? m.set(k, v) : m.delete(k)) };
})();
let openBrowser = async () => {
  throw new Error('Orbit can only open a sign-in page from the desktop app.');
};
let bridge = '';

/** The desktop shell: where tokens are kept (encrypted) and how to open the browser. */
export function setMcpShell({ store, openExternal } = {}) {
  if (store && typeof store.get === 'function' && typeof store.set === 'function') tokenStore = store;
  if (typeof openExternal === 'function') openBrowser = openExternal;
}
/** The bridge's address (the OAuth redirect comes back to it). */
export function setMcpBridge(url) {
  bridge = String(url || '');
}

let made = null;
let madeFor = '';
/** The manager (made on first use, for the current settings folder). */
export function mcp() {
  const dir = path.join(getConfigDir(), 'mcp');
  if (made && madeFor === dir) return made;
  const oauth = createOAuth({ redirectUri: () => `${bridge}/oauth/callback`, store: { get: (k) => tokenStore.get(k), set: (k, v) => tokenStore.set(k, v) }, openExternal: (u) => openBrowser(u) });
  made = createMcpManager({ pins: createPinStore({ dir }), oauth, cacheDir: path.join(dir, 'cache') });
  made.oauth = oauth;
  madeFor = dir;
  return made;
}
