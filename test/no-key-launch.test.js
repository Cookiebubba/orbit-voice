// Opening Orbit never needs an xAI key: the main page (Qubit, the orb) always shows, new installs
// start on Claude voice (the user's own Claude plan), installs from before keep their engine, and
// only a try to talk to Grok without a key says so, inline, with a way to Settings or to Claude.
//   - ui/src/talk.js: what can talk, which screen shows, the inline notice
//   - src/config.js: the default engine, and saved settings left as they were
//   - ui/src/App.tsx: no key screen is left in it, and every way to start goes through tryTalk

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CODE_MISSING, GROK_NEEDS_KEY, canTalk, needsModelDownload, screenFor, talkNotice } from '../ui/src/talk.js';
import { DEFAULTS, engineFor, getSetting, initConfig, updateSettings } from '../src/config.js';

// A developer's own .env key (brought over at first run in dev mode) mustn't make this a "has a key" machine.
process.env.XAI_API_KEY = '';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = (hasKey, voiceEngine) => ({ hasKey, settings: { voiceEngine } });
const store = (v = '') => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-no-key-'));
const saved = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

test('can talk: Claude voice always, Grok only with a key', () => {
  assert.equal(canTalk(cfg(false, 'claude')), true);
  assert.equal(canTalk(cfg(true, 'claude')), true);
  assert.equal(canTalk(cfg(true, 'grok')), true);
  assert.equal(canTalk(cfg(false, 'grok')), false);
  assert.equal(canTalk(null), false); // still loading
  assert.equal(canTalk(undefined), false);
});

test('first launch with no key shows the main page (there is no key screen)', () => {
  assert.equal(screenFor('main'), 'main');
  assert.equal(screenFor('settings'), 'settings');
  assert.equal(screenFor('history'), 'history');
  assert.equal(screenFor('anything else'), 'main');
  // The window's own code: no key screen, nothing on the main page gated on the key itself.
  const app = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'App.tsx'), 'utf8');
  assert.doesNotMatch(app, /KeySetup/);
  assert.doesNotMatch(app, /config\.hasKey|config\?\.hasKey/);
  assert.match(app, /screenFor\(view\)/);
  // Every way to start a call goes through tryTalk: the button, Qubit, the hotkey / wake word, an ask.
  assert.match(app, /label="Start talking" onClick=\{startTalk\}/);
  assert.match(app, /!on \? startTalk\(\)/);
  assert.match(app, /onWake: \(\) => hotkeyRef\.current\(\)/);
  assert.match(app, /onHotkey\(\(\) => hotkeyRef\.current\(\)\)/);
  assert.match(app, /void tryTalk\(ask\)/);
  assert.doesNotMatch(app, /onClick=\{v\.start\}/);
});

test('Grok without a key: the notice says so, plainly, and goes once it can talk', () => {
  const n = talkNotice('grok-key', cfg(false, 'grok'), null);
  assert.deepEqual(n, { kind: 'grok-key', text: GROK_NEEDS_KEY });
  assert.equal(GROK_NEEDS_KEY, 'Grok voice needs an xAI key. Add one in Settings, or switch to Claude voice.');
  assert.equal(talkNotice('grok-key', cfg(true, 'grok'), null), null, 'a key saved');
  assert.equal(talkNotice('grok-key', cfg(false, 'claude'), null), null, 'switched to Claude');
  assert.equal(talkNotice(null, cfg(false, 'grok'), null), null, 'nothing shows before a try to talk');
  // The page offers both ways out: Settings and Claude voice.
  const app = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'App.tsx'), 'utf8');
  assert.match(app, /<NoticeButton onClick=\{openSettings\}>Open Settings<\/NoticeButton>/);
  assert.match(app, /notice\.kind === "grok-key" && <NoticeButton onClick=\{switchToClaude\}>Use Claude voice<\/NoticeButton>/);
});

