// Drafting without listening: the draft is typed straight into Claude's prompt box, and a change
// retypes the whole box (cleared, then the new draft), never adding to the old text. Against the
// end-to-end fake Claude window (test/e2e/fake-desktop.mjs, the same rules as desktop.ps1): nothing
// touches the real Claude app. Synthetic words only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import fake from './e2e/fake-desktop.mjs';
import { setDesktopDriver } from '../src/desktop.js';
import { initConfig } from '../src/config.js';
import { createToolRunner, isEditOf } from '../src/tools.js';
import { core } from '../src/agent.js';

const mem = (v = '') => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-redraft-')), secrets: mem(), brainSecrets: mem() });
globalThis.__orbitE2E = { desktop: { windows: [{ hwnd: 101, kind: 'main', title: 'Login fix', newPage: null, promptText: '', min: false }], sidebar: ['Login fix'], folders: ['app'], calls: [], sends: [], chaos: 0, rng: () => 0, newCount: 0 } };
const desk = globalThis.__orbitE2E.desktop;
setDesktopDriver(fake);
const box = () => desk.windows[0].promptText;

function runner() {
  const said = [];
  let utterance = null;
  const tools = createToolRunner({
    notify: () => {},
    utteranceSince: async (since) => (utterance && utterance.at > since ? utterance : null),
    recentUtterance: () => utterance,
    userWords: () => said.join(' '),
  });
  const say = async (text) => {
    await new Promise((r) => setTimeout(r, 3));
    utterance = { text, at: Date.now() };
    said.push(text);
  };
  const draft = async (text) => JSON.parse(JSON.stringify(await tools.run('draft_prompt', JSON.stringify({ text }))));
  return { tools, say, draft };
}

test('a draft goes straight into the box; the model is told one short line, not to read it out', async () => {
  desk.windows[0].promptText = '';
  const { say, draft } = runner();
  await say('tell claude to fix the login redirect and add a test');
  const r = await draft('fix the login redirect and add a test');
  assert.equal(r.in_prompt_box, true);
  assert.equal(box(), 'fix the login redirect and add a test');
  assert.match(r.next_step, /one short line, like "It\x27s in the box\. Send it\?"/);
  assert.match(r.next_step, /Don\x27t read it out/);
  assert.match(core(), /Don\x27t read it back, and don\x27t ask before typing it in/);
});

test('a change retypes the whole box: the new draft replaces the old one, never added to it', async () => {
  desk.windows[0].promptText = '';
  const { say, draft } = runner();
  await say('tell claude to fix the login redirect and add a test for it');
  await draft('fix the login redirect and add a test for it');
  assert.equal(box(), 'fix the login redirect and add a test for it');
  await say('make it shorter, just fix the login redirect');
  const r = await draft('fix the login redirect');
  assert.equal(r.in_prompt_box, true);
  assert.equal(r.replaced_earlier_draft, true);
  assert.equal(box(), 'fix the login redirect', 'only the new draft is in the box');
  await say('no, say fix the logout redirect instead');
  await draft('fix the logout redirect');
  assert.equal(box(), 'fix the logout redirect');
  assert.ok(!box().includes('login'), 'nothing of the old draft left');
  // Each retype told the fake window which text it may replace (the old draft), and nothing was sent.
  assert.equal(desk.sends.length, 0);
});

test('a change after the user touched up the draft in the box still retypes it; their own text is never touched', async () => {
  desk.windows[0].promptText = '';
  const { say, draft } = runner();
  await say('tell claude to rename the config loader and update the docs');
  await draft('rename the config loader and update the docs');
  desk.windows[0].promptText = 'rename the config loader and update the docs please'; // the user added a word
  await say('add and the readme too');
  const r = await draft('rename the config loader and update the docs and the readme too');
  assert.equal(r.in_prompt_box, true);
  assert.equal(box(), 'rename the config loader and update the docs and the readme too');
  // Something else entirely in the box (the user's own words): the draft isn't typed over it.
  desk.windows[0].promptText = 'my own notes about something unrelated';
  await say('tell claude to run the tests');
  const r2 = await draft('run the tests');
  assert.equal(r2.in_prompt_box, false);
  assert.equal(box(), 'my own notes about something unrelated');
  desk.windows[0].promptText = '';
});

test('touched up, or something else? (the 60% rule)', () => {
  assert.equal(isEditOf('fix the login redirect please', 'fix the login redirect'), true);
  assert.equal(isEditOf('fix the login redirect', 'fix the login redirect and add a test'), false);
  assert.equal(isEditOf('fix the logout redirect', 'fix the login redirect'), true);
  assert.equal(isEditOf('my own notes', 'fix the login redirect'), false);
  assert.equal(isEditOf('', 'x'), false);
});
