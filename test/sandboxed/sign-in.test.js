// Grok's open_claude_sign_in tool: only after the second brain found Claude Code signed out,
// Grok offered, and the user said yes afterwards. Runs with test/fuzz/register.mjs (fakes only).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-signin-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };

const { initConfig, updateSettings } = await import('../../src/config.js');
const { createToolRunner, toolDefs } = await import('../../src/tools.js');
initConfig({ dir: path.join(root, 'cfg') });
updateSettings({ brainEnabled: true, brainConnection: 'claude-code' });

function runner({ brainResult }) {
  let utterance = null;
  const opened = [];
  const r = createToolRunner({
    notify: () => {},
    recentUtterance: () => utterance,
    brain: async () => brainResult,
    signIn: async (p) => {
      opened.push(p);
      return { ok: true };
    },
  });
  const say = async (text) => {
    await new Promise((res) => setTimeout(res, 3));
    utterance = { text, at: Date.now() };
  };
  return { r, say, opened };
}
const expired = { ok: false, error: 'Claude Code\x27s sign-in has expired.', needsSignIn: true };

test('the tool is offered only for the Claude-login connection', () => {
  assert.ok(toolDefs({ brainEnabled: true, brainConnection: 'claude-code' }).some((t) => t.name === 'open_claude_sign_in'));
  assert.ok(!toolDefs({ brainEnabled: true, brainConnection: 'api-key' }).some((t) => t.name === 'open_claude_sign_in'));
  assert.ok(!toolDefs({ brainEnabled: false }).some((t) => t.name === 'open_claude_sign_in'));
});

test('a signed-out run makes Grok offer; only a yes after the offer opens it, once per yes', async () => {
  const { r, say, opened } = runner({ brainResult: expired });
  await say('yes open it');
  assert.equal((await r.run('open_claude_sign_in', '{}')).ok, false, 'no sign-in problem yet: nothing to open');

  await say('why does the hotkey stop working');
  const res = await r.run('ask_second_brain', JSON.stringify({ question: 'why does the hotkey stop working?' }));
  assert.equal(res.sign_in_needed, true);
  assert.match(res.next_step, /should open the sign-in/);

  assert.equal((await r.run('open_claude_sign_in', '{}')).ok, false, 'the user hasn\x27t answered the offer yet');
  await say('no, not now');
  assert.equal((await r.run('open_claude_sign_in', '{}')).ok, false);
  await say('yes please');
  const done = await r.run('open_claude_sign_in', '{}');
  assert.equal(done.ok, true);
  assert.match(done.next_step, /sign-in window opened/);
  assert.equal((await r.run('open_claude_sign_in', '{}')).ok, false, 'one window per yes');
  assert.equal(opened.length, 1);
});

test('other failures don\x27t offer a sign-in', async () => {
  const { r, say, opened } = runner({ brainResult: { ok: false, error: 'Claude is rate-limited.' } });
  await say('explain the watcher');
  const res = await r.run('ask_second_brain', JSON.stringify({ question: 'explain the watcher' }));
  assert.equal(res.sign_in_needed, undefined);
  await say('yes');
  assert.equal((await r.run('open_claude_sign_in', '{}')).ok, false);
  assert.equal(opened.length, 0);
});