test('Claude voice not ready: Claude Code missing, models downloading or failed', () => {
  const st = (claudeFound, state, percent = 0, error = '') => ({ claudeFound, models: { state, percent, error } });
  const c = cfg(false, 'claude');
  assert.deepEqual(talkNotice('claude', c, st(false, 'ready')), { kind: 'claude-missing', text: CLAUDE_CODE_MISSING });
  // (How to install it, the command and Check again: test/claude-setup.test.js.)
  assert.equal(talkNotice('claude', c, st(true, 'downloading', 42)).kind, 'claude-models');
  assert.match(talkNotice('claude', c, st(true, 'downloading', 42)).text, /42%/);
  assert.equal(talkNotice('claude', c, st(true, 'idle')).kind, 'claude-models');
  assert.equal(talkNotice('claude', c, st(true, 'error', 0, 'HTTP 503')).kind, 'claude-models-error');
  assert.match(talkNotice('claude', c, st(true, 'error', 0, 'HTTP 503')).text, /HTTP 503/);
  assert.equal(talkNotice('claude', c, st(true, 'ready')), null, 'ready: the notice goes');
  assert.equal(talkNotice('claude', cfg(false, 'grok'), st(true, 'idle')), null, 'not on Claude voice any more');
  // The download starts on a try to talk only when it isn't running or done (and Claude Code is here).
  assert.equal(needsModelDownload(st(true, 'idle')), true);
  assert.equal(needsModelDownload(st(true, 'error')), true);
  assert.equal(needsModelDownload(st(true, 'downloading')), false);
  assert.equal(needsModelDownload(st(true, 'ready')), false);
  assert.equal(needsModelDownload(st(false, 'idle')), false);
  assert.equal(needsModelDownload(null), false);
});

test('the default engine: Claude for new installs, the saved choice always wins', () => {
  assert.equal(DEFAULTS.voiceEngine, 'claude');
  assert.equal(engineFor({}), 'claude');
  assert.equal(engineFor({ saved: 'grok' }), 'grok');
  assert.equal(engineFor({ saved: 'claude', hadFile: true, hasKey: true }), 'claude');
  assert.equal(engineFor({ saved: 'grok', hadFile: false, hasKey: false }), 'grok');
  // From before Claude was the default: a settings file without the choice, or a key already saved.
  assert.equal(engineFor({ hadFile: true }), 'grok');
  assert.equal(engineFor({ hasKey: true }), 'grok');
});

test('a new install (empty config folder, no key) starts on Claude voice, and says so in its file', () => {
  const dir = tmp();
  const s = initConfig({ dir, secrets: store(''), brainSecrets: store('') });
  assert.equal(s.voiceEngine, 'claude');
  assert.equal(getSetting('voiceEngine'), 'claude');
  assert.deepEqual(saved(dir), { voiceEngine: 'claude' });
  // Adding an xAI key later (nothing else changed) keeps it on Claude.
  assert.equal(initConfig({ dir, secrets: store('xai-' + 'k'.repeat(40)), brainSecrets: store('') }).voiceEngine, 'claude');
  // A change keeps the engine in the file, even at its default.
  updateSettings({ speed: 1.2 });
  assert.equal(saved(dir).speed, 1.2);
  assert.equal(saved(dir).voiceEngine, 'claude');
  assert.equal(initConfig({ dir, secrets: store('xai-' + 'k'.repeat(40)), brainSecrets: store('') }).voiceEngine, 'claude');
});

test('existing saved settings are left as they were', () => {
  for (const voiceEngine of ['grok', 'claude']) {
    for (const key of ['', 'xai-' + 'k'.repeat(40)]) {
      const dir = tmp();
      const before = JSON.stringify({ voiceEngine, avatar: 'qubit', speed: 1.1 }, null, 2);
      fs.writeFileSync(path.join(dir, 'settings.json'), before);
      const s = initConfig({ dir, secrets: store(key), brainSecrets: store('') });
      assert.equal(s.voiceEngine, voiceEngine, `${voiceEngine} saved, key ${key ? 'set' : 'not set'}`);
      assert.equal(s.avatar, 'qubit');
      assert.equal(s.speed, 1.1);
      assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before, 'the file is not rewritten');
    }
  }
  // A Grok install from before (its file has no engine: Grok was the default) stays on Grok.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ avatar: 'qubit' }));
  assert.equal(initConfig({ dir, secrets: store(''), brainSecrets: store('') }).voiceEngine, 'grok');
  assert.deepEqual(saved(dir), { avatar: 'qubit' }, 'not rewritten at launch');
  updateSettings({ speed: 1.3 });
  assert.equal(saved(dir).voiceEngine, 'grok', 'and the next change writes Grok out');
  // ...and so does one that never changed a setting but has its key saved.
  const dir2 = tmp();
  assert.equal(initConfig({ dir: dir2, secrets: store('xai-' + 'k'.repeat(40)), brainSecrets: store('') }).voiceEngine, 'grok');
  assert.equal(fs.existsSync(path.join(dir2, 'settings.json')), false);
});
