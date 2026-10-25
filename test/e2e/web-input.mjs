// Starts the test web app (test/e2e/web-input/): our own Electron window with a contenteditable
// editor and a controlled textarea that only notice real input events. Tests of Orbit's web input
// run against it only, never another app's window.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** { pid, hwnd, state(), waitFor(pred, ms), events, close() } */
export async function startWebInputApp(title = `ORBIT-WEB-INPUT-${process.pid}`, { cdpPort = 0, x = 40, y = 40 } = {}) {
  const electron = createRequire(path.join(ROOT, 'package.json'))('electron');
  // A debugging port goes on the real command line, as a user would start an app with one.
  const args = [...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []), path.join(ROOT, 'test', 'e2e', 'web-input', 'main.cjs'), title];
  const env = { ...process.env, WEB_INPUT_X: String(x), WEB_INPUT_Y: String(y) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: false });
  let ready = null;
  let last = null;
  const events = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      return;
    }
    if (j.ready) ready = j;
    else if (j.state) last = j.state;
    else if (j.event) events.push(j);
  });
  for (let i = 0; i < 400 && !(ready && last); i++) await sleep(50);
  if (!ready) {
    child.kill();
    throw new Error('the test web app did not start');
  }
  return {
    pid: ready.pid,
    hwnd: Number(ready.hwnd),
    title,
    events,
    state: () => last,
    async waitFor(pred, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (last && pred(last)) return true;
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
