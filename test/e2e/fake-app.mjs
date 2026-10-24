// Starts the "Orbit anywhere" test windows (test/e2e/FakeApp.cs): ordinary app windows of our own,
// so focus tracking, reading and mouse-free actions are only ever tested against windows the tests
// start themselves. Built once per process with .NET Framework's csc into a temp folder.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.env.SystemRoot || 'C:\\Windows';
const NET = path.join(WIN, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const CSC = path.join(NET, 'csc.exe');
export const POWERSHELL = path.join(WIN, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Can this machine build and show the test windows (Windows with .NET Framework 4)? */
export const canRunApps = () => process.platform === 'win32' && fs.existsSync(CSC);

let built = null;
export function buildFakeApp() {
  if (built) return built;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-fake-app-'));
  const exe = path.join(dir, 'OrbitFakeApp.exe');
  const wpf = ['PresentationFramework', 'PresentationCore', 'WindowsBase', 'UIAutomationProvider', 'UIAutomationTypes'].map((n) => `/r:${path.join(NET, 'WPF', `${n}.dll`)}`);
  const args = ['/nologo', '/optimize', '/target:winexe', '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', `/r:${path.join(NET, 'System.Xaml.dll')}`, ...wpf, `/out:${exe}`, path.join(ROOT, 'test', 'e2e', 'FakeApp.cs')];
  const r = spawnSync(CSC, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`could not build the test app:\n${r.stdout}${r.stderr}`);
  built = exe;
  return exe;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a test window: kind 'winforms' (classic Win32 controls) or 'wpf'. Returns { pid, hwnd,
 * events, send(cmd), state(), waitFor(pred), close() }. `events`: what happened in it, in order.
 */
export async function startFakeApp(kind = 'winforms', title = 'ORBIT-TEST', { onscreen = false } = {}) {
  const exe = buildFakeApp();
  const child = spawn(exe, [`--${kind}`, title, ...(onscreen ? ['--onscreen'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  const acks = new Set();
  let ready = null;
  let lastState = null;
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      return;
    }
    if (j.ready) ready = j;
    else if (j.event) events.push(j);
    else if (j.state) lastState = j.state;
    else if (j.ok) acks.add(j.ok);
  });
  for (let i = 0; i < 300 && !ready; i++) await sleep(50);
  if (!ready) {
    child.kill();
    throw new Error('the test app did not start');
  }
  let sent = 0;
  const api = {
    pid: ready.pid,
    hwnd: ready.hwnd,
    kind,
    events,
    async send(cmd) {
      const n = ++sent;
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
      for (let i = 0; i < 250 && !acks.has(n); i++) await sleep(20);
    },
    async state() {
      lastState = null;
      await api.send({ state: true });
      return lastState;
    },
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const hit = events.find(pred);
        if (hit) return hit;
        await sleep(25);
      }
      return null;
    },
    async close() {
      try {
        child.stdin.write('{"quit":true}\n');
      } catch {}
      await sleep(250);
      try {
        child.kill();
      } catch {}
    },
  };
  return api;
}

/** Milliseconds since the user last touched the mouse or keyboard (GetLastInputInfo). */
export function userIdleMs() {
  const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class Idle{[StructLayout(LayoutKind.Sequential)]struct L{public uint s;public uint t;}[DllImport("user32.dll")]static extern bool GetLastInputInfo(ref L l);public static uint Ms(){L l=new L();l.s=8;GetLastInputInfo(ref l);return (uint)Environment.TickCount-l.t;}}';[Idle]::Ms()`;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) ? n : 0;
}
