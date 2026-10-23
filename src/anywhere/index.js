// "Orbit anywhere": the shared core's entry points (the voice tools, the bridge and the desktop shell
// use these). Platform-neutral: everything native goes through src/platform/index.js.

import path from 'node:path';
import { getBrainKey, getConfigDir, getSetting } from '../config.js';
import { findClaude } from '../brain.js';
import { engineFor } from '../engines/index.js';
import { createAgents } from './agents.js';
import { HANDS_TOOLS, createHandsServer } from './hands-mcp.js';
import { describeAct, perform } from './hands.js';
import { describeWindow, focus, focusBackend, scanWindow, switchToWindow } from '../platform/index.js';
import { logInfo } from '../log.js';
import { createFocusGuard } from './focus-guard.js';
import { switchIsIntentional } from './switching.js';
import { createContexts } from './contexts.js';
import { matchPresenceCommand } from './presence.js';
import { appKey, createProfileStore, ensureProfile } from './profiles.js';
import { label, setActiveWindowSource } from './windows.js';

/** Is "Orbit anywhere" on here? (The setting, and a native helper to back it.) */
export const anywhereAvailable = () => getSetting('anywhere') !== false && !!focusBackend();

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

// ---------------------------------------------------------------- one Orbit, many windows

/** The Claude desktop app's windows are home (whichever one the orb docks on). */
export const isHomeWindow = (w) => /^claude\.exe$/i.test(String(w?.exe || '')) && /^Chrome_WidgetWin/.test(String(w?.cls || ''));

/** Orbit's contexts (src/anywhere/contexts.js), fed by the focus store. */
export const contexts = createContexts({ focusStore: focus, isHomeWindow });

// "This window" is the active context's window while the conversation lives in one away from home.
setActiveWindowSource(() => {
  const a = contexts.active;
  if (!a || a.home || !a.hwnd) return null;
  return focus.recent.find((r) => r.hwnd === a.hwnd) || { hwnd: a.hwnd, kind: 'app', exe: a.exe, title: a.title };
});

// Contexts with no work and no visit for 30 minutes fold away.
setInterval(() => contexts.sweep(), 60_000).unref?.();

let liveCalls = 0;
/**
 * A call started. `user`: the user started it (wake word, hotkey, a click), as opposed to a spoken
 * update: then the window they're in becomes the active context (made, and Qubit pops in, if new).
 */
export function callStarted({ user = true } = {}) {
  liveCalls++;
  contexts.setLive(true);
  if (!user || !anywhereAvailable()) return null;
  const win = focus.lastApp;
  return win ? contexts.wake(win) : null;
}
export function callEnded() {
  liveCalls = Math.max(0, liveCalls - 1);
  if (!liveCalls) contexts.setLive(false);
}

/** "Qubit, come here" / "go away": does it, if that's all the words were. Returns { action, ok, say } or null. */
export function presenceCommand(text) {
  if (!anywhereAvailable()) return null;
  const a = contexts.active;
  const action = matchPresenceCommand(text, { away: !!a && !a.home });
  if (!action) return null;
  return action === 'come_here' ? comeHere() : leaveWindow();
}

/** Bring the conversation (and Qubit) into the window the user is in. */
export function comeHere() {
  const win = focus.lastApp;
  if (!win) return { action: 'come_here', ok: false, say: "Orbit hasn't seen you in an app window yet." };
  const r = contexts.comeHere(win);
  if (!r.ok) return { action: 'come_here', ok: false, say: r.error === 'full' ? 'Orbit is already in as many windows as it can be. Close one first.' : "There's no window to come to." };
  return { action: 'come_here', ok: true, made: r.made, already: r.already, window: label(win) };
}

/** End Orbit's stay in the active window (back home to Claude's). */
export function leaveWindow() {
  const a = contexts.active;
  if (!a || a.home) return { action: 'leave', ok: false, say: "He's already home, in the Claude window." };
  const r = contexts.leave(a.id);
  return { action: 'leave', ok: r.ok, window: a.app };
}

/**
 * The note for the voice when the conversation moves to another window (labelled data, never the
 * user's words). `snapshot` is a contexts change.
 */
