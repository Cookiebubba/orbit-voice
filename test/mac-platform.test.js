// macOS (phase 1): where Orbit looks for Claude's files and for Claude Code on a Mac, the login
// shell's PATH, ending a process group and the Mac labels. Everything is asked "as a Mac" through
// injected platform, environment and home folder, so it runs on any machine; nothing here starts a
// real shell or kills anything.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  childEnv,
  claudeAppDataDirs,
  desktopClaudeCandidates,
  desktopUnsupportedMessage,
  groupOptions,
  hotkeyLabel,
  killTree,
  loginShellCommand,
  loginShellPath,
  parseShellPath,
  primeLoginShellPath,
  projectsDir,
  resetLoginShellPath,
  searchDirs,
  sessionRootCandidates,
  tarPath,
  wellKnownBinDirs,
} from '../src/platform/system.js';
import { desktopSessionRoots } from '../src/sessions.js';
import { findClaude, openClaudeSignIn, shellQuote, signInScript } from '../src/brain.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const HOME = '/Users/ada';
const MAC = { platform: 'darwin', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' }, homedir: HOME };

// ---- Claude's own folders -----------------------------------------------------------------------

test('Mac: Claude desktop keeps its sessions under ~/Library/Application Support/Claude', () => {
  assert.deepEqual(claudeAppDataDirs(MAC), ['/Users/ada/Library/Application Support/Claude']);
  assert.deepEqual(sessionRootCandidates(MAC), ['/Users/ada/Library/Application Support/Claude/claude-code-sessions']);
  assert.equal(projectsDir(MAC), '/Users/ada/.claude/projects', 'transcripts are ~/.claude/projects everywhere');
});

test('Windows: %APPDATA%\\Claude (and the Microsoft Store copy under LOCALAPPDATA) as before', () => {
  const local = tmp('orbit-local-');
  fs.mkdirSync(path.join(local, 'Packages', 'Claude_abc123'), { recursive: true });
  fs.mkdirSync(path.join(local, 'Packages', 'NotClaude_x'), { recursive: true });
  const roots = sessionRootCandidates({ platform: 'win32', env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming', LOCALAPPDATA: local }, homedir: 'C:\\Users\\ada' });
  assert.equal(roots[0], 'C:\\Users\\ada\\AppData\\Roaming\\Claude\\claude-code-sessions');
  assert.equal(roots.length, 2);
  assert.match(roots[1], /Packages[\\/]Claude_abc123[\\/]LocalCache[\\/]Roaming[\\/]Claude[\\/]claude-code-sessions$/);
});

test('Linux (from source): ~/.config/Claude, or $XDG_CONFIG_HOME', () => {
  assert.deepEqual(claudeAppDataDirs({ platform: 'linux', env: {}, homedir: '/home/ada' }), ['/home/ada/.config/Claude']);
  assert.deepEqual(claudeAppDataDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/cfg' }, homedir: '/home/ada' }), ['/x/cfg/Claude']);
});

test('the sessions reader finds a Mac layout on disk', () => {
  const home = tmp('orbit-machome-');
  const root = path.posix.join(home.replace(/\\/g, '/'), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  fs.mkdirSync(root, { recursive: true });
  const found = desktopSessionRoots({ platform: 'darwin', env: {}, homedir: home.replace(/\\/g, '/') });
  assert.deepEqual(found, [root]);
  assert.deepEqual(desktopSessionRoots({ platform: 'darwin', env: {}, homedir: tmp('orbit-machome-empty-').replace(/\\/g, '/') }), [], 'nothing there, nothing listed');
});

// ---- finding Claude Code on a Mac ---------------------------------------------------------------

test('Mac: the usual install folders an app opened from Finder does not have on its PATH', () => {
  assert.deepEqual(wellKnownBinDirs(MAC), ['/Users/ada/.local/bin', '/Users/ada/.claude/local', '/opt/homebrew/bin', '/usr/local/bin', '/Users/ada/.npm-global/bin']);
  // Windows: the native installer's folder (a running Orbit doesn't see the PATH it adds until it restarts).
  assert.deepEqual(wellKnownBinDirs({ platform: 'win32', homedir: 'C:\\Users\\ada' }), ['C:\\Users\\ada\\.local\\bin']);
});

test('Mac: findClaude looks on PATH, then the login shell PATH, then the usual folders, in that order', () => {
  const find = (files, shellPath = []) => findClaude('', MAC.env, { platform: 'darwin', homedir: HOME, shellPath, exists: (p) => files.includes(p) });
  assert.equal(find([]), null);
  assert.deepEqual(find(['/usr/local/bin/claude']), { path: '/usr/local/bin/claude', source: 'path' });
  assert.deepEqual(find(['/usr/local/bin/claude', '/opt/homebrew/bin/claude']), { path: '/opt/homebrew/bin/claude', source: 'path' }, 'Homebrew on Apple silicon before /usr/local');
  assert.deepEqual(find(['/usr/local/bin/claude', '/Users/ada/.local/bin/claude']), { path: '/Users/ada/.local/bin/claude', source: 'path' }, 'the native installer first');
  assert.deepEqual(find(['/Users/ada/.claude/local/claude']), { path: '/Users/ada/.claude/local/claude', source: 'path' });
  assert.deepEqual(find(['/Users/ada/.npm-global/bin/claude']), { path: '/Users/ada/.npm-global/bin/claude', source: 'path' });
  // The login shell's PATH (an nvm or custom prefix) comes before the guesses.
  assert.deepEqual(find(['/Users/ada/.nvm/versions/node/v22/bin/claude', '/usr/local/bin/claude'], ['/Users/ada/.nvm/versions/node/v22/bin']), { path: '/Users/ada/.nvm/versions/node/v22/bin/claude', source: 'path' });
  // ...and the app's own PATH before everything.
  const own = findClaude('', { PATH: '/custom/bin:/usr/bin' }, { platform: 'darwin', homedir: HOME, shellPath: [], exists: (p) => ['/custom/bin/claude', '/usr/local/bin/claude'].includes(p) });
  assert.deepEqual(own, { path: '/custom/bin/claude', source: 'path' });
  // Only a file named claude, never claude.exe or claude.cmd, on a Mac.
  assert.equal(find(['/usr/local/bin/claude.cmd', '/usr/local/bin/claude.exe']), null);
});

test('Mac: the copy bundled with the Claude app, newest version first', () => {
  const home = tmp('orbit-machome-').replace(/\\/g, '/');
  const base = path.posix.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  for (const [v, sub] of [['2.1.9', 'abc'], ['2.1.10', ''], ['2.1.10', 'def'], ['notaversion', '']]) {
    fs.mkdirSync(path.posix.join(base, v, sub), { recursive: true });
  }
  const c = desktopClaudeCandidates({ platform: 'darwin', env: {}, homedir: home });
  assert.deepEqual(c, [`${base}/2.1.10/claude`, `${base}/2.1.10/def/claude`, `${base}/2.1.9/claude`, `${base}/2.1.9/abc/claude`]);
  const found = findClaude('', { PATH: '' }, { platform: 'darwin', homedir: home, shellPath: [], exists: (p) => p === `${base}/2.1.9/abc/claude` });
  assert.deepEqual(found, { path: `${base}/2.1.9/abc/claude`, source: 'claude-desktop' });
});

test('Mac: a configured path must be named claude and exist', () => {
  const opts = { platform: 'darwin', homedir: HOME, shellPath: [], exists: (p) => p === '/opt/tools/claude' };
  assert.deepEqual(findClaude('/opt/tools/claude', {}, opts), { path: '/opt/tools/claude', source: 'settings' });
  assert.equal(findClaude('/opt/tools/bash', {}, { ...opts, exists: () => true }), null);
  assert.equal(findClaude('/opt/tools/missing/claude', {}, opts), null);
});

// ---- the login shell's PATH ---------------------------------------------------------------------

test('login shell PATH: asked once with $SHELL -ilc, markers survive shell noise, only absolute folders kept', () => {
  resetLoginShellPath();
  const calls = [];
  const fake = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { stdout: `Welcome to zsh!\nlast login...\n__ORBIT_PATH_START__/Users/ada/.local/bin:relative/bin::/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin__ORBIT_PATH_END__` };
  };
  const dirs = loginShellPath({ ...MAC, spawnSyncImpl: fake });
  assert.deepEqual(dirs, ['/Users/ada/.local/bin', '/opt/homebrew/bin', '/usr/bin']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/bin/zsh');
  assert.equal(calls[0].args[0], '-ilc');
  assert.match(calls[0].args[1], /printf .*"\$PATH"/);
  assert.ok(calls[0].opts.timeout > 0 && calls[0].opts.timeout <= 5000, 'a time limit');
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'ignore'], 'no input, no stderr');
  // Cached: no second shell.
  assert.deepEqual(loginShellPath({ ...MAC, spawnSyncImpl: fake }), dirs);
  assert.equal(calls.length, 1);
  resetLoginShellPath();
});

test('login shell PATH: logs only a count, never the folders', () => {
  resetLoginShellPath();
  const logs = [];
  loginShellPath({ ...MAC, spawnSyncImpl: () => ({ stdout: '__ORBIT_PATH_START__/secret/place/bin:/usr/bin__ORBIT_PATH_END__' }), log: (m) => logs.push(m) });
  assert.deepEqual(logs, ['login shell PATH: 2 folders']);
  assert.ok(!logs.join(' ').includes('/secret'));
  resetLoginShellPath();
});

test('login shell PATH: a shell that hangs, fails or prints nothing gives no folders (and no crash)', () => {
  for (const fake of [() => ({ stdout: '', error: new Error('ETIMEDOUT') }), () => { throw new Error('ENOENT'); }, () => ({ stdout: 'no markers here' }), () => null]) {
    resetLoginShellPath();
    assert.deepEqual(loginShellPath({ ...MAC, spawnSyncImpl: fake }), []);
  }
  resetLoginShellPath();
});

test('login shell PATH: only on a Mac; an odd $SHELL falls back to /bin/zsh', () => {
  resetLoginShellPath();
  let called = false;
  assert.deepEqual(loginShellPath({ platform: 'win32', env: {}, spawnSyncImpl: () => (called = true) }), []);
  assert.deepEqual(loginShellPath({ platform: 'linux', env: {}, spawnSyncImpl: () => (called = true) }), []);
  assert.equal(called, false);
  assert.equal(loginShellCommand({ env: { SHELL: '/opt/homebrew/bin/fish' } }).file, '/opt/homebrew/bin/fish');
  for (const SHELL of ['zsh', '/bin/zsh; rm -rf ~', '', undefined, '/bin/z sh']) assert.equal(loginShellCommand({ env: { SHELL } }).file, '/bin/zsh', String(SHELL));
  assert.deepEqual(parseShellPath('x__ORBIT_PATH_START__/a:/b__ORBIT_PATH_END__y'), ['/a', '/b']);
});

test('login shell PATH: primed in the background at startup, then read from the cache', async () => {
  resetLoginShellPath();
  let runs = 0;
  const execFileImpl = (file, args, opts, cb) => {
    runs++;
    setTimeout(() => cb(null, '__ORBIT_PATH_START__/Users/ada/.local/bin__ORBIT_PATH_END__'), 5);
  };
  const [a, b] = await Promise.all([primeLoginShellPath({ ...MAC, execFileImpl }), primeLoginShellPath({ ...MAC, execFileImpl })]);
  assert.deepEqual(a, ['/Users/ada/.local/bin']);
  assert.deepEqual(b, a);
  assert.equal(runs, 1, 'one shell for both');
  assert.deepEqual(loginShellPath({ ...MAC, spawnSyncImpl: () => assert.fail('cached: no second shell') }), a);
  assert.deepEqual(await primeLoginShellPath({ platform: 'win32', env: {}, execFileImpl: () => assert.fail('not on Windows') }), []);
  resetLoginShellPath();
});

test('Mac: children get the widened PATH (an npm-installed Claude Code needs its node); Windows unchanged', () => {
  const env = childEnv({ PATH: '/usr/bin:/bin', HOME, KEEP: '1' }, { platform: 'darwin', homedir: HOME, shellPath: ['/Users/ada/.nvm/bin', '/usr/bin'] });
  assert.equal(env.KEEP, '1');
  const dirs = env.PATH.split(':');
  assert.deepEqual(dirs.slice(0, 3), ['/usr/bin', '/bin', '/Users/ada/.nvm/bin'], 'own PATH first, then the login shell');
  assert.ok(dirs.includes('/opt/homebrew/bin') && dirs.includes('/Users/ada/.local/bin'));
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicates');
  const win = { PATH: 'C:\\Windows', Path: 'x' };
  assert.deepEqual(childEnv(win, { platform: 'win32' }), win);
  assert.deepEqual(searchDirs({ platform: 'win32', env: { Path: 'C:\\a;C:\\b' }, homedir: 'C:\\Users\\ada' }), ['C:\\a', 'C:\\b', 'C:\\Users\\ada\\.local\\bin']);
  assert.deepEqual(searchDirs({ platform: 'win32', env: { Path: 'C:\\Users\\ada\\.local\\bin;C:\\a' }, homedir: 'C:\\Users\\ada' }), ['C:\\Users\\ada\\.local\\bin', 'C:\\a'], 'once');
});

// ---- ending a process and everything it started -------------------------------------------------

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.killed = [];
  c.kill = (sig) => c.killed.push(sig ?? 'SIGTERM');
  return c;
}

test('Mac/Linux: each Claude Code run is its own process group, and killTree ends the whole group', async () => {
  assert.deepEqual(groupOptions('darwin'), { detached: true });
  assert.deepEqual(groupOptions('linux'), { detached: true });
  assert.deepEqual(groupOptions('win32'), {}, 'Windows uses taskkill /T instead');
  const sent = [];
  const child = fakeChild(4242);
  killTree(child, { platform: 'darwin', killImpl: (pid, sig) => sent.push([pid, sig]), graceMs: 10 });
  assert.deepEqual(sent, [[-4242, 'SIGTERM']], 'the negative pid: the whole group');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']], 'then SIGKILL for anything left');
  assert.deepEqual(child.killed, [], 'no plain kill needed');
});

test('Mac: on exit the group is killed at once (SIGKILL, nothing left to wait for)', () => {
  const sent = [];
  killTree(fakeChild(77), { platform: 'darwin', sync: true, killImpl: (pid, sig) => sent.push([pid, sig]) });
  assert.deepEqual(sent, [[-77, 'SIGKILL']]);
});

test('Mac: a child that is not a group leader (or already gone) still gets killed directly', () => {
  const child = fakeChild(99);
  killTree(child, { platform: 'darwin', killImpl: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); } });
  assert.deepEqual(child.killed, ['SIGTERM']);
  const noPid = fakeChild(undefined);
  killTree(noPid, { platform: 'darwin', killImpl: () => assert.fail('no pid, no group kill') });
  assert.deepEqual(noPid.killed, ['SIGTERM']);
  killTree(null, { platform: 'darwin' }); // nothing to do
});

