// One avatar per place, at every moment (electron/avatar-host.js). Regression: switching the voice
// engine back and forth (and the voice sessions restarting with it) showed two avatars for a while.
// Every churn here (avatar kinds switched quickly, contexts dropped and made again as calls restart,
// a window's Qubit on the window home is on) is sampled every few ms: never two avatars showing in
// one window, counting one still fading out.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAvatarHost } from '../electron/avatar-host.js';
import { createContexts } from '../src/anywhere/contexts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FADE_MS = 30;

/** Fake avatars: showing while enabled and placed on a found window, and still while fading out. */
function world() {
  const all = [];
  const mk = (kind, { home = false } = {}) => {
    const a = { kind, home, enabled: false, claude: null, fading: false, gone: false, window: { webContents: {} } };
    Object.assign(a, {
      onVoice() {},
      onClaude: (c) => (a.claude = c),
      setEnabled: (on) => (a.enabled = !!on),
      // Like avatar.js leave(): a showing one fades out for a while; one never shown just goes.
      leave: () => {
        const was = showing(a);
        a.enabled = false;
        if (!was) {
          a.gone = true;
          return Promise.resolve();
        }
        a.fading = true;
        return sleep(FADE_MS).then(() => ((a.gone = true), (a.fading = false)));
      },
      stop() {},
      refresh() {},
    });
    Object.defineProperty(a, 'hostHwnd', { get: () => (a.claude?.found ? a.claude.hwnd : 0) });
    all.push(a);
    return a;
  };
  const showing = (a) => !a.gone && (a.fading || (a.enabled && a.claude?.found && !a.claude.min));
  /** Avatars showing per window right now. */
  const perPlace = () => {
    const m = new Map();
    for (const a of all) if (showing(a)) m.set(a.claude.hwnd, (m.get(a.claude.hwnd) || 0) + 1);
    return m;
  };
  let worst = 0;
  const timer = setInterval(() => {
    for (const n of perPlace().values()) worst = Math.max(worst, n);
  }, 2);
  return { mk, all, perPlace, get worst() { for (const n of perPlace().values()) worst = Math.max(worst, n); return worst; }, stop: () => clearInterval(timer) };
}

test('kinds switched quickly, again and again: never two avatars in one window', async () => {
  const w = world();
  try {
  const home = w.mk('qubit', { home: true });
  home.setEnabled(true);
  home.onClaude({ found: true, hwnd: 1 });
  const host = createAvatarHost({ makeAvatar: (k) => w.mk(k), home: () => home, current: () => null });
  host.setKind('qubit', 2);
  const snap = { active: { id: 'home' }, contexts: [{ id: 'home', home: true }, { id: 'w10', hwnd: 10, lastActiveAt: 1 }, { id: 'w11', hwnd: 11, lastActiveAt: 2 }] };
  host.sync(snap);
  host.onWins([{ hwnd: 10, min: false, x: 0, y: 0, w: 800, h: 600 }, { hwnd: 11, min: false, x: 900, y: 0, w: 800, h: 600 }]);
  await sleep(5);
  for (let i = 0; i < 6; i++) {
    host.setKind(i % 2 ? 'qubit' : 'buddy', 2);
    await sleep(i % 3 === 0 ? 1 : 12); // faster than a fade, and slower
    host.onWins([{ hwnd: 10, min: false, x: 0, y: 0, w: 800, h: 600 }, { hwnd: 11, min: false, x: 900, y: 0, w: 800, h: 600 }]);
  }
  await sleep(FADE_MS * 3);
  assert.equal(w.worst, 1, 'at most one avatar showing per window at every sample');
  const last = w.perPlace();
  assert.equal(last.get(10), 1, 'and each window has its one at the end');
  assert.equal(last.get(11), 1);
  } finally {
    w.stop();
  }
});

test('voice sessions restarting with each engine switch: contexts made again never double up', async () => {
  const w = world();
  try {
  const home = w.mk('qubit', { home: true });
  home.setEnabled(true);
  home.onClaude({ found: true, hwnd: 1 });
  const cx = createContexts({ isHomeWindow: (x) => x.exe === 'claude.exe' });
  const host = createAvatarHost({ makeAvatar: (k) => w.mk(k), home: () => home, current: () => null });
  host.setKind('qubit', 2);
  cx.on((s) => host.sync(s));
  const notepad = { hwnd: 10, kind: 'app', exe: 'notepad.exe', title: 'n' };
  const bounds = [{ hwnd: 10, min: false, x: 0, y: 0, w: 800, h: 600 }];
  for (let i = 0; i < 8; i++) {
    // A call starts in Notepad (its Qubit pops in), ends; "go away" drops it; the next call (the
    // other engine) makes it again at once.
    cx.setLive(true);
    cx.wake(notepad);
    host.onWins(bounds);
    await sleep(i % 2 ? 2 : 9);
    cx.leave('w10');
    cx.setLive(false);
    await sleep(1);
  }
  cx.wake(notepad);
  host.onWins(bounds);
  await sleep(FADE_MS * 3);
  assert.equal(w.worst, 1, 'never two showing in Notepad (or on Claude)');
  assert.equal(w.perPlace().get(10), 1);
    cx.dispose();
  } finally {
    w.stop();
  }
});

test("a window's Qubit never shows on the window home's avatar is on", async () => {
  const w = world();
  try {
  const home = w.mk('qubit', { home: true });
  home.setEnabled(true);
  home.onClaude({ found: true, hwnd: 1 });
  const host = createAvatarHost({ makeAvatar: (k) => w.mk(k), home: () => home, current: () => null });
  host.setKind('qubit', 2);
  host.sync({ active: { id: 'w7' }, contexts: [{ id: 'home', home: true }, { id: 'w7', hwnd: 7, lastActiveAt: 1 }] });
  host.onWins([{ hwnd: 7, min: false, x: 0, y: 0, w: 800, h: 600 }]);
  await sleep(1);
  assert.equal(w.perPlace().get(7), 1, 'its own window: shown');
  // Home's avatar moves onto that very window (it became the Claude window Orbit docks on).
  home.onClaude({ found: true, hwnd: 7 });
  host.onFocus();
  assert.equal(w.perPlace().get(7), 1, 'only one there: the guest steps aside');
  assert.equal(w.all.find((a) => !a.home && !a.gone).claude.found, false);
  home.onClaude({ found: true, hwnd: 1 });
  host.onFocus();
  assert.equal(w.perPlace().get(7), 1, 'home gone back: the guest shows again');
  assert.equal(w.worst, 1);
  } finally {
    w.stop();
  }
});
