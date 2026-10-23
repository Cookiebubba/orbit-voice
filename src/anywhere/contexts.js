// One Orbit, many windows ("Orbit anywhere", phase 4). A context is Orbit's presence in one window:
// { id, hwnd, exe, app, title, home, createdAt, lastActiveAt, status }. The Claude window is the
// permanent "home" context (it follows whichever Claude window the orb docks on). Exactly one context
// is the active conversation; Qubit lives in each context's window (electron/avatar-host.js).
//
// The rules (from the brief):
//   - Wake word picks the place. "Hey Orbit" (or the hotkey) while window X is in front: X becomes
//     active. If X has no context, one is made and Qubit pops in. (Claude's window is home.)
//   - "Qubit, come here": the same, on the user's words, during a call.
//   - Focus follows, but only among his windows. While a call is live, a window with a context
//     coming to the front (settled ~300 ms) becomes active. A window without one changes nothing.
//   - Endings: a window that closes takes its context with it; a context with no work and no visit
//     for 30 minutes folds away; "Qubit, go away" (leave) ends this one. Home always stays.
//   - Caps: at most 6 contexts besides home; the oldest idle one makes room.
//
// Platform-neutral: windows come from the focus store (src/platform/focus.js).

import { appName } from '../platform/index.js';

export const CONTEXT_LIMITS = Object.freeze({ max: 6, idleFoldMs: 30 * 60_000 });
const HOME = 'home';

