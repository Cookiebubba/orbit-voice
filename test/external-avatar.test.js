import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalAvatarBinding, createExternalAvatarSync } from '../electron/external-avatar.js';
import { createAvatarHost } from '../electron/avatar-host.js';
import { clientStageFor } from '../electron/buddy-geometry.js';

function fixture() {
  let windows = [{ hwnd: 123, pid: 42, kind: 'app', x: -800, y: 100, w: 800, h: 600 }];
  const avatars = [];
  const host = createAvatarHost({
    makeAvatar: (kind) => {
      const a = { kind, placements: [], stages: [], voices: [], enabled: [], onStage(frame, native, enabled) { this.stages.push({ frame, native, enabled }); }, onVoice(v) { this.voices.push(v); }, onClaude(w) { this.placements.push(w); }, setEnabled(on, size) { this.enabled.push([on, size]); }, leave() { return Promise.resolve(); }, stop() {} };
      avatars.push(a); return a;
    },
    current: () => ({ hwnd: 123 }),
  });
  host.setKind('qubit', 2);
  let describes = 0;
  const tracker = { async describe(h) { describes++; return windows.find((w) => w.hwnd === h) || null; } };
  const binding = createExternalAvatarBinding({ avatarHost: host, tracker: () => tracker, platform: 'win32' });
  const snapshot = { instanceId: 'host-a', capabilities: ['avatar.desktop','avatar.attached'], window: { handle: '123', pid: 42 } };
  return { host, binding, avatars, snapshot, describes: () => describes, setWindows: (v) => windows = v };
}

test('Stay with bro uses existing animated native host with validated HWND/PID and negative coordinates', async () => {
  const f = fixture();
  assert.equal(await f.binding.sync(f.snapshot, 'attached'), true);
  assert.equal(f.host.guests.length, 1);
  assert.equal(f.host.activeId, 'external-host-a');
  assert.equal(f.avatars[0].placements.at(-1).x, -800);
  f.host.onVoice({ phase: 'speaking', input: 0, output: 0.7 });
  assert.equal(f.avatars[0].voices.at(-1).phase, 'speaking');
  f.host.onWins([{ hwnd: 123, pid: 42, min: true, cloaked: false, x: -500, y: 20, w: 1000, h: 700 }]);
  assert.equal(f.avatars[0].placements.at(-1).min, true);
  assert.equal(f.avatars[0].placements.at(-1).x, -500);
  await f.binding.sync(f.snapshot, 'attached');
  assert.equal(f.avatars.length, 1, 'snapshot polling never creates a duplicate character');
});

test('a reused HWND cannot attach to or remain over a different PID', async () => {
  const f = fixture();
  await f.binding.sync(f.snapshot, 'attached');
  f.host.onWins([{ hwnd: 123, pid: 99, x: 0, y: 0, w: 400, h: 300 }]);
  assert.deepEqual(f.avatars[0].placements.at(-1), { found: false });
  f.setWindows([{ hwnd: 123, pid: 99, kind: 'app', x: 0, y: 0, w: 400, h: 300 }]);
  assert.equal(await f.binding.sync(f.snapshot, 'attached'), false);
  assert.equal(f.host.guests.length, 0);
});

test('Desktop / disconnect remove attached guests; unsupported platforms do not claim attachment', async () => {
  const f = fixture();
  await f.binding.sync(f.snapshot, 'attached');
  assert.equal(await f.binding.sync(f.snapshot, 'desktop'), false);
  assert.equal(f.host.guests.length, 0);
  await f.binding.sync(f.snapshot, 'attached');
  await f.binding.sync(null, 'attached');
  assert.equal(f.host.guests.length, 0);
  const mac = createExternalAvatarBinding({ avatarHost: f.host, tracker: () => null, platform: 'darwin' });
  assert.equal(await mac.sync(f.snapshot, 'attached'), false);
});

test('late native validation cannot resurrect a closed or switched host', async () => {
  const f = fixture();
  let resolve;
  const binding = createExternalAvatarBinding({ avatarHost: f.host, platform: 'win32', tracker: () => ({ describe: () => new Promise((r) => resolve = r) }) });
  const pending = binding.sync(f.snapshot, 'attached');
  binding.clear();
  resolve({ hwnd: 123, pid: 42, kind: 'app', x: 0, y: 0, w: 400, h: 300 });
  assert.equal(await pending, false);
  assert.equal(f.host.guests.length, 0);
});

