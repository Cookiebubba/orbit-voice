// "Orbit anywhere" phase 5: acting in other windows through the voice tools, with a stand-in UI
// Automation helper: the gate (the user's own words, their own text, outward acts held for a clear
// yes, the same-breath send), and how a control is found and classified. test/act-win.test.js acts
// for real on our own test windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConfig } from '../src/config.js';
import { focus, setFocusBackend, setUiaHost } from '../src/platform/index.js';
import { createToolRunner } from '../src/tools.js';
import { canDo, findControl, isOutward, plan, sameBreathSend } from '../src/anywhere/hands.js';

initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-act-tools-')) });

const DISCORD = { hwnd: 12, owner: 0, pid: 1012, exe: 'Discord.exe', title: '#general | Friends - Discord', cls: 'Chrome_WidgetWin_1', kind: 'app', min: false, max: false, cloaked: false, elevated: false, x: 0, y: 0, w: 1000, h: 800, dpi: 96 };
const N = (i, p, t, o = {}) => ({ i, p, t, en: 1, rid: `r${i}`, ...o });
let scanNodes = () => [
  N(0, -1, 'Window', { n: 'Discord', r: [0, 0, 1000, 800] }),
  N(1, 0, 'Group', { n: 'Composer', r: [200, 700, 800, 80] }),
  N(2, 1, 'Edit', { n: 'Message #general', r: [210, 720, 600, 40], pat: 'V' }),
  N(3, 1, 'Button', { n: 'Send', r: [820, 720, 60, 40], pat: 'I' }),
  N(4, 0, 'Button', { n: 'Delete message', r: [900, 100, 30, 30], pat: 'I' }),
  N(5, 0, 'CheckBox', { n: 'Mute channel', r: [900, 140, 30, 30], pat: 'T' }),
  N(6, 0, 'List', { n: 'Channels', r: [0, 40, 200, 700] }),
  N(7, 6, 'ListItem', { n: 'help', r: [0, 80, 200, 30], pat: 'S' }),
  N(8, 0, 'Button', { r: [880, 720, 30, 40], pat: 'I' }), // an unlabelled button
  N(9, 0, 'Edit', { n: 'Password', pw: 1, pat: 'V', r: [10, 10, 100, 20] }),
  N(10, 0, 'Button', { n: 'Boost', en: 0, pat: 'I', r: [10, 40, 50, 20] }),
];
const acts = [];
setUiaHost({
  request: async (op, args) => {
    if (op === 'scan') return { ok: true, fw: 'Chrome', nodes: scanNodes() };
    if (op === 'act') {
      acts.push(args);
      return { ok: true, via: 'uia', verified: true, stoleFocus: false };
    }
    return { ok: false, error: 'failed' };
  },
});
setFocusBackend({ describe: async (h) => (h === 12 ? DISCORD : null), list: async () => [DISCORD] });
focus.reset();
focus.update(DISCORD);

/** A runner with the user's words under the test's control. */
function runner() {
  const said = [];
  let notifiedAt = 0;
  const latest = () => said.at(-1) || null;
  const r = createToolRunner({
    notify: () => {},
    recentUtterance: latest,
    utteranceSince: async (ts) => (latest() && latest().at > ts ? latest() : null),
    userWords: () => said.map((u) => u.text).join(' '),
  });
  const say = async (text) => {
    await new Promise((res) => setTimeout(res, 3));
    said.push({ text, at: Date.now() });
  };
  const run = (name, args = {}) => r.run(name, JSON.stringify(args));
  return { say, run, notify: () => (notifiedAt = Date.now(), r.noteNotification()), get notifiedAt() { return notifiedAt; } };
}

