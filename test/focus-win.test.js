// "Orbit anywhere" phase 1, for real: src/platform/win/focus.ps1 (the WinEvent hook helper) on
// this machine, against test windows these tests start themselves (test/e2e/FakeApp.cs). It only
// ever reads other windows (their handle, process, class and title, which are never printed).
//
// The last test brings our own test window to the front, so it changes the foreground for about a
// second; it runs only when nobody has touched the mouse or keyboard for a minute (or with
// ORBIT_TEST_FOCUS=1), and gives the foreground back by minimizing our window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWinFocusTracker } from '../src/platform/win/focus.js';
import { canRunApps, startFakeApp, userIdleMs } from './e2e/fake-app.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';
import { realDesktopSkip } from './e2e/real-desktop.mjs';

if (process.platform === 'win32' && !realDesktopSkip) await lockDesktop(); // one real-desktop test file at a time

const skip = realDesktopSkip || (!canRunApps() && 'needs Windows with .NET Framework 4 (csc.exe)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function track(parentPid = process.pid) {
  const log = { fg: [], gone: [], switching: [] };
  const t = createWinFocusTracker({ parentPid, onFocus: (w) => log.fg.push(w), onGone: (g) => log.gone.push(...g), onSwitching: (s) => log.switching.push(s), onError: (m) => log.error = m });
  t.start();
  return { t, log };
}
async function until(pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(25);
  }
  return false;
}

test('the helper reports the window in front at once, describes and lists windows, and a window shown without activation changes nothing', { skip, timeout: 120_000 }, async () => {
  const app = await startFakeApp('winforms', `ORBIT-FOCUS-${process.pid}`);
  const { t, log } = track();
  try {
    assert.ok(await until(() => log.fg.length > 0), 'a first report');
    const first = log.fg[0];
    assert.ok(['app', 'shell', 'none', 'orbit'].includes(first.kind));
    if (first.hwnd) {
      assert.ok(Number.isInteger(first.pid) && first.pid > 0);
      assert.equal(typeof first.title, 'string');
      assert.ok(first.dpi >= 96);
    }
    // Our window came up without activation: still the same window in front.
    await sleep(600);
    assert.ok(log.fg.every((w) => w.hwnd !== app.hwnd), 'our test window never came to the front');
    assert.ok(app.events.every((e) => e.event !== 'activated'), 'and it never became active');

    const d = await t.describe(app.hwnd);
    assert.equal(d.hwnd, app.hwnd);
    assert.equal(d.pid, app.pid);
    assert.equal(d.exe, 'OrbitFakeApp.exe');
    assert.equal(d.title, `ORBIT-FOCUS-${process.pid}`);
    assert.equal(d.kind, 'app');
    assert.equal(d.elevated, false);
    assert.equal(d.min, false);
    assert.ok(d.w >= 600 && d.h >= 380, `size ${d.w}x${d.h}`);
    assert.equal(d.x < -4000, true, 'off screen, where the test put it');
    assert.equal(await t.describe(1), null, 'not a window');

    const list = await t.list();
    assert.ok(list.some((w) => w.hwnd === app.hwnd), 'Alt+Tab would list it');
    assert.ok(list.every((w) => w.kind === 'app'));
    // Titles with quotes, backslashes and emoji come through as JSON intact.
    const odd = 'He said "hi" \\ path 🙂 ünï';
    await app.send({ title: odd });
    assert.equal((await t.describe(app.hwnd)).title, odd);

    // Orbit's own windows: a helper whose parent is the test app calls them "orbit".
    const other = track(app.pid);
    try {
      assert.equal((await other.t.describe(app.hwnd)).kind, 'orbit');
    } finally {
      other.t.stop();
    }
  } finally {
    await app.close();
    t.stop();
  }
});

