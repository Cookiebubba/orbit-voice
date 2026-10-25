// Text that web apps really take (src/anywhere/hands.js, cdp.js, uia.ps1), for real, on our own test
// web app (test/e2e/web-input/: Electron, a contenteditable editor and a controlled textarea that only
// notice real input events, as OpenCode's and React's do). Never another app's window.
//   - UI Automation's SetValue shows the text but the app doesn't take it: Orbit notices.
//   - With the debugging-port setting on and the app started with a port: typed through the app's
//     DevTools protocol instead, taken, and the window never activated. Remembered for the app.
//   - Without it: Orbit asks once to borrow focus; on a yes it types the text as keystrokes, the app
//     takes it, and the user's window comes straight back (only while nobody is using this PC).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConfig, updateSettings } from '../src/config.js';
import { focus, setUiaHost, startFocusTracking, switchToWindow } from '../src/platform/index.js';
import { createUiaHost } from '../src/platform/win/uia.js';
import { profileStore } from '../src/anywhere/index.js';
import { createToolRunner } from '../src/tools.js';
import { startWebInputApp } from './e2e/web-input.mjs';
import { canRunApps, startFakeApp, userIdleMs } from './e2e/fake-app.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';

const skip = process.platform !== 'win32' && 'needs Windows';
if (!skip) await lockDesktop(); // one real-desktop test file at a time
initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-web-input-')) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setUp(app) {
  const host = createUiaHost({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-uia-cache-')) });
  setUiaHost(host);
  focus.reset();
  const tracker = startFocusTracking();
  const said = [];
  const latest = () => said.at(-1) || null;
  const r = createToolRunner({ notify: () => {}, recentUtterance: latest, utteranceSince: async (ts) => (latest() && latest().at > ts ? latest() : null), userWords: () => said.map((u) => u.text).join(' ') });
  const say = async (text) => {
    await sleep(5);
    said.push({ text, at: Date.now() });
  };
  for (let i = 0; i < 40 && !focus.current; i++) await sleep(50);
  await sleep(600); // (Chromium builds its accessibility tree on the first question)
  const act = (args) => r.run('act_in_window', JSON.stringify({ window: app.title, ...args }));
  return { r, say, act, done: () => (tracker?.stop(), host.stop(), setUiaHost(null)) };
}

test('web app: SetValue isn\x27t taken and Orbit notices; through the debugging port it is, without focus', { skip, timeout: 180_000 }, async () => {
  updateSettings({ anywhereCdp: true });
  const app = await startWebInputApp(`ORBIT-WEB-CDP-${process.pid}`, { cdpPort: 9300 + (process.pid % 500) });
  const s = await setUp(app);
  try {
    await s.say(`in ${app.title} type hello from orbit into the prompt box`);
    const res = await s.act({ control: 'Prompt', action: 'set_text', text: 'hello from orbit' });
    assert.equal(res.done, true, JSON.stringify(res));
    assert.match(String(res.typed_how), /debugging port/, 'typed the second way, and says so');
    assert.ok(await app.waitFor((st) => st.prompt === 'hello from orbit' && st.sendPrompt), `the app took it: ${JSON.stringify(app.state())}`);
    assert.equal(profileStore().get('win-electron')?.inputMethod, 'cdp', 'remembered for this app');
    // Next time it goes that way first: the controlled textarea takes it too.
    await s.say('type hello from orbit into the message box');
    const res2 = await s.act({ control: 'Message', action: 'set_text', text: 'hello from orbit' });
    assert.equal(res2.done, true, JSON.stringify(res2));
    assert.ok(await app.waitFor((st) => st.message === 'hello from orbit' && st.sendMessage), `the app took it: ${JSON.stringify(app.state())}`);
    assert.equal(app.events.filter((e) => e.event === 'activated').length, 0, 'the window never became active');
  } finally {
    s.done();
    await app.close();
    updateSettings({ anywhereCdp: false });
    profileStore().remove('win-electron');
  }
});

test('web app without a debugging port: Orbit sees it wasn\x27t taken and asks to restart it under Orbit (not to borrow focus)', { skip, timeout: 180_000 }, async () => {
  const app = await startWebInputApp(`ORBIT-WEB-ASK-${process.pid}`);
  const s = await setUp(app);
  try {
    await s.say(`in ${app.title} type hello from orbit into the prompt box`);
    const res = await s.act({ control: 'Prompt', action: 'set_text', text: 'hello from orbit' });
    assert.equal(res.held, true, JSON.stringify(res));
    assert.match(res.ask, /isn't under Orbit right now/);
    assert.match(res.ask, /under Orbit/, 'offers to restart it under Orbit, not to borrow focus');
    await sleep(400);
    assert.equal(app.state().prompt, '', 'not taken (yet)');
    // "No" (or anything but a clear yes) never borrows anything.
    await s.say('no, leave it');
    const no = await s.r.run('confirm_window_action', JSON.stringify({ key: res.confirm_key }));
    assert.equal(no.ok, false);
    assert.equal(app.events.filter((e) => e.event === 'activated').length, 0, 'never activated without a yes');
  } finally {
    s.done();
    await app.close();
    profileStore().remove('win-electron');
  }
});

const idle = process.env.ORBIT_TEST_FOCUS === '1' || (canRunApps() && userIdleMs() > 60_000);
const skipBorrow = skip || (!canRunApps() ? 'needs .NET Framework 4 for the stand-in user window' : !idle && 'someone is using this PC (set ORBIT_TEST_FOCUS=1 to run it anyway)');
test('on a yes: typed by borrowing focus for a moment; the app takes it and the user\x27s window comes back', { skip: skipBorrow, timeout: 180_000 }, async () => {
  const user = await startFakeApp('winforms', `ORBIT-WEB-USER-${process.pid}`, { onscreen: true });
  const app = await startWebInputApp(`ORBIT-WEB-BORROW-${process.pid}`);
  const s = await setUp(app);
  try {
    assert.equal((await switchToWindow(user.hwnd))?.switched, true, 'our stand-in user window is in front');
    await sleep(300);
    await s.say(`in ${app.title} type hello from orbit into the prompt box`);
    const res = await s.act({ control: 'Prompt', action: 'set_text', text: 'hello from orbit' });
    assert.equal(res.held, true, JSON.stringify(res));
    await s.say('yeah go ahead');
    const yes = await s.r.run('confirm_window_action', JSON.stringify({ key: res.confirm_key }));
    assert.equal(yes.done, true, JSON.stringify(yes));
    assert.ok(await app.waitFor((st) => st.prompt === 'hello from orbit' && st.sendPrompt), `the app took it: ${JSON.stringify(app.state())}`);
    for (let i = 0; i < 40 && focus.current?.hwnd !== user.hwnd; i++) await sleep(50);
    assert.equal(focus.current?.hwnd, user.hwnd, 'the user\x27s window is back in front');
    assert.equal(profileStore().get('win-electron')?.borrowFocusOk, true, 'the yes is remembered for this app');
  } finally {
    s.done();
    await app.close();
    await user.close();
    profileStore().remove('win-electron');
  }
});
