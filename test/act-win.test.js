// "Orbit anywhere" phase 5, for real: the voice's act_in_window / confirm_window_action, through
// the real focus helper and UI Automation helper, on test windows these tests start themselves
// (test/e2e/FakeApp.cs: a classic Win32 window and a WPF one). Every act must land (read back from
// the app's own state) without the window ever becoming active and without the foreground changing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConfig } from '../src/config.js';
import { focus, setUiaHost, startFocusTracking } from '../src/platform/index.js';
import { createUiaHost } from '../src/platform/win/uia.js';
import { createToolRunner } from '../src/tools.js';
import { canRunApps, startFakeApp } from './e2e/fake-app.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';
import { realDesktopSkip } from './e2e/real-desktop.mjs';

if (process.platform === 'win32' && !realDesktopSkip) await lockDesktop(); // one real-desktop test file at a time

const skip = realDesktopSkip || (!canRunApps() && 'needs Windows with .NET Framework 4 (csc.exe)');
initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-act-win-')) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const kind of ['winforms', 'wpf']) {
  test(`${kind}: type, tick, pick and press without focus; Send waits for a yes`, { skip, timeout: 180_000 }, async () => {
    const title = `ORBITACT${kind.toUpperCase()}${process.pid}`;
    const app = await startFakeApp(kind, title);
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
    const act = (args) => r.run('act_in_window', JSON.stringify({ window: title, ...args }));
    try {
      for (let i = 0; i < 40 && !focus.current; i++) await sleep(50);
      await say(`in ${title} type hello there into the message box`);
      let res = await act({ control: 'Message', action: 'set_text', text: 'hello there' });
      assert.equal(res.done, true, JSON.stringify(res));
      assert.equal(res.verified, true);
      await say('add second try to the notes');
      res = await act({ control: 'Notes', action: 'type', text: 'second try' });
      assert.equal(res.done, true, JSON.stringify(res));
      await say('tick agree and pick the help channel');
      assert.equal((await act({ control: 'Agree', action: 'toggle' })).done, true);
      assert.equal((await act({ control: 'help', action: 'select' })).done, true);
      await say('press save');
      assert.equal((await act({ control: 'Save', action: 'press' })).done, true, 'Save stays in the app');
      await sleep(400);
      const st = await app.state();
      assert.equal(st.Message, 'hello there');
      assert.match(st.Notes.replace(/\r/g, ''), /second try/);
      assert.equal(st.Agree, true);
      assert.equal(st.Channel, 'help');
      assert.ok(app.events.some((e) => e.event === 'click' && e.name === 'Save'), 'Save was pressed');
      // Send is outward: held until a clear yes.
      await say('press send');
      const held = await act({ control: 'Send', action: 'press' });
      assert.equal(held.held, true, JSON.stringify(held));
      await sleep(300);
      assert.ok(!app.events.some((e) => e.event === 'click' && e.name === 'Send'), 'not pressed yet');
      await say('yes');
      const done = JSON.parse(JSON.stringify(await r.run('confirm_window_action', JSON.stringify({ key: held.confirm_key }))));
      assert.equal(done.done, true, JSON.stringify(done));
      assert.ok(await app.waitFor((e) => e.event === 'click' && e.name === 'Send', 3000), 'Send was pressed after the yes');
      // Never a password field.
      await say('type hello there into secret');
      assert.ok((await act({ control: 'Secret', action: 'set_text', text: 'hello there' })).error);
      assert.equal(await app.state().then((s) => s.active), false, 'the window never became active');
      assert.ok(app.events.every((e) => e.event !== 'activated'), 'no activation, ever');
      // (The user may be using the PC meanwhile, so the foreground may change: just never to ours.)
      assert.ok(focus.recent.every((w) => w.hwnd !== app.hwnd) && focus.current?.hwnd !== app.hwnd, 'our window never came to the front');
    } finally {
      tracker?.stop();
      host.stop();
      setUiaHost(null);
      await app.close();
    }
  });
}