test('Windows: still taskkill /T /F on the pid', () => {
  const runs = [];
  killTree(fakeChild(555), { platform: 'win32', spawnImpl: (file, args) => (runs.push([path.basename(file), args]), new EventEmitter()) });
  assert.deepEqual(runs, [['taskkill.exe', ['/pid', '555', '/T', '/F']]]);
  const syncRuns = [];
  killTree(fakeChild(556), { platform: 'win32', sync: true, spawnSyncImpl: (file, args) => syncRuns.push(args) });
  assert.deepEqual(syncRuns, [['/pid', '556', '/T', '/F']]);
});

// ---- Mac touches ----------------------------------------------------------------------------------

test('hotkey labels: ⌃⌥G on a Mac, Ctrl+Alt+G on Windows', () => {
  assert.equal(hotkeyLabel('Control+Alt+G', 'darwin'), '⌃⌥G');
  assert.equal(hotkeyLabel('Shift+Control+Alt+Command+k', 'darwin'), '⌃⌥⇧⌘K', "Apple's order");
  assert.equal(hotkeyLabel('CommandOrControl+Shift+Space', 'darwin'), '⇧⌘Space');
  assert.equal(hotkeyLabel('Super+F5', 'darwin'), '⌘F5');
  assert.equal(hotkeyLabel('Control+Alt+G', 'win32'), 'Ctrl+Alt+G');
  assert.equal(hotkeyLabel('Super+Alt+G', 'win32'), 'Win+Alt+G');
});

