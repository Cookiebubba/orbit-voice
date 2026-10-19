// "Mute my mic in other apps while Grok listens": drives mic-steal.ps1. While stealing, other
// apps' microphone streams are muted; on release (or if Orbit quits or crashes) exactly those are
// unmuted again. A run that died hard is undone at the next launch (recover()).

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mic-steal.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];

export function createMicSteal({ stateFile, ownExe = process.execPath, onResult = () => {}, onError = () => {} }) {
  let child = null;
  let want = false; // should other apps be muted right now?
  let rules = null; // the last rules command (see src/mic-apps.js), replayed after a restart

  const ensure = () => {
    if (child || process.platform !== 'win32') return;
    child = spawn(POWERSHELL, [...ARGS, '-OwnExe', ownExe, '-StateFile', stateFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    if (rules) child.stdin.write(`${rules}\n`); // rules first, so the first steal already follows them
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try { onResult(JSON.parse(line)); } catch { /* ignore */ }
    });
    child.on('exit', (code) => {
      child = null;
      if (code && err) onError(`Mic steal helper stopped (exit ${code}): ${err.trim().split('\n')[0]}`);
      if (want) setTimeout(() => { if (want) { ensure(); send('steal'); } }, 1000);
    });
  };
  const send = (cmd) => { try { child?.stdin.write(`${cmd}\n`); } catch { /* restarting */ } };

  return {
    /** Mute (true) or give back (false) other apps' microphones. */
    set(active) {
      if (active === want) return;
      want = active;
      if (active) { ensure(); send('steal'); } else send('release');
    },
    /** Turned off in Settings, or Orbit is quitting: give everything back and stop the helper. */
    stop() {
      want = false;
      if (!child) return;
      send('release');
      try { child.stdin.end(); } catch { /* gone */ } // the helper unmutes again on exit, then quits
      child = null;
    },
    /** Which apps may be muted (a rules command from src/mic-apps.js). Applies at once while stealing. */
    setRules(command) {
      if (command === rules) return;
      rules = command;
      send(command);
    },
    /** The apps that have a microphone stream open (for Settings), without changing anything. */
    listApps() {
      return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve([]);
        const p = spawn(POWERSHELL, [...ARGS, '-OwnExe', ownExe, '-OnlyExe', 'C:\\nothing\\nobody.exe'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        const timer = setTimeout(() => { p.kill(); resolve([]); }, 15000);
        readline.createInterface({ input: p.stdout }).on('line', (line) => {
          if (!line.startsWith('{"sessions"')) return;
          clearTimeout(timer);
          try { resolve(JSON.parse(line).sessions); } catch { resolve([]); }
          p.stdin.end();
        });
        p.stdin.on('error', () => {});
        p.stdin.write('list\n');
      });
    },
    /** At startup: undo anything a crashed run left muted. */
    recover() {
      if (process.platform !== 'win32') return;
      const p = spawn(POWERSHELL, [...ARGS, '-OwnExe', ownExe, '-StateFile', stateFile, '-Recover'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      readline.createInterface({ input: p.stdout }).on('line', (line) => { try { onResult(JSON.parse(line)); } catch { /* ignore */ } });
    },
  };
}
