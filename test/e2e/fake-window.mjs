// Drives the stand-in Claude window (test/e2e/FakeClaude.cs --window) for tests of src/desktop.ps1
// against a real UI Automation tree. desktop.ps1 is always run with -OnlyPid <the stand-in>, so it
// never looks at, clicks or types into the real Claude app.

import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'src', 'desktop.ps1');
const WIN = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(WIN, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NET = path.join(WIN, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const CSC = path.join(NET, 'csc.exe');

/** Can this machine build and show the stand-in (Windows with .NET Framework 4)? */
export const canRun = () => process.platform === 'win32' && fs.existsSync(CSC);

/** csc arguments for FakeClaude.cs, with the WPF references its --window mode needs. */
export function cscArgs(out) {
  const wpf = ['PresentationFramework', 'PresentationCore', 'WindowsBase', 'UIAutomationProvider', 'UIAutomationTypes'].map((n) => `/r:${path.join(NET, 'WPF', `${n}.dll`)}`);
  return ['/nologo', '/optimize', '/target:exe', '/r:System.Web.Extensions.dll', `/r:${path.join(NET, 'System.Xaml.dll')}`, ...wpf, `/out:${out}`, path.join(ROOT, 'test', 'e2e', 'FakeClaude.cs')];
}

let built = null;
/** Build the stand-in once per process, into a temp folder. Never named claude.exe. */
export function buildFakeWindow() {
  if (built) return built;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-fake-window-'));
  const exe = path.join(dir, 'FakeClaudeWindow.exe');
  const r = spawnSync(CSC, cscArgs(exe), { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`could not build the stand-in window:\n${r.stdout}${r.stderr}`);
  built = exe;
  return exe;
}

/**
 * Start a stand-in window showing session `title`. Returns { pid, send(cmd), events, ps(mode, args),
 * close() }. `events`: what was pressed in it ({ event: 'stop' }, ...), in order.
 */
export async function startFakeWindow(title = 'Fake session') {
  const exe = buildFakeWindow();
  const child = spawn(exe, ['--window', title], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const events = [];
  const acks = [];
  let ready = null;
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      return;
    }
    if (j.ready) ready = j;
    else if (j.event) events.push(j);
    else if (j.ok) acks.push(j.ok);
  });
  for (let i = 0; i < 200 && !ready; i++) await new Promise((r) => setTimeout(r, 50));
  if (!ready) throw new Error('the stand-in window did not start');
  let sent = 0;
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
  return {
    pid: ready.pid,
    events,
    b64,
    /** Change the stand-in (e.g. { working: true }); resolves once it's applied. */
    async send(cmd) {
      const n = ++sent;
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
      for (let i = 0; i < 200 && !acks.includes(n); i++) await new Promise((r) => setTimeout(r, 20));
    },
    /** Run desktop.ps1 against this window only. Resolves with its JSON answer. */
    ps(mode, args = []) {
      return new Promise((resolve) => {
        execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', SCRIPT, '-Mode', mode, '-OnlyPid', String(ready.pid), ...args], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
          try {
            resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop()));
          } catch {
            resolve({ ok: false, error: 'bad_output', message: String(err?.message || stdout).slice(0, 300) });
          }
        });
      });
    },
    async close() {
      try {
        child.stdin.write('{"quit":true}\n');
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
      try {
        child.kill();
      } catch {}
    },
  };
}

/** desktop.ps1 with -OnlyPid for a process that isn't a stand-in (refusal checks). */
export function psWithPid(mode, pid) {
  return new Promise((resolve) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', SCRIPT, '-Mode', mode, '-OnlyPid', String(pid)], { windowsHide: true, timeout: 30000 }, (_e, stdout) => {
      try {
        resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop()));
      } catch {
        resolve({ ok: false, error: 'bad_output' });
      }
    });
  });
}
