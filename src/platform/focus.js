// Which window is in front, in any app ("Orbit anywhere", phase 1). Platform-neutral: a native
// helper (Windows: platform/win/focus.ps1 through focus.js) feeds it, and the rest of Orbit asks it.
//
//   current     the window in front right now (any kind: an app, one of Orbit's own, the shell)
//   lastApp     the app window the user was in last: the one that's in front, or, while Orbit's own
//               window, the taskbar or Alt+Tab is in front, the app window before it. "This window"
//               means this one.
//   recent      app windows the user has been in, most recent first (closed ones drop out)
//   settled     fires once the window in front has stayed the same for settleMs (300 ms), so a
//               quick Alt+Tab through five windows is one change, not five
//
// Window titles are the apps' own text: they are kept here for the voice to name windows, and never
// written to the log.

const TITLE_MAX = 300;
// Control characters, and every kind of line break or odd space (\s covers the Unicode line separators).
const CONTROL = /(?:[\x00-\x1f\x7f]|[^\S ])+/g;
const KINDS = new Set(['app', 'orbit', 'shell', 'none']);

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const text = (v, max) =>
  typeof v === 'string'
    ? v
        .replace(CONTROL, ' ')
        .trim()
        .slice(0, max)
    : '';

/** A helper's window report, checked and trimmed: { hwnd, owner, pid, exe, title, cls, kind, min, max, cloaked, elevated, rect, dpi }. */
export function cleanWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const hwnd = int(w.hwnd);
  if (hwnd <= 0) return { hwnd: 0, kind: 'none' };
  return {
    hwnd,
    owner: Math.max(0, int(w.owner)),
    pid: Math.max(0, int(w.pid)),
    exe: text(w.exe, 80),
    title: text(w.title, TITLE_MAX),
    cls: text(w.cls, 120),
    kind: KINDS.has(w.kind) ? w.kind : 'app',
    min: !!w.min,
    max: !!w.max,
    cloaked: !!w.cloaked,
    elevated: !!w.elevated,
    rect: { x: int(w.x), y: int(w.y), w: Math.max(0, int(w.w)), h: Math.max(0, int(w.h)) },
    dpi: int(w.dpi) > 0 ? int(w.dpi) : 96,
    ...(Number.isFinite(Number(w.idle)) && w.idle !== null && w.idle !== undefined ? { idle: Math.max(0, int(w.idle)) } : {}),
  };
}

/** The app's name as people say it: "notepad.exe" -> "Notepad", "Discord.exe" -> "Discord". */
export function appName(win) {
  const exe = String(win?.exe || '').replace(/\.exe$/i, '');
  if (!exe) return '';
  const known = { applicationframehost: '', explorer: 'File Explorer', msedge: 'Edge', chrome: 'Chrome', code: 'VS Code', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', outlook: 'Outlook', windowsterminal: 'Terminal', wt: 'Terminal', photoshop: 'Photoshop', obs64: 'OBS', claude: 'Claude' };
  const k = exe.toLowerCase();
  if (Object.hasOwn(known, k)) return known[k] || text(win?.title, 40);
  return exe.charAt(0).toUpperCase() + exe.slice(1);
}

export function createFocusStore({ settleMs = 300, maxRecent = 30, now = () => Date.now() } = {}) {
  let current = null; // { ...window, at }
  let lastApp = null;
  let recent = []; // app windows, most recent first
  let switching = false;
  let settleTimer = null;
  let settledHwnd = 0;
  const listeners = { change: new Set(), settled: new Set(), gone: new Set(), switching: new Set() };
  const emit = (ev, arg) => {
    for (const fn of [...listeners[ev]]) {
      try {
        fn(arg);
      } catch { /* a listener's own problem */ }
    }
  };

  const isApp = (w) => !!w && w.kind === 'app' && w.hwnd > 0 && !w.cloaked;

  const store = {
    /** A report from the native helper: the window in front changed (or its title, or minimized). */
    update(raw) {
      const w = cleanWindow(raw);
      if (!w) return;
      const at = now();
      const prev = current;
      current = { ...w, at };
      if (isApp(w)) {
        lastApp = current;
        recent = [current, ...recent.filter((r) => r.hwnd !== w.hwnd)].slice(0, maxRecent);
      }
      emit('change', { current, previous: prev, lastApp });
      if (prev?.hwnd !== w.hwnd || !settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (!current || current.hwnd === settledHwnd) return;
          settledHwnd = current.hwnd;
          emit('settled', { current, lastApp });
        }, settleMs);
        settleTimer.unref?.();
      }
    },
    /** Windows the helper reported before have closed. */
    gone(hwnds) {
      const set = new Set((Array.isArray(hwnds) ? hwnds : []).map(int).filter((h) => h > 0));
      if (!set.size) return;
      recent = recent.filter((r) => !set.has(r.hwnd));
      if (lastApp && set.has(lastApp.hwnd)) lastApp = recent[0] || null;
      if (current && set.has(current.hwnd)) current = { hwnd: 0, kind: 'none', at: now() };
      emit('gone', [...set]);
    },
    /** Alt+Tab (or Win+Tab) started or ended. */
    setSwitching(on) {
      switching = !!on;
      emit('switching', switching);
    },
    on(ev, fn) {
      if (!listeners[ev] || typeof fn !== 'function') return () => {};
      listeners[ev].add(fn);
      return () => listeners[ev].delete(fn);
    },
    get current() {
      return current;
    },
    /** The app window the user is working in (see the top). */
    get lastApp() {
      return lastApp;
    },
    get recent() {
      return [...recent];
    },
    get switching() {
      return switching;
    },
    /** Tests: forget everything. */
    reset() {
      clearTimeout(settleTimer);
      settleTimer = null;
      settledHwnd = 0;
      current = null;
      lastApp = null;
      recent = [];
      switching = false;
    },
  };
  return store;
}

/** Orbit's one focus store (fed by the desktop shell; see electron/main.js). */
export const focus = createFocusStore();

// The native side for questions about windows (describe one, list them): the Windows helper, a test
// double, or none (browser mode, macOS for now).
let backend = null;
export function setFocusBackend(b) {
  backend = b && typeof b === 'object' ? b : null;
}
export const focusBackend = () => backend;

/** One window as the helper sees it now (null if gone or no helper). */
export async function describeWindow(hwnd) {
  if (!backend?.describe) return null;
  return cleanWindow(await backend.describe(hwnd).catch(() => null));
}

/** Bring a window to the front, on the user's request only: { switched, how } or { error }. */
export async function switchToWindow(hwnd) {
  if (!backend?.switchTo) return { error: 'unavailable' };
  return backend.switchTo(hwnd).catch(() => ({ error: 'failed' }));
}

/** The app windows the user could switch to, front first ([] without a helper). */
export async function listWindows() {
  if (!backend?.list) return [];
  const list = await backend.list().catch(() => []);
  return (Array.isArray(list) ? list : []).map(cleanWindow).filter((w) => w && w.hwnd > 0 && w.kind === 'app');
}