test('WPF windows too', { skip, timeout: 120_000 }, async () => {
  const app = await startFakeApp('wpf', `ORBIT-FOCUS-WPF-${process.pid}`);
  const { t } = track();
  try {
    const d = await t.describe(app.hwnd);
    assert.equal(d.pid, app.pid);
    assert.equal(d.kind, 'app');
    assert.match(d.cls, /^HwndWrapper\[/);
    assert.ok(app.events.every((e) => e.event !== 'activated'));
  } finally {
    await app.close();
    t.stop();
  }
});

test('watch: the windows Qubit is in report their moves, minimizing and closing (no focus change)', { skip, timeout: 120_000 }, async () => {
  const a = await startFakeApp('winforms', `ORBIT-WATCH-A-${process.pid}`);
  const b = await startFakeApp('wpf', `ORBIT-WATCH-B-${process.pid}`);
  const wins = [];
  const gone = [];
  const t = createWinFocusTracker({ onWins: (w) => wins.push(w), onGone: (g) => gone.push(...g) });
  t.start();
  try {
    assert.equal(await t.watch([a.hwnd, b.hwnd, 'x', -1]), 2);
    assert.ok(await until(() => wins.some((w) => w.length === 2)), 'both reported');
    const first = wins.find((w) => w.length === 2).find((w) => w.hwnd === a.hwnd);
    assert.ok(first.x < -4000 && first.w >= 600, JSON.stringify(first));
    await a.send({ minimize: true });
    assert.ok(await until(() => wins.at(-1)?.find((w) => w.hwnd === a.hwnd)?.min === true), 'minimized reported');
    await a.send({ restore: true });
    assert.ok(await until(() => wins.at(-1)?.find((w) => w.hwnd === a.hwnd)?.min === false), 'restored reported');
    await b.close();
    assert.ok(await until(() => wins.at(-1)?.length === 1), 'a closed window drops out');
    assert.ok(await until(() => gone.includes(b.hwnd), 4000), 'and is reported gone');
    assert.equal(await t.watch([]), 0);
    assert.ok(a.events.every((e) => e.event !== 'activated'), 'never activated');
  } finally {
    t.stop();
    await a.close();
    await b.close();
  }
});

const idle = process.env.ORBIT_TEST_FOCUS === '1' || (canRunApps() && userIdleMs() > 60_000);
test('following focus for real: our window comes to the front, its title changes, it minimizes and closes', { skip: skip || (!idle && 'someone is using this PC (set ORBIT_TEST_FOCUS=1 to run it anyway)'), timeout: 120_000 }, async () => {
  const app = await startFakeApp('winforms', `ORBIT-FOCUS-LIVE-${process.pid}`);
  const { t, log } = track();
  try {
    assert.ok(await until(() => log.fg.length > 0));
    const before = log.fg.at(-1).hwnd;
    const t0 = Date.now();
    await app.send({ activate: true });
    assert.ok(await until(() => log.fg.some((w) => w.hwnd === app.hwnd)), 'reported in front');
    const hit = log.fg.find((w) => w.hwnd === app.hwnd);
    assert.equal(hit.kind, 'app');
    assert.equal(hit.title, `ORBIT-FOCUS-LIVE-${process.pid}`);
    const latency = Date.now() - t0;
    assert.ok(latency < 1500, `within a moment (${latency} ms)`);
    // A title change of the window in front is reported (no polling: the name-change hook).
    await app.send({ title: 'ORBIT-FOCUS renamed' });
    assert.ok(await until(() => log.fg.at(-1).hwnd === app.hwnd && log.fg.at(-1).title === 'ORBIT-FOCUS renamed', 3000), 'title change reported');
    // Minimizing hands the foreground back to the window that was in front before.
    await app.send({ minimize: true });
    assert.ok(await until(() => log.fg.at(-1).hwnd !== app.hwnd || log.fg.at(-1).min), 'minimize reported');
    await app.close();
    assert.ok(await until(() => log.gone.includes(app.hwnd), 4000), 'closed window reported gone');
    await sleep(300);
    // (Not asserted: whether Windows gave the foreground back to exactly `before`.)
    if (log.fg.at(-1).hwnd !== before) console.log('# note: the foreground went to a different window after the test');
  } finally {
    await app.close();
    t.stop();
  }
});
