// change_orbit_setting: Orbit's own settings by voice ("use Opus"), on the user's own words only.
// Runs with test/fuzz/register.mjs: Claude's window is a fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-settings-tool-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };

const { initConfig, getSetting, updateSettings, onSettingsChange } = await import('../../src/config.js');
const { createToolRunner, asksSetting } = await import('../../src/tools.js');
initConfig({ dir: path.join(root, 'cfg') });

function runner() {
  let utterance = null;
  const r = createToolRunner({ notify: () => {}, recentUtterance: () => utterance, utteranceSince: async () => utterance });
  const say = async (text, at) => {
    await new Promise((res) => setTimeout(res, 3));
    utterance = { text, at: at ?? Date.now() };
  };
  return { r, say };
}
const set = (r, value, setting = 'voice_model') => r.run('change_orbit_setting', JSON.stringify({ setting, value }));

test('which words ask for a brain', () => {
  for (const [w, v] of [
    ['use Opus', 'opus'],
    ['switch to haiku', 'haiku'],
    ["let's try Sonnet for a bit", 'sonnet'],
    ['can you use fable', 'fable'],
    ['go back to hi ku', 'haiku'],
    ['I want Opus', 'opus'],
  ]) assert.equal(asksSetting(w, 'voice_model', v), true, w);
  for (const [w, v] of [
    ["don't use Opus", 'opus'],
    ['tell Claude to use opus for the subagent', 'opus'],
    ['use Opus', 'haiku'], // the words name another one
    ['opus', 'opus'], // no ask
    ['what is opus', 'opus'],
    ['use the best one', 'opus'],
    ['', 'opus'],
  ]) assert.equal(asksSetting(w, 'voice_model', v), false, w);
  assert.equal(asksSetting('use Opus', 'nonsense', 'opus'), false);
});

test('the user\x27s own words change the brain once; nothing else does', async () => {
  updateSettings({ claudeVoiceModel: 'haiku' });
  const seen = [];
  const off = onSettingsChange((changed, all) => changed.includes('claudeVoiceModel') && seen.push(all.claudeVoiceModel));
  const { r, say } = runner();
  assert.equal((await set(r, 'opus')).ok, false, 'nothing said yet');
  await say('use Opus');
  const ok = await set(r, 'opus');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(getSetting('claudeVoiceModel'), 'opus');
  assert.deepEqual(seen, ['opus'], 'the live call is told (session.update follows a settings change)');
  assert.equal((await set(r, 'sonnet')).ok, false, 'one request, one change (and these words named Opus)');
  await say('switch to sonnet', Date.now() - 61_000);
  assert.equal((await set(r, 'sonnet')).ok, false, 'a request over a minute old');
  await say('tell Claude to switch to sonnet');
  assert.equal((await set(r, 'sonnet')).ok, false, 'a prompt for Claude is not a setting');
  await say('switch to fable');
  assert.equal((await set(r, 'nonsense')).ok, false);
  assert.equal((await set(r, 'fable', 'volume_of_doom')).ok, false);
  assert.equal(getSetting('claudeVoiceModel'), 'opus');
  await say('ok go back to haiku');
  assert.equal((await set(r, 'haiku')).ok, true);
  assert.equal(getSetting('claudeVoiceModel'), 'haiku');
  off();
});

test('settings keep only known brains and efforts', () => {
  updateSettings({ claudeVoiceModel: 'gpt-9', claudeVoiceEffort: 'max' });
  assert.equal(getSetting('claudeVoiceModel'), 'haiku');
  assert.equal(getSetting('claudeVoiceEffort'), 'low');
  updateSettings({ claudeVoiceModel: 'fable', claudeVoiceEffort: 'high' });
  assert.equal(getSetting('claudeVoiceModel'), 'fable');
  assert.equal(getSetting('claudeVoiceEffort'), 'high');
  updateSettings({ claudeVoiceModel: { toString: 1 }, claudeVoiceEffort: 7 });
  assert.equal(getSetting('claudeVoiceModel'), 'fable');
  assert.equal(getSetting('claudeVoiceEffort'), 'high');
  updateSettings({ claudeVoiceModel: 'haiku', claudeVoiceEffort: 'low' });
});
