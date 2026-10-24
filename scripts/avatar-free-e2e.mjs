// End-to-end test of the free-floating avatar (macOS phase 1: no Claude window to live on), run on
// any machine: the real Orbit (electron/main.js, the bridge, the pages) with ORBIT_FREE_AVATAR=1,
// which makes the avatar float as it does on a Mac, and no stand-in Claude window at all.
//
//   npm --prefix ui run build          (once: the pages it drives)
//   npm run e2e:avatar-free -- [--port 4412]
//
// Isolation as in avatar-e2e: a throwaway profile, its own port, network only to 127.0.0.1, no child
// processes at all (so no Claude window watcher or UI Automation either: the free avatar must not
// need them; the Claude app answers as it does on a Mac, "not on Mac yet"), the clipboard and global
// hotkey stubbed. The "screen" is a stand-in display far off to
// the left (x -4200), so the strip never appears on your desktop.
//
// What it checks: Qubit's strip is the bottom of the screen's work area (just above the Dock), centred
// and capped in width, shown and always on top, with no prompt box (so he has the floor to himself)
// and no "waiting for the box"; it moves when the screen layout changes; his page has no errors; a
// live switch to the pixel buddy floats free the same way; nothing tried to start a process.

import child_process from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, safeStorage, screen, session, shell } from 'electron';
import { createFakeGrok } from '../test/e2e/fake-grok.mjs';
import { freeStripFor } from '../electron/buddy-geometry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const PORT = Number(opt('port', 4412));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-avatar-free-e2e-'));
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
    process.nextTick(() => this.destroy(new Error('Blocked by avatar-free-e2e: only 127.0.0.1')));
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
  if (!LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''))) throw new TypeError('Blocked by avatar-free-e2e: only 127.0.0.1');
  return origFetch(input, init);
};
const spawnTries = [];
for (const name of ['spawn', 'execFile', 'spawnSync', 'execFileSync', 'exec', 'execSync', 'fork']) {
  child_process[name] = (file) => {
    spawnTries.push(path.basename(String(file)));
    throw new Error('Blocked by avatar-free-e2e');
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
// Orbit's own windows stay hidden; only the avatar's strip shows (on the off-screen stand-in display).
const isAvatar = (w) => /^Orbit (Qubit|buddy)$/.test(w.getTitle());
for (const m of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) {
  const orig = BrowserWindow.prototype[m];
  BrowserWindow.prototype[m] = function (...a) {
    if (isAvatar(this)) return orig.apply(this, a);
  };
}

// ---------- a throwaway profile ----------
for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'local'], ['USERPROFILE', 'home'], ['HOME', 'home']]) {
  process.env[k] = path.join(tmp, d);
  fs.mkdirSync(process.env[k], { recursive: true });
}
app.setPath('appData', process.env.APPDATA);
const USER_DATA = path.join(process.env.APPDATA, 'Orbit');
fs.mkdirSync(USER_DATA, { recursive: true });
fs.writeFileSync(
  path.join(USER_DATA, 'settings.json'),
  JSON.stringify({ avatar: 'qubit', buddySize: 2, orbStick: false, announce: 'chime', announceWake: false, wakeOnResults: false, brainEnabled: false, wakeWord: false, autoUpdate: false, listenMode: 'always' }),
);
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ORBIT_FAKE_DESKTOP;
process.env.ORBIT_FREE_AVATAR = '1'; // float as on a Mac
process.env.PORT = String(PORT);

const fake = createFakeGrok({ g: { pick: (a) => a[0], int: (n) => Math.floor(n / 2), chance: () => false } });
await fake.ready;
process.env.XAI_REALTIME_URL = fake.url;
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const consoleErrors = [];
app.on('web-contents-created', (_e, wc) => {
  wc.setAudioMuted(true);
  wc.on('render-process-gone', (_ev, d) => fail('a page crashed', d?.reason));
  wc.on('console-message', (e) => {
    if (e?.level === 'error') consoleErrors.push(`${wc.getURL().replace(/^.*\/\/[^/]+/, '').slice(0, 30)}: ${String(e?.message ?? '').slice(0, 200)}`);
  });
});
process.on('uncaughtException', (e) => fail('uncaught exception in the main process', e?.stack || e));
process.on('unhandledRejection', (e) => fail('unhandled rejection in the main process', e?.stack || e));

// The stand-in screen: one display far off to the left, with a menu bar on top and a Dock below.
let workArea = { x: -4200, y: 25, width: 1512, height: 870 };
const display = () => ({ id: 1, bounds: { x: workArea.x, y: 0, width: workArea.width, height: 982 }, workArea: { ...workArea }, scaleFactor: 2, size: { width: workArea.width, height: 982 }, workAreaSize: { width: workArea.width, height: workArea.height } });