export function createContexts({ focusStore, isHomeWindow = () => false, now = () => Date.now(), limits = CONTEXT_LIMITS } = {}) {
  const contexts = new Map(); // id -> context (id = 'home' or 'w<hwnd>')
  let activeId = HOME;
  let live = false; // a call is on
  let homeHwnd = 0;
  const listeners = new Set();
  const emit = (why, extra = {}) => {
    const snap = { why, active: get(activeId), contexts: list(), ...extra };
    for (const fn of [...listeners]) {
      try {
        fn(snap);
      } catch { /* a listener's own problem */ }
    }
  };

  const home = () => contexts.get(HOME);
  contexts.set(HOME, { id: HOME, home: true, hwnd: 0, exe: 'claude.exe', app: 'Claude', title: 'Claude', createdAt: now(), lastActiveAt: now(), status: 'idle' });

  const get = (id) => (contexts.has(id) ? { ...contexts.get(id) } : null);
  const list = () => [...contexts.values()].map((c) => ({ ...c }));
  const idFor = (win) => (!win?.hwnd ? null : isHomeWindow(win) || win.hwnd === homeHwnd ? HOME : `w${win.hwnd}`);

  /** Make `id` the active context (a no-op if it already is). */
  function activate(id, why) {
    const c = contexts.get(id);
    if (!c) return false;
    c.lastActiveAt = now();
    if (activeId === id) return false;
    const previous = activeId;
    activeId = id;
    emit(why, { previous });
    return true;
  }

  /** The context for this window, made if it's new (room is made by folding the oldest idle one). */
  function ensure(win) {
    const id = idFor(win);
    if (!id) return null;
    if (contexts.has(id)) {
      const c = contexts.get(id);
      if (id !== HOME) Object.assign(c, { title: win.title || c.title, exe: win.exe || c.exe, app: appName(win) || c.app });
      return { id, made: false };
    }
    const others = [...contexts.values()].filter((c) => !c.home);
    if (others.length >= limits.max) {
      const idle = others.filter((c) => c.status === 'idle' && c.id !== activeId).sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
      if (!idle) return { id: null, full: true };
      contexts.delete(idle.id);
      emit('folded', { removed: { ...idle } });
    }
    contexts.set(id, { id, home: false, hwnd: win.hwnd, exe: win.exe || '', app: appName(win) || 'an app', title: win.title || '', createdAt: now(), lastActiveAt: now(), status: 'idle' });
    emit('added', { added: get(id) });
    return { id, made: true };
  }

  /** Orbit was woken (wake word, hotkey, a click) with `win` in front: it becomes active. */
  function wake(win) {
    if (!win?.hwnd || win.kind !== 'app') return { id: activeId, made: false };
    const r = ensure(win);
    if (!r?.id) return { id: activeId, made: false, full: !!r?.full };
    activate(r.id, 'wake');
    return r;
  }

  const offFocus = [];
  if (focusStore) {
    // Focus follows among his windows, while a call is on.
    offFocus.push(
      focusStore.on('settled', ({ current }) => {
        if (!live || !current?.hwnd || current.kind !== 'app') return;
        const id = idFor(current);
        if (id && contexts.has(id)) activate(id, 'focus');
      }),
    );
    offFocus.push(
      focusStore.on('gone', (hwnds) => {
        for (const h of hwnds) {
          const id = `w${h}`;
          if (!contexts.has(id)) continue;
          const c = contexts.get(id);
          contexts.delete(id);
          if (activeId === id) activeId = HOME;
          emit('closed', { removed: c });
        }
      }),
    );
  }

  return {
    wake,
    /** "Qubit, come here": the window the user is in gets him (and the conversation). */
    comeHere(win) {
      if (!win?.hwnd || win.kind !== 'app') return { ok: false, error: 'no_window' };
      const r = ensure(win);
      if (!r?.id) return { ok: false, error: r?.full ? 'full' : 'no_window' };
      activate(r.id, 'come_here');
      return { ok: true, id: r.id, made: r.made, already: !r.made && activeId === r.id };
    },
    /** A context for this window without moving the conversation there (a helper starting work). */
    attach(win) {
      if (!win?.hwnd || win.kind === 'orbit' || win.kind === 'shell') return null;
      const r = ensure(win);
      return r?.id ? { id: r.id, made: r.made } : null;
    },
    /** "Qubit, go away" / "go home": end this window's context (home stays). */
    leave(id = activeId) {
      if (id === HOME || !contexts.has(id)) return { ok: false, error: id === HOME ? 'home' : 'none' };
      const c = contexts.get(id);
      contexts.delete(id);
      if (activeId === id) activeId = HOME;
      emit('left', { removed: c });
      return { ok: true };
    },
    /** A call started (true) or ended (false). Focus follows only while one is on. */
    setLive(on) {
      live = !!on;
    },
    /** The home window (the Claude window the orb docks on) changed. */
    setHomeWindow(hwnd) {
      homeHwnd = Math.max(0, Math.floor(Number(hwnd)) || 0);
      home().hwnd = homeHwnd;
      // A context made for that window before it was known to be Claude's merges into home.
      const dup = contexts.get(`w${homeHwnd}`);
      if (dup) {
        contexts.delete(dup.id);
        if (activeId === dup.id) activeId = HOME;
        emit('merged', { removed: dup });
      }
    },
    /** Work status of a context (helpers, phase 8): 'idle' | 'working' | 'waiting' | 'done'. */
    setStatus(id, status) {
      const c = contexts.get(id);
      if (!c || !['idle', 'working', 'waiting', 'done'].includes(status) || c.status === status) return;
      c.status = status;
      emit('status', { changed: get(id) });
    },
    /** Fold contexts with no work and no visit for a while (call it now and then). */
    sweep() {
      const t = now();
      for (const c of [...contexts.values()]) {
        if (c.home || c.id === activeId || c.status === 'working' || c.status === 'waiting') continue;
        if (t - c.lastActiveAt > limits.idleFoldMs) {
          contexts.delete(c.id);
          emit('folded', { removed: c });
        }
      }
    },
    /** The context for a window (or null). */
    forWindow(win) {
      const id = idFor(win);
      return id ? get(id) : null;
    },
    on(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get active() {
      return get(activeId);
    },
    get list() {
      return list();
    },
    get live() {
      return live;
    },
    dispose() {
      for (const off of offFocus) off();
      listeners.clear();
    },
  };
}
