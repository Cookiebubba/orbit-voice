// "Stick to Claude Code": orb geometry (in DIPs, so it holds at any scaling), saved-spot
// validation, and the real Claude window watcher (Windows only).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ANCHOR, anchorFor, isAnchor, orbPositionFor } from '../electron/orb-stick.js';
import { getSetting, initConfig, updateSettings } from '../src/config.js';

const ORB = 128;
const SCRIPT = fileURLToPath(new URL('../electron/claude-window.ps1', import.meta.url));
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

test('default spot: bottom-right of the Claude window, above the prompt box', () => {
  const win = { x: 1720, y: 0, width: 1720, height: 1392 };
  assert.deepEqual(orbPositionFor(win, null, ORB), { x: 1720 + 1720 - DEFAULT_ANCHOR.dx - ORB, y: 1392 - DEFAULT_ANCHOR.dy - ORB });
});

test('a dropped orb is remembered from the nearest corner and comes back to the same spot', () => {
  const win = { x: 100, y: 50, width: 1200, height: 800 };
  for (const pos of [{ x: 120, y: 70 }, { x: 1100, y: 60 }, { x: 130, y: 650 }, { x: 1150, y: 700 }, { x: 600, y: 400 }]) {
    const a = anchorFor(win, pos, ORB);
    assert.ok(isAnchor(a), JSON.stringify(a));
    assert.deepEqual(orbPositionFor(win, a, ORB), pos, `round trip for ${JSON.stringify(pos)} via ${a.corner}`);
  }
  assert.equal(anchorFor(win, { x: 1150, y: 700 }, ORB).corner, 'br');
  assert.equal(anchorFor(win, { x: 120, y: 70 }, ORB).corner, 'tl');
});

test('it keeps its distance from the corner when the window is resized or moved to another display', () => {
  const a = { corner: 'br', dx: 30, dy: 150 };
  const small = orbPositionFor({ x: 0, y: 0, width: 900, height: 700 }, a, ORB);
  const big = orbPositionFor({ x: -2560, y: -1440, width: 2560, height: 1400 }, a, ORB);
  assert.deepEqual([900 - (small.x + ORB), 700 - (small.y + ORB)], [30, 150]);
  assert.deepEqual([0 - (big.x + ORB), -40 - (big.y + ORB)], [30, 150]);
});

test('display scaling: the same window at 100%, 150% and 200% keeps the orb in the same visual place', () => {
  // The watcher reports real pixels; Orbit converts them to DIPs (screenToDipRect) before this
  // math, so at any scale the orb lands at the same fraction of the window.
  const a = { corner: 'br', dx: 24, dy: 140 };
  const physical = { x: 3000, y: 300, width: 2400, height: 1600 };
  const frac = [1, 1.5, 2].map((scale) => {
    const dip = { x: physical.x / scale, y: physical.y / scale, width: physical.width / scale, height: physical.height / scale };
    const p = orbPositionFor(dip, a, ORB);
    // In physical pixels: same distance from the corner * scale (it is a DIP distance), size * scale.
    return [(dip.x + dip.width - (p.x + ORB)) * scale, (dip.y + dip.height - (p.y + ORB)) * scale];
  });
  assert.deepEqual(frac.map(([dx]) => Math.round(dx)), [24, 36, 48], 'distance scales with the UI, like the orb itself');
});

test('the orb never leaves the window; a window smaller than the orb centres it', () => {
  const win = { x: 0, y: 0, width: 400, height: 300 };
  const far = orbPositionFor(win, { corner: 'tl', dx: 5000, dy: 5000 }, ORB);
  assert.deepEqual(far, { x: 400 - ORB, y: 300 - ORB });
  const tiny = orbPositionFor({ x: 10, y: 10, width: 100, height: 80 }, DEFAULT_ANCHOR, ORB);
  assert.deepEqual(tiny, { x: 10 + Math.round((100 - ORB) / 2), y: 10 + Math.round((80 - ORB) / 2) });
  const outside = anchorFor(win, { x: -300, y: 900 }, ORB);
  assert.deepEqual(orbPositionFor(win, outside, ORB), { x: 0, y: 300 - ORB }, 'dragged off the window: snaps back inside');
});

test('only well-formed spots are saved', () => {
  initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stick-cfg-')) });
  updateSettings({ orbStickAnchor: { corner: 'br', dx: 24.4, dy: 140.6 } });
  assert.deepEqual(getSetting('orbStickAnchor'), { corner: 'br', dx: 24, dy: 141 });
  for (const bad of [{ corner: 'middle', dx: 1, dy: 1 }, { corner: 'tl', dx: -5, dy: 0 }, { corner: 'tl', dx: 'x', dy: 0 }, 'br']) {
    updateSettings({ orbStickAnchor: bad });
    assert.deepEqual(getSetting('orbStickAnchor'), { corner: 'br', dx: 24, dy: 141 }, JSON.stringify(bad));
  }
  updateSettings({ orbStick: true });
  assert.equal(getSetting('orbStick'), true);
});

function startWatcher(parentPid = 0) {
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', String(parentPid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
  return { child, lines };
}

test('the watcher reports the Claude window (or that there is none) as JSON', { skip: process.platform !== 'win32' }, async () => {
  const { child, lines } = startWatcher();
  const t0 = Date.now();
  while (!lines.length && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  assert.ok(lines.length, 'got a state line');
  const s = lines[0];
  if (s.found) {
    assert.deepEqual(Object.keys(s).sort(), ['found', 'front', 'h', 'hwnd', 'min', 'w', 'x', 'y']);
    assert.ok(['claude', 'orbit', 'other'].includes(s.front));
    assert.ok(s.min || (s.w > 100 && s.h > 100), JSON.stringify(s));
  } else {
    assert.deepEqual(s, { found: false });
  }
});

test('the watcher exits on its own when Orbit is gone', { skip: process.platform !== 'win32' }, async () => {
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const { child } = startWatcher(parent.pid);
  await new Promise((r) => setTimeout(r, 2500)); // let it start (Add-Type takes a moment)
  assert.equal(child.exitCode, null, 'still running while its parent lives');
  parent.kill();
  const exited = await Promise.race([new Promise((r) => child.once('exit', () => r(true))), new Promise((r) => setTimeout(() => r(false), 6000))]);
  if (!exited) child.kill();
  assert.ok(exited, 'exited within a few seconds of its parent');
});
