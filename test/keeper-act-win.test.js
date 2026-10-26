// The whole "apps under Orbit" flow through Orbit's own tools, for real (Windows), on our own
// Discord-like test app (test/e2e/slate-input). Never another app.
//   - Typing into its Slate box (started the normal way): nothing written, and Orbit asks to
//     restart it under Orbit (no borrow-focus question).
//   - "No": nothing happens. A clear yes: the app is restarted under Orbit's keeper, the text typed
//     through the pipe, the app remembered as okayed.
//   - Enter (sends in a chat box): held like Send until a yes; then the message is sent.
//   - An app okayed before (in anywhereUnderOrbit): still asked out loud, every time ("Orbit must ask
//     me out loud every time before restarting any app under its keeper, even ones I approved
//     before"); "no" does nothing; on a yes the retry waits past the app's splash window ("<title>
//     Updater", like Discord's) for its real main window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, initConfig, updateSettings } from '../src/config.js';
import { focus, setUiaHost, startFocusTracking } from '../src/platform/index.js';
import { createUiaHost } from '../src/platform/win/uia.js';
import { profileStore } from '../src/anywhere/index.js';
import { keepers, pageSession, setKeeperLauncher } from '../src/anywhere/keeper.js';
import { createToolRunner } from '../src/tools.js';
import { startSlateApp } from './e2e/slate-input.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';
import { realDesktopSkip } from './e2e/real-desktop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = realDesktopSkip || (process.platform !== 'win32' && 'needs Windows');
if (!skip) await lockDesktop(); // one real-desktop test file at a time
initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-keeper-act-')) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page's DOM, through the pipe (never running code in it). */
async function dom(win, selector) {
  const s = await pageSession(win);
  try {
    const doc = await s.call('DOM.getDocument', { depth: -1 });
    const r = await s.call('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector });
    const html = await Promise.all((r.nodeIds || []).map(async (id) => (await s.call('DOM.getOuterHTML', { nodeId: id })).outerHTML));
    return html;
  } finally {
    s.close();
  }
}

test('a rich editor: asked to restart the app under Orbit; on a yes, typed through the pipe, and Enter asked like Send', { skip, timeout: 180_000 }, async () => {
  setKeeperLauncher({ execPath: process.execPath, preArgs: [path.join(ROOT, 'src/anywhere/keeper-node.mjs')] });
  const app = await startSlateApp(`ORBIT-KEEPER-ACT-${process.pid}`, { x: 70, y: 70 });
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
  const act = (args) => r.run('act_in_window', JSON.stringify({ window: app.title, ...args }));
  let appPid = app.pid;
  try {
    for (let i = 0; i < 40 && !focus.current; i++) await sleep(50);
    await sleep(800); // Chromium builds its accessibility tree on the first question
    await say(`in ${app.title} type hello from orbit into the message box`);
    const res = await act({ control: 'Message #general', action: 'set_text', text: 'hello from orbit' });
    assert.equal(res.held, true, JSON.stringify(res));
    assert.match(res.ask, /Restart .+ under Orbit/);
    assert.match(res.ask, /isn't under Orbit right now/);
    assert.doesNotMatch(res.ask, /borrow/i);
    await sleep(400);
    assert.equal(app.state()?.model, '', 'nothing in Slate');
    assert.doesNotMatch(String(app.state()?.dom), /hello from orbit/, 'and no stray text in the page either (only its placeholder)');
    // A "no" does nothing.
    await say('no not now');
    const no = await r.run('confirm_window_action', JSON.stringify({ key: res.confirm_key }));
    assert.equal(no.ok, false);
    assert.equal(keepers().length, 0, 'not restarted');
    // Asked again, then a clear yes: restarted under Orbit and typed through the pipe.
    await say(`in ${app.title} type hello from orbit into the message box`);
    const res2 = await act({ control: 'Message #general', action: 'set_text', text: 'hello from orbit' });
    assert.equal(res2.held, true, JSON.stringify(res2));
    await say('yes do it');
    const yes = await r.run('confirm_window_action', JSON.stringify({ key: res2.confirm_key }));
    assert.equal(yes.done, true, JSON.stringify(yes));
    const k = keepers()[0];
    assert.ok(k, 'the app is under a keeper');
    appPid = k.appPid;
    assert.deepEqual(getSetting('anywhereUnderOrbit'), ['electron.exe'], 'okayed for next time');
    const win = { pid: k.appPid, title: app.title };
    const editor = (await dom(win, '[data-slate-editor="true"]'))[0] || '';
    assert.match(editor, /hello from orbit/, 'Slate holds the text');
    // Enter in the chat box: held like Send.
    await say('now send it');
    const send = await act({ control: 'Message #general', action: 'enter' });
    assert.equal(send.held, true, JSON.stringify(send));
    assert.match(send.ask, /Enter/);
    assert.equal((await dom(win, '#messages li.sent')).length, 0, 'not sent before the yes');
    await say('yep');
    const sent = await r.run('confirm_window_action', JSON.stringify({ key: send.confirm_key }));
    assert.equal(sent.done, true, JSON.stringify(sent));
    await sleep(400);
    const msgs = await dom(win, '#messages li.sent');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /hello from orbit/);
  } finally {
    tracker?.stop();
    host.stop();
    setUiaHost(null);
    // Every app this test started goes, on a failure too: its own and any its keeper restarted.
    for (const pid of [appPid, app.pid, ...keepers().map((k) => k.appPid)]) {
      try {
        process.kill(pid);
      } catch {}
    }
    await app.close().catch(() => {});
    for (let i = 0; i < 50 && keepers().length; i++) await sleep(100);
    updateSettings({ anywhereUnderOrbit: [] }); // (no keeper left, so nothing is restarted)
    profileStore().remove('win-electron');
  }
});

test('approved before: still asked out loud every time; "no" does nothing; a yes restarts it and the retry waits past its splash for the main window', { skip, timeout: 240_000 }, async () => {
  setKeeperLauncher({ execPath: process.execPath, preArgs: [path.join(ROOT, 'src/anywhere/keeper-node.mjs')] });
  updateSettings({ anywhereUnderOrbit: ['electron.exe'] }); // okayed before
  const SPLASH_MS = 3500;
  const app = await startSlateApp(`ORBIT-KEEPER-APPROVED-${process.pid}`, { x: 90, y: 90, args: [`--splash=${SPLASH_MS}`] });
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
  const act = (args) => r.run('act_in_window', JSON.stringify({ window: app.title, ...args }));
  let appPid = app.pid;
  try {
    for (let i = 0; i < 40 && !focus.current; i++) await sleep(50);
    await sleep(800);
    await say(`in ${app.title} type splash test into the message box`);
    const res = await act({ control: 'Message #general', action: 'set_text', text: 'splash test' });
    assert.equal(res.held, true, `asked, though the app was okayed before: ${JSON.stringify(res)}`);
    assert.match(res.ask, /isn't under Orbit right now\. Restart .+ under Orbit so I can type there\? It'll close and reopen for a few seconds\./);
    await sleep(300);
    assert.equal(keepers().length, 0, 'not restarted on its own');
    // "No": nothing at all happens.
    await say('no');
    const no = await r.run('confirm_window_action', JSON.stringify({ key: res.confirm_key }));
    assert.equal(no.ok, false);
    await sleep(500);
    assert.equal(keepers().length, 0, 'still not restarted');
    assert.doesNotThrow(() => process.kill(app.pid, 0), 'the app was never closed');
    // Asked again (every time), then a clear yes: restarted, and the act waits past the splash.
    await say(`in ${app.title} type splash test into the message box`);
    const res2 = await act({ control: 'Message #general', action: 'set_text', text: 'splash test' });
    assert.equal(res2.held, true, JSON.stringify(res2));
    await say('yes go ahead');
    const t0 = Date.now();
    const yes = await r.run('confirm_window_action', JSON.stringify({ key: res2.confirm_key }));
    const took = Date.now() - t0;
    assert.equal(yes.done, true, JSON.stringify(yes));
    assert.equal(yes.restarted, true);
    assert.ok(took >= SPLASH_MS, `it waited out the splash (${took} ms)`);
    const k = keepers()[0];
    assert.ok(k, 'under a keeper');
    appPid = k.appPid;
    const editor = (await dom({ pid: k.appPid, title: app.title }, '[data-slate-editor="true"]'))[0] || '';
    assert.match(editor, /splash test/, 'typed into the main window, not the splash');
  } finally {
    tracker?.stop();
    host.stop();
    setUiaHost(null);
    // Every app this test started goes, on a failure too: its own and any its keeper restarted.
    for (const pid of [appPid, app.pid, ...keepers().map((k) => k.appPid)]) {
      try {
        process.kill(pid);
      } catch {}
    }
    await app.close().catch(() => {});
    for (let i = 0; i < 50 && keepers().length; i++) await sleep(100);
    updateSettings({ anywhereUnderOrbit: [] });
    profileStore().remove('win-electron');
  }
});
