// No Claude Code on this computer (or not signed in): the main page's notice and Settings →
// Second brain show the official install command for the platform (Copy, never run), the sign-in
// step, a link to Anthropic's setup page, and "Check again", which looks again and clears the
// notice once Claude Code is here.
//   - ui/src/talk.js: the command per platform, the notice, the Check-again flow
//   - src/brain.js: a Claude Code installed while Orbit runs is found (its stale PATH aside)
//   - ui/src/App.tsx, ui/src/Settings.tsx: the help is wired in on both
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_CODE_MISSING,
  CLAUDE_NOT_SIGNED_IN,
  CLAUDE_NPM_INSTALL,
  CLAUDE_SETUP_URL,
  CLAUDE_SIGN_IN_STEP,
  checkClaudeAgain,
  claudeInstall,
  claudeVoiceReady,
  talkNotice,
} from '../ui/src/talk.js';
import { findClaude } from '../src/brain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const claude = { hasKey: false, settings: { voiceEngine: 'claude' } };
const st = (claudeFound, state = 'ready', signedIn = null) => ({ claudeFound, signedIn, models: { state, percent: 0, error: '' } });

test('the install command is the official one for each platform', () => {
  assert.deepEqual(claudeInstall('win32'), { where: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' });
  assert.deepEqual(claudeInstall('darwin'), { where: 'Terminal', command: 'curl -fsSL https://claude.ai/install.sh | bash' });
  assert.deepEqual(claudeInstall('linux'), { where: 'a terminal', command: 'curl -fsSL https://claude.ai/install.sh | bash' });
  assert.equal(claudeInstall(undefined).command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(CLAUDE_NPM_INSTALL, 'npm install -g @anthropic-ai/claude-code');
  assert.equal(CLAUDE_SETUP_URL, 'https://code.claude.com/docs/en/setup');
  assert.match(CLAUDE_SIGN_IN_STEP, /run claude once in a terminal and sign in with your Claude account/);
});

test('the notice: missing, then found but signed out, each with its own line', () => {
  assert.deepEqual(talkNotice('claude', claude, st(false)), { kind: 'claude-missing', text: CLAUDE_CODE_MISSING });
  assert.match(CLAUDE_CODE_MISSING, /needs Claude Code/);
  assert.deepEqual(talkNotice('claude', claude, st(true, 'ready', false)), { kind: 'claude-signed-out', text: CLAUDE_NOT_SIGNED_IN });
  assert.match(CLAUDE_NOT_SIGNED_IN, /isn't signed in\. Run claude/);
  // Signed in, or not known (the check couldn't run): never blocks.
  assert.equal(talkNotice('claude', claude, st(true, 'ready', true)), null);
  assert.equal(talkNotice('claude', claude, st(true, 'ready', null)), null);
  assert.equal(claudeVoiceReady(st(true, 'ready', null)), true);
  assert.equal(claudeVoiceReady(st(true, 'ready', false)), false);
  assert.equal(claudeVoiceReady(st(false)), false);
  assert.equal(claudeVoiceReady(null), false);
});

/** A stand-in for GET /api/claude-voice and POST /api/claude-voice/download. */
function endpoint(responses, download = { models: { state: 'downloading', percent: 0, error: '' } }) {
  const calls = { status: 0, download: 0 };
  return {
    calls,
    fetchStatus: async () => {
      const r = responses[Math.min(calls.status++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    startDownload: async () => {
      calls.download++;
      return download;
    },
  };
}

test('Check again: Claude Code installed since → ready, and the notice clears', async () => {
  const io = endpoint([st(true, 'ready', true)]);
  const r = await checkClaudeAgain(io);
  assert.equal(r.ready, true);
  assert.equal(io.calls.status, 1);
  assert.equal(io.calls.download, 0, 'models already here: nothing downloaded');
  assert.equal(talkNotice('claude', claude, r.status), null);
});

test('Check again: still missing → the same notice, nothing downloaded', async () => {
  const io = endpoint([st(false, 'idle')]);
  const r = await checkClaudeAgain(io);
  assert.equal(r.ready, false);
  assert.equal(io.calls.download, 0);
  assert.equal(talkNotice('claude', claude, r.status).kind, 'claude-missing');
});

test('Check again: found but signed out → the sign-in line; signed in on the next check → clears', async () => {
  const io = endpoint([st(true, 'ready', false), st(true, 'ready', true)]);
  const first = await checkClaudeAgain(io);
  assert.equal(first.ready, false);
  assert.equal(talkNotice('claude', claude, first.status).kind, 'claude-signed-out');
  const second = await checkClaudeAgain(io);
  assert.equal(second.ready, true);
});

test('Check again: found but no speech models yet → their download starts and the notice follows it', async () => {
  const io = endpoint([st(true, 'idle', true)]);
  const r = await checkClaudeAgain(io);
  assert.equal(io.calls.download, 1);
  assert.equal(r.ready, false);
  assert.equal(r.status.models.state, 'downloading');
  assert.equal(talkNotice('claude', claude, r.status).kind, 'claude-models');
});

test('Check again: Orbit unreachable → nothing changes (no crash, not ready)', async () => {
  const r = await checkClaudeAgain(endpoint([new Error('offline')]));
  assert.deepEqual(r, { status: null, ready: false });
  const r2 = await checkClaudeAgain(endpoint([null]));
  assert.deepEqual(r2, { status: null, ready: false });
});

test('Windows: a Claude Code installed while Orbit runs is found in the installer\x27s folder', () => {
  const home = 'C:\\Users\\ada';
  const exe = 'C:\\Users\\ada\\.local\\bin\\claude.exe';
  const env = { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\ada\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' };
  assert.deepEqual(findClaude('', env, { platform: 'win32', homedir: home, exists: (p) => p === exe }), { path: exe, source: 'path' });
  assert.equal(findClaude('', env, { platform: 'win32', homedir: home, exists: () => false }), null);
  // A path set in Settings still means only that path.
  assert.equal(findClaude('C:\\nowhere\\claude.exe', env, { platform: 'win32', homedir: home, exists: (p) => p === exe }), null);
});

test('the main page and Settings carry the help; Orbit only copies the command, never runs it', () => {
  const app = read('ui', 'src', 'App.tsx');
  assert.match(app, /notice\.kind === "claude-missing" && \(\s*<>\s*<InstallCommand \/>\s*<SignInStep/);
  assert.match(app, /<NoticeButton onClick=\{checkAgain\}/);
  assert.match(app, /Check again/);
  assert.match(app, /<SetupGuideLink/);
  assert.match(app, /<NotSignedInLine \/>/);
  const settings = read('ui', 'src', 'Settings.tsx');
  assert.match(settings, /<InstallCommand className=/);
  assert.match(settings, /<SignInStep className=/);
  assert.match(settings, /onClick=\{checkAgain\}/);
  assert.match(settings, /<SetupGuideLink/);
  const help = read('ui', 'src', 'components', 'ClaudeSetup.tsx');
  assert.match(help, /target="_blank" rel="noreferrer"/, 'the setup page opens in the browser');
  assert.match(help, /claudeInstall\(platform\)/);
  assert.doesNotMatch(help, /postJson|fetch\(/, 'nothing is installed or run from Orbit');
  // The status endpoint the main page checks reports the sign-in too.
  assert.match(read('src', 'server.js'), /claudeFound: !!claude, signedIn,/);
});
