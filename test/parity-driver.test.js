// The parity driver's pure parts (electron/parity-core.js): the token and Host checks, what each
// action may be given, the fake permissions, and the state's shape (parity/PROTOCOL.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_VOICE, EVENTS_MAX, PARITY_ACTIONS, PARITY_EVENTS, PARITY_FEATURES, cleanData, createRing, hostOk, isWav, onScreen, parsePerms, rect, shapeAvatar, shapeState, shapeVoice, tokenOk, validateAct } from '../electron/parity-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the token: only the exact run token passes, and no token configured means nothing passes', () => {
  assert.equal(tokenOk('s3cret-token', 's3cret-token'), true);
  assert.equal(tokenOk('s3cret-tokeN', 's3cret-token'), false);
  assert.equal(tokenOk('s3cret-token-and-more', 's3cret-token'), false);
  assert.equal(tokenOk(undefined, 's3cret-token'), false);
  assert.equal(tokenOk(['s3cret-token'], 's3cret-token'), false);
  assert.equal(tokenOk('', ''), false);
  assert.equal(tokenOk('short', 'short'), false); // a token under 8 characters is no token
});

test('Host: only the loopback address and the driver port (no DNS rebinding)', () => {
  assert.equal(hostOk('127.0.0.1:4541', 4541), true);
  assert.equal(hostOk('localhost:4541', 4541), true);
  assert.equal(hostOk('127.0.0.1:4542', 4541), false);
  assert.equal(hostOk('evil.example:4541', 4541), false);
  assert.equal(hostOk(undefined, 4541), false);
});

test('every protocol action is known, and only those', () => {
  const protocol = fs.readFileSync(path.join(ROOT, 'parity', 'PROTOCOL.md'), 'utf8');
  const table = protocol.slice(protocol.indexOf('### `POST /parity/act`'), protocol.indexOf('## Cases'));
  const named = [...table.matchAll(/^\| `([a-z.]+)`(?:, `([a-z.]+)`)? \|/gm)].flatMap((m) => [m[1], m[2]].filter(Boolean));
  assert.equal(named.length, 17);
  assert.deepEqual([...PARITY_ACTIONS].sort(), [...new Set(named)].sort());
  assert.deepEqual(validateAct({ action: 'rm -rf' }).ok, false);
  assert.deepEqual(validateAct({ action: '__proto__' }).ok, false);
  assert.deepEqual(validateAct({ action: 'toString' }).ok, false);
  assert.equal(validateAct(null).ok, false);
  assert.equal(validateAct([]).ok, false);
  assert.equal(validateAct({ action: 'voice.hotkey', args: 'x' }).ok, false);
  assert.deepEqual(validateAct({ action: 'voice.hotkey' }), { ok: true, action: 'voice.hotkey', args: {} });
});

test('action arguments are checked', () => {
  assert.equal(validateAct({ action: 'voice.type', args: {} }).ok, false);
  assert.equal(validateAct({ action: 'voice.type', args: { text: 'x'.repeat(4001) } }).ok, false);
  assert.deepEqual(validateAct({ action: 'voice.type', args: { text: 'hello' } }).args, { text: 'hello' });
  assert.deepEqual(validateAct({ action: 'mic.play', args: { wav: '/tmp/a.wav' } }).args, { wav: '/tmp/a.wav', gapMs: 0 });
  assert.equal(validateAct({ action: 'mic.play', args: { wav: 'a.wav' } }).ok, false); // an absolute path only
  assert.equal(validateAct({ action: 'mic.play', args: { wav: '/tmp/a.wav', gapMs: -1 } }).ok, false);
  assert.equal(validateAct({ action: 'mic.play', args: { wav: '/tmp/a.wav', gapMs: 1e9 } }).ok, false);
  assert.deepEqual(validateAct({ action: 'cursor.set', args: null }).args, { cursor: null });
  assert.deepEqual(validateAct({ action: 'cursor.set', args: { x: null } }).args, { cursor: null });
  assert.deepEqual(validateAct({ action: 'cursor.set', args: { x: 10, y: 20.5 } }).args, { cursor: { x: 10, y: 20.5 } });
  assert.equal(validateAct({ action: 'cursor.set', args: { x: 10 } }).ok, false);
  assert.equal(validateAct({ action: 'cursor.set', args: { x: NaN, y: 1 } }).ok, false);
  assert.deepEqual(validateAct({ action: 'pointer', args: { avatar: 'home', type: 'down', x: 1, y: 2 } }).args, { avatar: 'home', type: 'down', x: 1, y: 2 });
  assert.equal(validateAct({ action: 'pointer', args: { avatar: 'home', type: 'click', x: 1, y: 2 } }).ok, false);
  assert.equal(validateAct({ action: 'pointer', args: { type: 'down', x: 1, y: 2 } }).ok, false);
  // Probes: a file name in parity/probes, never a path.
  assert.deepEqual(validateAct({ action: 'avatar.eval', args: { avatar: 'home', probe: 'qubit-art' } }).args, { avatar: 'home', probe: 'qubit-art.js' });
  assert.deepEqual(validateAct({ action: 'avatar.eval', args: { avatar: 'home', probe: 'figure.js' } }).args.probe, 'figure.js');
  for (const probe of ['../secret.js', '..\\x.js', '/etc/passwd', 'a/b.js', '.hidden.js', 'x.json', '']) assert.equal(validateAct({ action: 'avatar.eval', args: { avatar: 'home', probe } }).ok, false, probe);
  assert.deepEqual(validateAct({ action: 'avatar.command', args: { action: 'roll', dir: 'left' } }).args, { action: 'roll', dir: 'left' });
  assert.equal(validateAct({ action: 'avatar.command', args: { action: 'roll', dir: 'up' } }).ok, false);
  assert.equal(validateAct({ action: 'avatar.command', args: { action: 'Roll()' } }).ok, false);
  assert.deepEqual(validateAct({ action: 'settings.ui', args: { key: 'avatar', value: 'qubit' } }).args, { key: 'avatar', value: 'qubit' });
  assert.equal(validateAct({ action: 'settings.ui', args: { key: 'avatar' } }).ok, false);
  assert.equal(validateAct({ action: 'settings.ui', args: { key: '__proto__.x', value: 1 } }).ok, false);
  assert.equal(validateAct({ action: 'settings.read', args: { key: 'a b' } }).ok, false);
  assert.deepEqual(validateAct({ action: 'window.show', args: { name: 'settings' } }).args, { name: 'settings' });
  assert.equal(validateAct({ action: 'window.show', args: { name: 'devtools' } }).ok, false);
  assert.equal(validateAct({ action: 'perms.set', args: { mic: 'maybe' } }).ok, false);
  assert.equal(validateAct({ action: 'perms.set', args: { ax: 'yes' } }).ok, false);
  assert.equal(validateAct({ action: 'perms.set', args: { mic: 'denied', ax: false } }).ok, true);
});

