// Orbit Native's sidecar: Orbit's Node core (src/server.js, the bridge) run for the Swift shell, the
// way electron/main.js runs it for Electron. The Swift app starts this with the embedded Node, talks
// to the bridge over its HTTP/WebSocket API like the Electron page does, and exchanges the rest (the
// shell hooks main.js wires in-process) over stdin/stdout, one JSON object per line. See
// mac-swift/README.md "Sidecar channel".
//
// stdout belongs to the channel: every channel line starts with CHANNEL_MARK, and everything the core
// prints with console.log goes to stderr instead (the Swift side logs stderr, minus user words, which
// the core never prints anyway).
//
// Keys at rest: the xAI key, the optional Anthropic key, connector tokens and keeper tokens are
// sealed with AES-256-GCM under a key the Swift app keeps in the login Keychain and hands over on
// stdin at start (`init`). The key itself never touches the disk or the logs here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The core: next to this file in the app bundle (Resources/core/src), or the repo when run from source.
const CORE = process.env.ORBIT_CORE_DIR ? path.resolve(process.env.ORBIT_CORE_DIR) : path.resolve(HERE, '..', '..');
export const CHANNEL_MARK = '\u0001ORB ';
// Test switches (fake desktop, fake Grok...) only when the Swift app says this is a test build.
const TESTING = process.env.ORBIT_PARITY_ALLOWED === '1';

// ---------------------------------------------------------------- the channel

const out = process.stdout;
export function send(msg) {
  try {
    out.write(CHANNEL_MARK + JSON.stringify(msg) + '\n');
  } catch {}
}
// The core's own prints go to stderr (the channel owns stdout).
for (const k of ['log', 'info', 'debug']) console[k] = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

const handlers = new Map(); // t -> fn(msg)
export const on = (t, fn) => handlers.set(t, fn);

/** The first line on stdin is `init` (the seal key); then commands, until stdin closes (the app quit). */
function readInit() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin });
    let first = true;
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (first) {
        first = false;
        if (msg?.t !== 'init') return reject(new Error('expected init'));
        return resolve(msg);
      }
      const fn = handlers.get(msg?.t);
      if (fn) Promise.resolve().then(() => fn(msg)).catch((e) => send({ t: 'log', level: 'warn', scope: 'sidecar', message: `${msg.t} failed: ${String(e?.message || e).slice(0, 200)}` }));
    });
    // The app is gone (it closed our stdin): stop with it.
    rl.on('close', () => shutdown(0));
    setTimeout(() => first && reject(new Error('no init within 10 s')), 10_000).unref();
  });
}

// ---------------------------------------------------------------- sealed storage

const SEAL_MAGIC = Buffer.from('ONS1');
export function makeSealer(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('seal key must be 32 bytes');
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return Buffer.concat([SEAL_MAGIC, iv, c.getAuthTag(), body]);
    },
    open(buf) {
      if (!Buffer.isBuffer(buf) || buf.length < 32 || !buf.subarray(0, 4).equals(SEAL_MAGIC)) throw new Error('not sealed');
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16));
      d.setAuthTag(buf.subarray(16, 32));
      return Buffer.concat([d.update(buf.subarray(32)), d.final()]).toString('utf8');
    },
  };
}

/** A key store like electron/main.js encryptedKeyStore, sealed with the sidecar's key. */
export function sealedKeyStore(sealer, dir, name) {
  const file = path.join(dir, name);
  return {
    kind: 'macos-keychain', // the sealing key lives in the login Keychain
    get() {
      try {
        return sealer.open(fs.readFileSync(file));
      } catch {
        return '';
      }
    },
    set(key) {
      if (key) fs.writeFileSync(file, sealer.seal(key), { mode: 0o600 });
      else fs.rmSync(file, { force: true });
    },
  };
}

/** Connectors' tokens (electron/main.js encryptedMapStore), sealed the same way. */
export function sealedMapStore(sealer, dir, name) {
  const file = path.join(dir, name);
  let memory = null;
  const load = () => {
    if (memory) return memory;
    try {
      memory = JSON.parse(sealer.open(fs.readFileSync(file)));
    } catch {
      memory = {};
    }
    return memory;
  };
  return {
    get: (k) => (typeof load()[k] === 'string' ? load()[k] : null),
    set(k, v) {
      const m = load();
      if (v) m[k] = String(v);
      else delete m[k];
      fs.writeFileSync(file, sealer.seal(JSON.stringify(m)), { mode: 0o600 });
    },
  };
}

