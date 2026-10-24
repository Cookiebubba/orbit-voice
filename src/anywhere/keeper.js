// Orbit's side of the pipe keeper (see keeper-core.js for what the keeper is and why).
//
//   - Apps under Orbit: an app the user approved once ("Restart Discord under Orbit so it can type
//     and look without your mouse?"), remembered in settings (anywhereUnderOrbit: program names).
//     Orbit never starts an app under a keeper without that approval, and the user can take it back
//     (Settings, or by voice): the app is then started normally again.
//   - Starting one: Orbit closes the running app (gently first), then starts a keeper (detached, so
//     it outlives Orbit) with the app's own program and arguments. The keeper's one-time token is
//     kept in Orbit's settings folder, encrypted with the same Windows protection as Orbit's keys.
//   - Using one: pageSession(win) connects to the keeper that holds the window's app, attaches to the
//     page whose title is the window's, and returns { call(method, params), close() }.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getConfigDir, getSetting, onSettingsChange, updateSettings } from '../config.js';
import { cleanArgs } from './keeper-core.js';

export const KEEPER_TIMING = Object.freeze({ startMs: 20_000, connectMs: 3000, callMs: 4000, closeMs: 5000 });

// ---- how keepers are started (Electron: the app itself with --orbit-keeper; tests: plain Node) ----
let launcher = null; // { execPath, preArgs: [] }
export function setKeeperLauncher(l) {
  launcher = l && typeof l.execPath === 'string' ? { execPath: l.execPath, preArgs: Array.isArray(l.preArgs) ? l.preArgs : [] } : null;
  primeApprovals();
}
// Tokens at rest: encrypted with the shell's protection (Electron safeStorage) when it gives one.
let crypt = { protect: (s) => s, unprotect: (s) => s };
export function setKeeperCrypto(c) {
  if (c && typeof c.protect === 'function' && typeof c.unprotect === 'function') crypt = c;
}

const configDir = () => getConfigDir() || '';
const stateDir = () => (configDir() ? path.join(configDir(), 'keepers') : '');
const tokenFile = () => path.join(configDir(), 'keeper-tokens.json');
const alive = (pid) => {
  const n = Math.floor(Number(pid)) || 0;
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
};
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
function saveToken(id, token) {
  const all = readJson(tokenFile(), {});
  all[id] = crypt.protect(token);
  for (const k of Object.keys(all)) if (k !== id && !fs.existsSync(path.join(stateDir(), `${k}.json`))) delete all[k];
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(all), { mode: 0o600 });
}
function tokenOf(id) {
  const v = readJson(tokenFile(), {})[id];
  if (typeof v !== 'string') return '';
  try {
    return crypt.unprotect(v);
  } catch {
    return '';
  }
}

/** Program name an approval is kept under: "discord.exe". */
export const appIdOf = (exeOrWin) => path.basename(String(exeOrWin?.exe ?? exeOrWin ?? '')).toLowerCase();

/** Running keepers (stale state files of dead ones are removed). */
export function keepers() {
  if (!stateDir()) return [];
  let files = [];
  try {
    files = fs.readdirSync(stateDir()).filter((f) => /^[a-f0-9]{8,64}\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const s = readJson(path.join(stateDir(), f), null);
    if (s && alive(s.keeperPid) && alive(s.appPid)) out.push(s);
    else if (s && !alive(s.keeperPid)) fs.rmSync(path.join(stateDir(), f), { force: true });
  }
  return out;
}
/** The keeper that holds the app this window belongs to (its process), or null. */
export const keeperForWindow = (win) => keepers().find((k) => Number(k.appPid) === Number(win?.pid)) || null;

// ---- approvals ----
export const approvedApps = () => (Array.isArray(getSetting('anywhereUnderOrbit')) ? getSetting('anywhereUnderOrbit') : []);
// An approval taken back (Settings, or release_app_from_orbit): that app goes back to normal.
let lastApproved = null;
onSettingsChange((changed) => {
  if (!changed.includes('anywhereUnderOrbit')) return;
  const now = approvedApps();
  for (const gone of (lastApproved || []).filter((a) => !now.includes(a))) releaseFromOrbit(gone).catch(() => {});
  lastApproved = now;
});
export function primeApprovals() {
  lastApproved = approvedApps();
}
export const isApproved = (win) => approvedApps().includes(appIdOf(win));
export function approveApp(win) {
  const id = appIdOf(win);
  if (id && !approvedApps().includes(id)) updateSettings({ anywhereUnderOrbit: [...approvedApps(), id] });
}
export function revokeApp(id) {
  const k = appIdOf(id);
  updateSettings({ anywhereUnderOrbit: approvedApps().filter((a) => a !== k) });
}

// ---- processes (Windows: read-only process info; closing an app the user approved restarting) ----
function processInfo(pid, { exec = execFile } = {}) {
  const id = Math.floor(Number(pid)) || 0;
  if (!id || process.platform !== 'win32') return Promise.resolve(null);
  const ps = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${id}"; if($p){[pscustomobject]@{exe=$p.ExecutablePath;cmd=$p.CommandLine;parent=$p.ParentProcessId}|ConvertTo-Json -Compress}`;
  return new Promise((resolve) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, out) => {
    try {
      resolve(err ? null : JSON.parse(String(out || '').trim()));
    } catch {
      resolve(null);
    }
  }));
}

