// Choosing which apps "Mute my mic in other apps while Grok listens" mutes: per-user rules,
// the "mute all except / mute only" default, safe built-ins, and settings validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_LEAVE, decide, helperRules, isExeName, rulesCommand } from '../src/mic-apps.js';
import { getSetting, initConfig, updateSettings } from '../src/config.js';

test('mute all except: unknown apps are muted, recording and routing apps left alone, your picks win', () => {
  const s = { micStealDefault: 'mute', micStealRules: { 'zoom.exe': 'leave', 'obs64.exe': 'mute' } };
  assert.deepEqual(decide('Discord.exe', s), { action: 'mute', why: 'default' });
  assert.deepEqual(decide('zoom.exe', s), { action: 'leave', why: 'you' });
  assert.deepEqual(decide('krisp.exe', s), { action: 'leave', why: 'recording-or-routing' });
  assert.deepEqual(decide('obs64.exe', s), { action: 'mute', why: 'you' }, 'you can still mute OBS if you want to');
});

test('mute only: nothing is muted unless you pick it', () => {
  const s = { micStealDefault: 'leave', micStealRules: { 'discord.exe': 'mute' } };
  assert.equal(decide('discord.exe', s).action, 'mute');
  assert.equal(decide('teams.exe', s).action, 'leave');
  assert.equal(decide('obs64.exe', s).action, 'leave');
});

test('the helper gets the default, your mutes, and the built-ins you have not overridden', () => {
  const r = helperRules({ micStealDefault: 'mute', micStealRules: { 'discord.exe': 'mute', 'zoom.exe': 'leave', 'obs64.exe': 'mute' } });
  assert.equal(r.default, 'mute');
  assert.deepEqual(r.mute.sort(), ['discord.exe', 'obs64.exe']);
  assert.ok(r.leave.includes('zoom.exe') && r.leave.includes('krisp.exe') && r.leave.includes('cap.exe'));
  assert.ok(!r.leave.includes('obs64.exe'), 'your choice beats the built-in');
  const cmd = rulesCommand(r);
  assert.equal(cmd.split('\t').length, 4);
  assert.ok(!cmd.includes('\n'));
});

test('built-ins cover the common recorders and audio-routing apps, all valid file names', () => {
  for (const exe of ['obs64.exe', 'streamlabs desktop.exe', 'voicemeeterpro.exe', 'krisp.exe', 'nvidia broadcast.exe', 'cap.exe', 'voicemoddesktop.exe']) assert.ok(BUILTIN_LEAVE[exe], exe);
  for (const exe of Object.keys(BUILTIN_LEAVE)) assert.ok(isExeName(exe) && exe === exe.toLowerCase(), exe);
});

test('settings keep only valid rules, lowercased', () => {
  initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mic-cfg-')) });
  updateSettings({ micStealDefault: 'leave', micStealRules: { 'Discord.exe': 'mute', 'a/b.exe': 'mute', 'notes.txt': 'leave', 'zoom.exe': 'sometimes', 'Teams.exe': 'leave' } });
  assert.equal(getSetting('micStealDefault'), 'leave');
  assert.deepEqual(getSetting('micStealRules'), { 'discord.exe': 'mute', 'teams.exe': 'leave' });
  updateSettings({ micStealDefault: 'everything' });
  assert.equal(getSetting('micStealDefault'), 'leave');
  updateSettings({ micStealRules: ['discord.exe'] });
  assert.deepEqual(getSetting('micStealRules'), { 'discord.exe': 'mute', 'teams.exe': 'leave' }, 'an array is not rules');
});
