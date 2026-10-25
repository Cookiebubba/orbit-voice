// Starts the test chat app (test/e2e/slate-input/): our own Electron window, Discord-like, with a
// Slate.js message box and a React search box that only notice real input events. Tests of Orbit's
// web input run against it only, never another app's window.
//   startSlateApp(title, { pipe: true })  CDP over --remote-debugging-pipe on fds 3 and 4 (returned as app.pipe)
//   startSlateApp(title, { port: N })     a debugging port, as a user could start an app with one
//   startSlateApp(title, { spawnApp })    started by someone else (Orbit's launcher): only watched
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SLATE_MAIN = path.join(ROOT, 'test', 'e2e', 'slate-input', 'main.cjs');
export const electronPath = () => createRequire(path.join(ROOT, 'package.json'))('electron');

/** The app's command line (for a launcher to use): [exe, args]. */
export function slateCommand(title, { userDataDir = '', extra = [] } = {}) {
  return [electronPath(), [...extra, SLATE_MAIN, title, `--user-data-dir=${userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-slate-profile-'))}`]];
}

/** Watches a running app's stdout lines: { ready, state(), events, waitFor(pred, ms) }. */
export function watchApp(stdout) {
  const w = { ready: null, last: null, events: [] };
  readline.createInterface({ input: stdout }).on('line', (l) => {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      return;
    }
    if (j.ready) w.ready = j;
    else if (j.state) w.last = j.state;
    else if (j.event) w.events.push(j);
    else if (j.secondInstance) w.events.push({ event: 'second-instance-quit' });
  });
  return w;
}

/** { pid, hwnd, title, state(), waitFor(pred, ms), events, pipe?, close() } */
export async function startSlateApp(title = `ORBIT-SLATE-${process.pid}`, { pipe = false, port = 0, x = 60, y = 60, userDataDir = '', args: more = [] } = {}) {
  const [exe, base] = slateCommand(title, { userDataDir, extra: [...(pipe ? ['--remote-debugging-pipe'] : []), ...(port ? [`--remote-debugging-port=${port}`] : [])] });
  const args = [...base, ...more]; // (after the app's own path: they're the app's arguments)
  const env = { ...process.env, SLATE_X: String(x), SLATE_Y: String(y) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe', ...(pipe ? ['pipe', 'pipe'] : [])], env, windowsHide: false });
  child.stderr.on('data', () => {});
  const w = watchApp(child.stdout);
  for (let i = 0; i < 400 && !(w.ready && w.last); i++) await sleep(50);
  if (!w.ready) {
    child.kill();
    throw new Error('the test chat app did not start');
  }
  return {
    pid: w.ready.pid,
    hwnd: Number(w.ready.hwnd),
    title,
    events: w.events,
    child,
    pipe: pipe ? { write: child.stdio[3], read: child.stdio[4] } : null,
    state: () => w.last,
    async waitFor(pred, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (w.last && pred(w.last)) return true;
        await sleep(50);
      }
      return false;
    },
    async close() {
      try {
        child.stdin.write('quit\n');
      } catch {}
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
      if (child.exitCode === null) child.kill();
      // (Never left running: whatever process the app reported as its own goes too.)
      for (const pid of [this.pid, child.pid]) {
        try {
          if (pid) process.kill(pid);
        } catch {}
      }
    },
  };
}