/** The arguments on a Windows command line after the program itself. */
export function argsAfterProgram(cmd) {
  const s = String(cmd || '').trim();
  const rest = s.startsWith('"') ? s.slice(s.indexOf('"', 1) + 1) : s.replace(/^\S+/, '');
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(rest))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function taskkill(pid, force) {
  return new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, timeout: 8000 }, () => resolve()));
}
/** Close an app (its whole process tree): gently, then for sure. Resolves once it's gone. */
async function closeApp(pid) {
  await taskkill(pid, false);
  for (let i = 0; i < KEEPER_TIMING.closeMs / 100 && alive(pid); i++) await sleep(100);
  if (alive(pid)) await taskkill(pid, true);
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  await sleep(400); // its helper processes and single-instance lock let go
  return !alive(pid);
}

/**
 * Start `exe` (with `args`) under a new keeper. Resolves its state ({ id, appPid, pipe, ... }) once
 * the keeper is serving, or throws.
 */
export async function startUnderKeeper({ exe, args = [], cwd = '', app = '' }, { spawnImpl = spawn } = {}) {
  if (!launcher) throw new Error('Orbit can\x27t start apps under its control here.');
  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  saveToken(id, token);
  // Its settings go in a file only this user can read, which the keeper deletes as soon as it has
  // read it (the Windows app process gets no stdin); only the file's path is on its command line.
  fs.mkdirSync(stateDir(), { recursive: true });
  const cfgFile = path.join(stateDir(), `${id}.start`);
  fs.writeFileSync(cfgFile, JSON.stringify({ id, token, exe, args: cleanArgs(args), cwd, stateDir: stateDir(), app }), { mode: 0o600 });
  const k = spawnImpl(launcher.execPath, [...launcher.preArgs, '--orbit-keeper', `--orbit-keeper-config=${cfgFile}`], { detached: true, stdio: 'ignore', windowsHide: true });
  k.on?.('error', () => {});
  k.unref();
  const file = path.join(stateDir(), `${id}.json`);
  for (let i = 0; i < KEEPER_TIMING.startMs / 100; i++) {
    const s = readJson(file, null);
    if (s?.pipe) return s;
    if (k.exitCode !== null && k.exitCode !== undefined) break;
    await sleep(100);
  }
  fs.rmSync(cfgFile, { force: true });
  throw new Error('The app didn\x27t start under Orbit.');
}

/**
 * Restart the app this window belongs to under Orbit (the user approved it). Resolves
 * { ok: true, state } or { ok: false, error }.
 */