const nativeStage = () => ({ schema: 1, instanceId: 'host-a', revision: 1, available: true, frame: { window: { handle: '123', pid: 42, epoch: 'window-1' }, viewport: { width: 800, height: 600, scaleFactor: 1.5, physicalOrigin: { x: -1200, y: 45 } }, suspended: false, surfaces: [{ id: 'header', kind: 'oneWay', rect: { x: 20, y: 100, w: 500, h: 20 } }], exclusions: [] } });
const nativeWindow = () => ({ hwnd: 123, pid: 42, kind: 'app', x: -1210, y: 0, w: 1220, h: 960, client: { x: -1200, y: 45, w: 1200, h: 900 }, dpi: 144 });

test('stage binding: client bounds/DPI/epoch, translation, modal/exclusion/resize and expiry fail closed without native roundtrips', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const f = fixture(), w = nativeWindow(), s = nativeStage();
  t.after(() => f.binding.clear());
  f.setWindows([w]);
  const snapshot = { ...f.snapshot, window: { ...f.snapshot.window, epoch: 'window-1' }, capabilities: [...f.snapshot.capabilities, 'avatar.stage.v1'] };
  await f.binding.sync(snapshot, 'attached');
  assert.equal(f.avatars[0].placements.at(-1).found, false, 'wait for independently validated geometry');
  f.binding.stage(s);
  assert.equal(f.avatars[0].placements.at(-1).found, true);
  for (let i = 0; i < 60; i++) f.binding.stage(s);
  assert.equal(f.describes(), 1, 'geometry never describes a window per frame');
  const moved = { ...w, x: -1010, client: { ...w.client, x: -1000 } };
  f.host.onWins([moved]);
  assert.equal(f.avatars[0].placements.at(-1).found, true, 'ordinary movement rebases old local geometry');
  f.host.onWins([{ ...moved, client: { ...moved.client, w: 900 } }]);
  assert.equal(f.avatars[0].placements.at(-1).found, false, 'resize invalidates mismatched viewport');
  f.host.onWins([moved]);
  const wrong = structuredClone(s); wrong.revision++; wrong.frame.window.epoch = 'old-window';
  f.binding.stage(wrong);
  assert.equal(f.avatars[0].placements.at(-1).found, false, 'host epoch is authoritative when supplied');
  const fresh = structuredClone(s); fresh.revision += 2; fresh.frame.viewport.physicalOrigin.x = -1000;
  f.binding.stage(fresh);
  assert.equal(f.avatars[0].placements.at(-1).found, true);
  const exclusion = structuredClone(fresh); exclusion.revision++; exclusion.frame.exclusions = [{ x: 0, y: 0, w: 100, h: 100 }];
  f.binding.stage(exclusion); assert.equal(f.avatars[0].placements.at(-1).found, false, 'unsupported native child cannot be occupied');
  f.binding.stage(fresh);
  t.mock.timers.tick(1000); f.binding.stage(fresh);
  t.mock.timers.tick(1500); assert.equal(f.avatars[0].placements.at(-1).found, true, 'unchanged heartbeat renews native lease');
  t.mock.timers.tick(501); assert.equal(f.avatars[0].placements.at(-1).found, false, 'geometry expires without disconnecting voice');
  f.host.onVoice({ phase: 'speaking' }); assert.equal(f.avatars[0].voices.at(-1).phase, 'speaking');
  f.binding.stage(fresh);
  f.host.onWins([{ ...moved, dpi: 192 }]); assert.equal(f.avatars[0].placements.at(-1).found, false);
  f.host.onWins([{ ...moved, min: true }]); assert.equal(f.avatars[0].placements.at(-1).min, true);
});

test('stage transform: physical client not outer window, negative origins, DPI, clipping and unavailable monitors', () => {
  const s = nativeStage(), w = nativeWindow();
  const screen = { screenToDipRect: (_win, r) => ({ x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 }), getDisplayMatching: () => ({ workArea: { x: -800, y: 0, width: 1600, height: 1000 } }) };
  const placed = clientStageFor(screen, s.frame, w);
  assert.deepEqual(placed.bounds, { x: -800, y: 30, width: 800, height: 600 });
  assert.deepEqual(placed.geometry.solids[0], { id: 'header', x: 20, y: 100, w: 500, h: 20, oneWay: true });
  screen.getDisplayMatching = () => ({ workArea: { x: -700, y: 80, width: 600, height: 500 } });
  const clipped = clientStageFor(screen, s.frame, w);
  assert.deepEqual(clipped.bounds, { x: -700, y: 80, width: 600, height: 500 });
  assert.equal(clipped.geometry.solids[0].x, 0);
  assert.equal(clipped.geometry.solids[0].y, 50);
  screen.getDisplayMatching = () => ({ workArea: { x: 2000, y: 0, width: 800, height: 500 } });
  assert.equal(clientStageFor(screen, s.frame, w), null, 'fully offscreen never falls back onto the user desktop');
});

