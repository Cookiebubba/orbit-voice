// Developer testing only: the parity suite's driver for the Electron build (parity/PROTOCOL.md; how
// each field and action maps here: parity/drivers/electron.md). electron/main.js imports this only
// when the app is not packaged and ORBIT_PARITY_PORT is set; the installed app never loads it (and
// the build leaves it out).
//
// It serves GET /parity/hello, GET /parity/state and POST /parity/act on 127.0.0.1, to requests
// carrying the run's x-parity-token. And, while loaded, it keeps the app off the real machine where a
// test would otherwise reach it:
//   - the global hotkey is held here, not registered with the system (voice.hotkey runs it);
//   - "Open at login" is remembered here, never written to the system's login items;
//   - message boxes, error boxes and external links are noted as events, never shown or opened;
//   - ORBIT_FAKE_PERMS: what the permission checks report (systemPreferences), never the real TCC;
//   - ORBIT_MUTE_OUTPUT=1: every page is muted (the voice still plays, timed and counted, unheard);
//   - ORBIT_FAKE_MIC: the pages' microphone is a fake one (electron/parity-preload.cjs) fed WAV clips.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, globalShortcut, ipcMain, screen, session, shell, systemPreferences } from 'electron';
import { getSetting } from '../src/config.js';
import { authUrl, hotkeyLabel } from '../src/server.js';
import { runAvatarCommand } from '../src/avatar-commands.js';
import { logInfo, logWarn } from '../src/log.js';
import { setTestCursor } from './avatar-hover.js';
import { BODY_MAX, PARITY_FEATURES, SOUNDS_MAX, cleanData, createRing, hostOk, isWav, parsePerms, rect, shapeAvatar, shapeState, tokenOk, validateAct, onScreen } from './parity-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROBES = path.join(ROOT, 'parity', 'probes');
const IS_MAC = process.platform === 'darwin';
const PORT = Number(process.env.ORBIT_PARITY_PORT);
const TOKEN = process.env.ORBIT_PARITY_TOKEN || '';
const FAKE_MIC = process.env.ORBIT_FAKE_MIC || '';
const MUTED = process.env.ORBIT_MUTE_OUTPUT === '1';
const JS_TIMEOUT_MS = 2000;

const events = createRing();
const sounds = createRing(SOUNDS_MAX);
const note = (type, data) => events.push({ at: Date.now(), type, data: cleanData(data) });

// ---------- kept off the real machine (applied as this module loads, before main.js uses them) ----------

// The global hotkey: held here (main.js registers it as usual; nothing reaches the system).
const hotkeys = new Map();
globalShortcut.register = (accel, cb) => (hotkeys.set(accel, cb), true);
globalShortcut.isRegistered = (accel) => hotkeys.has(accel);
globalShortcut.unregister = (accel) => void hotkeys.delete(accel);
globalShortcut.unregisterAll = () => hotkeys.clear();

// "Open at login": remembered here only, never registered with the system (PROTOCOL.md's
// ORBIT_FAKE_LOGIN=1; under the driver it is always so).
let loginItem = false;
app.setLoginItemSettings = (s) => {
  loginItem = !!s?.openAtLogin;
};
app.getLoginItemSettings = () => ({ openAtLogin: loginItem, openAsHidden: false, wasOpenedAtLogin: false, wasOpenedAsHidden: false, restoreState: false, executableWillLaunchAtLogin: loginItem, launchItems: [] });

// Dialogs and links: a log line, never a window or a browser. (A message box answers with its last
// button: "Not now", "OK".)
dialog.showMessageBox = async (...a) => {
  const o = a.find((x) => x && typeof x === 'object' && 'message' in x) || {};
  logInfo('parity', `A message box was not shown (${o.type || 'none'})`);
  return { response: Array.isArray(o.buttons) ? o.buttons.length - 1 : 0, checkboxChecked: false };
};
dialog.showErrorBox = () => logInfo('parity', 'An error box was not shown');
shell.openExternal = async () => logInfo('parity', 'An external link was not opened');
shell.openPath = async () => '';

