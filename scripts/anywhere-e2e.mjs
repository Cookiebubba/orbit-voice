// End-to-end test of "Orbit anywhere" phase 4 (one Orbit, many windows): the real Orbit
// (electron/main.js, the bridge, the pages) with Qubit chosen, a stand-in Grok and stand-ins for the
// Claude window and the focus helper (test/e2e/fake-desktop.mjs, fake-focus.mjs), with two other
// "app windows" far off screen. Checks: waking Orbit in an app window brings the conversation (and
// a Qubit) there; focus follows only among his windows; "Qubit, come here" (the fast path, no model
// turn) brings him into another; the voice gets a quiet note each time; each guest Qubit sits on
// his window's bottom edge and follows it (moves, minimize); a window that closes takes its Qubit
// with it; "go away" sends him home; only the window the talk is in has a live Qubit.
//
//   npm --prefix ui run build          (once: the pages it drives)
//   npm run e2e:anywhere -- [--port 4421]
//
// Isolation as in avatar-e2e: a throwaway profile, its own port, network only to 127.0.0.1, no
// child processes at all, the clipboard and global hotkey stubbed, Orbit's own windows hidden.

import child_process from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, safeStorage, session, shell } from 'electron';
import { createFakeGrok } from '../test/e2e/fake-grok.mjs';
import { fakeFocusState } from '../test/e2e/fake-focus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const PORT = Number(opt('port', 4421));
const OUT = opt('out', ''); // a folder for pictures of the strips (optional)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-anywhere-e2e-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const out = (line) => console.log(line);
const fail = (what, detail = '') => {
  failures.push(what);
  out(`  FAIL ${what}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
};
const check = (ok, what, detail) => (ok ? out(`  ok   ${what}${detail ? ` (${detail})` : ''}`) : fail(what, detail));

// ---------- isolation ----------
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  if (typeof o === 'number' || (typeof o === 'string' && /^\d+$/.test(o))) o = { port: Number(o), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  else if (typeof o === 'string') o = { path: o };
  if (o && !o.path && !LOOPBACK.has(o.host || 'localhost')) {
    process.nextTick(() => this.destroy(new Error('Blocked by anywhere-e2e: only 127.0.0.1')));
    return this;
  }
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!LOOPBACK.has(String(host))) {
    const cb = rest.find((x) => typeof x === 'function');
    return cb && process.nextTick(cb, Object.assign(new Error('Blocked'), { code: 'ENOTFOUND' }));
  }
  return origLookup.call(this, host, ...rest);
};
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  if (!LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''))) throw new TypeError('Blocked by anywhere-e2e: only 127.0.0.1');
  return origFetch(input, init);
};
// No child processes at all (the second brain is off; the Claude window and its watcher are fakes).
const spawnTries = [];
for (const name of ['spawn', 'execFile', 'spawnSync', 'execFileSync', 'exec', 'execSync', 'fork']) {
  child_process[name] = (file) => {
    spawnTries.push(path.basename(String(file)));
    throw new Error('Blocked by anywhere-e2e');
  };
}
syncBuiltinESMExports();
clipboard.writeText = () => {};
const hotkeys = new Map();
globalShortcut.register = (accel, cb) => (hotkeys.set(accel, cb), true);
globalShortcut.isRegistered = (accel) => hotkeys.has(accel);
globalShortcut.unregister = (accel) => hotkeys.delete(accel);
globalShortcut.unregisterAll = () => hotkeys.clear();
shell.openExternal = async () => {};
shell.openPath = async () => '';
dialog.showErrorBox = (title, msg) => fail('error dialog', msg);
// Orbit's own windows stay hidden; only the avatars' strips show (on the off-screen fake Claude window).
const isAvatar = (w) => /^Orbit (Qubit|buddy)$/.test(w.getTitle());
const realShowInactive = BrowserWindow.prototype.showInactive;
// The orb never really shows either; whether Orbit wants it showing is tracked here instead.
const isOrb = (w) => /#orb$|view=orb/.test(w.webContents.getURL()); // its page renames the window, so go by the URL
let orbShown = false;
for (const m of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) {
  const orig = BrowserWindow.prototype[m];
  BrowserWindow.prototype[m] = function (...a) {
    if (isOrb(this) && (m === 'show' || m === 'showInactive')) orbShown = true;
    if (isAvatar(this)) return orig.apply(this, a);
  };
}
const origHide = BrowserWindow.prototype.hide;
BrowserWindow.prototype.hide = function (...a) {
  if (isOrb(this)) orbShown = false;
  return origHide.apply(this, a);
};

// Whether the avatar's window takes the mouse (only while the cursor is on him).
const ignoreCalls = [];
const origIgnore = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function (ignore, o) {
  if (isAvatar(this)) ignoreCalls.push(!!ignore);
  return origIgnore.call(this, ignore, o);
};


// ---------- a throwaway profile ----------
const KEY = `xai-anywhere${'k'.repeat(40)}`;
for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'local'], ['USERPROFILE', 'home'], ['HOME', 'home']]) {
  process.env[k] = path.join(tmp, d);
  fs.mkdirSync(process.env[k], { recursive: true });
}
app.setPath('appData', process.env.APPDATA);
const USER_DATA = path.join(process.env.APPDATA, 'Orbit');
fs.mkdirSync(USER_DATA, { recursive: true });
fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({ avatar: 'qubit', buddySize: 2, orbStick: false, announce: 'chime', announceWake: false, wakeOnResults: false, brainEnabled: false, wakeWord: false, autoUpdate: false, listenMode: 'always', anywhere: true }));
process.env.PATH = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(path.delimiter);
delete process.env.ANTHROPIC_API_KEY;
process.env.ORBIT_FAKE_DESKTOP = path.join(ROOT, 'test', 'e2e', 'fake-desktop.mjs');
process.env.PORT = String(PORT);

// The Claude window (home) and two other app windows, all far off screen.
const TITLE = 'Dark mode toggle';
globalThis.__orbitE2E = { desktop: { windows: [{ hwnd: 101, kind: 'main', title: TITLE, newPage: null, promptText: '', min: false }], sidebar: [TITLE], folders: ['app'], calls: [], sends: [], chaos: 0, rng: () => 0.5, newCount: 0 } };
const F = fakeFocusState();
F.on = true;
const NOTEPAD = 501;
const DISCORD = 502;
F.windows.set(101, { hwnd: 101, exe: 'claude.exe', cls: 'Chrome_WidgetWin_1', title: 'Claude', x: -4200, y: 120, w: 1200, h: 800 });
F.windows.set(NOTEPAD, { hwnd: NOTEPAD, exe: 'notepad.exe', cls: 'Notepad', title: 'shopping list.txt - Notepad', x: -4200, y: 1100, w: 900, h: 600 });
F.windows.set(DISCORD, { hwnd: DISCORD, exe: 'Discord.exe', cls: 'Chrome_WidgetWin_1', title: '#general | Friends - Discord', x: -2800, y: 1100, w: 1000, h: 700 });
F.fg = 101;

const fake = createFakeGrok({ g: { pick: (a) => a[0], int: (n) => Math.floor(n / 2), chance: () => false } });
await fake.ready;
process.env.XAI_REALTIME_URL = fake.url;
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
app.commandLine.appendSwitch('disable-background-networking');
const consoleErrors = [];
app.on('web-contents-created', (_e, wc) => {
  wc.setAudioMuted(true);
  wc.on('render-process-gone', (_ev, d) => fail('a page crashed', d?.reason));
  wc.on('console-message', (e) => {
    if (e?.level === 'error') consoleErrors.push(String(e?.message ?? '').slice(0, 200));
  });
});
process.on('uncaughtException', (e) => fail('uncaught exception in the main process', e?.stack || e));
process.on('unhandledRejection', (e) => fail('unhandled rejection in the main process', e?.stack || e));

const { getConfigDir, updateSettings } = await import('../src/config.js');
const { contexts } = await import('../src/anywhere/index.js');

out(`Orbit anywhere end-to-end: port ${PORT}, profile ${tmp}`);
app.whenReady().then(() => {
  fs.writeFileSync(path.join(USER_DATA, 'xai-key.bin'), safeStorage.encryptString(KEY));
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    let ok = false;
    try {
      const u = new URL(d.url);
      ok = ['data:', 'blob:', 'devtools:', 'chrome:'].includes(u.protocol) || LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''));
    } catch {}
    cb({ cancel: !ok });
  });
  run()
    .catch((e) => fail('HARNESS ERROR', e?.stack || e))
    .finally(() => finish());
});
await import(pathToFileURL(path.join(ROOT, 'electron', 'main.js')).href);

// ---------- helpers ----------
let page = null;
const pjs = (code) => page.webContents.executeJavaScript(code, true);
async function waitFor(fn, ms, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await wait(step);
  }
  return false;
}
/** The Qubit windows (home on the Claude window, and the guests). */
const qubits = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /\/qubit\.html/.test(w.webContents.getURL()));
/** The Qubit standing on this window's bottom edge (his strip's bottom is the window's). */
const qubitOn = (win) =>
  qubits().find((q) => {
    const b = q.getBounds();
    return q.isVisible() && b.x === win.x && b.y + b.height === win.y + win.h;
  });
const qstateOf = (q) => q.webContents.executeJavaScript('(() => { const Q = window.__qubit; if (!Q || !Q.q) return null; return { state: Q.dir.state, mode: Q.q.mode, box: Q.dir.geometry && Q.dir.geometry.box }; })()', true).catch(() => null);
const notes = (c) => (c.notes || []).slice();

async function run() {
  const found = await waitFor(() => (page = BrowserWindow.getAllWindows().find((w) => /^http:\/\/127\.0\.0\.1:\d+\/(#?)$/.test(w.webContents.getURL()))), 20_000);
  if (!found) throw new Error("Orbit's main window never loaded (is the UI built? npm --prefix ui run build)");
  if (!path.resolve(getConfigDir()).startsWith(tmp)) throw new Error(`Orbit is using a config folder outside the temp profile: ${getConfigDir()}`);
  await waitFor(() => pjs(`[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('Start talking'))`), 20_000);
  check(await waitFor(() => F.started > 0, 5000), 'the focus helper (stand-in) is running');
  check(await waitFor(() => qubits().length === 1, 15_000), 'one Qubit, at home on the Claude window');
  const home = qubits()[0];

  out('1. Waking Orbit in Notepad brings the conversation there, and a Qubit pops in');
  F.front(NOTEPAD);
  await wait(500);
  const hot = [...hotkeys.values()][0];
  hot();
  check(await waitFor(() => fake.current() && fake.current().configured > 0, 10_000), 'a call is on');
  const c = fake.current();
  check(await waitFor(() => contexts.active?.hwnd === NOTEPAD, 3000), 'the active context is Notepad', JSON.stringify(contexts.active));
  check(await waitFor(() => !!qubitOn(F.windows.get(NOTEPAD)), 8000), "a Qubit stands on Notepad's bottom edge", JSON.stringify(qubits().map((q) => q.getBounds())));
  const qn = qubitOn(F.windows.get(NOTEPAD));
  check(await waitFor(async () => (await qstateOf(qn))?.state === 'listening', 8000), 'he is the one listening', JSON.stringify(await qstateOf(qn)));
  check(await waitFor(async () => (await qstateOf(home))?.state === 'asleep', 6000), 'the home Qubit rests while the talk is elsewhere', JSON.stringify(await qstateOf(home)));
  check(await waitFor(() => notes(c).some((n) => n.includes('another window now') && n.includes('Notepad')), 4000), 'the voice got a note: the conversation is in Notepad', JSON.stringify(notes(c)));
  check(notes(c).every((n) => n.includes('not the user speaking')), 'notes say they are not the user');
  check((await qstateOf(qn))?.box == null, 'no prompt box there: he stands on the window edge');
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    await wait(800);
    fs.writeFileSync(path.join(OUT, 'guest-notepad-listening.png'), (await qn.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(OUT, 'home-resting.png'), (await home.webContents.capturePage()).toPNG());
  }

  out('2. His window moves and minimizes: he follows');
  F.move(NOTEPAD, { x: -4100, y: 1150 });
  check(await waitFor(() => { const b = qn.getBounds(); return b.x === -4100 && b.y + b.height === 1150 + 600; }, 3000), 'moved with Notepad', JSON.stringify(qn.getBounds()));
  F.move(NOTEPAD, { min: true });
  check(await waitFor(() => !qn.isVisible(), 3000), 'hidden while Notepad is minimized');
  F.move(NOTEPAD, { min: false });
  check(await waitFor(() => qn.isVisible(), 3000), 'back when it is restored');

  out('3. Focus follows only among his windows');
  F.front(DISCORD);
  await wait(900);
  check(contexts.active?.hwnd === NOTEPAD, 'Discord (not invited) changes nothing', JSON.stringify(contexts.active));
  check(!qubitOn(F.windows.get(DISCORD)), 'no Qubit on Discord');

  out('4. "Qubit, come here" in Discord: the fast path, no model turn');
  const cancels0 = c.cancels.length;
  void fake.userSays(c, 'Qubit, come here', { kind: 'avatar', tools: [] });
  check(await waitFor(() => contexts.active?.hwnd === DISCORD, 5000), 'the conversation moved to Discord', JSON.stringify(contexts.active));
  check(await waitFor(() => !!qubitOn(F.windows.get(DISCORD)), 8000), 'a Qubit pops in on Discord');
  const qd = qubitOn(F.windows.get(DISCORD));
  check(await waitFor(() => c.cancels.length > cancels0, 3000), "Grok's own answer to those words was cancelled");
  check(await waitFor(() => notes(c).some((n) => n.includes('come into the window')), 3000), 'the voice got the fast path note');
  check(await waitFor(async () => (await qstateOf(qd))?.state === 'listening', 8000), 'the Discord Qubit is the live one', JSON.stringify(await qstateOf(qd)));
  check(await waitFor(async () => (await qstateOf(qn))?.state === 'asleep', 6000), 'the Notepad Qubit rests now', JSON.stringify(await qstateOf(qn)));

  out('5. Back to Notepad: the conversation follows (he is in both)');
  const n5 = notes(c).length;
  F.front(NOTEPAD);
  check(await waitFor(() => contexts.active?.hwnd === NOTEPAD, 3000), 'active again: Notepad');
  check(await waitFor(() => notes(c).length > n5 && notes(c).at(-1).includes('Notepad'), 3000), 'with a note');
  check(await waitFor(async () => (await qstateOf(qn))?.state === 'listening', 8000), 'the Notepad Qubit is live again');

  out('6. A window that closes takes its Qubit with it');
  F.close(DISCORD);
  check(await waitFor(() => qubits().length === 2, 5000), 'the Discord Qubit is gone', `${qubits().length} Qubits`);
  check(!contexts.list.some((x) => x.hwnd === DISCORD), 'and its context');

  out('7. "Go away": the Notepad Qubit leaves, the conversation goes home');
  void fake.userSays(c, 'go away', { kind: 'avatar', tools: [] });
  check(await waitFor(() => contexts.active?.home, 5000), 'home again', JSON.stringify(contexts.active));
  check(await waitFor(() => qubits().length === 1, 5000), 'only the home Qubit is left', `${qubits().length} Qubits`);
  check(await waitFor(async () => (await qstateOf(home))?.state === 'listening', 8000), 'and he is the live one again', JSON.stringify(await qstateOf(home)));

  out('8. Settings: the avatar off takes the guests too; back on, they return');
  F.front(NOTEPAD);
  void fake.userSays(c, 'come here', { kind: 'avatar', tools: [] });
  check(await waitFor(() => qubits().length === 2, 8000), 'Notepad gets him back');
  updateSettings({ avatar: 'none' });
  check(await waitFor(() => qubits().length === 0, 5000), 'avatar off: no Qubits anywhere', `${qubits().length}`);
  updateSettings({ avatar: 'qubit' });
  check(await waitFor(() => qubits().length === 2, 10_000), 'avatar on: home and Notepad again', `${qubits().length}`);

  check(consoleErrors.length === 0, 'no script errors on any page', consoleErrors.slice(0, 3).join(' | '));
}

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  out(`RESULT ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} failure(s)`);
  await fake.close();
  setTimeout(() => {
    for (let i = 0; i < 5; i++) try { fs.rmSync(path.join(tmp, 'appdata'), { recursive: true, force: true, maxRetries: 3 }); break; } catch {}
    app.exit(failures.length ? 1 : 0);
  }, 500);
}
