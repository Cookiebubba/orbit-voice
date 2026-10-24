// Runs uia.ps1 (COM UI Automation, AutoSetFocus off) and matches its answers to requests. Started on
// the first request, kept while in use and stopped after 10 idle minutes (it holds a PowerShell and
// UI Automation in memory). A request that takes too long (an app that hangs UI Automation) gets a
// "timeout" answer and the helper is restarted, so one stuck app can't block the next request.

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { POWERSHELL } from './focus.js';

export const UIA_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'uia.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

export function createUiaHost({ spawnHelper = null, cacheDir = '', parentPid = process.pid, idleMs = 10 * 60_000, requestMs = 15_000, onError = () => {} } = {}) {
  let child = null;
  let nextId = 1;
  let idleTimer = null;
  let starts = [];
  const pending = new Map(); // id -> { resolve, timer }

  const finishAll = (error) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ id, ok: false, error });
    }
    pending.clear();
  };

  const kill = () => {
    const c = child;
    child = null;
    try {
      c?.stdin.end();
    } catch {}
    try {
      c?.kill();
    } catch {}
  };

  const start = () => {
    if (child) return child;
    if (process.platform !== 'win32' && !spawnHelper) return null;
    starts = starts.filter((t) => Date.now() - t < 60_000).concat(Date.now());
    if (starts.length > 6) {
      onError('The UI Automation helper keeps stopping.');
      return null;
    }
    let c;
    try {
      c = spawnHelper?.() || spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_SCRIPT, '-ParentPid', String(parentPid), ...(cacheDir ? ['-Cache', cacheDir] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      onError(`The UI Automation helper could not start: ${String(e?.message || e).slice(0, 160)}`);
      return null;
    }
    child = c;
    c.stdin?.on?.('error', () => {});
    let err = '';
    c.stderr?.on?.('data', (d) => {
      if (err.length < 4000) err += d;
    });
    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      const p = j && pending.get(j.id);
      if (!p) return;
      pending.delete(j.id);
      clearTimeout(p.timer);
      p.resolve(j);
    });
    c.on('exit', (code) => {
      if (child === c) child = null;
      if (pending.size) {
        if (code) onError(`The UI Automation helper stopped (exit ${code}). ${err.trim().split('\n')[0] || ''}`.trim());
        finishAll('helper_exited');
      }
    });
    return c;
  };

  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!pending.size) kill();
    }, idleMs);
    idleTimer.unref?.();
  };

  return {
    /** One request ({ op, ...args }); resolves with the helper's answer ({ ok, ... } or { ok: false, error }). */
    request(op, args = {}, { timeoutMs = requestMs } = {}) {
      return new Promise((resolve) => {
        const c = start();
        if (!c) return resolve({ ok: false, error: 'unavailable', message: 'Reading other apps works only on Windows for now.' });
        touch();
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ id, ok: false, error: 'timeout', message: 'That app took too long to answer.' });
          kill(); // it may be stuck inside that app: start fresh next time
          finishAll('timeout');
        }, timeoutMs); // (not unref'd: an answer is owed)
        pending.set(id, { resolve, timer });
        try {
          c.stdin.write(`${JSON.stringify({ ...args, op, id })}\n`);
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          resolve({ id, ok: false, error: 'helper_exited' });
        }
      });
    },
    stop() {
      clearTimeout(idleTimer);
      finishAll('stopped');
      kill();
    },
    get running() {
      return !!child;
    },
  };
}
