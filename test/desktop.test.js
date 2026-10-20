// src/desktop.js with a stand-in driver (nothing reaches PowerShell or the real Claude window):
// the arguments each action passes, and the front-window hint the orb's tracker provides.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getDesktopInfo, listSidebarSessions, newSession, sendToDesktop, setDesktopDriver, setFrontWindowHint, switchSession } from '../src/desktop.js';

const calls = [];
setDesktopDriver({ run: async (mode, args) => (calls.push({ mode, args }), { ok: true, mode }) });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const arg = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test('each action passes its arguments, plus the window the orb is on', async () => {
  setFrontWindowHint(() => 4242);
  await getDesktopInfo();
  await listSidebarSessions();
  await switchSession('  My session  ');
  await newSession({ project: 'grok x claude' });
  await sendToDesktop('hello', { expectTitle: 'My session' });
  await sendToDesktop('hi', { expectNew: true, expectFolder: 'proj' });
  assert.deepEqual(calls.map((c) => c.mode), ['info', 'list', 'switch', 'new', 'send', 'send']);
  for (const c of calls) assert.equal(arg(c.args, '-FrontHwnd'), '4242', c.mode);
  assert.equal(arg(calls[2].args, '-TitleB64'), b64('My session'));
  assert.equal(arg(calls[3].args, '-ProjectB64'), b64('grok x claude'));
  assert.equal(arg(calls[4].args, '-ExpectTitleB64'), b64('My session'));
  assert.ok(!calls[4].args.includes('-ExpectNew'));
  assert.ok(calls[5].args.includes('-ExpectNew'));
  assert.equal(arg(calls[5].args, '-ExpectFolderB64'), b64('proj'));
});

test('no hint (the tracker is off, or it is not a usable handle) passes none', async () => {
  for (const h of [() => 0, () => -5, () => 1.5, () => 'abc', () => { throw new Error('x'); }, null]) {
    calls.length = 0;
    setFrontWindowHint(h);
    await getDesktopInfo();
    assert.equal(calls[0].args.includes('-FrontHwnd'), false, String(h));
  }
});

test('nothing reaches the window for empty or oversized input', async () => {
  calls.length = 0;
  assert.equal((await switchSession('   ')).error, 'empty_title');
  assert.equal((await sendToDesktop('  ')).error, 'empty_text');
  assert.equal((await sendToDesktop('x'.repeat(8001))).error, 'too_long');
  assert.equal(calls.length, 0);
});

test('a driver that throws is a failed action, not a crash', async () => {
  setDesktopDriver({ run: () => { throw new Error('boom'); } });
  const r = await getDesktopInfo();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'script_failed');
  setDesktopDriver(null);
});