// The permissions the shell checks (ORBIT_FAKE_PERMS). Without it the checks are the real ones.
let perms = process.env.ORBIT_FAKE_PERMS ? parsePerms(process.env.ORBIT_FAKE_PERMS) : null;
if (process.env.ORBIT_FAKE_PERMS && !perms) logWarn('parity', 'ORBIT_FAKE_PERMS is not valid JSON of { mic, ax, screen }: using the real permission checks');
const realPerms = {
  getMediaAccessStatus: systemPreferences.getMediaAccessStatus?.bind(systemPreferences),
  isTrustedAccessibilityClient: systemPreferences.isTrustedAccessibilityClient?.bind(systemPreferences),
};
if (perms) {
  systemPreferences.getMediaAccessStatus = (type) => (type === 'microphone' ? perms.mic : type === 'screen' ? (perms.screen ? 'granted' : 'denied') : 'granted');
  systemPreferences.askForMediaAccess = async (type) => type !== 'microphone' || perms.mic === 'granted';
  systemPreferences.isTrustedAccessibilityClient = () => perms.ax;
}
function permState() {
  if (perms) return { ...perms };
  if (!IS_MAC) return { mic: 'granted', ax: true, screen: true };
  try {
    // Read-only checks (no prompt): the microphone, Accessibility (prompt=false), Screen Recording.
    return { mic: realPerms.getMediaAccessStatus('microphone'), ax: !!realPerms.isTrustedAccessibilityClient(false), screen: realPerms.getMediaAccessStatus('screen') === 'granted' };
  } catch {
    return { mic: 'not-determined', ax: false, screen: false };
  }
}

// ---------- what the pages and windows do ----------

/** The bridge's origin (empty until it has started). */
const bridgeBase = () => {
  try {
    return new URL(authUrl('main')).origin;
  } catch {
    return '';
  }
};
const ours = (wc) => {
  try {
    return !!bridgeBase() && new URL(wc.getURL()).origin === bridgeBase();
  } catch {
    return false;
  }
};
// The parity preload asks whether the fake microphone is on (nothing else is told to the page).
ipcMain.on('parity:config', (e) => {
  e.returnValue = { fakeMic: !!FAKE_MIC };
});

app.on('web-contents-created', (_e, wc) => {
  if (MUTED) wc.setAudioMuted(true);
});
/**
 * A window's messages from the shell to its page, seen on the way (`fn(channel, args)`), once per
 * window. The main page: the sounds it is asked to play, the hotkey; an avatar's: its commands.
 */
const tapped = new WeakSet();
function tapSend(win, fn) {
  if (!win || win.isDestroyed() || tapped.has(win)) return false;
  tapped.add(win);
  const wc = win.webContents;
  const send = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    try {
      fn(channel, args);
    } catch {}
    return send(channel, ...args);
  };
  return true;
}
function watchMain(win) {
  const fresh = tapSend(win, (channel, args) => {
    if (channel === 'avatar:sound') sounds.push({ name: String(args[0]), at: Date.now() });
    else if (channel === 'hotkey') note('hotkey', {});
  });
  if (!fresh) return;
  const wc = win.webContents;
  // ORBIT_FAKE_MIC naming a WAV file: it plays once, when the page first opens the mic.
  if (FAKE_MIC && fs.existsSync(FAKE_MIC)) {
    const initial = () => {
      const b64 = readWav(FAKE_MIC);
      if (b64) wc.executeJavaScript(`window.__orbitParity && window.__orbitParity.mic && window.__orbitParity.mic.setInitial(${JSON.stringify(b64)}), true`, true).catch(() => {});
    };
    wc.on('did-finish-load', initial);
    if (!wc.isLoading()) initial();
  }
}

function readWav(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 30 * 1024 * 1024) return null;
    const buf = fs.readFileSync(file);
    return isWav(buf) ? buf.toString('base64') : null;
  } catch {
    return null;
  }
}

// ---------- the driver ----------

/** Run JS in a page, giving up after a moment (a busy or closing page must not hang the driver). */
function js(wc, code, ms = JS_TIMEOUT_MS) {
  if (!wc || wc.isDestroyed()) return Promise.resolve(undefined);
  let timer;
  return Promise.race([wc.executeJavaScript(code, true).catch((e) => ({ __error: String(e?.message || e).slice(0, 200) })), new Promise((r) => (timer = setTimeout(() => r({ __error: 'the page did not answer' }), ms)))]).finally(() => clearTimeout(timer));
}
const alive = (w) => !!w && !w.isDestroyed();
/** Screen pixels (the Claude window tracker, the focus helper, Orbit's mouse) -> points. */
function dipRect(r) {
  const a = rect(r);
  if (!a) return null;
  if (process.platform !== 'win32') return a;
  try {
    return rect(screen.screenToDipRect(null, { x: a.x, y: a.y, width: a.w, height: a.h }));
  } catch {
    return a;
  }
}
function dipPoint(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  if (process.platform !== 'win32') return { x: p.x, y: p.y };
  try {
    return screen.screenToDipPoint({ x: p.x, y: p.y });
  } catch {
    return { x: p.x, y: p.y };
  }
}

