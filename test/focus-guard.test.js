// "Orbit anywhere" phase 7: the focus guard (theft vs. the user's own switches) with stand-ins, and
// for real: our own test window, acted on by Orbit, pulls itself forward and the guard puts the
// user's window (another test window of ours) back in front. The real part moves the foreground,
// so it runs only while nobody has touched the mouse or keyboard for a minute (or with
// ORBIT_TEST_FOCUS=1), and minimizes our windows afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusStore } from '../src/platform/focus.js';
import { createFocusGuard } from '../src/anywhere/focus-guard.js';
import { createWinFocusTracker } from '../src/platform/win/focus.js';
import { canRunApps, startFakeApp, userIdleMs } from './e2e/fake-app.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = (hwnd, extra = {}) => ({ hwnd, owner: 0, pid: hwnd + 1, exe: `app${hwnd}.exe`, title: `w${hwnd}`, cls: 'X', kind: 'app', min: false, max: false, cloaked: false, elevated: false, x: 0, y: 0, w: 10, h: 10, dpi: 96, ...extra });

function setup({ intentional = () => false } = {}) {
  const focus = createFocusStore({ settleMs: 5 });
  const restored = [];
  const thefts = [];
  let t = 1_000_000;
  const guard = createFocusGuard({ focusStore: focus, switchTo: async (h) => (restored.push(h), { switched: true, how: 'foreground' }), isIntentional: intentional, onTheft: (e) => thefts.push(e), now: () => t });
  guard.start();
  return { focus, guard, restored, thefts, tick: (ms) => (t += ms) };
}

test('theft: a window Orbit just acted in comes forward with no input from the user; the user\x27s window goes back', async () => {
  const { focus, guard, restored, thefts } = setup();
  focus.update(W(1, { idle: 5000 })); // the user's window
  guard.noteAct(2, { action: 'press', role: 'Button', app: 'App2' });
  focus.update(W(2, { idle: 4000 }));
  await sleep(10);
  assert.deepEqual(restored, [1]);
  assert.equal(thefts[0].act.action, 'press');
  assert.equal(thefts[0].restored, true);
});

test('not theft: the user clicked (input just now), Alt+Tab, a switch they asked for, a window Orbit never touched, an old act', async () => {
  let s = setup();
  s.focus.update(W(1));
  s.guard.noteAct(2);
  s.focus.update(W(2, { idle: 100 }));
  await sleep(10);
  assert.deepEqual(s.restored, [], 'the user clicked it');

  s = setup();
  s.focus.update(W(1));
  s.guard.noteAct(2);
  s.focus.setSwitching(true);
  s.focus.update(W(2, { idle: 5000 }));
  await sleep(10);
  assert.deepEqual(s.restored, [], 'Alt+Tab');

  s = setup({ intentional: (h) => h === 2 });
  s.focus.update(W(1));
  s.guard.noteAct(2);
  s.focus.update(W(2, { idle: 5000 }));
  await sleep(10);
  assert.deepEqual(s.restored, [], 'switch_to_window');

  s = setup();
  s.focus.update(W(1));
  s.focus.update(W(3, { idle: 5000 }));
  await sleep(10);
  assert.deepEqual(s.restored, [], 'Orbit never acted there');

  s = setup();
  s.focus.update(W(1));
  s.guard.noteAct(2);
  s.tick(9000);
  s.focus.update(W(2, { idle: 5000 }));
  await sleep(10);
  assert.deepEqual(s.restored, [], 'the act was a while ago');
});

test('never a tug of war: at most 6 restores a minute', async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) {
    s.focus.update(W(1, { idle: 5000 }));
    s.guard.noteAct(2);
    s.focus.update(W(2, { idle: 5000 }));
    await sleep(2);
  }
  assert.equal(s.restored.length, 6);
  s.guard.stop();
  assert.equal(s.guard.running, false);
});

const idle = process.env.ORBIT_TEST_FOCUS === '1' || (canRunApps() && userIdleMs() > 60_000);
const skipReal = !canRunApps() ? 'needs Windows with .NET Framework 4 (csc.exe)' : !idle && 'someone is using this PC (set ORBIT_TEST_FOCUS=1 to run it anyway)';
// The desktop lock is taken here, not inside the test: waiting for the other real-desktop files
// (desktop-uia alone takes over a minute) must not count against the test's own timeout.
if (!skipReal && process.platform === 'win32') await lockDesktop();
test('for real: our "user" window is put back in front after our acted-on window steals it', { skip: skipReal, timeout: 120_000 }, async () => {
  const user = await startFakeApp('winforms', `ORBIT-GUARD-USER-${process.pid}`);
  const thief = await startFakeApp('wpf', `ORBIT-GUARD-THIEF-${process.pid}`);
  const focus = createFocusStore({ settleMs: 50 });
  const t = createWinFocusTracker({ onFocus: (w) => focus.update(w) });
  t.start();
  const thefts = [];
  const guard = createFocusGuard({ focusStore: focus, switchTo: (h) => t.switchTo(h), onTheft: (e) => thefts.push(e) });
  guard.start();
  try {
    // The user is in their window.
    assert.equal((await t.switchTo(user.hwnd)).switched, true);
    for (let i = 0; i < 40 && focus.current?.hwnd !== user.hwnd; i++) await sleep(50);
    assert.equal(focus.current?.hwnd, user.hwnd);
    // Orbit acts in the other window, which then pulls itself forward.
    guard.noteAct(thief.hwnd, { action: 'press', role: 'Button' });
    await thief.send({ activate: true });
    for (let i = 0; i < 60 && !thefts.length; i++) await sleep(50);
    assert.equal(thefts.length, 1, 'theft seen');
    assert.equal(thefts[0].thief.hwnd, thief.hwnd);
    for (let i = 0; i < 40 && focus.current?.hwnd !== user.hwnd; i++) await sleep(50);
    assert.equal(focus.current?.hwnd, user.hwnd, 'the user\x27s window is back in front');
    assert.equal(thefts[0].restored, true);
    assert.equal((await user.state()).active, true);
  } finally {
    guard.stop();
    await user.send({ minimize: true }).catch(() => {});
    await thief.send({ minimize: true }).catch(() => {});
    await sleep(200);
    t.stop();
    await user.close();
    await thief.close();
  }
});
