// After an app is restarted under Orbit (on the user's yes), the act waits for its real main window
// (src/anywhere/act-tools.js pickRestartedWindow): never its splash or updater window. The owner's
// log twice had the retry pick "Discord Updater" and fail.
import test from 'node:test';
import assert from 'node:assert/strict';

import { RESTART_WAIT_MS, pickRestartedWindow } from '../src/anywhere/act-tools.js';

const W = (hwnd, o = {}) => ({ hwnd, pid: 500, exe: 'C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0.9\\Discord.exe', title: '#general | Friends - Discord', cloaked: false, min: false, w: 1200, h: 800, kind: 'app', ...o });

test('the splash or updater window is never the one; the main window is', () => {
  const splash = W(1, { title: 'Discord Updater', w: 300, h: 350 });
  assert.equal(pickRestartedWindow([splash], { pid: 500 }), null, 'only the splash: keep waiting');
  const main = W(2);
  assert.equal(pickRestartedWindow([splash, main], { pid: 500 }).hwnd, 2);
  // A big window titled like an updater still isn't it; a small untitled-like one neither.
  assert.equal(pickRestartedWindow([W(3, { title: 'Discord - Updating', w: 900, h: 700 })], { pid: 500 }), null);
  assert.equal(pickRestartedWindow([W(4, { title: 'Loading...', w: 900, h: 700 })], { pid: 500 }), null);
  assert.equal(pickRestartedWindow([W(5, { w: 320, h: 240 })], { pid: 500 }), null, 'too small to be the main window');
});

test('only its own windows, shown: its process, or a new window of the same program', () => {
  const other = W(10, { pid: 777, exe: 'C:\\Windows\\notepad.exe', title: 'notes - Notepad' });
  assert.equal(pickRestartedWindow([other], { pid: 500 }), null, 'another app');
  assert.equal(pickRestartedWindow([W(11, { cloaked: true })], { pid: 500 }), null, 'cloaked (another desktop, or not shown yet)');
  assert.equal(pickRestartedWindow([W(12, { min: true })], { pid: 500 }), null, 'minimized');
  assert.equal(pickRestartedWindow([W(13, { title: '' })], { pid: 500 }), null, 'untitled');
  // A child process of the same program: a new window counts; one from before the restart doesn't.
  const child = W(20, { pid: 501 });
  assert.equal(pickRestartedWindow([child], { pid: 500, exe: 'D:\\other\\Discord.exe', before: new Set([20]) }), null, 'there before the restart');
  assert.equal(pickRestartedWindow([child], { pid: 500, exe: 'D:\\other\\Discord.exe', before: new Set() }).hwnd, 20);
});

test('several candidates: the one titled like the old window, then the biggest', () => {
  const a = W(30, { title: 'Discord', w: 1600, h: 1000 });
  const b = W(31, { title: '#general | Friends - Discord', w: 1000, h: 700 });
  assert.equal(pickRestartedWindow([a, b], { pid: 500, title: '#general | Friends - Discord' }).hwnd, 31);
  assert.equal(pickRestartedWindow([a, b], { pid: 500 }).hwnd, 30);
  assert.equal(RESTART_WAIT_MS, 30_000, 'it waits up to about 30 s');
});
