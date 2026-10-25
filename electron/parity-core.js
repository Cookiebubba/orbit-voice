// The parity driver's pure parts (no Electron here, so the tests run them in plain node): the token
// and Host checks, what each action may be given, the fake permissions, and how the shell's own
// state is shaped into parity/PROTOCOL.md's GET /parity/state. electron/parity-driver.js does the
// Electron side. Developer testing only: neither file loads in the installed app.

import crypto from 'node:crypto';
import path from 'node:path';

/** What this build implements (PROTOCOL.md "features"). Electron has no onboarding screen. */
export const PARITY_FEATURES = Object.freeze(['avatar', 'mouse', 'voice', 'settings', 'window', 'hotkey', 'login', 'updater']);
export const EVENTS_MAX = 200;
/** The events ring's types (PROTOCOL.md), and nothing else. */
export const PARITY_EVENTS = Object.freeze(['avatar.created', 'avatar.closed', 'avatar.talk', 'avatar.lift', 'avatar.sound', 'avatar.command', 'voice.phase', 'hotkey', 'core.ready']);
export const SOUNDS_MAX = 50;

// Electron's accelerator grammar (modifiers, then one key), so the driver's stand-in hotkey refuses
// what globalShortcut.register itself would throw on.
const MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta']);
const KEYS = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4])|plus|space|tab|capslock|numlock|scrolllock|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|volumeup|volumedown|volumemute|medianexttrack|mediaprevioustrack|mediastop|mediaplaypause|printscreen|num[0-9]|numdec|numadd|numsub|nummult|numdiv|[)!@#$%^&*(:;:+=<,_\-.>?/~`{\]|}"'])$/;
export function isValidAccelerator(accel) {
  if (typeof accel !== 'string' || !accel || accel.length > 60) return false;
  const parts = accel.split('+');
  if (parts.some((p) => p === '')) return false;
  const key = parts.pop().toLowerCase();
  return parts.every((m) => MODIFIERS.has(m.toLowerCase())) && new Set(parts.map((m) => m.toLowerCase())).size === parts.length && KEYS.test(key) && !MODIFIERS.has(key);
}
export const BODY_MAX = 1 << 20;
const MIC_STATES = new Set(['granted', 'denied', 'not-determined', 'restricted']);