export function startParityDriver(ctx) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) return logWarn('parity', 'ORBIT_PARITY_PORT is not a port: no driver');
  if (!TOKEN || TOKEN.length < 8) logWarn('parity', 'ORBIT_PARITY_TOKEN is missing or short: every driver request will be refused');

  // Events (PROTOCOL.md: exactly these types). voice.phase: the voice state the orb and avatars get,
  // when its phase or sleep changes (levels left out).
  let lastPhase = '';
  ipcMain.on('orb:state', (_e, s) => {
    if (!s || typeof s !== 'object') return;
    const key = `${s.phase}|${!!s.asleep}`;
    if (key === lastPhase) return;
    lastPhase = key;
    note('voice.phase', { phase: String(s.phase), asleep: !!s.asleep });
  });
  // An avatar's page: clicked to talk, picked up / put down, thrown (its sound).
  const who = (e) => avatarList().find((a) => a.avatar.window.webContents === e.sender)?.id || null;
  const fromAvatar = { 'buddy:talk': ['avatar.talk', () => ({})], 'buddy:lift': ['avatar.lift', (on) => ({ on: !!on })], 'buddy:sound': ['avatar.sound', (name) => ({ name: String(name) })] };
  for (const [ch, [type, data]] of Object.entries(fromAvatar)) {
    ipcMain.on(ch, (e, arg) => {
      const id = ours(e.sender) && who(e);
      if (id) note(type, { id, ...data(arg) });
    });
  }
  // Avatars as their windows come and go (avatar.created, avatar.closed), and the commands that reach
  // their pages (avatar.command). The bridge listening (core.ready).
  const seen = new WeakSet();
  let coreReady = false;
  function watchAvatars() {
    if (!coreReady && bridgeBase()) {
      coreReady = true;
      note('core.ready', {});
    }
    for (const a of avatarList()) {
      const win = a.avatar.window;
      if (seen.has(win)) continue;
      seen.add(win);
      const { id } = a;
      note('avatar.created', { id, kind: a.avatar.kind, role: a.role });
      win.once('closed', () => note('avatar.closed', { id }));
      tapSend(win, (channel, args) => {
        if (channel !== 'buddy:command' || !args[0] || typeof args[0] !== 'object') return;
        note('avatar.command', { id, action: String(args[0].action), dir: args[0].dir || null });
      });
    }
  }

  // The session preload: window.__orbitParity (and the fake mic) in every Orbit page.
  app.whenReady().then(() => {
    // (main.js makes its windows later in its own ready handler: picked up as they appear.)
    const look = setInterval(() => {
      if (alive(ctx.main())) watchMain(ctx.main());
      watchAvatars();
    }, 100);
    app.on('will-quit', () => clearInterval(look));
    try {
      session.defaultSession.registerPreloadScript({ type: 'frame', id: 'orbit-parity', filePath: path.join(HERE, 'parity-preload.cjs') });
    } catch (e) {
      logWarn('parity', `Could not register the parity preload: ${String(e?.message || e).slice(0, 120)}`);
    }
  });

  /** Every avatar now: home (main.js's) and the guests (avatar-host.js), with its id and role. */
  function avatarList() {
    const out = [];
    const home = ctx.avatar();
    if (home && alive(home.window)) out.push({ id: 'home', role: 'home', avatar: home, host: null });
    for (const g of ctx.avatarHost()?.debug?.() || []) if (alive(g.avatar.window)) out.push({ id: String(g.id), role: 'guest', avatar: g.avatar, host: g });
    return out;
  }
  const findAvatar = (id) => avatarList().find((a) => a.id === id) || null;
  const probeSource = (name) => fs.readFileSync(path.join(PROBES, name), 'utf8');
  let figureSrc = null;

  async function avatarsState() {
    const list = avatarList();
    figureSrc ??= (() => {
      try {
        return probeSource('figure.js');
      } catch {
        return null;
      }
    })();
    return Promise.all(
      list.map(async (a) => {
        const d = a.avatar.debug();
        const fig = figureSrc && d.visible ? await js(a.avatar.window.webContents, figureSrc, 800) : null;
        let host = null;
        if (a.role === 'home') host = d.host ? { pid: null, hwnd: d.hostHwnd || undefined, frame: d.host } : null;
        else if (a.host?.bounds) host = { pid: null, hwnd: a.host.hwnd || undefined, frame: dipRect(a.host.bounds) };
        return shapeAvatar({ id: a.id, role: a.role, debug: d, host, figure: fig && !fig.__error ? fig : null });
      }),
    );
  }

  async function state() {
    const main = ctx.main();
    const orb = ctx.orb();
    const page = alive(main) ? await js(main.webContents, '(() => { const p = window.__orbitParity; return p ? { voice: p.voice ? p.voice() : null, view: p.app ? p.app.view : null } : null; })()') : null;
    const pg = page && !page.__error ? page : null;
    const c = ctx.claude();
    const home = ctx.avatar();
    const hd = home && alive(home.window) ? home.debug() : null;
    const strip = hd?.strip;
    const m = ctx.orbitMouse()?.debug?.();
    const p = permState();
    const accel = getSetting('wakeHotkey');
    return shapeState({
      windows: {
        main: { visible: alive(main) && main.isVisible(), frame: alive(main) ? rect(main.getBounds()) : null, view: pg?.view || 'main' },
        orb: { visible: alive(orb) && orb.isVisible(), frame: alive(orb) ? rect(orb.getBounds()) : null },
      },
      claude: {
        found: !!c?.found,
        pid: null,
        ...(c?.found ? { hwnd: c.hwnd } : {}),
        frame: c?.found ? dipRect({ x: c.x, y: c.y, w: c.w, h: c.h }) : null,
        box: hd && !hd.free && hd.box && strip ? onScreen(hd.box, strip) : null,
        send: hd && !hd.free && hd.send && strip ? onScreen(hd.send, strip) : null,
      },
      avatars: await avatarsState(),
      mouse: m ? { visible: !!m.visible, pos: dipPoint(m.now || m.pos), windows: (m.pages || []).filter((x) => x.shown).length } : null,
      voice: pg?.voice || null,
      onboarding: { ...p, step: 'done', shown: false }, // (Electron has no onboarding screen)
      hotkey: { accelerator: accel, label: hotkeyLabel(accel), registered: hotkeys.has(accel) },
      login: { enabled: loginItem },
      sounds: sounds.list(),
      events: events.list(),
    });
  }

  /** Run something on the main page's parity object (ui/src/App.tsx). */
  async function pageCall(expr) {
    const main = ctx.main();
    if (!alive(main)) return { ok: false, error: 'The main window is not there.' };
    const r = await js(main.webContents, `(async () => { const a = window.__orbitParity && window.__orbitParity.app; if (!a) return { ok: false, error: 'The page has not loaded its parity hooks.' }; return ${expr}; })()`, 5000);
    if (r && r.__error) return { ok: false, error: r.__error };
    return r;
  }

  const pressed = new Set(); // avatars with a synthetic press under way (their moves carry the button)
  const act = {
    'voice.hotkey': () => {
      const cb = hotkeys.get(getSetting('wakeHotkey'));
      if (!cb) return { ok: false, error: 'The hotkey is not registered.' };
      cb();
      return { ok: true };
    },
    'voice.sleep': () => pageCall('(a.sleep(), { ok: true })'),
    'voice.wake': () => pageCall('(a.wake(), { ok: true })'),
    'voice.hangup': () => pageCall('(a.hangup(), { ok: true })'),
    'voice.type': ({ text }) => pageCall(`a.type(${JSON.stringify(text)})`),
    'mic.play': async ({ wav, gapMs }) => {
      if (!FAKE_MIC) return { ok: false, error: 'ORBIT_FAKE_MIC is not set (the real microphone is never swapped).' };
      const b64 = readWav(path.resolve(wav));
      if (!b64) return { ok: false, error: 'Not a readable WAV file (RIFF/WAVE, at most 30 MB).' };
      const main = ctx.main();
      if (!alive(main)) return { ok: false, error: 'The main window is not there.' };
      const r = await js(main.webContents, `(async () => { const m = window.__orbitParity && window.__orbitParity.mic; if (!m) return { __error: 'no fake mic in the page' }; return m.play(${JSON.stringify(b64)}, ${Number(gapMs) || 0}); })()`, 10_000);
      if (!r || r.__error) return { ok: false, error: r?.__error || 'The page did not play it.' };
      return { ok: true, ...r };
    },
    'cursor.set': ({ cursor }) => {
      setTestCursor(cursor);
      return { ok: true, cursor };
    },
    pointer: ({ avatar, type, x, y }) => {
      const a = findAvatar(avatar);
      if (!a) return { ok: false, error: `No avatar ${avatar}.` };
      const win = a.avatar.window;
      const b = win.getBounds();
      // Straight to that window's page (never the system's input queue, never the real cursor).
      const ev = { type: type === 'down' ? 'mouseDown' : type === 'up' ? 'mouseUp' : 'mouseMove', x: Math.round(x - b.x), y: Math.round(y - b.y), globalX: Math.round(x), globalY: Math.round(y), button: 'left', clickCount: 1 };
      if (type === 'move' && pressed.has(avatar)) ev.modifiers = ['leftButtonDown'];
      if (type === 'down') pressed.add(avatar);
      if (type === 'up') pressed.delete(avatar);
      win.webContents.sendInputEvent(ev);
      return { ok: true, local: { x: ev.x, y: ev.y } };
    },
    'avatar.eval': async ({ avatar, probe }) => {
      const a = findAvatar(avatar);
      if (!a) return { ok: false, error: `No avatar ${avatar}.` };
      let src;
      try {
        src = probeSource(probe);
      } catch {
        return { ok: false, error: `No probe ${probe} in parity/probes.` };
      }
      const v = await js(a.avatar.window.webContents, src, 5000);
      if (v && v.__error) return { ok: false, error: v.__error };
      return { ok: true, value: v ?? null };
    },
    'avatar.command': ({ action, dir }) => {
      const r = runAvatarCommand({ action, dir }, { source: 'model' });
      return { ...r, ok: !!r?.ok };
    },
    // Electron's Settings screen is the React page: these go through its own model (useAppState's
    // updateSettings, which posts /api/settings with the page's sign-in; the hotkey and "Open at
    // login" through window.desktop, as its controls do).
    'settings.ui': ({ key, value }) => pageCall(`a.setSetting(${JSON.stringify(key)}, ${JSON.stringify(value)})`),
    'settings.read': async ({ key }) => {
      const r = await pageCall(`({ ok: true, value: await a.setting(${JSON.stringify(key)}) })`);
      return r?.ok ? { ok: true, value: r.value === undefined ? null : r.value } : r;
    },
    'window.show': async ({ name }) => {
      ctx.showMain();
      return pageCall(`(a.show(${JSON.stringify(name)}), { ok: true })`);
    },
    'window.minimize': () => {
      ctx.showOrb();
      return { ok: true };
    },
    'perms.set': ({ perms: next }) => {
      perms = parsePerms(next, perms || permState());
      if (perms) {
        systemPreferences.getMediaAccessStatus = (type) => (type === 'microphone' ? perms.mic : type === 'screen' ? (perms.screen ? 'granted' : 'denied') : 'granted');
        systemPreferences.askForMediaAccess = async (type) => type !== 'microphone' || perms.mic === 'granted';
        systemPreferences.isTrustedAccessibilityClient = () => perms.ax;
      }
      // (Electron's shell checks the microphone once at launch; it has nothing that re-checks.)
      return { ok: true, perms };
    },
    'onboarding.next': () => ({ ok: false, error: 'Electron has no onboarding screen.' }),
    quit: () => {
      setTimeout(() => app.quit(), 100);
      return { ok: true };
    },
  };

  const reply = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };
  const server = http.createServer((req, res) => {
    // Only this run's caller: the loopback Host (no DNS rebinding), no browser page (no Origin), the token.
    if (!hostOk(req.headers.host, PORT) || req.headers.origin || !tokenOk(req.headers['x-parity-token'], TOKEN)) return reply(res, 403, { ok: false, error: 'forbidden' });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/parity/hello') {
      return reply(res, 200, { app: 'electron', version: app.getVersion(), pid: process.pid, platform: process.platform, bridge: { base: bridgeBase() || null, authUrl: bridgeBase() ? authUrl('main') : null }, features: [...PARITY_FEATURES], actions: Object.keys(act) });
    }
    if (req.method === 'GET' && url.pathname === '/parity/state') {
      return state().then(
        (s) => reply(res, 200, s),
        (e) => reply(res, 500, { ok: false, error: String(e?.message || e).slice(0, 200) }),
      );
    }
    if (req.method === 'POST' && url.pathname === '/parity/act') {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > BODY_MAX) req.destroy();
        else chunks.push(c);
      });
      req.on('end', async () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        } catch {
          return reply(res, 400, { ok: false, error: 'The body is not JSON.' });
        }
        const v = validateAct(body);
        if (!v.ok) return reply(res, 400, v);
        try {
          const r = await act[v.action](v.args);
          reply(res, 200, r && typeof r === 'object' ? r : { ok: false, error: 'No answer.' });
        } catch (e) {
          reply(res, 200, { ok: false, error: String(e?.message || e).slice(0, 200) });
        }
      });
      return;
    }
    reply(res, 404, { ok: false, error: 'not found' });
  });
  server.on('error', (e) => logWarn('parity', `The parity driver could not listen on ${PORT}: ${e.code || e.message}`));
  server.listen(PORT, '127.0.0.1', () => logInfo('parity', `Developer mode: the parity driver is listening on 127.0.0.1:${PORT}`));
  app.on('will-quit', () => server.close());
  return { server, state, events, note };
}