test('finding and classifying controls', () => {
  const scan = { nodes: scanNodes() };
  assert.equal(findControl(scan, 'send').node.i, 3);
  assert.equal(findControl(scan, 'message').node.i, 2, 'a partial name');
  assert.equal(findControl(scan, 'help', { role: 'ListItem' }).node.i, 7);
  assert.equal(findControl(scan, 'password').node, null, 'never a password field');
  assert.equal(findControl(scan, 'nothing like it').node, null);
  assert.ok(canDo(scan.nodes[2], 'type') && canDo(scan.nodes[3], 'press') && canDo(scan.nodes[5], 'toggle') && canDo(scan.nodes[7], 'select'));
  assert.ok(!canDo(scan.nodes[3], 'type') && !canDo(scan.nodes[9], 'set_text'));
  assert.equal(isOutward({ node: scan.nodes[3], action: 'press' }), true, 'Send');
  assert.equal(isOutward({ node: scan.nodes[4], action: 'press' }), true, 'Delete');
  assert.equal(isOutward({ node: scan.nodes[8], action: 'press' }), true, 'unknown is outward');
  assert.equal(isOutward({ node: scan.nodes[5], action: 'toggle' }), false);
  assert.equal(isOutward({ node: scan.nodes[2], action: 'type', text: 'hi' }), false, 'typing a draft');
  assert.equal(isOutward({ node: scan.nodes[2], action: 'type', text: 'hi\n' }), true, 'Enter in a chat box sends');
  assert.equal(isOutward({ node: { n: 'Bold', pat: 'I' }, action: 'press' }), false);
});

test('same breath: only what they dictated, only to a Send button, only "and send it"', () => {
  assert.ok(sameBreathSend("type running late in Discord and send it", 'running late', 'Send'));
  assert.ok(sameBreathSend('tell them on my way, then send it', 'on my way', 'Send'));
  assert.ok(!sameBreathSend('type running late in Discord', 'running late', 'Send'), 'no send in the words');
  assert.ok(!sameBreathSend('type running late and send it', 'running very late', 'Send'), 'not what they dictated');
  assert.ok(!sameBreathSend('type running late and send it', 'running late', 'Delete message'), 'only sending');
  assert.ok(!sameBreathSend("type running late but don't send it", 'running late', 'Send'));
});