test('fake permissions: JSON or an object, merged over what was there; anything odd is refused', () => {
  assert.deepEqual(parsePerms('{"mic":"denied","ax":false,"screen":true}'), { mic: 'denied', ax: false, screen: true });
  assert.deepEqual(parsePerms({ mic: 'not-determined' }), { mic: 'not-determined', ax: true, screen: true });
  assert.deepEqual(parsePerms({ screen: false }, { mic: 'denied', ax: false, screen: true }), { mic: 'denied', ax: false, screen: false });
  assert.equal(parsePerms('not json'), null);
  assert.equal(parsePerms('[1]'), null);
  assert.equal(parsePerms({ mic: 'yes' }), null);
  assert.equal(parsePerms({ ax: 1 }), null);
});

test('WAV files are told by their header', () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  assert.equal(isWav(wav), true);
  assert.equal(isWav(Buffer.from('RIFF....AVI LIST'.padEnd(44))), false);
  assert.equal(isWav(Buffer.alloc(10)), false);
  assert.equal(isWav('RIFF'), false);
});

test('rects: Electron bounds and protocol rects become { x, y, w, h }; window px move to the screen', () => {
  assert.deepEqual(rect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(rect({ x: 1.234, y: 2, w: 3, h: 4 }), { x: 1.23, y: 2, w: 3, h: 4 });
  assert.equal(rect({ x: 1, y: 2, w: 3 }), null);
  assert.equal(rect(null), null);
  assert.deepEqual(onScreen({ x: 10, y: 20, w: 30, h: 30 }, { x: 100, y: 500 }), { x: 110, y: 520, w: 30, h: 30 });
  assert.equal(onScreen({ x: 10, y: 20, w: 30, h: 30 }, null), null);
});

test('the events ring keeps the last 200', () => {
  const r = createRing();
  for (let i = 0; i < EVENTS_MAX + 50; i++) r.push({ at: i, type: 't' });
  assert.equal(r.size, EVENTS_MAX);
  assert.equal(r.list()[0].at, 50);
  assert.equal(r.list().at(-1).at, EVENTS_MAX + 49);
});

test('the driver notes only the protocol\x27s event types', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'parity-driver.js'), 'utf8');
  const literal = [...src.matchAll(/note\('([^']+)'/g)].map((m) => m[1]);
  const mapped = [...src.matchAll(/\['(avatar\.[a-z]+)', \(/g)].map((m) => m[1]); // (buddy:* -> avatar.*)
  assert.ok(literal.length >= 6);
  for (const t of [...literal, ...mapped]) assert.ok(PARITY_EVENTS.includes(t), t);
  assert.deepEqual([...new Set([...literal, ...mapped])].sort(), [...PARITY_EVENTS].sort());
});

test('event data holds small plain values only', () => {
  assert.deepEqual(cleanData({ name: 'throw', on: true, n: 3, obj: { secret: 1 }, fn: () => 1 }), { name: 'throw', on: true, n: 3 });
  assert.equal(cleanData({ s: 'x'.repeat(500) }).s.length, 60);
  assert.deepEqual(cleanData(undefined), {});
  assert.deepEqual(cleanData('throw'), { value: 'throw' });
});

test('the voice state: the page\x27s values in the protocol\x27s shape, with defaults', () => {
  assert.deepEqual(shapeVoice(null), EMPTY_VOICE);
  assert.deepEqual(shapeVoice({ phase: 'weird', playedMs: -5, chunks: 2.6, draft: { id: 3, text: 'fix it', targetTitle: null }, lastError: 'x'.repeat(300) }), {
    phase: 'off', asleep: false, connected: false, muted: false, playedMs: 0, scheduledMs: 0, chunks: 3, lastError: 'x'.repeat(200), draft: { id: 3, text: 'fix it', targetTitle: null }, sentCount: 0,
  });
  assert.equal(shapeVoice({ phase: 'speaking', connected: 1 }).connected, true);
  assert.equal(shapeVoice({ draft: { id: 1 } }).draft, null);
});

test('an avatar: window, host, figure (from the page\x27s hit rect), what he stands on', () => {
  const debug = { kind: 'qubit', visible: true, leaving: false, bounds: { x: 0, y: 800, width: 1440, height: 120 }, lifted: false, takesMouse: true, hit: { x: 600, y: 40, w: 60, h: 60 }, voice: { phase: 'listening', asleep: false } };
  const a = shapeAvatar({ id: 'home', role: 'home', debug, host: { pid: null, hwnd: 101, frame: { x: 0, y: 0, width: 1440, height: 900 } }, figure: { standingOn: 'box', asleep: false } });
  assert.deepEqual(a, {
    id: 'home', kind: 'qubit', role: 'home', visible: true, frame: { x: 0, y: 800, w: 1440, h: 120 },
    host: { pid: null, hwnd: 101, frame: { x: 0, y: 0, w: 1440, h: 900 } }, figure: { x: 600, y: 840, w: 60, h: 60 },
    standingOn: 'box', lifted: false, asleep: false, takesMouse: true, leaving: false,
  });
  // No probe answer (the pixel buddy): asleep from the voice state he has, standingOn unknown.
  const b = shapeAvatar({ id: 'ctx1', role: 'guest', debug: { ...debug, kind: 'buddy', hit: null, voice: { phase: 'off' } }, figure: { standingOn: 'roof' } });
  assert.equal(b.kind, 'buddy');
  assert.equal(b.figure, null);
  assert.equal(b.standingOn, null);
  assert.equal(b.asleep, true);
  assert.equal(b.host, null);
  assert.equal(shapeAvatar({ id: 'home', role: 'home', debug: { ...debug, leaving: true } }).visible, false);
});

test('the whole state has every key of the protocol', () => {
  const s = shapeState({});
  assert.deepEqual(Object.keys(s), ['windows', 'claude', 'avatars', 'mouse', 'voice', 'onboarding', 'hotkey', 'login', 'sounds', 'events']);
  assert.deepEqual(Object.keys(s.windows), ['main', 'orb']);
  assert.deepEqual(Object.keys(s.voice), Object.keys(EMPTY_VOICE));
  assert.equal(shapeState({ login: { enabled: 1 } }).login.enabled, true);
});

test('features are honest: no onboarding screen in the Electron build', () => {
  assert.ok(!PARITY_FEATURES.includes('onboarding'));
  for (const f of ['avatar', 'mouse', 'voice', 'settings', 'window', 'hotkey', 'login']) assert.ok(PARITY_FEATURES.includes(f), f);
});

test('the driver is dev-only: main.js loads it only unpackaged with ORBIT_PARITY_PORT, and the build leaves it out', () => {
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const loads = [...main.matchAll(/import\('\.\/parity-driver\.js'\)/g)];
  assert.equal(loads.length, 1);
  const before = main.slice(0, loads[0].index);
  assert.match(before.slice(before.lastIndexOf('if (')), /^if \(!app\.isPackaged && process\.env\.ORBIT_PARITY_PORT\)/);
  assert.ok(!/from '\.\/parity-/.test(main), 'never a static import');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('!electron/parity-*'));
  // The profile folder and its plain key file: unpackaged only.
  assert.match(main, /const PROFILE = !app\.isPackaged && process\.env\.ORBIT_PROFILE_DIR/);
  // The pages fill window.__orbitParity only when the parity preload made it.
  for (const f of ['ui/src/useVoice.ts', 'ui/src/App.tsx']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /const parity = \(window as any\)\.__orbitParity;\s+if \(parity\) \{/);
});

test('the probes are single expressions that parse', () => {
  for (const f of ['qubit-art.js', 'figure.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'parity', 'probes', f), 'utf8');
    assert.doesNotThrow(() => new Function(`return ${src.replace(/^\s*\/\/.*$/gm, '').trim()}`), f);
  }
});
