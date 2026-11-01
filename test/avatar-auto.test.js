import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FOCUS_SCRIPT, POWERSHELL } from '../src/platform/win/focus.js';
import { createExternalAvatarBinding, createExternalAvatarSync, supportsAutomatic, AUTO_OWNER } from '../electron/external-avatar.js';
import { createAvatarHost } from '../electron/avatar-host.js';
import { automaticStageFor } from '../electron/buddy-geometry.js';
import { createWinFocusTracker } from '../src/platform/win/focus.js';
import { createRoamClassifier, sweptRegion } from '../ui/src/qubit/roam.js';
import { createThrow, bodyExtents } from '../ui/src/qubit/throw.js';
import { createDirector, FLOOR } from '../ui/src/qubit/director.js';
const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} });
globalThis.document ??= { createElementNS: el };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
await import('../ui/src/vendor/avatars/orbit-nav.js');
await import('../ui/src/vendor/avatars/qubit-engine.js');
const E = globalThis.QubitEngine;
const stage = (instanceId = 'a', epoch = 'w1', hwnd = 123) => ({ schema: 1, instanceId, revision: 1, available: true, frame: { window: { handle: String(hwnd), pid: 42, epoch }, viewport: { width: 800, height: 600, scaleFactor: 1, physicalOrigin: { x: -1800, y: 100 } }, suspended: false, surfaces: [{ id: 'header', kind: 'oneWay', rect: { x: 40, y: 200, w: 600, h: 12 } }], exclusions: [] } });
const native = (hwnd = 123) => ({ hwnd, pid: 42, kind: 'app', x: -1808, y: 70, w: 816, h: 638, client: { x: -1800, y: 100, w: 800, h: 600 }, dpi: 96 });
const snapshot = () => ({ instanceId: 'a', mode: 'attached', avatarRoam: { schema: 1, policy: 'auto' }, window: { handle: '123', pid: 42, epoch: 'w1' }, capabilities: ['avatar.attached', 'avatar.stage.v1', 'avatar.roam.v1'] });
function fixture() {
  const avatars = []; let front = 123, frontKind = 'app', w = native();
  const host = createAvatarHost({ current: () => ({ hwnd: front, kind: frontKind }), makeAvatar: () => {
    const a = { roam: [], voices: [], left: 0, onRoam(frame, bounds, options) { this.roam.push({ frame, bounds, options }); }, onVoice(v) { this.voices.push(v); }, onClaude() {}, onStage() {}, setEnabled() {}, leave() { this.left++; return Promise.resolve(); }, stop() {} };
    avatars.push(a); return a;
  } });
  host.setKind('qubit');
  const binding = createExternalAvatarBinding({ avatarHost: host, platform: 'win32', tracker: () => ({ describe: async () => w }) });
  return { host, binding, avatars, setFront(v, kind = 'app') { front = v; frontKind = kind; host.onFocus(); }, setNative(v) { w = v; } };
}
test('Automatic is optional, strictly negotiated, unchanged snapshots never retoggle the fixed fallback', async () => {
  for (const v of [null, {}, { ...snapshot(), avatarRoam: { schema: 2, policy: 'auto' } }, { ...snapshot(), avatarRoam: { schema: 1, policy: 'auto', authority: true } }, { ...snapshot(), capabilities: ['avatar.attached'] }]) assert.equal(supportsAutomatic(v), false);
  const f = fixture(); let mode = 'desktop'; const writes = [];
  const sync = createExternalAvatarSync({ binding: f.binding, selected: () => true, getMode: () => mode, setMode: (m) => { mode = m; writes.push(m); } });
  await sync.initialize(snapshot()); f.binding.stage(stage());
  const owner = f.host.active();
  for (let i = 0; i < 50; i++) { await sync.sync(snapshot()); f.binding.stage(stage()); }
  assert.deepEqual(writes, ['auto']); assert.equal(f.avatars.length, 1); assert.equal(f.host.activeId, AUTO_OWNER); assert.equal(f.host.active(), owner);
  await sync.sync(null); assert.equal(f.host.active(), owner); assert.equal(owner.roam.at(-1).options.eligible, false);
  const fixed = snapshot(); delete fixed.avatarRoam;
  await sync.sync(fixed); assert.deepEqual(writes, ['auto', 'attached']); assert.equal(owner.left, 1);
  f.binding.clear(); f.host.stop();
});
test('Auto host loss/replacement, identity reuse, stage lease, minimize and foreground occlusion revoke only region, not character/voice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const f = fixture(); await f.binding.sync(snapshot(), 'auto'); f.binding.stage(stage());
  const a = f.host.active(), fakeVoice = { phase: 'speaking', connection: {} }; f.host.onVoice(fakeVoice);
  assert.equal(a.roam.at(-1).options.eligible, true);
  f.setFront(999); assert.equal(a.roam.at(-1).options.eligible, false);
  f.setFront(999, 'orbit'); assert.equal(a.roam.at(-1).options.eligible, false, 'Orbit settings is not an occlusion exemption for the bro region');
  f.setFront(123); assert.equal(a.roam.at(-1).options.eligible, true);
  f.host.onWins([{ ...native(), min: true }]); assert.equal(a.roam.at(-1).options.eligible, false);
  f.host.onWins([native()]); t.mock.timers.tick(2001); assert.equal(a.roam.at(-1).options.eligible, false);
  f.binding.stage(stage()); assert.equal(a.roam.at(-1).options.eligible, true);
  f.binding.clear(); assert.equal(f.host.active(), a); assert.equal(f.host.guests.length, 1); assert.equal(a.left, 0);
  const next = { ...snapshot(), instanceId: 'b', window: { handle: '124', pid: 42, epoch: 'w2' } }; f.setNative(native(124)); f.setFront(124);
  await f.binding.sync(next, 'auto'); f.binding.stage(stage()); assert.equal(a.roam.at(-1).options.eligible, false, 'old identity never becomes region');
  f.binding.stage(stage('b', 'w2', 124)); assert.equal(a.roam.at(-1).options.eligible, true);
  assert.equal(f.avatars.length, 1); assert.equal(f.host.active(), a); assert.equal(a.voices.at(-1), fakeVoice);
  f.host.onWins([{ ...native(124), pid: 99 }]); assert.equal(a.roam.at(-1).options.eligible, false); assert.equal(f.host.active(), a);
  f.binding.clear(); f.host.stop();
});
test('Automatic full work-area transform uses interior bro surfaces and retains active display, including negative origins', () => {
  const display = { id: 1, scaleFactor: 1, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
  const screen = { screenToDipRect: (_, r) => r, getDisplayMatching: () => display };
  const s = automaticStageFor(screen, display, stage().frame, native(), { identity: 'a:w1', eligible: true });
  assert.deepEqual(s.bounds, display.workArea); assert.equal(s.geometry.H, 1040); assert.deepEqual(s.geometry.hostRegion, { x: 120, y: 100, w: 800, h: 600 });
  assert.deepEqual(s.geometry.solids[0], { id: 'a:w1:header', x: 160, y: 300, w: 600, h: 12, oneWay: true });
  screen.getDisplayMatching = () => ({ id: 2, scaleFactor: 1.5 });
  const moved = automaticStageFor(screen, display, stage().frame, native(), { eligible: true });
  assert.deepEqual(moved.bounds, display.workArea); assert.equal(moved.geometry.eligible, false); assert.deepEqual(moved.geometry.solids, []);
  assert.equal(automaticStageFor(screen, { ...display, scaleFactor: NaN }, null, null), null);
});
test('classifier uses actual moving body/pointer, hysteresis and swept segments; moving host never catches stationary detached body', () => {
  const c = createRoamClassifier(), r = { x: 100, y: 100, w: 400, h: 400 };
  const put = (x, y = 300, extra = {}) => c.update({ region: r, eligible: true, identity: 'a', body: { x, y, ex: 18, ey: 18 }, ...extra });
  assert.equal(put(50), 'desktop'); assert.equal(put(150), 'bro');
  for (let i = 0; i < 40; i++) assert.equal(put(100 + i % 2), 'bro');
  assert.equal(put(50), 'desktop');
  const r2 = { ...r, x: 0 }; assert.equal(put(50, 300, { region: r2 }), 'desktop');
  assert.equal(put(70, 300, { region: r2 }), 'desktop', 'geometry appearing under detached body is not entry');
  assert.equal(put(450, 300, { region: r2 }), 'desktop'); assert.equal(put(200, 300, { region: r2 }), 'bro');
  assert.equal(put(200, 300, { region: r2, eligible: false }), 'desktop');
  assert.equal(sweptRegion({ x: -100, y: 200 }, { x: 800, y: 200 }, r), true);
  assert.equal(sweptRegion({ x: -100, y: 20 }, { x: 800, y: 20 }, r), false);
});
function scene() {
  const q = E.create({ mount: null, width: 1200, height: 800, size: 36, floor: FLOOR, keepAlive: true });
  q.brainT.play = q.brainT.stunt = Infinity;
  const dir = createDirector(q, { reduceMotion: true });
  const th = createThrow(q); const g = { W: 1200, H: 800, side: 36, stage: { persistent: true, automatic: true, solids: [] } };
  dir.setGeometry(g); dir.place(); th.setSolids([], { continuous: true, automatic: true });
  return { q, dir, th, g, stop() { th.destroy(); q.destroy(); } };
}
test('one controller: drag/flight preserve physical pose/velocity on origin reframe; screen edges clamp full grown rotated body', () => {
  const s = scene(), { q, th } = s;
  try {
    th.hold({ x: 500, y: 300 }); for (let i = 0; i < 100; i++) q.update(1 / 120);
    const before = { x: q.cx, y: q.ground - q.cy, angle: q.angle, vx: q.vx, vy: q.vy };
    th.reframe({ shift: { x: -40, y: 30 }, W: 1200, H: 850 });
    assert.equal(q.cx + 40, before.x); assert.equal(q.ground - q.cy - 30, before.y); assert.equal(q.angle, before.angle); assert.equal(th.held, true);
    th.release({ x: 900, y: -500 }); const v = [q.vx, q.vy, q.av]; th.reframe({ shift: { x: 20, y: -10 }, W: 1200, H: 800 }); assert.deepEqual([q.vx, q.vy, q.av], v); assert.equal(th.flying, true);
    q.sp.grow.snap(1.5); q.angle = 45; th.hold({ x: -999, y: -999 });
    for (let i = 0; i < 120; i++) { q.update(1 / 120); const e = bodyExtents(q); assert.ok(q.cx >= e.x - 0.1 && q.ground - q.cy >= e.y - 0.1); }
    th.recover(); assert.equal(th.active, false); assert.equal(q.air, true); assert.deepEqual([q.vx, q.vy, q.av], [0, 0, 0]);
  } finally { s.stop(); }
});
test('new geometry never retroactively scoops detached body; compatible support rides, removed support releases, invalid clients have no perch', () => {
  const s = scene(), { q, th, dir, g } = s;
  try {
    q.cx = 400; q.cy = 18; q.sy = 0; q.air = false;
    const beneath = { id: 'appeared', x: 300, y: q.ground - 1, w: 300, h: 1, oneWay: true };
    const list = th.setSolids([beneath], { continuous: true, automatic: true }); assert.deepEqual(list, []);
    for (let i = 0; i < 10; i++) q.update(1 / 120); assert.equal(q.sy, 0);
    const support = { id: 'a:header', x: 200, y: 400, w: 500, h: 12, oneWay: true };
    dir.setGeometry({ ...g, stage: { ...g.stage, solids: [support] } }); q.cx = 400; q.sy = q.ground - 400; q.cy = q.sy + 18; q.air = false;
    dir.setGeometry({ ...g, stage: { ...g.stage, solids: [{ ...support, x: 300, y: 450 }] } }); assert.equal(q.cx, 500); assert.equal(q.ground - q.sy, 450);
    dir.setGeometry(g); assert.equal(q.air, true);
    const excluded = { id: '__excluded', x: 200, y: 100, w: 700, h: 650, noTop: true };
    th.setSolids([excluded], { continuous: true, automatic: true, forbidden: excluded });
    assert.equal(q.nav.surfaces.some((s) => s.solidId === '__excluded'), false);
    assert.ok(q.cx < 200 || q.cx > 900 || q.ground - q.cy > 750);
  } finally { s.stop(); }
});
test('one-way geometry appearing through a detached flight stays ghosted through release and landing', () => {
  const s = scene(), { q, th } = s;
  try {
    q.cx = 500; q.cy = q.ground - 300; q._rx = q._ry = null;
    th.hold({ x: 500, y: 300 }); th.release({ x: 0, y: 0 });
    const newLedge = { id: 'appeared-midflight', x: 300, y: 317, w: 500, h: 4, oneWay: true };
    assert.deepEqual(th.setSolids([newLedge], { continuous: true, automatic: true }), []);
    let landed = null; th.on('land', (v) => { landed = v; });
    for (let i = 0; i < 1800 && !landed; i++) q.update(1 / 120);
    assert.ok(landed); assert.ok(Math.abs(landed.y - q.ground) < 1, 'newly appeared one-way must not catch the existing flight');
  } finally { s.stop(); }
});
test('reachable walking crosses the open interior boundary; a full-height real rail has no invented route', async () => {
  const s = scene(), { q, th } = s;
  try {
    q.cx = 200; q.sy = 0; q.cy = 18; q.air = false;
    const walk = q.goTo(600, q.ground - 1);
    for (let i = 0; i < 1800 && q.busy; i++) { q.update(1 / 120); await null; }
    assert.equal(await walk, true); assert.ok(q.cx > 590);
    th.setSolids([{ id: 'real-rail', x: 700, y: 0, w: 3, h: 800 }], { continuous: true, automatic: true });
    assert.equal(q.plan(1000, q.ground - 1), null);
  } finally { s.stop(); }
});
test('native primary-button mapping covers swapped buttons without invoking any input API', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(FOCUS_SCRIPT, 'utf8');
  const method = source.match(/public static int PrimaryMouseKey\(bool swapped\) \{[^}]+\}/)?.[0];
  assert.ok(method);
  const helper = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert.ok(helper);
  // Compile the actual helper, but never Run it or call any OS input API.
  const result = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${helper}\n'@\n[OrbitFocus]::PrimaryMouseKey($false)\n[OrbitFocus]::PrimaryMouseKey($true)\n`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(result.trim().split(/\s+/).map(Number), [1, 2]);
  assert.match(source, /GetAsyncKeyState\(PrimaryMouseKey\(GetSystemMetrics\(23\) != 0\)\) & 0x8000/);
});
test('active-only native cursor stream filters ids/sequences, stops on up, and cancels stale/helper failure without replay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => c.emit('exit', 0);
  const commands = []; c.stdin.on('data', (d) => commands.push(String(d).trim()));
  const tracker = createWinFocusTracker({ spawnHelper: () => c }); tracker.start();
  assert.deepEqual(commands, [], 'no idle button/cursor poll');
  const seen = []; const stop = tracker.watchGesture(7, (v) => seen.push(v)); const token = Number(commands.at(-1).split(' ')[2]);
  const say = (v) => c.stdout.write(`${JSON.stringify({ gesture: v })}\n`);
  say({ id: token, sequence: 1, x: -20, y: 900, down: true });
  say({ id: token, sequence: 1, x: 20, y: 20, down: false }); say({ id: token + 1, sequence: 2, down: false });
  assert.equal(seen.length, 1); say({ id: token, sequence: 2, x: -10, y: 901, down: false }); assert.equal(seen.length, 2); stop();
  tracker.watchGesture(8, (v) => seen.push(v)); t.mock.timers.tick(751); assert.equal(seen.at(-1).cancel, true); assert.equal(commands.at(-1), 'gesture 0 0');
  tracker.watchGesture(9, (v) => seen.push(v)); c.emit('exit', 1); assert.equal(seen.at(-1).cancel, true); tracker.stop();
});