test('without its helper, the Claude app tools say plainly what Orbit cannot do on this Mac', () => {
  const m = desktopUnsupportedMessage('darwin');
  assert.match(m, /helper is missing/);
  assert.match(m, /send/i);
  assert.match(m, /Stop/);
  assert.match(desktopUnsupportedMessage('linux'), /only implemented for Windows/);
});

test('speech models unpack with /usr/bin/tar on a Mac, Windows tar.exe by full path', () => {
  assert.equal(tarPath('darwin'), '/usr/bin/tar');
  assert.equal(tarPath('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe');
});

test('Mac sign-in: a self-removing .command file opened in Terminal, the path safely quoted', async () => {
  assert.equal(shellQuote("/Users/a b/it's/claude"), "'/Users/a b/it'\\''s/claude'");
  const script = signInScript('/tmp/x.command', '/Users/a b/.local/bin/claude');
  assert.equal(script, "#!/bin/sh\nrm -f '/tmp/x.command'\nexec '/Users/a b/.local/bin/claude' auth login\n");
  const runs = [];
  const r = await openClaudeSignIn({
    claudePath: '/Users/ada/.local/bin/claude',
    platform: 'darwin',
    spawnImpl: (file, args) => {
      runs.push({ file, args });
      const c = new EventEmitter();
      setImmediate(() => c.emit('spawn'));
      return c;
    },
  });
  assert.deepEqual(r, { ok: true });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].file, '/usr/bin/open');
  assert.match(runs[0].args[0], /orbit-claude-sign-in-[0-9a-f]{12}\.command$/);
  const written = fs.readFileSync(runs[0].args[0], 'utf8');
  assert.match(written, /exec '\/Users\/ada\/\.local\/bin\/claude' auth login/);
  fs.rmSync(runs[0].args[0], { force: true });
});
