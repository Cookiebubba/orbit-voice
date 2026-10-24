// A stand-in for src/platform/win/focus.ps1 (the focus helper), for end-to-end tests of "Orbit
// anywhere" (scripts/anywhere-e2e.mjs): the real Orbit gets it through ORBIT_FAKE_DESKTOP's
// focusHelper, but only when the harness turned it on (globalThis.__orbitE2E.focus), so the other
// end-to-end tests run without a focus helper as before. Nothing real is looked at.
//
// The harness drives it through globalThis.__orbitE2E.focus:
//   windows   Map hwnd -> { hwnd, pid, exe, title, cls, kind, min, cloaked, x, y, w, h }
//   front(hwnd)   that window comes to the front (a {"fg":...} report)
//   move(hwnd, patch)   it moves / resizes / minimizes (a {"wins":...} report if it's watched)
//   close(hwnd)   it closes ({"gone":[hwnd]}, and out of "wins")
//   watching      what Orbit asked to watch, last
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export function fakeFocusState() {
  globalThis.__orbitE2E ??= {};
  const e = globalThis.__orbitE2E;
  e.focus ??= { on: false, windows: new Map(), fg: 0, watching: [], child: null, reports: [] };
  return e.focus;
}

const describe = (w) => (w ? { hwnd: w.hwnd, owner: 0, pid: w.pid || 4000 + w.hwnd, exe: w.exe, title: w.title || '', cls: w.cls || 'FakeAppWindow', kind: w.kind || 'app', min: !!w.min, max: false, cloaked: !!w.cloaked, elevated: !!w.elevated, x: w.x, y: w.y, w: w.w, h: w.h, dpi: 96 } : { hwnd: 0, kind: 'none' });

export function focusHelper() {
  const F = fakeFocusState();
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const say = (obj) => {
    F.reports.push(obj);
    child.stdout.write(`${JSON.stringify(obj)}\n`);
  };
  const wins = () => F.watching.map((h) => F.windows.get(h)).filter(Boolean).map((w) => ({ hwnd: w.hwnd, min: !!w.min, cloaked: !!w.cloaked, x: w.x, y: w.y, w: w.w, h: w.h }));
  let buf = '';
  child.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const [cmd, id, arg] = line.split(' ');
      if (cmd === 'describe') say({ id: Number(id), describe: F.windows.has(Number(arg)) ? describe(F.windows.get(Number(arg))) : null });
      else if (cmd === 'list') say({ id: Number(id), list: [...F.windows.values()].filter((w) => !w.cloaked && (w.kind || 'app') === 'app').map(describe) });
      else if (cmd === 'watch') {
        F.watching = arg === '-' || !arg ? [] : arg.split(',').map(Number).filter((h) => h > 0);
        say({ id: Number(id), watching: F.watching.length });
        say({ wins: wins() });
      }
    }
  });
  F.front = (hwnd) => {
    F.fg = hwnd;
    say({ fg: describe(F.windows.get(hwnd)) });
  };
  F.move = (hwnd, patch) => {
    const w = F.windows.get(hwnd);
    if (!w) return;
    Object.assign(w, patch);
    if (F.watching.includes(hwnd)) say({ wins: wins() });
    if (F.fg === hwnd) say({ fg: describe(w) });
  };
  F.close = (hwnd) => {
    F.windows.delete(hwnd);
    say({ gone: [hwnd] });
    if (F.watching.includes(hwnd)) say({ wins: wins() });
  };
  child.kill = () => {
    child.stdout.end();
    setImmediate(() => child.emit('exit', 0));
  };
  F.child = child;
  F.started = (F.started || 0) + 1;
  if (F.fg) setTimeout(() => F.front(F.fg), 20);
  return child;
}
