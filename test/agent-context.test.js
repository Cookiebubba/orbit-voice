// What the voice model is told, in layers (src/agent.js): who it is follows what's on screen (Orbit,
// Qubit or the pixel buddy), the job never changes, and the avatar's body and tool come only with an
// avatar. Plus what Claude voice's system prompt gets from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initConfig, updateSettings } from '../src/config.js';
import { setAvatarSink } from '../src/avatar-commands.js';
import { CONTEXT_SETTINGS, agentContext, core, onScreen } from '../src/agent.js';
import { systemPrompt } from '../src/claude-voice.js';

const mem = (v = '') => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agent-')), secrets: mem(), brainSecrets: mem() });
setAvatarSink(() => ({ ok: true })); // the desktop shell is there
const ctx = (avatar, showOrb = true) => {
  updateSettings({ avatar, showOrb });
  return agentContext();
};
const tool = (c) => c.tools.find((t) => t.name === 'avatar');

// The behaviour the job layer must always keep (the agent prompt before the layers, word for word).
const JOB = [
  'You are the user\'s voice for Claude Code.',
  'you are the go-between',
  'Two modes (decide on every turn)',
  'Prompting: they want Claude to do something, or to hear something.',
  'Talking: they\'re talking to you.',
  'The prompt is the user talking to Claude, in their own words, made direct.',
  '"tell him he forgot to update the README" → "You forgot to update the README."',
  'Be faithful.',
  'Orbit types the draft straight into Claude\'s prompt box.',
  'Drafting is the default: then say one short line, like "It\'s in the box. Send it?"',
  'If the request itself also said to send it',
  'Orbit sends it by itself.',
  'Orbit retypes the box with it (the old draft is replaced, never added to)',
  'call send_draft only after a clear yes in their latest reply',
  'Never send a prompt on your own initiative, and never send more than one prompt per confirmation.',
  'call go_to_sleep and say nothing at all',
  'Never explain how to wake you, put you to sleep, use the hotkey or the wake word',
  'So never say "I can\'t do that from here"',
  'Messages that start with "[App notification]" come from this app, not from the user.',
  '"Stop", "stop it", "cancel that run", "that\'s wrong, stop" mean: call stop_claude at once',
];