/** The request's x-parity-token is the run's token (constant time). No token configured: nothing passes. */
export function tokenOk(header, token) {
  if (typeof token !== 'string' || token.length < 8 || typeof header !== 'string') return false;
  const a = crypto.createHash('sha256').update(header).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Only requests addressed to the driver itself (no DNS rebinding: Host is the loopback address and port). */
export function hostOk(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** ORBIT_FAKE_PERMS / perms.set: `{ mic, ax, screen }`, each optional; merged over `base`. null if not valid. */
export function parsePerms(input, base = { mic: 'granted', ax: true, screen: true }) {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = { ...base };
  if ('mic' in v) {
    if (!MIC_STATES.has(v.mic)) return null;
    out.mic = v.mic;
  }
  for (const k of ['ax', 'screen']) {
    if (!(k in v)) continue;
    if (typeof v[k] !== 'boolean') return null;
    out[k] = v[k];
  }
  return out;
}

const str = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;
const none = () => ({});

/** Each action and what it may be given (returns the clean args, or a string saying what's wrong). */
const ACTIONS = {
  'voice.hotkey': none,
  'voice.sleep': none,
  'voice.wake': none,
  'voice.hangup': none,
  'voice.type': (a) => (str(a.text, 4000) ? { text: a.text } : 'text: a non-empty string'),
  'mic.play': (a) => {
    if (!str(a.wav, 1024) || !path.isAbsolute(a.wav)) return 'wav: an absolute path to a WAV file';
    if (a.gapMs !== undefined && !(num(a.gapMs) && a.gapMs >= 0 && a.gapMs <= 60_000)) return 'gapMs: 0..60000';
    return { wav: a.wav, gapMs: a.gapMs ?? 0 };
  },
  'cursor.set': (a) => {
    if (a === null || a.x === null || a.x === undefined) return { cursor: null };
    return num(a.x) && num(a.y) ? { cursor: { x: a.x, y: a.y } } : 'x, y: numbers (or null for the real cursor)';
  },
  pointer: (a) => {
    if (!str(a.avatar, 100)) return 'avatar: an avatar id';
    if (!['down', 'move', 'up'].includes(a.type)) return 'type: down, move or up';
    return num(a.x) && num(a.y) ? { avatar: a.avatar, type: a.type, x: a.x, y: a.y } : 'x, y: numbers (screen points)';
  },
  'avatar.eval': (a) => {
    if (!str(a.avatar, 100)) return 'avatar: an avatar id';
    // A file name in parity/probes, nothing else (no paths).
    if (typeof a.probe !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}(\.js)?$/i.test(a.probe)) return 'probe: a file name in parity/probes';
    return { avatar: a.avatar, probe: a.probe.endsWith('.js') ? a.probe : `${a.probe}.js` };
  },
  'avatar.command': (a) => {
    if (typeof a.action !== 'string' || !/^[a-z_]{1,30}$/.test(a.action)) return 'action: an avatar action';
    if (a.dir !== undefined && a.dir !== null && a.dir !== 'left' && a.dir !== 'right') return 'dir: left or right';
    return { action: a.action, ...(a.dir ? { dir: a.dir } : {}) };
  },
  'settings.ui': (a) => {
    if (typeof a.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(a.key)) return 'key: a setting name';
    return a.value === undefined ? 'value: required' : { key: a.key, value: a.value };
  },
  'settings.read': (a) => (typeof a.key === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(a.key) ? { key: a.key } : 'key: a setting name'),
  'window.show': (a) => (['main', 'settings', 'history'].includes(a.name) ? { name: a.name } : 'name: main, settings or history'),
  'window.minimize': none,
  'perms.set': (a) => (parsePerms(a, {}) ? { perms: a } : 'mic: granted|denied|not-determined|restricted, ax and screen: booleans'),
  'onboarding.next': none,
  quit: none,
};
export const PARITY_ACTIONS = Object.freeze(Object.keys(ACTIONS));

/** A POST /parity/act body: { ok, action, args } or { ok: false, error }. */
export function validateAct(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send { "action": "...", "args": { ... } }.' };
  const { action } = body;
  if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) return { ok: false, error: `Unknown action: ${String(action).slice(0, 60)}` };
  const raw = body.args === undefined ? {} : body.args;
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) return { ok: false, error: `${action}: args must be an object` };
  const r = ACTIONS[action](raw === null ? (action === 'cursor.set' ? null : {}) : raw);
  if (typeof r === 'string') return { ok: false, error: `${action}: ${r}` };
  return { ok: true, action, args: r };
}

/** A WAV file's header (RIFF....WAVE). */
export const isWav = (buf) => Buffer.isBuffer(buf) && buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';

// ---------- shaping the state ----------

