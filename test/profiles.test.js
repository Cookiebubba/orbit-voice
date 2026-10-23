// "Orbit anywhere" phase 2: app profiles from a scan (synthetic scans here; test/uia-win.test.js
// scans real test windows), the locator ladder and healing, and the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appKey, buildProfile, createProfileStore, ensureProfile, frameworkOf, heal, isOutwardLabel, locate, profileSummary, skeleton } from '../src/anywhere/profiles.js';

const WIN = { hwnd: 5, exe: 'Chatty.exe', title: 'Chatty - #general' };
// A chat app: a sidebar of channels, a message list, a message box with Send, a toolbar.
function chatScan({ sendAid = 'send-btn', sendName = 'Send', extra = [] } = {}) {
  const N = (i, p, t, o = {}) => ({ i, p, t, en: 1, ...o });
  return {
    ok: true,
    fw: 'Chrome',
    nodes: [
      N(0, -1, 'Window', { n: 'Chatty - #general (secret project)', c: 'Chrome_WidgetWin_1', r: [100, 100, 1000, 800] }),
      N(1, 0, 'ToolBar', { n: 'Top bar', r: [100, 100, 1000, 40] }),
      N(2, 1, 'Button', { n: 'Settings', a: 'settings', r: [1040, 105, 30, 30], pat: 'I' }),
      N(3, 0, 'Pane', { n: 'Channels', a: 'sidebar', r: [100, 140, 200, 760] }),
      N(4, 3, 'List', { n: 'Channel list', r: [100, 140, 200, 700] }),
      N(5, 4, 'ListItem', { n: 'general', r: [100, 140, 200, 30], pat: 'SI' }),
      N(6, 4, 'ListItem', { n: 'top-secret-plans', r: [100, 170, 200, 30], pat: 'SI' }),
      N(7, 0, 'Document', { n: 'Messages', r: [300, 140, 800, 600], pat: 'X' }),
      N(8, 7, 'Text', { n: 'Alice: the launch code is 1234', r: [310, 150, 600, 20] }),
      N(9, 0, 'Group', { n: 'Composer', a: 'composer', r: [300, 760, 800, 120] }),
      N(10, 9, 'Edit', { n: 'Message #general', a: 'msg-box', r: [310, 800, 600, 40], pat: 'VX', v: 'draft text never kept' }),
      N(11, 9, 'Button', { n: sendName, ...(sendAid ? { a: sendAid } : {}), r: [920, 800, 80, 40], pat: 'I' }),
      N(12, 9, 'Button', { r: [1010, 800, 40, 40], pat: 'I' }), // an unlabelled emoji button
      N(13, 9, 'Edit', { n: 'Password', pw: 1, r: [310, 850, 100, 20], pat: 'V', v: 'hunter2' }),
      N(14, 9, 'Button', { n: 'Delete message', r: [1060, 800, 30, 40], pat: 'I' }),
      ...extra,
    ],
  };
}

test('appKey, frameworkOf, outward labels', () => {
  assert.equal(appKey({ exe: 'Discord.exe' }), 'win-discord');
  assert.equal(appKey({ exe: 'My App (x86).EXE' }), 'win-my-app-x86-');
  assert.equal(appKey({}), '');
  assert.equal(frameworkOf({ fw: 'Chrome' }), 'chromium');
  assert.equal(frameworkOf({ fw: 'WPF' }), 'wpf');
  assert.equal(frameworkOf({ fw: 'WinForm' }), 'winforms');
  assert.equal(frameworkOf({ fw: 'Win32' }), 'win32');
  assert.equal(frameworkOf({ fw: '', nodes: [{ c: 'ApplicationFrameWindow' }] }), 'uwp');
  for (const w of ['Send', 'Send message', 'Post', 'Delete', 'Ban member', 'Kick', 'Buy now', 'Checkout', "Don't Save", 'Sign out', 'Empty Recycle Bin', 'Publish', 'Reply']) assert.ok(isOutwardLabel(w), w);
  for (const w of ['Settings', 'Bold', 'Search', 'Open', 'Sender name', 'Deleted items', 'Channels']) assert.ok(!isOutwardLabel(w), w);
});

test('the skeleton keeps labels of controls, never content or values', () => {
  const sk = skeleton(chatScan());
  const json = JSON.stringify(sk);
  for (const secret of ['launch code', 'top-secret-plans', 'secret project', 'draft text', 'hunter2']) assert.ok(!json.includes(secret), `no "${secret}"`);
  const send = sk.find((n) => n.i === 11);
  assert.equal(send.n, 'Send');
  assert.deepEqual(send.rel, [0.82, 0.875, 0.08, 0.05]);
  assert.equal(sk.find((n) => n.i === 13).password, true);
  assert.equal(sk.find((n) => n.i === 10).n, 'Message #general', 'an edit box\x27s label is a label');
});