// ---------------------------------------------------------------- start

let stopCore = null;
let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  try {
    stopCore?.();
  } catch {}
  setTimeout(() => process.exit(code), 150).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

async function main() {
  const init = await readInit();
  const profile = path.resolve(process.env.ORBIT_PROFILE_DIR || path.join(process.env.HOME || '.', 'Library', 'Application Support', 'Orbit Native'));
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const sealer = makeSealer(Buffer.from(String(init.sealKey || ''), 'base64'));
  const core = (rel) => import(pathToFileURL(path.join(CORE, rel)).href);

  const server = await core('src/server.js');
  const desktop = await core('src/desktop.js');
  const avatarCommands = await core('src/avatar-commands.js');
  const mouse = await core('src/anywhere/mouse.js');
  const anywhere = await core('src/anywhere/index.js');
  const mcp = await core('src/mcp/index.js');
  const keeper = await core('src/anywhere/keeper.js');
  const platform = await core('src/platform/index.js');
  const config = await core('src/config.js');

  // Developer testing only: the JS stand-in for the Claude desktop driver (and its focus/UIA doubles).
  let fake = null;
  if (TESTING && process.env.ORBIT_FAKE_DESKTOP) {
    const m = await import(pathToFileURL(path.resolve(process.env.ORBIT_FAKE_DESKTOP)).href);
    fake = m.default || m;
    desktop.setDesktopDriver(fake);
  }

  // ---- the avatar: the Swift shell owns it; it reports what's on screen, so the core gets its
  // answer at once (the core's sink is synchronous, like Electron's).
  let avatarState = { kind: null, onScreen: false };
  on('avatarState', (m) => (avatarState = { kind: m.kind === 'qubit' || m.kind === 'buddy' ? m.kind : null, onScreen: !!m.onScreen }));
  avatarCommands.setAvatarSink((cmd) => {
    if (!avatarState.kind || !avatarState.onScreen) return { ok: false, error: 'There is no avatar on screen.' };
    send({ t: 'avatar.cmd', cmd });
    return { ok: true };
  });

  // ---- Orbit's mouse: drawn by the Swift shell. The glide's timing is worked out here the way
  // electron/orbit-mouse.js does, so the core can wait on `arrived` without a round trip.
  let displays = []; // work areas, physical px: [{x,y,w,h,scale}]
  on('screens', (m) => (displays = Array.isArray(m.displays) ? m.displays.filter((d) => [d.x, d.y, d.w, d.h].every(Number.isFinite)) : []));
  const displayAt = (p) => displays.find((d) => p.x >= d.x && p.y >= d.y && p.x < d.x + d.w && p.y < d.y + d.h) || null;
  let mousePos = null;
  let mouseUntil = 0; // when it will have faded out
  mouse.setMouseSink({
    glide({ x, y, ms = null, holdMs = 1500 } = {}) {
      if (config.getSetting('anywhere') === false || config.getSetting('anywhereMouse') === false) return { shown: false, why: 'off' };
      const to = { x: Number(x), y: Number(y) };
      if (![to.x, to.y].every(Number.isFinite)) return { shown: false, why: 'no_place' };
      const d = displayAt(to);
      if (!d) return { shown: false, why: 'off_screen' };
      const scale = d.scale || 1;
      const was = mousePos && Date.now() < mouseUntil ? mousePos : null;
      const from = was || { x: to.x + MOUSE_TIMING.enterDip.x * scale, y: to.y + MOUSE_TIMING.enterDip.y * scale };
      const dist = Math.hypot(to.x - from.x, to.y - from.y) / scale;
      const dur = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : glideMs(dist);
      mousePos = to;
      mouseUntil = Date.now() + dur + Math.max(0, Number(holdMs) || 0) + MOUSE_TIMING.fadeMs;
      send({ t: 'mouse.glide', x: to.x, y: to.y, ms: dur, holdMs: Math.max(0, Number(holdMs) || 0) });
      return { shown: true, ms: dur, arrived: new Promise((r) => setTimeout(r, dur)) };
    },
    press() {
      send({ t: 'mouse.press' });
      return true;
    },
    hide() {
      mousePos = null;
      send({ t: 'mouse.hide' });
    },
    onScreen: (p) => !!(p && displayAt(p)),
  });

  // ---- Orbit anywhere: contexts and focus go to the shell (Qubit comes along to other windows).
  anywhere.contexts.on((snap) => send({ t: 'contexts', snap }));
  platform.focus.on('change', () => send({ t: 'focus', current: platform.focus.current || null, recent: (platform.focus.recent || []).slice(0, 12) }));
  on('wake', (m) => m.win && anywhere.wakeWith(m.win));
  on('homeWindow', (m) => anywhere.contexts.setHomeWindow(Number(m.id) || 0));
  let frontHint = 0;
  on('frontHint', (m) => (frontHint = Number(m.id) || 0));
  desktop.setFrontWindowHint(() => frontHint);
  desktop.onPromptBoxWork(() => send({ t: 'promptBoxWork' }));

  // The window in front, in any app (Settings -> Orbit anywhere), as electron/main.js setFocusTracking.
  let tracker = null;
  const cacheDir = path.join(profile, 'cache');
  const setFocusTracking = () => {
    const want = config.getSetting('anywhere') !== false && (!fake || !!fake.focusHelper);
    if (want && !tracker) {
      tracker = platform.startFocusTracking({ spawnHelper: fake?.focusHelper || null, onError: (m) => send({ t: 'log', level: 'warn', scope: 'focus', message: m }), onWins: (wins) => send({ t: 'wins', wins }) });
      if (!fake || fake.uiaHelper) platform.startUia({ spawnHelper: fake?.uiaHelper || null, cacheDir, onError: (m) => send({ t: 'log', level: 'warn', scope: 'uia', message: m }) });
    } else if (!want && tracker) {
      tracker.stop();
      tracker = null;
      platform.stopUia();
    }
  };

  // ---- the bridge
  let base;
  try {
    base = await server.startServer({
      port: Number(process.env.PORT || 4317),
      configDir: profile,
      secrets: sealedKeyStore(sealer, profile, 'xai-key.sealed'),
      brainSecrets: sealedKeyStore(sealer, profile, 'anthropic-key.sealed'),
      clipboard: (text) => send({ t: 'clipboard', text: String(text) }),
      models: process.env.ORBIT_MODELS_DIR || path.join(CORE, 'resources', 'models'),
    });
  } catch (e) {
    send({ t: 'error', code: e?.code || 'start_failed', message: e?.code === 'EADDRINUSE' ? `Port ${process.env.PORT || 4317} is already in use, probably by another copy of Orbit. Close it first.` : String(e?.message || e).slice(0, 300) });
    return shutdown(1);
  }
  mcp.setMcpShell({
    store: sealedMapStore(sealer, profile, 'mcp-tokens.sealed'),
    openExternal: (u) => (/^https:\/\//.test(u) ? (send({ t: 'openExternal', url: u }), Promise.resolve()) : Promise.reject(new Error('Only https sign-in pages open.'))),
  });
  // Apps under Orbit: keepers run as this Node with the keeper entry (no Electron here).
  keeper.setKeeperLauncher({ execPath: process.execPath, preArgs: [path.join(HERE, 'keeper.mjs')] });
  keeper.setKeeperCrypto({ protect: (s) => sealer.seal(String(s)).toString('base64'), unprotect: (s) => sealer.open(Buffer.from(String(s), 'base64')) });
  config.onSettingsChange((changed) => changed.includes('anywhere') && setFocusTracking());
  setFocusTracking();

  stopCore = () => {
    server.stopBackgroundWork();
    tracker?.stop();
    platform.stopUia();
  };
  on('quit', () => shutdown(0));
  const auth = Object.fromEntries(['main', 'orb', 'qubit', 'buddy', 'mouse'].map((v) => [v, server.authUrl(v)]));
  send({ t: 'ready', base, auth, version: config.DEFAULTS ? JSON.parse(fs.readFileSync(path.join(CORE, 'package.json'), 'utf8')).version : '' });
}

// electron/orbit-mouse.js's timing (that file needs Electron, so it can't be imported here; a test
// checks these match it).
export const MOUSE_TIMING = Object.freeze({ fadeMs: 260, enterDip: { x: -46, y: -34 }, margin: 56, roomDip: 160 });
/** How long a glide of `distDip` takes (electron/orbit-mouse.js glideMs). */
export const glideMs = (distDip) => Math.round(Math.min(700, Math.max(260, 240 + Math.max(0, Number(distDip) || 0) * 0.45)));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    send({ t: 'error', code: 'start_failed', message: String(e?.message || e).slice(0, 300) });
    shutdown(1);
  });
}