/** { x, y, width, height } or { x, y, w, h } -> { x, y, w, h } (rounded to 0.01), or null. */
export function rect(r) {
  if (!r || typeof r !== 'object') return null;
  const w = r.w ?? r.width;
  const h = r.h ?? r.height;
  if (![r.x, r.y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const k = (n) => Math.round(n * 100) / 100;
  return { x: k(r.x), y: k(r.y), w: k(w), h: k(h) };
}

/** A rect given in a window's (or strip's) own px, moved to the screen by that window's origin. */
export function onScreen(r, origin) {
  const a = rect(r);
  if (!a || !origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
  return rect({ x: a.x + origin.x, y: a.y + origin.y, w: a.w, h: a.h });
}

/** A ring buffer of the last `max` items. */
export function createRing(max = EVENTS_MAX) {
  const items = [];
  return {
    push(item) {
      items.push(item);
      if (items.length > max) items.splice(0, items.length - max);
    },
    list: () => items.slice(),
    get size() {
      return items.length;
    },
  };
}

const PHASES = new Set(['off', 'connecting', 'listening', 'thinking', 'speaking']);
export const EMPTY_VOICE = Object.freeze({ phase: 'off', asleep: false, connected: false, muted: false, playedMs: 0, scheduledMs: 0, chunks: 0, lastError: null, draft: null, sentCount: 0 });

/** The page's voice state (ui/src/useVoice.ts, window.__orbitParity.voice()) in the protocol's shape. */
export function shapeVoice(v) {
  if (!v || typeof v !== 'object') return { ...EMPTY_VOICE };
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);
  const d = v.draft && typeof v.draft === 'object' && typeof v.draft.text === 'string' ? { id: n(v.draft.id), text: v.draft.text, targetTitle: typeof v.draft.targetTitle === 'string' ? v.draft.targetTitle : null } : null;
  return {
    phase: PHASES.has(v.phase) ? v.phase : 'off',
    asleep: !!v.asleep,
    connected: !!v.connected,
    muted: !!v.muted,
    playedMs: n(v.playedMs),
    scheduledMs: n(v.scheduledMs),
    chunks: n(v.chunks),
    lastError: typeof v.lastError === 'string' ? v.lastError.slice(0, 200) : null,
    draft: d,
    sentCount: n(v.sentCount),
  };
}

const STANDING = new Set(['box', 'floor', 'air']);

/**
 * One avatar in the protocol's shape, from its window's debug() (electron/avatar.js), the window it
 * lives on (`host`: { pid, hwnd, frame } in screen points, or null) and what the figure probe read in
 * its page (`figure`: { standingOn, asleep } or null).
 */
export function shapeAvatar({ id, role, debug: d, host = null, figure = null }) {
  const frame = rect(d?.bounds);
  const voiceAsleep = !d?.voice || d.voice.phase === 'off' || !!d.voice.asleep;
  return {
    id,
    kind: d?.kind === 'qubit' ? 'qubit' : 'buddy',
    role,
    visible: !!d?.visible && !d?.leaving,
    frame,
    host: host && host.frame ? { pid: Number.isInteger(host.pid) ? host.pid : null, ...(host.hwnd ? { hwnd: host.hwnd } : {}), frame: rect(host.frame) } : null,
    figure: d?.hit && frame ? onScreen(d.hit, frame) : null,
    standingOn: STANDING.has(figure?.standingOn) ? figure.standingOn : null,
    lifted: !!d?.lifted,
    asleep: typeof figure?.asleep === 'boolean' ? figure.asleep : voiceAsleep,
    takesMouse: !!d?.takesMouse,
    leaving: !!d?.leaving,
  };
}

/** The whole snapshot, every key present (defaults where a part is missing). */
export function shapeState(p = {}) {
  return {
    windows: {
      main: p.windows?.main || { visible: false, frame: null, view: 'main' },
      orb: p.windows?.orb || { visible: false, frame: null },
    },
    claude: p.claude || { found: false, pid: null, frame: null, box: null, send: null },
    avatars: Array.isArray(p.avatars) ? p.avatars : [],
    mouse: p.mouse || { visible: false, pos: null, windows: 0 },
    voice: shapeVoice(p.voice),
    onboarding: p.onboarding || { mic: 'granted', ax: true, screen: true, step: 'done', shown: false },
    hotkey: p.hotkey || { accelerator: '', label: '', registered: false },
    login: { enabled: !!p.login?.enabled },
    sounds: Array.isArray(p.sounds) ? p.sounds : [],
    events: Array.isArray(p.events) ? p.events : [],
  };
}

/** Event data with nothing but small plain values (no user words go in here; strings are cut short). */
export function cleanData(data) {
  if (data === undefined || data === null) return {};
  if (typeof data !== 'object') return { value: typeof data === 'string' ? data.slice(0, 60) : data };
  const out = {};
  for (const [k, v] of Object.entries(data).slice(0, 12)) {
    if (typeof v === 'string') out[k] = v.slice(0, 60);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}
