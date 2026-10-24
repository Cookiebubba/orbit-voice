// "Orbit anywhere" phase 1: the focus store and the Windows tracker's line protocol, with a
// stand-in for focus.ps1 (no PowerShell here; test/focus-win.test.js runs the real helper).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appName, cleanWindow, createFocusStore } from '../src/platform/focus.js';
import { createWinFocusTracker } from '../src/platform/win/focus.js';
import { startFocusTracking, focus, focusBackend, listWindows, describeWindow } from '../src/platform/index.js';

const W = (hwnd, extra = {}) => ({ hwnd, owner: 0, pid: 100 + hwnd, exe: 'notepad.exe', title: `Doc ${hwnd}`, cls: 'Notepad', kind: 'app', min: false, max: false, cloaked: false, elevated: false, x: 10, y: 20, w: 800, h: 600, dpi: 96, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for focus.ps1: lines written to `say`, commands read from `heard`. */
function fakeHelper({ answer = () => null } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.heard = [];
  child.stdin.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      child.heard.push(line);
      const a = answer(line);
      if (a) child.stdout.write(`${JSON.stringify(a)}\n`);
    }
  });
  child.say = (obj) => child.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  child.kill = () => child.emit('exit', 0);
  return child;
}

test('cleanWindow keeps only sane values, and trims titles', () => {
  const w = cleanWindow({ ...W(5), title: `a\u0000b\nc${'x'.repeat(400)}`, kind: 'weird', x: 'nope', w: -4, extra: 'dropped' });
  assert.equal(w.hwnd, 5);
  assert.equal(w.kind, 'app', 'unknown kinds count as an app');
  assert.equal(w.title.length, 300);
  assert.ok(!/[\u0000\n]/.test(w.title), 'no control characters');
  assert.deepEqual(w.rect, { x: 0, y: 20, w: 0, h: 600 });
  assert.equal(w.extra, undefined);
  assert.deepEqual(cleanWindow({ hwnd: 0 }), { hwnd: 0, kind: 'none' });
  assert.equal(cleanWindow(null), null);
  assert.equal(cleanWindow('x'), null);
});

test('appName says the app the way people do', () => {
  assert.equal(appName({ exe: 'notepad.exe' }), 'Notepad');
  assert.equal(appName({ exe: 'Discord.exe' }), 'Discord');
  assert.equal(appName({ exe: 'msedge.exe' }), 'Edge');
  assert.equal(appName({ exe: 'ApplicationFrameHost.exe', title: 'Settings' }), 'Settings', 'a UWP frame goes by its title');
  assert.equal(appName({}), '');
});

test('the store: current, the app window you were in last, recent windows, closed windows', () => {
  const s = createFocusStore({ settleMs: 5 });
  const changes = [];
  s.on('change', (c) => changes.push(c.current.hwnd));
  s.update(W(1));
  s.update(W(2));
  assert.equal(s.current.hwnd, 2);
  assert.equal(s.lastApp.hwnd, 2);
  // Orbit's own window, the taskbar, a cloaked window: in front, but "this window" stays the app.
  s.update(W(9, { kind: 'orbit' }));
  assert.equal(s.current.hwnd, 9);
  assert.equal(s.lastApp.hwnd, 2);
  s.update(W(8, { kind: 'shell', exe: 'explorer.exe', cls: 'Shell_TrayWnd' }));
  s.update(W(7, { cloaked: true }));
  assert.equal(s.lastApp.hwnd, 2);
  s.update(W(1));
  assert.deepEqual(s.recent.map((r) => r.hwnd), [1, 2], 'most recent first, no duplicates, no Orbit or shell windows');
  assert.deepEqual(changes, [1, 2, 9, 8, 7, 1]);
  s.gone([1]);
  assert.equal(s.current.kind, 'none', 'the window in front closed');
  assert.equal(s.lastApp.hwnd, 2, 'the one before it');
  assert.deepEqual(s.recent.map((r) => r.hwnd), [2]);
  s.gone(['x', -3]);
  s.gone([2]);
  assert.equal(s.lastApp, null);
  s.setSwitching(true);
  assert.equal(s.switching, true);
  s.reset();
  assert.equal(s.current, null);
});