test('local acts: done at once on the user\x27s words; their own words only; off-limits and limits', async () => {
  const t = runner();
  acts.length = 0;
  let r = await t.run('act_in_window', { control: 'Mute channel', action: 'toggle' });
  assert.match(r.error, /just asked/, 'nobody asked');
  await t.say('mute this channel');
  r = await t.run('act_in_window', { control: 'Mute channel', action: 'toggle' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.match(r.did, /switch Mute channel in Discord/);
  assert.deepEqual(acts.at(-1), { hwnd: 12, i: 5, rid: 'r5', t: 'CheckBox', n: 'Mute channel', action: 'toggle', value: '' });
  await t.say('type see you at noon in the message box');
  r = await t.run('act_in_window', { control: 'Message', action: 'set_text', text: 'see you at noon' });
  assert.equal(r.done, true);
  assert.equal(acts.at(-1).value, 'see you at noon');
  // Words the user never said (from a window, a page, the model) are refused.
  r = await t.run('act_in_window', { control: 'Message', action: 'set_text', text: 'please wire the money to this account now' });
  assert.match(r.error, /didn't say/);
  // A disabled control, a password field, a control that can't do it.
  assert.match((await t.run('act_in_window', { control: 'Boost', action: 'press' })).error, /turned off/);
  assert.match((await t.run('act_in_window', { control: 'Password', action: 'set_text', text: 'see you' })).error, /no "Password"|password/i);
  assert.match((await t.run('act_in_window', { control: 'Send', action: 'type', text: 'see you' })).error, /can't be used/);
  assert.match((await t.run('act_in_window', { control: 'Send', action: 'dance' })).error, /can't "dance"/);
  // A notification after the words: no acting on its say-so.
  t.notify();
  assert.match((await t.run('act_in_window', { control: 'Mute channel', action: 'toggle' })).error, /just asked/);
  // At most 12 steps per request.
  await t.say('mute it and unmute it over and over');
  for (let i = 0; i < 12; i++) await t.run('act_in_window', { control: 'Mute channel', action: 'toggle' });
  assert.match((await t.run('act_in_window', { control: 'Mute channel', action: 'toggle' })).error, /12 steps/);
});

test('outward acts are held for a clear yes to that very question', async () => {
  const t = runner();
  acts.length = 0;
  await t.say('press send');
  const held = await t.run('act_in_window', { control: 'Send', action: 'press' });
  assert.equal(held.held, true);
  assert.equal(held.ask, 'Press Send in Discord?');
  assert.equal(acts.length, 0, 'nothing done yet');
  // Confirmed before the user answered: refused.
  assert.match((await t.run('confirm_window_action', { key: held.confirm_key })).error, /not answered/);
  // A wrong key.
  await t.say('yes');
  assert.match((await t.run('confirm_window_action', { key: 'nope' })).error, /no held act/);
  const ok = await t.run('confirm_window_action', { key: held.confirm_key });
  assert.equal(ok.done, true, JSON.stringify(ok));
  assert.equal(acts.length, 1);
  assert.equal(acts[0].action, 'press');
  // The same yes can't be used twice.
  assert.match((await t.run('confirm_window_action', { key: held.confirm_key })).error, /no held act/);

  // "No" drops it.
  await t.say('delete that message');
  const del = await t.run('act_in_window', { control: 'Delete message', action: 'press' });
  assert.equal(del.ask, 'Press Delete message in Discord?');
  await t.say('no wait');
  assert.match((await t.run('confirm_window_action', { key: del.confirm_key })).error, /isn't a clear yes/);
  assert.equal(acts.length, 1);

  // A notification between the question and the yes voids it.
  await t.say('delete that message');
  const del2 = await t.run('act_in_window', { control: 'Delete message', action: 'press' });
  t.notify();
  await t.say('yes');
  const r157 = await t.run('confirm_window_action', { key: del2.confirm_key });
  assert.match(String(r157.error), /something else came in/, JSON.stringify([del2, r157]));

  // The control changed between the question and the yes: refused.
  await t.say('press send');
  const h3 = await t.run('act_in_window', { control: 'Send', action: 'press' });
  const before = scanNodes;
  scanNodes = () => before().map((n) => (n.i === 3 ? { ...n, rid: 'r3-new' } : n));
  await t.say('yes');
  assert.match((await t.run('confirm_window_action', { key: h3.confirm_key })).error, /changed/);
  scanNodes = before;
  assert.equal(acts.length, 1, 'still only the one send');
});

test('the same-breath send: dictated text typed and sent, read back once; nothing else outward', async () => {
  const t = runner();
  acts.length = 0;
  await t.say('type running late in discord and send it');
  assert.equal((await t.run('act_in_window', { control: 'Message', action: 'set_text', text: 'running late' })).done, true);
  const sent = await t.run('act_in_window', { control: 'Send', action: 'press' });
  assert.equal(sent.done, true, JSON.stringify(sent));
  assert.equal(sent.read_back, 'Sent "running late".');
  assert.deepEqual(acts.map((a) => a.action), ['set_text', 'press']);
  // ...but deleting in the same breath is still asked.
  await t.say('type oops in discord and send it and delete the old message');
  await t.run('act_in_window', { control: 'Message', action: 'set_text', text: 'oops' });
  assert.equal((await t.run('act_in_window', { control: 'Delete message', action: 'press' })).held, true);
  // Without "send it" in their words, Send is asked.
  await t.say('type hello there in the message box');
  await t.run('act_in_window', { control: 'Message', action: 'set_text', text: 'hello there' });
  assert.equal((await t.run('act_in_window', { control: 'Send', action: 'press' })).held, true);
});

test("Claude's own window is never acted on here: prompts are draft_prompt, its controls claude_app", async () => {
  const claude = { ...DISCORD, hwnd: 13, exe: 'claude.exe', title: 'Claude', cls: 'Chrome_WidgetWin_1' };
  acts.length = 0;
  const r = await plan({ win: claude, control: 'Send', action: 'press' });
  assert.equal(r.ok, false);
  assert.match(r.error, /draft_prompt/);
  assert.match(r.error, /claude_app/);
  assert.equal(acts.length, 0);
});