export async function restartUnderOrbit(win, deps = {}) {
  if (keeperForWindow(win)) return { ok: true, state: keeperForWindow(win), already: true };
  const info = await (deps.processInfo || processInfo)(win.pid);
  if (!info?.exe) return { ok: false, error: 'Orbit couldn\x27t tell which program that window belongs to.' };
  const args = argsAfterProgram(info.cmd);
  if (!(await (deps.closeApp || closeApp)(win.pid))) return { ok: false, error: 'The app didn\x27t close, so it wasn\x27t restarted.' };
  try {
    const state = await startUnderKeeper({ exe: info.exe, args, cwd: path.dirname(info.exe), app: path.basename(info.exe) }, deps);
    return { ok: true, state };
  } catch (e) {
    // Never leave the user without the app: start it the normal way again.
    try {
      spawn(info.exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(info.exe) }).unref();
    } catch {}
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** Start an app the normal way again (the user took back its approval): closes the keeper's copy first. */
export async function releaseFromOrbit(appId) {
  const id = appIdOf(appId);
  const k = keepers().find((s) => appIdOf(s.exe) === id);
  if (!k) return { ok: true, running: false };
  await closeApp(k.appPid);
  try {
    spawn(k.exe, Array.isArray(k.args) ? k.args : [], { detached: true, stdio: 'ignore', cwd: path.dirname(k.exe) }).unref();
  } catch {}
  return { ok: true, running: true };
}

// ---- talking to a keeper ----
/** Connects to a keeper: { call(method, params, sessionId), close() }. */
export function connectKeeper(state, { connect = net.connect } = {}) {
  const token = tokenOf(state.id);
  if (!token) return Promise.reject(new Error('Orbit lost the key to that app\x27s control. Restart it under Orbit again.'));
  return new Promise((resolve, reject) => {
    const sock = connect(state.pipe);
    const waiting = new Map();
    let buf = '';
    let n = 1 + crypto.randomInt(1e6); // ids of an old connection never match a new one's
    let ready = false;
    const fail = (e) => {
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
      if (!ready) reject(e);
    };
    const t = setTimeout(() => (sock.destroy(), fail(new Error('The app under Orbit didn\x27t answer.'))), KEEPER_TIMING.connectMs);
    sock.setEncoding('utf8');
    sock.on('error', (e) => (clearTimeout(t), fail(e)));
    sock.on('close', () => (clearTimeout(t), fail(new Error('The app under Orbit closed.'))));
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (!ready && m.keeper === 'ok') {
          ready = true;
          clearTimeout(t);
          resolve(api);
          continue;
        }
        const w = m.id && waiting.get(m.id);
        if (!w) continue;
        waiting.delete(m.id);
        if (m.error) w.reject(new Error(`${w.method}: ${String(m.error.message || 'failed').slice(0, 120)}`));
        else w.resolve(m.result || {});
      }
    });
    const api = {
      call(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const id = ++n;
          const timer = setTimeout(() => (waiting.delete(id), rej(new Error(`${method} timed out`))), KEEPER_TIMING.callMs);
          waiting.set(id, { method, resolve: (v) => (clearTimeout(timer), res(v)), reject: (e) => (clearTimeout(timer), rej(e)) });
          sock.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\n`);
        });
      },
      close: () => sock.destroy(),
    };
    sock.write(`${JSON.stringify({ token })}\n`);
  });
}

/** The page target that is this window: same title, or what the window title starts with, or the only page. */
export function pickPage(targets, title) {
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t?.type === 'page');
  const want = String(title || '').trim();
  const t = (x) => String(x.title || '').trim();
  return (
    pages.find((x) => want && t(x) === want) ||
    pages.filter((x) => t(x) && want.startsWith(`${t(x)} `)).sort((a, b) => t(b).length - t(a).length)[0] ||
    (pages.length === 1 ? pages[0] : null) ||
    pages.find((x) => !/^devtools:|^chrome-extension:/.test(String(x.url || ''))) ||
    null
  );
}

/**
 * A DevTools session on the page this window shows, through its app's keeper: { call(method,
 * params), close() }, or null if the window's app isn't under Orbit.
 */
export async function pageSession(win, deps = {}) {
  const state = keeperForWindow(win);
  if (!state) return null;
  const conn = await connectKeeper(state, deps);
  try {
    const { targetInfos } = await conn.call('Target.getTargets');
    const page = pickPage(targetInfos, win?.title);
    if (!page) throw new Error('Couldn\x27t tell which page of that app is the window.');
    const { sessionId } = await conn.call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    return {
      via: 'pipe',
      call: (method, params) => conn.call(method, params, sessionId),
      // Browser-level calls (where the window is): to the app itself, about this page.
      browserCall: (method, params = {}) => conn.call(method, { ...params, targetId: page.targetId }),
      close: () => {
        conn.call('Target.detachFromTarget', { sessionId }).catch(() => {}).finally(() => conn.close());
      },
    };
  } catch (e) {
    conn.close();
    throw e;
  }
}