const { getConfigDir } = await import('../src/config.js');
// The Claude app can't be driven, as on a Mac: every desktop.js call gets the Mac's answer.
const { setDesktopDriver } = await import('../src/desktop.js');
const { desktopUnsupportedMessage } = await import('../src/platform/system.js');
const desktopCalls = [];
setDesktopDriver({ run: (mode) => (desktopCalls.push(mode), { ok: false, error: 'unsupported_platform', message: desktopUnsupportedMessage('darwin') }) });
let finished = false;
app.whenReady().then(() => {
  // (Registered before main.js's own ready handler, so the stand-in screen is in place first.)
  screen.getDisplayNearestPoint = () => display();
  screen.getPrimaryDisplay = () => display();
  screen.getAllDisplays = () => [display()];
  screen.getCursorScreenPoint = () => ({ x: workArea.x + 10, y: workArea.y + 10 });
  fs.writeFileSync(path.join(USER_DATA, 'xai-key.bin'), safeStorage.encryptString(`xai-free${'k'.repeat(40)}`));
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

async function waitFor(fn, ms, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await wait(step);
  }
  return false;
}
const avatarWin = (kind) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && new RegExp(`/${kind}\\.html`).test(w.webContents.getURL()));
const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

async function run() {
  let page = null;
  const found = await waitFor(() => (page = BrowserWindow.getAllWindows().find((w) => /^http:\/\/127\.0\.0\.1:\d+\/(#?)$/.test(w.webContents.getURL()))), 20_000);
  if (!found) throw new Error("Orbit's main window never loaded (is the UI built? npm --prefix ui run build)");
  if (!path.resolve(getConfigDir()).startsWith(tmp)) throw new Error(`Orbit is using a config folder outside the temp profile: ${getConfigDir()}`);
  const pjs = (code) => page.webContents.executeJavaScript(code, true);

  out('1. Qubit floats free: along the bottom of the screen, above the Dock');
  let qwin = null;
  check(await waitFor(() => (qwin = avatarWin('qubit')) && qwin.isVisible(), 15_000), 'his window shows without any Claude window');
  await waitFor(() => qwin.webContents.executeJavaScript('!!(window.__qubit && window.__qubit.q)', true), 8000);
  const want = freeStripFor(workArea);
  check(same(qwin.getBounds(), want), 'the strip is the bottom of the work area, centred and capped', `${JSON.stringify(qwin.getBounds())} vs ${JSON.stringify(want)}`);
  check(qwin.getBounds().y + qwin.getBounds().height === workArea.y + workArea.height, 'he stands on the top of the Dock');
  check(qwin.isAlwaysOnTop(), 'always on top');
  const st = await qwin.webContents.executeJavaScript('(() => { const Q = window.__qubit; return { box: Q.dir.geometry && Q.dir.geometry.box, state: Q.state && { boxKnown: Q.state.boxKnown, box: Q.state.box, send: Q.state.send } }; })()', true);
  check(!st.box, 'no prompt box to stand on: the floor is his', JSON.stringify(st.box));
  check(!st.state || (st.state.boxKnown !== false && !st.state.box && !st.state.send), "the page isn't left waiting for a prompt box", JSON.stringify(st.state));

  out('2. The screen layout changes (a display, the Dock moved): the strip follows');
  workArea = { x: -4200, y: 25, width: 1100, height: 700 };
  screen.emit('display-metrics-changed', {}, display(), ['workArea']);
  const want2 = freeStripFor(workArea);
  check(await waitFor(() => same(qwin.getBounds(), want2), 3000), 'moved to the new bottom of the screen', JSON.stringify(qwin.getBounds()));

  out('3. A live switch to the pixel buddy floats free the same way');
  await pjs(`fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar: 'buddy' }) }).then((r) => r.ok)`);
  let bwin = null;
  check(await waitFor(() => (bwin = avatarWin('buddy')) && bwin.isVisible(), 8000), 'the buddy shows');
  check(bwin && same(bwin.getBounds(), want2), 'on the same free strip', bwin && JSON.stringify(bwin.getBounds()));
  check(await waitFor(() => !avatarWin('qubit'), 4000), "Qubit's window is gone after the handover");
  await pjs(`fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar: 'qubit' }) }).then((r) => r.ok)`);
  check(await waitFor(() => (qwin = avatarWin('qubit')) && qwin.isVisible() && same(qwin.getBounds(), want2), 8000), 'and back to Qubit');

  out('4. Nothing else needed');
  await wait(1500);
  check(spawnTries.length === 0, 'no child processes (no Claude window watcher, no UI Automation)', spawnTries.join(', '));
  check(!desktopCalls.includes('info'), "the avatar never asked where Claude's prompt box is", desktopCalls.join(', '));
  check(consoleErrors.length === 0, "no console errors on Orbit's pages or the avatars'", consoleErrors.slice(0, 3).join(' | '));
}

async function finish() {
  if (finished) return;
  finished = true;
  out(`RESULT ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} failure(s)`);
  await fake.close();
  setTimeout(() => {
    for (let i = 0; i < 5; i++) try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); break; } catch {}
    app.exit(failures.length ? 1 : 0);
  }, 500);
}
