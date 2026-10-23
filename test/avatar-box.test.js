// The avatar following Claude's prompt box as it moves: the window helper's box reports through
// the tracker (electron/claude-window.js), the geometry that turns them into the avatar's platform
// and Send button, and the e2e stand-in for the helper. No real windows are looked at.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClaudeWindowTracker } from '../electron/claude-window.js';
import { boxInStrip, sendAtOffset, sendOffsetFor, usableBox } from '../electron/buddy-geometry.js';

/** A stand-in for claude-window.ps1: what Orbit writes to it, and lines it can print. */
function fakeHelper() {
  const spawned = [];
  const spawnHelper = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.got = [];
    child.stdin.on('data', (d) => child.got.push(...String(d).split('\n').filter(Boolean)));
    child.kill = () => setImmediate(() => child.emit('exit', 0));
    child.say = (o) => child.stdout.write(`${JSON.stringify(o)}\n`);
    spawned.push(child);
    return child;
  };
  return { spawned, spawnHelper };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('the tracker passes box reports on, and asks the helper to watch the box', async () => {
  const h = fakeHelper();
  const changes = [];
  const boxes = [];
  const t = createClaudeWindowTracker({ spawnHelper: h.spawnHelper, onChange: (s) => changes.push(s), onBox: (b) => boxes.push(b) });
  t.start();
  const c = h.spawned[0];
  c.say({ wins: [{ hwnd: 7, min: false, x: 0, y: 0, w: 1200, h: 800 }], fg: 7, front: 'claude' });
  await tick();
  assert.equal(changes.at(-1).hwnd, 7);
  t.watchBox(7);
  t.watchBox(7); // the same again: not repeated
  await tick();
  assert.deepEqual(c.got, ['pause', 'box 7']);
  const report = { hwnd: 7, rect: { x: 300, y: 700, w: 600, h: 24 }, win: { x: 0, y: 0, w: 1200, h: 800 } };
  c.say({ box: report });
  await tick();
  assert.deepEqual(boxes, [report]);
  assert.equal(changes.length, 1, 'a box report is not a window change');
  // The helper dies: the new one gets the watch again.
  c.emit('exit', 1);
  await tick(1100);
  const c2 = h.spawned[1];
  assert.ok(c2, 'restarted');
  await tick();
  assert.deepEqual(c2.got, ['pause', 'box 7']);
  t.watchBox(0);
  await tick();
  assert.equal(c2.got.at(-1), 'box 0');
  t.stop();
});

test('box geometry: a grown box, at any scaling, and the Send button moving with it', () => {
  const claudeDip = { x: 100, y: 50, width: 1000, height: 600 };
  const strip = { x: 100, y: 410, width: 1000, height: 240 };
  const win = { x: 150, y: 75, w: 1500, h: 900 }; // UI Automation at 150%
  const box1 = boxInStrip({ x: 150 + 450, y: 75 + 840, w: 900, h: 36 }, win, claudeDip, strip);
  // The text grows two lines (30 px a line at 150%): the box's top goes up 40 DIPs, its bottom stays.
  const box3 = boxInStrip({ x: 150 + 450, y: 75 + 780, w: 900, h: 96 }, win, claudeDip, strip);
  assert.equal(box1.y - box3.y, 40);
  assert.equal(box1.y + box1.h, box3.y + box3.h);
  // Send was found with the one-line box: it stays at the same place from the bottom right.
  const send1 = { x: box1.x + box1.w - 40, y: box1.y + box1.h - 34, w: 32, h: 32 };
  const off = sendOffsetFor(box1, send1);
  assert.deepEqual(sendAtOffset(box1, off, send1), send1);
  assert.deepEqual(sendAtOffset(box3, off, send1), send1, 'the box grew upward: Send stays put');
  const moved = { ...box1, x: box1.x + 120 }; // a sidebar opened: the box moved right
  assert.deepEqual(sendAtOffset(moved, off, send1), { ...send1, x: send1.x + 120 });
  assert.equal(sendAtOffset(box1, null, send1), null);
  assert.equal(sendOffsetFor(box1, null), null);
  // A box with no top inside the strip isn't a platform.
  assert.equal(usableBox({ x: 0, y: 10, w: 100, h: 300 }, 240), null);
  assert.equal(usableBox({ x: 0, y: 250, w: 100, h: 10 }, 240), null);
  assert.deepEqual(usableBox(box1, 240), box1);
});

test('the e2e stand-in for the helper reports the box like the real one: on watch, every 150 ms, on a move', async () => {
  globalThis.__orbitE2E = { desktop: { windows: [{ hwnd: 101, kind: 'main', title: 'T', newPage: null, promptText: '', min: false }], sidebar: [], folders: [], calls: [], sends: [], chaos: 0, rng: () => 0, newCount: 0 } };
  const desk = globalThis.__orbitE2E.desktop;
  const { windowHelper } = await import('./e2e/fake-desktop.mjs');
  const child = windowHelper();
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  const boxes = () => lines.filter((l) => l.box);
  child.stdin.write('box 101\n');
  await tick(60);
  assert.equal(boxes().length, 1);
  assert.deepEqual(boxes()[0].box.rect, { x: 300, y: 700, w: 600, h: 24 });
  // Someone types two more lines: seen within 150 ms.
  desk.windows[0].promptText = 'a\nb\nc';
  const t0 = Date.now();
  while (boxes().length < 2 && Date.now() - t0 < 1000) await tick(5);
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
  assert.deepEqual(boxes()[1].box.rect, { x: 300, y: 660, w: 600, h: 64 });
  // The window moves: at once.
  desk.windows[0].promptText = '';
  const t1 = Date.now();
  desk.nudge();
  while (boxes().length < 3 && Date.now() - t1 < 1000) await tick(5);
  assert.ok(Date.now() - t1 < 60, `move: ${Date.now() - t1} ms`);
  // Unchanged: nothing more.
  await tick(200);
  assert.equal(boxes().length, 3);
  child.kill();
});