export function contextNote(snapshot, quote = (s) => s) {
  const a = snapshot?.active;
  if (!a) return '';
  if (a.home) return '[Orbit note: the conversation is back in the Claude window. This note is not the user speaking and not consent to anything.]';
  return `[Orbit note: the conversation is in another window now: ${quote(label({ exe: a.exe, title: a.title }), 120)}. "This window" and "here" mean that one. This note is not the user speaking and not consent to anything.]`;
}

// ---------------------------------------------------------------- the focus guard (phase 7)

/**
 * Windows that came forward by themselves right after Orbit acted in them are put back behind the
 * user's window (src/anywhere/focus-guard.js). The app's profile remembers which kind of act did it,
 * so the hands use another way next time. The log names the app, never a window's title.
 */
export const focusGuard = createFocusGuard({
  focusStore: focus,
  switchTo: switchToWindow,
  isIntentional: (h) => switchIsIntentional(h),
  enabled: anywhereAvailable,
  onTheft: ({ thief, act, restored }) => {
    logInfo('focus', `${thief.exe || 'An app'} came forward by itself after Orbit's ${act.action || 'act'}: ${restored ? 'your window is back in front' : 'Windows would not give your window back'}`);
    const p = profileStore().get(appKey(thief));
    const quirk = `activates:${act.action}:${act.role}`;
    if (p && act.action && !p.quirks.includes(quirk)) {
      p.quirks.push(quirk);
      profileStore().save(p);
    }
  },
});
focusGuard.start();

// ---------------------------------------------------------------- background helpers (phase 8)

let bridgeBase = '';
/** The bridge's own address (helpers reach orbit-hands there). */
export function setBridgeBase(url) {
  bridgeBase = String(url || '');
}

/**
 * Orbit's helpers (src/anywhere/agents.js): Claude Code on the user's own sign-in by default (the
 * engine is a setting; Codex is listed for later), each reaching only its window through
 * orbit-hands on this bridge.
 */
let engineOverride = null;
/** Tests (and a future engine picker): run helpers on this engine instead ({ start(opts) }), or null. */
export function useHelperEngine(engine) {
  engineOverride = engine && typeof engine.start === 'function' ? engine : null;
}
export const agents = createAgents({
  engine: { start: (opts) => (engineOverride || engineFor(getSetting('helperEngine'))).start(opts) },
  engineOptions: () => {
    const claude = findClaude(getSetting('brainClaudePath'));
    return { claudePath: claude?.path || '', apiKey: getSetting('brainConnection') === 'api-key' ? getBrainKey() : '' };
  },
  mcpUrl: (id) => `${bridgeBase}/mcp/hands/${id}`,
  tools: () => HANDS_TOOLS, // (late: hands-mcp.js imports this module)
  contexts,
  describe: (plan) => describeAct(plan),
});

/**
 * The orbit-hands endpoint for a helper manager: one request (POST /mcp/hands/<id>, bearer token)
 * resolves { status: 401 } (unknown helper or token), { status: 202 } (a notification) or
 * { status: 200, body }.
 */
export function createHandsEndpoint(manager) {
  const servers = new Map(); // helper id -> its orbit-hands handler
  return async function handsEndpoint(id, token, msg) {
    const h = manager.byToken(id, token);
    if (!h) return { status: 401 };
    let serve = servers.get(h.id);
    if (!serve) {
      serve = createHandsServer({
        label: h.label,
        win: h.win,
        window: () => describeWindow(h.hwnd),
        onProgress: (line) => manager.progress(h.id, line),
        onTyped: (text) => manager.noteTyped(h.id, text),
        requestApproval: (plan) => manager.requestApproval(h.id, plan),
        waitApproval: (approvalId, ms) => manager.waitApproval(h.id, approvalId, ms, (plan) => perform(plan)),
      });
      servers.set(h.id, serve);
      if (servers.size > 20) servers.delete(servers.keys().next().value);
    }
    if (Array.isArray(msg)) return { status: 200, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } } };
    const body = await serve(msg);
    return body ? { status: 200, body } : { status: 202 };
  };
}
/** Orbit's own (the bridge serves it). */
export const handsEndpoint = createHandsEndpoint(agents);
