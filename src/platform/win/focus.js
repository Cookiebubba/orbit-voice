// Runs focus.ps1 (the WinEvent hook helper) and turns its lines into calls: onFocus(win) when the
// window in front changes, onSwitching(bool) around Alt+Tab, onGone(hwnds) when reported windows
// close. describe(hwnd) and list() ask it about windows. Restarts the helper if it dies (at most 5
// times a minute), like electron/claude-window.js.

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// In the installed app this file is inside app.asar, which PowerShell can't read; the script is
// unpacked next to it (see "asarUnpack" in package.json).
export const FOCUS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'focus.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
export const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const REQUEST_MS = 5000;

/**
 * `spawnHelper` (tests): returns a stand-in child ({ stdin, stdout, on('exit') }) or null for the
 * real helper. `parentPid`: Orbit's own process, whose windows report as kind "orbit".
 */
export function createWinFocusTracker({ onFocus = () => {}, onSwitching = () => {}, onGone = () => {}, onWins = () => {}, onError = () => {}, spawnHelper = null, parentPid = process.pid } = {}) {
  let child = null;
  let stopped = true;
  let restarts = [];
  let nextId = 1;
  let watching = []; // the windows Qubit is in, replayed after a restart
  const pending = new Map(); // id -> { resolve, timer }

  const onLine = (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return; // a partial or stray line
    }
    if (!j || typeof j !== 'object') return;
    if (j.fg && typeof j.fg === 'object') return onFocus(Number.isFinite(j.idle) ? { ...j.fg, idle: j.idle } : j.fg);
    if (typeof j.switching === 'boolean') return onSwitching(j.switching);
    if (Array.isArray(j.gone)) return onGone(j.gone.filter(Number.isFinite));
    if (Array.isArray(j.wins)) return onWins(j.wins.filter((w) => w && Number.isFinite(w.hwnd)));
    if (Number.isFinite(j.id) && pending.has(j.id)) {
      const p = pending.get(j.id);
      pending.delete(j.id);
      clearTimeout(p.timer);
      p.resolve(j);
    }
  };

  const start = () => {
    if (process.platform !== 'win32' && !spawnHelper) return;
    try {
      child = spawnHelper?.() || spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_SCRIPT, '-ParentPid', String(parentPid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      child = null;
      return onError(`The focus watcher could not start: ${String(e?.message || e).slice(0, 160)}`);
    }
    const me = child;
    me.stdin?.on?.('error', () => {});
    let err = '';
    me.stderr?.on?.('data', (d) => {
      if (err.length < 4000) err += d;
    });
    readline.createInterface({ input: me.stdout }).on('line', onLine);
    if (watching.length) {
      try {
        me.stdin.write(`watch 0 ${watching.join(',')}\n`);
      } catch {}
    }
    me.on('exit', (code) => {
      if (child === me) child = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ id, error: 'helper_exited' });
      }
      pending.clear();
      if (stopped) return;
      restarts = restarts.filter((t) => Date.now() - t < 60_000).concat(Date.now());
      if (restarts.length > 5) return onError(`The focus watcher keeps stopping (exit ${code}). ${err.trim().split('\n')[0] || ''}`.trim());
      setTimeout(() => {
        if (!stopped) start();
      }, 1000).unref?.();
    });
  };

  /** Ask the helper something; resolves with its answer object ({ error } on a timeout). */
  const request = (cmd) =>
    new Promise((resolve) => {
      if (!child) return resolve({ error: 'not_running' });
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ id, error: 'timeout' });
      }, REQUEST_MS);
      timer.unref?.();
      pending.set(id, { resolve, timer });
      try {
        child.stdin.write(`${cmd.replace('#', String(id))}\n`);
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ id, error: 'not_running' });
      }
    });

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      restarts = [];
      start();
    },
    stop() {
      stopped = true;
      try {
        child?.stdin.end();
      } catch {}
      try {
        child?.kill();
      } catch {}
      child = null;
    },
    /** One window, now (null if it's gone). */
    async describe(hwnd) {
      const h = Math.floor(Number(hwnd));
      if (!(h > 0)) return null;
      const r = await request(`describe # ${h}`);
      return r.describe && typeof r.describe === 'object' ? r.describe : null;
    },
    /** Follow these windows' moves (Qubit lives on them): onWins gets their bounds on every change. */
    async watch(hwnds) {
      watching = [...new Set((Array.isArray(hwnds) ? hwnds : []).map((h) => Math.floor(Number(h))).filter((h) => h > 0))].slice(0, 16);
      const r = await request(`watch # ${watching.length ? watching.join(',') : '-'}`);
      return Number.isFinite(r.watching) ? r.watching : -1;
    },
    /** Bring a window to the front (only on the user's request): { switched, how } or { error }. */
    async switchTo(hwnd) {
      const h = Math.floor(Number(hwnd));
      if (!(h > 0)) return { error: 'no_window' };
      const r = await request(`switch # ${h}`);
      return r.error ? { error: r.error } : { switched: !!r.switched, how: String(r.how || '') };
    },
    /** The app windows Alt+Tab would show, front first. */
    async list() {
      const r = await request('list #');
      return Array.isArray(r.list) ? r.list : [];
    },
    get running() {
      return !stopped && !!child;
    },
  };
}
