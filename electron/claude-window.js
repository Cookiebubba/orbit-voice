// Runs claude-window.ps1, which reports Claude's windows whenever they change, picks the one the
// orb docks on (see claude-windows.js) and reports that one ({ found, hwnd, min, front, x, y, w, h }
// in real screen pixels). While following (see follow()), the helper moves the orb itself, on that
// window. For the avatar it also watches that window's prompt box (watchBox()) and reports
// where it is (onBox). Restarts the helper if it dies, re-sending the last commands.

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createWindowPicker } from './claude-windows.js';

// In the installed app this file is inside app.asar, which PowerShell can't read; the script
// is unpacked next to it (see "asarUnpack" in package.json).
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-window.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function createClaudeWindowTracker({ onChange, onBox = () => {}, onError = () => {}, spawnHelper = null }) {
  let child = null;
  let stopped = true;
  let restarts = [];
  let command = 'pause'; // the last instruction, replayed after a restart
  const picker = createWindowPicker();
  let current = { found: false }; // the window the orb docks on
  let following = null; // { orbHwnd, anchor } while the helper moves the orb
  let boxCommand = null; // 'box <hwnd>' while the avatar wants the prompt box watched

  const send = (line) => {
    command = line;
    try { child?.stdin.write(`${line}\n`); } catch { /* restarting; replayed on start */ }
  };
  const sendFollow = () => {
    if (!following || !current.found) return;
    const { orbHwnd, anchor } = following;
    const line = `follow ${orbHwnd} ${current.hwnd} ${anchor.corner} ${anchor.dx} ${anchor.dy}`;
    if (line !== command) send(line);
  };
  /** One report line from the helper. */
  const onLine = (line) => {
    let s;
    try {
      s = JSON.parse(line);
    } catch {
      return; // a partial line
    }
    if (s && s.box && typeof s.box === 'object') return onBox(s.box);
    if (!s || !Array.isArray(s.wins)) return;
    const next = picker.pick(s);
    const moved = next.hwnd !== current.hwnd;
    current = next;
    if (moved) sendFollow(); // onto the other window at once, before Orbit re-places the orb
    onChange(next);
  };

  const start = () => {
    if (process.platform !== 'win32' && !spawnHelper) return;
    // spawnHelper (tests) may return null to use the real helper.
    child = spawnHelper?.() || spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.write(`${command}\n`);
    if (boxCommand) child.stdin.write(`${boxCommand}\n`);
    let err = '';
    child.stderr?.on('data', (d) => { if (err.length < 4000) err += d; });
    readline.createInterface({ input: child.stdout }).on('line', onLine);
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
      command = 'pause';
      following = null;
      boxCommand = null;
      current = { found: false };
      try { child?.kill(); } catch { /* already gone */ }
      child = null;
    },
    /** Keep the orb (native window handle) at this spot on the Claude window it docks on; the helper moves it. */
    follow(orbHwnd, anchor) {
      following = { orbHwnd, anchor };
      sendFollow();
    },
    /** Stop moving the orb (hidden, free, or being dragged). */
    pause() {
      following = null;
      if (command !== 'pause') send('pause');
    },
    /** Watch this Claude window's prompt box (0: stop): its rects come to onBox as it moves. */
    watchBox(hwnd) {
      const line = `box ${Number(hwnd) > 0 ? Math.floor(Number(hwnd)) : 0}`;
      if (line === (boxCommand || 'box 0')) return;
      boxCommand = line === 'box 0' ? null : line;
      try { child?.stdin.write(`${line}\n`); } catch { /* restarting; replayed on start */ }
    },
    /** The window the orb docks on (the Claude window you were in last). */
    get current() { return current; },
    get running() { return !stopped; },
  };
}