test('no avatar: Orbit is the face; nothing about any avatar is loaded', () => {
  const c = ctx('none');
  assert.equal(c.face, 'orbit');
  assert.match(c.instructions, /^Who you are:\n- You are Orbit, the voice of the Orbit app/);
  for (const s of JOB) assert.ok(c.instructions.includes(s), s);
  assert.ok(!/Qubit|Buddy|pixel buddy|Your body|\[Orbit note/.test(c.instructions), 'no avatar text');
  assert.equal(tool(c), undefined, 'no avatar tool');
});

test('Qubit: his persona and body, his tool; Orbit\x27s persona is not loaded', () => {
  for (const showOrb of [false, true]) {
    const c = ctx('qubit', showOrb);
    assert.equal(c.face, 'qubit');
    assert.match(c.instructions, /^Who you are:\n- You are Qubit: a small square with one rectangular eye/);
    assert.ok(!c.instructions.includes('You are Orbit'), 'not Orbit\x27s persona');
    assert.ok(!/Buddy|pixel buddy|16-pixel/.test(c.instructions), 'not the other avatar');
    assert.match(c.instructions, /Your body \(Qubit, on the Claude window\):/);
    assert.match(c.instructions, /a backflip/);
    for (const s of JOB) assert.ok(c.instructions.includes(s), s);
    const t = tool(c);
    assert.ok(t && t.parameters.properties.action.enum.includes('backflip'));
    // The orb shown too: one line about it, still Qubit talking.
    assert.equal(c.instructions.includes('The glowing orb on screen is the Orbit app'), showOrb, `showOrb ${showOrb}`);
  }
});

test('the pixel buddy: its own persona, body and tool', () => {
  const c = ctx('buddy', false);
  assert.equal(c.face, 'buddy');
  assert.match(c.instructions, /^Who you are:\n- You are Buddy, the pixel buddy/);
  assert.ok(!/You are Orbit|Qubit/.test(c.instructions));
  assert.match(c.instructions, /Your body \(Buddy, on the Claude window\)/);
  const t = tool(c);
  assert.ok(t.parameters.properties.action.enum.includes('wave'));
  assert.ok(!t.parameters.properties.action.enum.includes('backflip'));
});

test('the job layer is the same text whatever the face, and comes after the persona', () => {
  for (const [a, o] of [['none', true], ['qubit', false], ['qubit', true], ['buddy', true]]) {
    const c = ctx(a, o);
    const i = c.instructions.indexOf(core());
    assert.ok(i > 0, `${a}/${o}: the job is there in full`);
    assert.ok(c.instructions.slice(0, i).startsWith('Who you are:'));
  }
  // And it still follows the second-brain settings.
  updateSettings({ brainEnabled: false });
  assert.ok(!core().includes('Second brain:'));
  assert.ok(!agentContext().tools.some((t) => t.name === 'ask_second_brain'));
  updateSettings({ brainEnabled: true });
  assert.ok(core().includes('Second brain:'));
});

test('without the desktop shell (browser mode) there is no avatar on screen: Orbit', () => {
  updateSettings({ avatar: 'qubit' });
  setAvatarSink(null);
  assert.deepEqual(onScreen(), { face: 'orbit', avatar: null, orb: true });
  assert.equal(tool(agentContext()), undefined);
  setAvatarSink(() => ({ ok: true }));
  assert.equal(onScreen().face, 'qubit');
});

test('less to load when there is less on screen', () => {
  const none = ctx('none').instructions.length;
  const qubit = ctx('qubit', false).instructions.length;
  const persona = (s) => s.slice(0, s.indexOf(core()));
  assert.ok(persona(ctx('none').instructions).length < 400, 'Orbit\x27s persona is a few lines');
  assert.ok(qubit > none, 'an avatar adds its body and tool');
  assert.ok(qubit - none < 2500, `the avatar layers stay small (${qubit - none} chars)`);
});

test('Claude voice gets the same layers in its system prompt, tools included', () => {
  const q = ctx('qubit', false);
  const p = systemPrompt({ instructions: q.instructions, tools: q.tools });
  assert.match(p, /You are Qubit/);
  assert.match(p, /- avatar: Make Qubit/);
  assert.match(p, /not a coding agent/);
  const n = ctx('none');
  const pn = systemPrompt({ instructions: n.instructions, tools: n.tools });
  assert.ok(!/Qubit|- avatar:/.test(pn));
  assert.match(pn, /You are Orbit/);
});

test('the settings that change the context are the ones the live session is updated for', () => {
  for (const k of ['avatar', 'showOrb', 'brainEnabled', 'brainModel', 'brainExplore', 'brainConnection', 'wakeOnResults']) assert.ok(CONTEXT_SETTINGS.includes(k), k);
});

test('Qubit\x27s emote cues: a short guide in his body layer only, after the job, naming exactly his cues', async () => {
  const { CUES } = await import('../src/emote-cues.js');
  const q = ctx('qubit', false);
  const guide = q.instructions.split('\n').find((l) => l.startsWith('- Your face can show a feeling'));
  assert.ok(guide, 'the guide is there');
  assert.ok(q.instructions.indexOf(guide) > q.instructions.indexOf('Your body (Qubit'), 'in his body layer');
  assert.ok(q.instructions.indexOf(guide) > q.instructions.indexOf(core()) + core().length - 1, 'after the job (which is unchanged)');
  assert.deepEqual([...new Set([...guide.matchAll(/<([a-z]+)>/g)].map((m) => m[1]))].sort(), [...CUES].sort(), 'its cues are exactly his');
  assert.ok(guide.length < 520, `short (${guide.length} chars)`);
  assert.match(guide, /sparingly/);
  assert.match(guide, /never spoken or shown, and never go in prompts or tool arguments/);
  for (const [a, o] of [['none', true], ['buddy', false]]) assert.ok(!/Your face can show a feeling|<happy>/.test(ctx(a, o).instructions), `not for ${a}`);
});
