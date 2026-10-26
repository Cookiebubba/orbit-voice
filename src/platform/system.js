// What differs between Windows and macOS (and Linux, for running from source), in one place:
// where Claude keeps its files, where Claude Code may be installed, the PATH a child process needs,
// how to end a process and everything it started, and how a hotkey reads.
// (Other apps' windows, for Orbit anywhere, are src/platform/index.js.)
//
// Every function takes the platform, environment and home folder as options (defaulting to this
// machine's), so tests can ask "what would a Mac do?" on any machine.

import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = () => ({ platform: process.platform, env: process.env, homedir: os.homedir() });
const listDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
// Paths built for another platform (in tests) use that platform's separators.
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * The Claude desktop app's data folders (where it keeps claude-code-sessions and its own copy of
 * Claude Code). Electron apps keep these under the platform's app-data folder, named after the app:
 *   Windows  %APPDATA%\Claude, and for the Microsoft Store version
 *            %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude
 *   macOS    ~/Library/Application Support/Claude
 *   Linux    $XDG_CONFIG_HOME/Claude or ~/.config/Claude (no official app; harmless to look)
 */
export function claudeAppDataDirs({ platform, env, homedir } = here()) {
  const p = pathFor(platform);
  if (platform === 'win32') {
    const appData = env.APPDATA || p.join(homedir, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || p.join(homedir, 'AppData', 'Local');
    const dirs = [p.join(appData, 'Claude')];
    const packages = p.join(localAppData, 'Packages');
    for (const d of listDir(packages)) {
      if (d.isDirectory() && /^Claude_/i.test(d.name)) dirs.push(p.join(packages, d.name, 'LocalCache', 'Roaming', 'Claude'));
    }
    return dirs;
  }
  if (platform === 'darwin') return [p.join(homedir, 'Library', 'Application Support', 'Claude')];
  return [p.join(env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(homedir, '.config'), 'Claude')];
}

/** Every claude-code-sessions folder Claude desktop may use on this platform (existing or not). */
export function sessionRootCandidates(opts = here()) {
  const p = pathFor(opts.platform);
  return claudeAppDataDirs(opts).map((d) => p.join(d, 'claude-code-sessions'));
}

/** Claude Code's own transcripts: ~/.claude/projects on every platform. */
export function projectsDir({ platform, homedir } = here()) {
  return pathFor(platform).join(homedir, '.claude', 'projects');
}

/** The name(s) Claude Code's executable has here (npm's claude.cmd shim is resolved by brain.js). */
export const claudeNames = (platform = process.platform) => (platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']);

/**
 * Folders Claude Code is commonly installed in that a Mac app started from Finder or the Dock does
 * not see on its PATH (it gets only /usr/bin:/bin:/usr/sbin:/sbin, not the login shell's PATH).
 * In order: the native installer, the old local install, Homebrew (Apple silicon, then Intel), and
 * npm's user prefix. Linux gets the same minus Homebrew's macOS paths. Windows: the native
 * installer's folder (it adds it to the user's PATH, which a running Orbit doesn't see until it
 * restarts, so a Claude Code installed while Orbit runs is found at once).
 */
export function wellKnownBinDirs({ platform, homedir } = here()) {
  if (platform === 'win32') return [path.win32.join(homedir, '.local', 'bin')];
  const p = pathFor(platform);
  return [
    p.join(homedir, '.local', 'bin'),
    p.join(homedir, '.claude', 'local'),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
    '/usr/local/bin',
    p.join(homedir, '.npm-global', 'bin'),
  ];
}

/**
 * Copies of Claude Code bundled with the Claude desktop app, newest version first:
 *   <Claude app data>/claude-code/<x.y.z>/claude(.exe)  or  .../<x.y.z>/<build id>/claude(.exe)
 * (the build-id folder is how the Windows app lays it out; the Mac app uses the same folder names).
 */
export function desktopClaudeCandidates(opts = here()) {
  const p = pathFor(opts.platform);
  const exe = opts.platform === 'win32' ? 'claude.exe' : 'claude';
  const out = [];
  for (const dir of claudeAppDataDirs(opts)) {
    const root = p.join(dir, 'claude-code');
    const versions = listDir(root)
      .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
      .map((d) => d.name)
      .sort(compareVersions)
      .reverse();
    for (const v of versions) {
      out.push(p.join(root, v, exe));
      for (const sub of listDir(p.join(root, v))) if (sub.isDirectory()) out.push(p.join(root, v, sub.name, exe));
    }
  }
  return out;
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// ---- the login shell's PATH (macOS) -------------------------------------------------------------
// A Mac app opened from Finder doesn't inherit the PATH your terminal has, so `claude` (and the
// `node` an npm-installed Claude Code needs) can be missing. Orbit asks your login shell for its
// PATH once, with a time limit, and remembers it. Only absolute folders are kept. The PATH itself is
// never logged (only how many folders it had).

const MARK_A = '__ORBIT_PATH_START__';
const MARK_B = '__ORBIT_PATH_END__';
let shellPathCache = null; // { key, dirs }
let shellPathJob = null;

/** The command that prints the login shell's PATH between markers (shell startup noise is ignored). */
export function loginShellCommand({ env } = here()) {
  const shell = typeof env.SHELL === 'string' && path.posix.isAbsolute(env.SHELL) && !/[\s'"`$;&|<>]/.test(env.SHELL) ? env.SHELL : '/bin/zsh';
  return { file: shell, args: ['-ilc', `printf '%s%s%s' '${MARK_A}' "$PATH" '${MARK_B}'`] };
}

/** The folders in that shell output (absolute ones only, no duplicates). */
export function parseShellPath(out) {
  const s = String(out || '');
  const a = s.lastIndexOf(MARK_A);
  const b = a >= 0 ? s.indexOf(MARK_B, a) : -1;
  if (a < 0 || b < 0) return [];
  const dirs = s.slice(a + MARK_A.length, b).split(':').map((d) => d.trim()).filter((d) => d && path.posix.isAbsolute(d) && !/[\0\r\n]/.test(d));
  return [...new Set(dirs)].slice(0, 200);
}

/**
 * The login shell's PATH folders, asked once and cached (macOS only; [] elsewhere). Synchronous,
 * with a short time limit; primeLoginShellPath() fetches it in the background at startup so this
 * normally just reads the cache. `spawnSyncImpl` is for tests.
 */
export function loginShellPath({ platform, env, timeoutMs = 3000, spawnSyncImpl = spawnSync, log = () => {} } = here()) {
  if (platform !== 'darwin') return [];
  const key = `${env.SHELL || ''}`;
  if (shellPathCache && shellPathCache.key === key) return shellPathCache.dirs;
  const { file, args } = loginShellCommand({ env });
  let dirs = [];
  try {
    const r = spawnSyncImpl(file, args, { env: { ...env, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    dirs = parseShellPath(r?.stdout);
  } catch {
    dirs = [];
  }
  shellPathCache = { key, dirs };
  log(`login shell PATH: ${dirs.length} folders`);
  return dirs;
}

/** Start asking the login shell in the background (macOS), so the first findClaude doesn't wait. */
export function primeLoginShellPath({ platform, env, timeoutMs = 5000, execFileImpl = execFile, log = () => {} } = here()) {
  if (platform !== 'darwin') return Promise.resolve([]);
  const key = `${env.SHELL || ''}`;
  if (shellPathCache && shellPathCache.key === key) return Promise.resolve(shellPathCache.dirs);
  if (shellPathJob) return shellPathJob;
  const { file, args } = loginShellCommand({ env });
  shellPathJob = new Promise((resolve) => {
    try {
      execFileImpl(file, args, { env: { ...env, TERM: 'dumb' }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (_err, stdout) => {
        const dirs = parseShellPath(stdout);
        if (!shellPathCache || shellPathCache.key !== key) shellPathCache = { key, dirs };
        log(`login shell PATH: ${dirs.length} folders`);
        resolve(shellPathCache.dirs);
      });
    } catch {
      resolve([]);
    }
  }).finally(() => {
    shellPathJob = null;
  });
  return shellPathJob;
}

/** Tests only: forget the cached login-shell PATH. */
export function resetLoginShellPath() {
  shellPathCache = null;
  shellPathJob = null;
}

/**
 * The folders to look for programs in: this process's PATH, then (macOS) the login shell's PATH
 * and the well-known install folders. On Windows just PATH.
 */
export function searchDirs({ platform, env, homedir, shellPath } = here()) {
  const sep = platform === 'win32' ? ';' : ':';
  const own = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  if (platform === 'win32') return [...new Set([...own, ...wellKnownBinDirs({ platform, homedir })])];
  const shell = platform === 'darwin' ? (shellPath ?? loginShellPath({ platform, env })) : [];
  return [...new Set([...own, ...shell, ...wellKnownBinDirs({ platform, homedir })])];
}

/**
 * The environment for a child process (Claude Code): `base` with PATH widened as searchDirs does on
 * macOS, so an npm-installed Claude Code finds its `node`, and Claude Code finds git and the rest.
 * Windows: unchanged.
 */
export function childEnv(base = process.env, opts = {}) {
  const o = { platform: process.platform, env: base, homedir: os.homedir(), ...opts };
  if (o.platform === 'win32') return { ...base };
  return { ...base, PATH: searchDirs({ ...o, env: base }).join(':') };
}

// ---- ending a process and everything it started -------------------------------------------------

const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');

/** Spawn options so killTree can end the whole tree: on macOS/Linux its own process group. */
export const groupOptions = (platform = process.platform) => (platform === 'win32' ? {} : { detached: true });

/**
 * End `child` and everything it started (Claude Code runs ripgrep and other helpers).
 *   Windows: taskkill /T /F on its pid.
 *   macOS/Linux: the child was spawned detached (groupOptions), so it leads its own process group;
 *   SIGTERM goes to the whole group (-pid), then SIGKILL a moment later if anything is left.
 *   `sync` (Orbit is exiting): straight to SIGKILL / a waited-for taskkill.
 * A child without a pid (never started, or a test double) gets a plain kill().
 */
export function killTree(child, { sync = false, platform = process.platform, spawnImpl = spawn, spawnSyncImpl = spawnSync, killImpl = process.kill.bind(process), graceMs = 2000 } = {}) {
  if (!child) return;
  const pid = child.pid;
  if (pid && platform === 'win32') {
    const args = ['/pid', String(pid), '/T', '/F'];
    try {
      if (sync) spawnSyncImpl(TASKKILL, args, { windowsHide: true, timeout: 5000 });
      else spawnImpl(TASKKILL, args, { windowsHide: true, stdio: 'ignore' }).on?.('error', () => {});
      return;
    } catch { /* fall back to a plain kill */ }
  } else if (pid && Number.isInteger(pid) && pid > 1) {
    try {
      killImpl(-pid, sync ? 'SIGKILL' : 'SIGTERM');
      if (!sync) {
        const t = setTimeout(() => {
          try {
            killImpl(-pid, 'SIGKILL');
          } catch { /* the group is gone */ }
        }, graceMs);
        t.unref?.();
      }
      return;
    } catch { /* not a group leader (or gone): fall back to a plain kill */ }
  }
  try {
    child.kill(sync ? 'SIGKILL' : undefined);
  } catch { /* gone */ }
}

// ---- small platform touches ----------------------------------------------------------------------

/** tar for unpacking the speech models: Windows' own tar.exe by full path, /usr/bin/tar elsewhere. */
export const tarPath = (platform = process.platform, env = process.env) => (platform === 'win32' ? path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar');

const MAC_MODS = { Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', AltGr: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Super: '⌘', Meta: '⌘' };
const MAC_ORDER = ['⌃', '⌥', '⇧', '⌘'];

/**
 * An Electron accelerator as people read it: "Ctrl+Alt+G" on Windows, "⌃⌥G" on a Mac (modifiers in
 * Apple's order: Control, Option, Shift, Command).
 */
export function hotkeyLabel(accel = '', platform = process.platform) {
  const s = String(accel || '');
  if (platform !== 'darwin') return s.replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl').replace(/Super|Meta/g, 'Win');
  const parts = s.split('+').filter(Boolean);
  const mods = new Set();
  const keys = [];
  for (const part of parts) {
    if (MAC_MODS[part]) mods.add(MAC_MODS[part]);
    else keys.push(part.length === 1 ? part.toUpperCase() : part);
  }
  return `${MAC_ORDER.filter((m) => mods.has(m)).join('')}${keys.join('+')}`;
}

/** The plain words for "the Claude app can't be controlled here" (desktop.js, tools). */
export function desktopUnsupportedMessage(platform = process.platform) {
  if (platform === 'darwin') {
    return "Typing into Claude isn't on Mac yet. In this version Orbit can't type, send, press Stop, switch sessions or answer Claude's prompts in the Claude app on a Mac. It can still hear what your sessions are doing, ask the second brain and search the web. Tell the user that in one short sentence; if it helps, read the prompt out so they can type or paste it themselves.";
  }
  return 'Controlling the Claude app is only implemented for Windows so far.';
}