test('stage remains Qubit-only; another selected avatar retains its old strip behavior', async () => {
  const f = fixture(); f.host.setKind('buddy'); f.setWindows([nativeWindow()]);
  await f.binding.sync({ ...f.snapshot, capabilities: [...f.snapshot.capabilities, 'avatar.stage.v1'] }, 'attached');
  f.binding.stage(nativeStage());
  assert.equal(f.avatars[0].kind, 'buddy');
  assert.equal(f.avatars[0].placements.at(-1).found, true);
  assert.equal(f.avatars[0].stages.at(-1).enabled, false);
  f.binding.clear();
});

test('initial and changed host modes reach the real native binding after shell initialization', async () => {
  const f = fixture();
  let mode = 'desktop';
  const changes = [], boundModes = [];
  const sync = createExternalAvatarSync({
    selected: () => true,
    getMode: () => mode,
    setMode: (next) => {
      changes.push(next);
      mode = next;
      // Same transition seam as main.js: its settings listener changes the existing avatar host.
      f.host.setKind(next === 'attached' ? 'qubit' : null, 2);
      f.host.setEnabled(next === 'attached');
    },
    binding: { sync: (snapshot, placement) => { boundModes.push(placement); return f.binding.sync(snapshot, placement); } },
  });
  await sync.sync({ ...f.snapshot, mode: 'attached' });
  assert.deepEqual(changes, [], 'startup snapshot must not change settings before initConfig');
  assert.deepEqual(boundModes, [], 'native shell is not ready yet');
  assert.equal(await sync.initialize(), true);
  assert.equal(mode, 'attached');
  assert.deepEqual(changes, ['attached']);
  assert.equal(f.host.guests.length, 1);
  assert.equal(f.avatars[0].placements.at(-1).hwnd, 123);
  assert.equal(f.avatars[0].placements.at(-1).x, -800);
  await sync.sync({ ...f.snapshot, mode: 'attached' });
  assert.equal(f.avatars.length, 1, 'unchanged snapshots do not recreate the character');
  assert.equal(await sync.sync({ ...f.snapshot, mode: 'desktop' }), false);
  assert.equal(mode, 'desktop');
  assert.equal(f.host.guests.length, 0);
  assert.deepEqual(changes, ['attached', 'desktop']);
  assert.deepEqual(boundModes, ['attached', 'attached', 'desktop']);
  assert.equal(await sync.sync({ ...f.snapshot, mode: 'attached' }), true);
  assert.ok(f.avatars.every((avatar) => avatar.kind === 'qubit'), 'mode switches retain the selected genuine character');
});

test('host mode synchronization is optional, validates modes and leaves standalone behavior alone', async () => {
  const f = fixture();
  let mode = 'attached', selected = false;
  const changes = [], boundModes = [];
  const sync = createExternalAvatarSync({
    selected: () => selected,
    getMode: () => mode,
    setMode: (next) => { changes.push(next); mode = next; },
    binding: { sync: (snapshot, placement) => { boundModes.push(placement); return f.binding.sync(snapshot, placement); } },
  });
  await sync.initialize({ ...f.snapshot, mode: 'desktop' });
  assert.equal(mode, 'attached');
  assert.deepEqual(changes, []);
  assert.deepEqual(boundModes, [], 'standalone never reaches the external native binding');
  selected = true;
  for (const invalid of [undefined, null, 'free', 'ATTACHED', true, {}]) await sync.sync({ ...f.snapshot, mode: invalid });
  assert.deepEqual(changes, []);
  assert.equal(mode, 'attached', 'missing or invalid host modes preserve the local preference');
  await sync.sync({ ...f.snapshot, mode: 'desktop' });
  assert.deepEqual(changes, ['desktop']);
  mode = 'attached'; // unexpected local drift cannot override the host's saved preference
  await sync.sync({ ...f.snapshot, mode: 'desktop' });
  assert.equal(mode, 'desktop');
  assert.deepEqual(changes, ['desktop', 'desktop']);
  await sync.sync({ ...f.snapshot, mode: 'desktop', focusedSessionId: 'unrelated-change' });
  assert.equal(changes.length, 2, 'unrelated snapshots do not repeat a character transition');
  await sync.sync(null);
  assert.equal(f.host.guests.length, 0);
  mode = 'attached'; // local controls may be used while the host publishes no mode
  await sync.sync({ ...f.snapshot, mode: 'desktop' });
  assert.equal(mode, 'desktop', 'reconnect reapplies the host mode');
});
