// Runs claude-window.ps1 and reports the Claude window's state ({ found, hwnd, min, front, x, y,
// w, h } in real screen pixels) whenever it changes. Restarts the watcher if it dies.

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// In the installed app this file is inside app.asar, which PowerShell can't read; the script
// is unpacked next to it (see "asarUnpack" in package.json).
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-window.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function createClaudeWindowTracker({ onChange, onError = () => {} }) {
  let child = null;
  let stopped = true;
  let restarts = [];

  const start = () => {
    if (process.platform !== 'win32') return;
    child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const s = JSON.parse(line);
        if (s && typeof s.found === 'boolean') onChange(s);
      } catch { /* ignore a partial line */ }
    });
    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      // Restart, but give up after 5 crashes in a minute (and say why).
      restarts = restarts.filter((t) => Date.now() - t < 60_000).concat(Date.now());
      if (restarts.length > 5) return onError(`The Claude window watcher keeps stopping (exit ${code}). ${err.trim().split('\n')[0] || ''}`.trim());
      setTimeout(() => { if (!stopped) start(); }, 1000);
    });
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      restarts = [];
      start();
    },
    stop() {
      stopped = true;
      try { child?.kill(); } catch { /* already gone */ }
      child = null;
    },
    get running() { return !stopped; },
  };
}