test('a profile: controls with ladders, regions, outward controls, surfaces, quirks', () => {
  const p = buildProfile(WIN, chatScan(), { now: 1000 });
  assert.equal(p.key, 'win-chatty');
  assert.equal(p.platform, 'win');
  assert.equal(p.framework, 'chromium');
  assert.equal(p.scannedAt, 1000);
  const keys = p.controls.map((c) => c.key);
  assert.deepEqual(keys, ['settings', 'document 1', 'message #general', 'send', 'button 1', 'delete message'], "a document's name is content: it goes by type");
  assert.ok(!keys.some((k) => k.includes('password')), 'no password fields');
  assert.ok(!JSON.stringify(p).includes('top-secret'), 'list items are content: not kept');
  assert.deepEqual(p.outward.sort(), ['delete message', 'send']);
  const send = p.controls.find((c) => c.key === 'send');
  assert.deepEqual(send.locator.map((r) => r.by), ['aid', 'name', 'path', 'box']);
  assert.equal(send.region, 'input area');
  const names = p.regions.map((g) => g.name);
  for (const n of ['toolbar', 'sidebar', 'main area', 'input area']) assert.ok(names.includes(n), `${n} in ${names}`);
  assert.ok(p.quirks.includes('chromium-tree-wakes-late'));
  assert.ok(p.quirks.includes('rich-editor'), 'a text-only document in Chromium');
  assert.ok(p.surfaces.some((s) => s.kind === 'input'));
  const emoji = p.controls.find((c) => c.key === 'button 1');
  assert.deepEqual(emoji.locator.map((r) => r.by), ['path', 'anchor', 'box'], 'unlabelled: by landmark path, neighbour and position');
  const sum = profileSummary(p);
  assert.ok(sum.controls.includes('send (input area) [asks first]'));
});

test('locate walks the ladder; a moved control heals once, never an outward one', () => {
  const p = buildProfile(WIN, chatScan());
  const settings = p.controls.find((c) => c.key === 'settings');
  const send = p.controls.find((c) => c.key === 'send');
  // Same layout: found by automation id.
  let f = locate(settings, chatScan());
  assert.equal(f.node.i, 2);
  assert.equal(f.by, 'aid');
  assert.equal(f.healed, false);
  // The app updated and renamed the id: found by its name, healed.
  const moved = chatScan();
  moved.nodes[2] = { ...moved.nodes[2], a: 'gear' };
  f = locate(settings, moved);
  assert.equal(f.by, 'name');
  assert.equal(f.healed, true);
  assert.equal(heal(p, settings, moved, f), true);
  assert.equal(settings.locator[0].a, 'gear', 'the new id goes first next time');
  assert.equal(heal(p, settings, moved, f), false, 'once');
  // An outward control found only by a later rung is not healed (it's asked about instead).
  const sendMoved = chatScan({ sendAid: 'send-v2' });
  f = locate(send, sendMoved);
  assert.equal(f.healed, true);
  assert.equal(heal(p, send, sendMoved, f), false);
  assert.equal(send.locator[0].a, 'send-btn');
  // Gone entirely (no name, no id, nothing in its box of that type): null.
  const gone = chatScan();
  gone.nodes = gone.nodes.filter((n) => n.i !== 2);
  assert.equal(locate(settings, gone), null);
  // Two controls with the same name and no id: the name rung is ambiguous, the path decides.
  const twins = chatScan({ extra: [{ i: 15, p: 1, t: 'Button', n: 'Settings', r: [1000, 105, 30, 30], en: 1, pat: 'I' }] });
  twins.nodes[2] = { ...twins.nodes[2], a: undefined };
  const twinProfile = buildProfile(WIN, twins);
  const second = twinProfile.controls.find((c) => c.key === 'settings (button #15)');
  assert.ok(second);
  assert.equal(locate(second, twins).node.i, 15);
});

test('the store: saved per app, only valid keys, reused until it\x27s a month old', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-profiles-'));
  const store = createProfileStore({ dir });
  let scans = 0;
  const scan = async () => {
    scans++;
    return chatScan();
  };
  const p1 = await ensureProfile(WIN, { store, scan, now: 1000 });
  assert.equal(p1.key, 'win-chatty');
  assert.deepEqual(store.list(), ['win-chatty']);
  const again = await ensureProfile(WIN, { store, scan, now: 2000 });
  assert.equal(again.scannedAt, 1000, 'the saved one');
  assert.equal(scans, 1, 'no second scan');
  const later = await ensureProfile(WIN, { store, scan, now: 1000 + 31 * 24 * 3600_000 });
  assert.equal(scans, 2, 'rescanned after a month');
  assert.ok(later.scannedAt > 1000);
  // A failed scan keeps the old profile.
  const failed = await ensureProfile(WIN, { store, scan: async () => ({ ok: false, error: 'timeout' }), now: 1000 + 62 * 24 * 3600_000 });
  assert.equal(failed.scannedAt, later.scannedAt);
  assert.equal(store.save({ key: '../evil' }), false);
  assert.equal(store.get('../evil'), null);
  fs.writeFileSync(path.join(dir, 'win-bad.json'), '{not json');
  assert.equal(store.get('win-bad'), null);
  assert.equal(await ensureProfile({ exe: '' }, { store, scan }), null);
  store.remove('win-chatty');
  assert.equal(store.get('win-chatty'), null);
  assert.ok(!fs.readFileSync(path.join(dir, 'win-bad.json'), 'utf8').includes('launch code'));
});
