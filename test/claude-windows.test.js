// Which Claude window the orb docks on when Claude has several, from fake window reports (the
// shape electron/claude-window.ps1 prints). No real windows are looked at.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowPicker } from '../electron/claude-windows.js';
import { createClaudeWindowTracker } from '../electron/claude-window.js';

const win = (hwnd, extra = {}) => ({ hwnd, min: false, x: hwnd * 10, y: 0, w: 1200, h: 800, ...extra });

test('docks on the Claude window most recently in front', () => {
  const p = createWindowPicker();
  // Before any Claude window was in front: the highest in z-order.
  assert.equal(p.pick({ wins: [win(2), win(1)], fg: 0, front: 'other' }).hwnd, 2);
  assert.equal(p.pick({ wins: [win(1), win(2)], fg: 1, front: 'claude' }).hwnd, 1);
  assert.equal(p.pick({ wins: [win(2), win(1)], fg: 2, front: 'claude' }).hwnd, 2);
  // Another app comes to the front: stays on the last Claude window, wherever it is in z-order.
  const s = p.pick({ wins: [win(1), win(2)], fg: 0, front: 'other' });
  assert.deepEqual(s, { found: true, hwnd: 2, min: false, front: 'other', x: 20, y: 0, w: 1200, h: 800, windows: 2 });
  assert.deepEqual(p.recent(), [2, 1]);
});

test('a minimized window gives way to the most recent visible one; all minimized hides', () => {
  const p = createWindowPicker();
  p.pick({ wins: [win(1), win(2), win(3)], fg: 1, front: 'claude' });
  p.pick({ wins: [win(3), win(1), win(2)], fg: 3, front: 'claude' });
  // 3 is minimized: back to 1 (in front before 3), not 2 (higher in z-order but never in front).
  assert.equal(p.pick({ wins: [win(2), win(1), win(3, { min: true })], fg: 0, front: 'other' }).hwnd, 1);
  // 1 minimized too: 2, the only one left on screen.
  assert.equal(p.pick({ wins: [win(2), win(1, { min: true }), win(3, { min: true })], fg: 0, front: 'other' }).hwnd, 2);
  // Every one minimized: the most recent one, reported minimized (Orbit hides the orb).
  const all = p.pick({ wins: [win(2, { min: true }), win(1, { min: true }), win(3, { min: true })], fg: 0, front: 'other' });
  assert.equal(all.hwnd, 3);
  assert.equal(all.min, true);
  // 3 restored: back on it.
  assert.equal(p.pick({ wins: [win(3), win(2, { min: true }), win(1, { min: true })], fg: 3, front: 'claude' }).hwnd, 3);
});

test('a closed window is forgotten; no windows left is not found', () => {
  const p = createWindowPicker();
  p.pick({ wins: [win(1), win(2)], fg: 1, front: 'claude' });
  p.pick({ wins: [win(2), win(1)], fg: 2, front: 'claude' });
  assert.equal(p.pick({ wins: [win(1)], fg: 0, front: 'other' }).hwnd, 1, '2 closed');
  assert.deepEqual(p.recent(), [1]);
  // A window with the same handle later is a new one: not "recent" until it is in front.
  assert.equal(p.pick({ wins: [win(2), win(1)], fg: 0, front: 'other' }).hwnd, 1);
  assert.deepEqual(p.pick({ wins: [], fg: 0, front: 'other' }), { found: false });
  assert.deepEqual(p.pick({ wins: 'nope' }), { found: false });
  assert.deepEqual(p.pick(null), { found: false });
});

test('junk in a report is ignored', () => {
  const p = createWindowPicker();
  const s = p.pick({ wins: [null, { hwnd: -1, x: 0, y: 0, w: 1, h: 1 }, { hwnd: 5, x: 'a' }, win(7)], fg: 99, front: 'evil' });
  assert.equal(s.hwnd, 7);
  assert.equal(s.front, 'other');
  assert.deepEqual(p.recent(), [], 'a foreground window that is not one of Claude\x27s');
});

test('the tracker follows the active window and moves the orb onto another one at once', async () => {
  const lines = [];
  let out;
  const fakeHelper = () => {
    const child = new EventEmitter();
    out = new PassThrough();
    child.stdout = out;
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d) => lines.push(...String(d).trim().split('\n')));
    child.kill = () => child.emit('exit', 0);
    return child;
  };
  const seen = [];
  const t = createClaudeWindowTracker({ onChange: (s) => seen.push(s), spawnHelper: fakeHelper });
  t.start();
  const report = async (s) => {
    out.write(`${JSON.stringify(s)}\n`);
    await new Promise((r) => setImmediate(r));
  };
  await report({ wins: [win(1), win(2)], fg: 1, front: 'claude' });
  t.follow('900', { corner: 'br', dx: 24, dy: 140 });
  assert.equal(lines.at(-1), 'follow 900 1 br 24 140');
  await report({ wins: [win(2), win(1)], fg: 2, front: 'claude' });
  assert.equal(lines.at(-1), 'follow 900 2 br 24 140', 'onto the other window before Orbit re-places the orb');
  assert.equal(t.current.hwnd, 2);
  await report({ wins: [win(1), win(2)], fg: 0, front: 'other' });
  assert.equal(seen.at(-1).hwnd, 2);
  assert.equal(seen.at(-1).front, 'other');
  t.pause();
  assert.equal(lines.at(-1), 'pause');
  await report({ wins: [win(1)], fg: 1, front: 'claude' });
  assert.equal(lines.at(-1), 'pause', 'nothing moves while paused');
  await report('{not json');
  t.stop();
  assert.equal(t.current.found, false);
});