test('the store: "settled" waits for the window in front to stay put (a quick Alt+Tab is one change)', async () => {
  const s = createFocusStore({ settleMs: 40 });
  const settled = [];
  s.on('settled', (e) => settled.push(e.current.hwnd));
  s.update(W(1));
  await sleep(10);
  s.update(W(2));
  await sleep(10);
  s.update(W(3));
  await sleep(10);
  s.update(W(3, { title: 'renamed' })); // same window, new title: no new wait
  await sleep(80);
  assert.deepEqual(settled, [3]);
  s.update(W(3, { title: 'again' }));
  await sleep(80);
  assert.deepEqual(settled, [3], 'the same window again is not a new settle');
  s.update(W(4));
  await sleep(80);
  assert.deepEqual(settled, [3, 4]);
  // A listener that throws doesn't break the others.
  s.on('change', () => {
    throw new Error('boom');
  });
  let ok = false;
  s.on('change', () => (ok = true));
  s.update(W(5));
  assert.ok(ok);
});

test('the Windows tracker: reports, Alt+Tab, closed windows, questions and answers', async () => {
  const seen = { focus: [], switching: [], gone: [] };
  const child = fakeHelper({
    answer: (line) => {
      const [cmd, id, h] = line.split(' ');
      if (cmd === 'describe') return { id: Number(id), describe: Number(h) === 42 ? W(42) : null };
      if (cmd === 'list') return { id: Number(id), list: [W(1), W(2)] };
      return null;
    },
  });
  const t = createWinFocusTracker({ spawnHelper: () => child, onFocus: (w) => seen.focus.push(w.hwnd), onSwitching: (b) => seen.switching.push(b), onGone: (g) => seen.gone.push(g) });
  t.start();
  child.say({ fg: W(7) });
  child.say('not json');
  child.say('{"fg":');
  child.say({ switching: true });
  child.say({ gone: [7, 'x', 8] });
  child.say({ id: 999, describe: W(1) }); // nobody asked
  await sleep(20);
  assert.deepEqual(seen, { focus: [7], switching: [true], gone: [[7, 8]] });
  assert.equal((await t.describe(42)).hwnd, 42);
  assert.equal(await t.describe(43), null);
  assert.equal(await t.describe('nope'), null, 'not a window handle: not even asked');
  assert.deepEqual((await t.list()).map((w) => w.hwnd), [1, 2]);
  assert.deepEqual(child.heard, ['describe 1 42', 'describe 2 43', 'list 3']);
  t.stop();
  assert.equal(await t.describe(42), null, 'stopped: no helper to ask');
});

test('the Windows tracker restarts a helper that died, and gives up after five in a minute', async () => {
  let spawned = 0;
  const errors = [];
  const children = [];
  const t = createWinFocusTracker({
    spawnHelper: () => {
      spawned++;
      const c = fakeHelper();
      children.push(c);
      return c;
    },
    onError: (m) => errors.push(m),
  });
  t.start();
  // A question in flight when it dies gets an answer (not a hang).
  const q = t.describe(5);
  children[0].kill();
  assert.equal(await q, null);
  for (let i = 0; i < 5; i++) {
    await sleep(1050);
    children.at(-1).kill();
  }
  await sleep(50);
  assert.equal(spawned, 6, 'five restarts, then it gave up');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /keeps stopping/);
  t.stop();
});

test('startFocusTracking feeds the shared store and backs describe/list', async () => {
  const child = fakeHelper({ answer: (line) => (line.startsWith('list') ? { id: Number(line.split(' ')[1]), list: [W(3), W(4, { kind: 'shell' }), { hwnd: 0 }] } : { id: Number(line.split(' ')[1]), describe: null }) });
  focus.reset();
  const t = startFocusTracking({ spawnHelper: () => child });
  child.say({ fg: W(3) });
  await sleep(20);
  assert.equal(focus.lastApp.hwnd, 3);
  assert.ok(focusBackend());
  assert.deepEqual((await listWindows()).map((w) => w.hwnd), [3], 'app windows only');
  assert.equal(await describeWindow(3), null, 'gone: null');
  t.stop();
  assert.equal(focusBackend(), null);
  assert.deepEqual(await listWindows(), []);
  focus.reset();
});
