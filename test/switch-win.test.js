// "Orbit anywhere" phase 6, for real: the focus helper's switch chain (restore, SetForegroundWindow,
// minimize-and-restore, flash) on a test window these tests start themselves. Switching moves the
// foreground, so this runs only while nobody has touched the mouse or keyboard for a minute (or with
// ORBIT_TEST_FOCUS=1), and gives the foreground back by minimizing our window afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWinFocusTracker } from '../src/platform/win/focus.js';
import { canRunApps, startFakeApp, userIdleMs } from './e2e/fake-app.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';

if (process.platform === 'win32') await lockDesktop(); // one real-desktop test file at a time

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = process.env.ORBIT_TEST_FOCUS === '1' || (canRunApps() && userIdleMs() > 60_000);
const skip = !canRunApps() ? 'needs Windows with .NET Framework 4 (csc.exe)' : !idle && 'someone is using this PC (set ORBIT_TEST_FOCUS=1 to run it anyway)';

test('switch: a minimized window and a window behind others both come to the front', { skip, timeout: 120_000 }, async () => {
  const app = await startFakeApp('winforms', `ORBIT-SWITCH-${process.pid}`);
  const fg = [];
  const t = createWinFocusTracker({ onFocus: (w) => fg.push(w) });
  t.start();
  try {
    for (let i = 0; i < 60 && !fg.length; i++) await sleep(50);
    // 1. Minimized: restore brings it forward.
    await app.send({ minimize: true });
    await sleep(300);
    let r = await t.switchTo(app.hwnd);
    assert.equal(r.switched, true, JSON.stringify(r));
    assert.ok(['restore', 'foreground', 'minrestore'].includes(r.how), r.how);
    for (let i = 0; i < 40 && fg.at(-1)?.hwnd !== app.hwnd; i++) await sleep(50);
    assert.equal(fg.at(-1)?.hwnd, app.hwnd, 'the focus helper saw it come forward');
    assert.ok(Number.isFinite(fg.at(-1)?.idle), 'with the time since the last input');
    assert.equal((await app.state()).active, true);
    // Give the foreground back (the next window gets it), then 2: a window behind others.
    await app.send({ minimize: true });
    await sleep(300);
    await app.send({ restore: true }); // shown again, without activating: behind the window in front
    await sleep(300);
    assert.equal((await app.state()).active, false);
    r = await t.switchTo(app.hwnd);
    assert.equal(r.switched, true, JSON.stringify(r));
    assert.equal((await app.state()).active, true);
    assert.equal((await t.switchTo(1)).error, 'no_window');
  } finally {
    await app.send({ minimize: true }).catch(() => {});
    await sleep(200);
    t.stop();
    await app.close();
  }
});
