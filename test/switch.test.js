// "Orbit anywhere" phase 6: switch_to_window's gate (the user's own switch words, or a yes to
// Orbit's offer; once per request) with a stand-in focus helper. test/switch-win.test.js switches
// to our own test window for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConfig } from '../src/config.js';
import { focus, setFocusBackend } from '../src/platform/index.js';
import { asksToSwitch, markIntentional, switchIsIntentional, switchOutcome } from '../src/anywhere/switching.js';
import { createSwitchHandler, offerSwitch } from '../src/anywhere/switch-tool.js';
import { isClearYes } from '../src/tools.js';

initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-switch-')) });
const W = (hwnd, exe, title) => ({ hwnd, owner: 0, pid: hwnd + 1, exe, title, cls: 'X', kind: 'app', min: false, max: false, cloaked: false, elevated: false, x: 0, y: 0, w: 800, h: 600, dpi: 96 });
const DISCORD = W(12, 'Discord.exe', '#general - Discord');
const PS = W(13, 'Photoshop.exe', 'cat.psd - Photoshop');
const switched = [];
let answer = { switched: true, how: 'foreground' };
setFocusBackend({ describe: async (h) => [DISCORD, PS].find((w) => w.hwnd === h) || null, list: async () => [DISCORD, PS], switchTo: async (h) => (switched.push(h), answer) });
focus.reset();

test('switch words', () => {
  for (const s of ['switch to Discord', 'bring up Photoshop', 'take me there', 'go to discord', 'open photoshop', 'show me', 'jump over to discord']) assert.ok(asksToSwitch(s), s);
  for (const s of ["don't switch", 'do not open photoshop', 'what is in discord', 'yes', 'never take me there']) assert.ok(!asksToSwitch(s), s);
});

test('only on the user\x27s switch words, once per request; never on a notification', async () => {
  let spoke = null;
  const h = createSwitchHandler({ recentUtterance: () => spoke, isClearYes });
  switched.length = 0;
  assert.match((await h.switch_to_window({ window: 'discord' })).error, /just asked/);
  spoke = { text: 'what is in discord', at: Date.now() };
  assert.match((await h.switch_to_window({ window: 'discord' })).error, /just asked/, 'a question is not a switch');
  spoke = { text: 'switch to discord', at: Date.now() };
  const r = await h.switch_to_window({ window: 'discord' });
  assert.equal(r.switched, true);
  assert.deepEqual(switched, [12]);
  assert.ok(switchIsIntentional(12), 'the focus guard is told');
  assert.match((await h.switch_to_window({ window: 'photoshop' })).error, /each request switches once/);
  spoke = { text: "don't switch to photoshop", at: Date.now() + 1 };
  assert.match((await h.switch_to_window({ window: 'photoshop' })).error, /just asked/);
  // Old words (over two minutes) don't count.
  spoke = { text: 'bring up photoshop', at: Date.now() - 3 * 60_000 };
  assert.match((await h.switch_to_window({ window: 'photoshop' })).error, /just asked/);
  assert.deepEqual(switched, [12]);
});

test('"take me there" after Orbit\x27s offer; a yes to it; no target without one', async () => {
  let spoke = { text: 'take me there', at: Date.now() };
  const h = createSwitchHandler({ recentUtterance: () => spoke, isClearYes });
  switched.length = 0;
  assert.match((await h.switch_to_window({})).error, /Which window/);
  offerSwitch(PS);
  spoke = { text: 'yes', at: Date.now() + 5 };
  assert.equal((await h.switch_to_window({})).switched, true);
  assert.deepEqual(switched, [13]);
  // The offer is used up; a later "yes" switches nothing.
  spoke = { text: 'yes', at: Date.now() + 10 };
  assert.match((await h.switch_to_window({})).error, /just asked/);
  // A "no" to the offer.
  offerSwitch(DISCORD);
  spoke = { text: 'no thanks', at: Date.now() + 20 };
  assert.match((await h.switch_to_window({})).error, /just asked/);
});

test('outcomes: refused by Windows, flashing, gone', async () => {
  assert.deepEqual(switchOutcome({ switched: true, how: 'minrestore' }, 'Discord'), { ok: true, switched: true, how: 'minrestore' });
  assert.match(switchOutcome({ switched: false, how: 'flash' }, 'Discord').say, /flashing/);
  assert.match(switchOutcome({ error: 'no_window' }, 'Discord').error, /closed/);
  answer = { switched: false, how: 'flash' };
  const h = createSwitchHandler({ recentUtterance: () => ({ text: 'bring up discord', at: Date.now() }), isClearYes });
  const r = await h.switch_to_window({ window: 'discord' });
  assert.equal(r.flashing, true);
  answer = { switched: true, how: 'foreground' };
  markIntentional(0, 10, Date.now() - 100);
  assert.ok(!switchIsIntentional(5));
});
