// End-to-end test of the avatars on the Claude window: the real Orbit (electron/main.js, the bridge,
// the page) with Qubit chosen, driven through a whole session against the same test doubles as
// scripts/fuzz-e2e.mjs (a fake Grok, a fake Claude window), then switched live to the pixel buddy,
// to none, and back.
//
//   npm --prefix ui run build          (once: the pages it drives)
//   npm run e2e:avatar -- [--port 4411] [--out <folder for frames and contact sheets>]
//
// Isolation as in fuzz-e2e: a throwaway profile (APPDATA, LOCALAPPDATA, USERPROFILE and Electron's
// appData in a temp folder), its own port, network only to 127.0.0.1, no child processes at all
// (no PowerShell: the Claude window and its watcher are test/e2e/fake-desktop.mjs), the clipboard
// and global hotkey stubbed. Orbit's own windows stay hidden; only the avatar's strip is shown, on
// the fake Claude window, which is far off screen (x -4200), so nothing appears on your desktop.
//
// What it checks, at every step: Qubit's state and mode for each Orbit state (asleep, waking,
// listening with the mic level, thinking, speaking with the voice level, a draft, "Send it?",
// sending and the stomp on Send, Claude working, Claude finished, an error and a failed send,
// mute, a quiet call, going to sleep); his strip following the Claude window as it moves, resizes
// and minimizes (his frame loop stops while hidden); the handover between avatars; no script errors
// on any page; smooth motion (no single-frame jumps of his outline, no sinking into or floating
// above what he stands on); his CPU use asleep, active and hidden. It saves a picture of the strip at
// each step and contact sheets of them (composited on a mock of the Claude window) in --out.

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const PORT = Number(opt('port', 4411));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-avatar-e2e-'));
const OUT = path.resolve(opt('out', path.join(tmp, 'frames')));
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const out = (line) => {
  console.log(line);
  lines.push(line);
};
const failures = [];
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
    process.nextTick(() => this.destroy(new Error('Blocked by avatar-e2e: only 127.0.0.1')));
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
  if (!LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''))) throw new TypeError('Blocked by avatar-e2e: only 127.0.0.1');
  return origFetch(input, init);
};
// No child processes at all (the second brain is off; the Claude window and its watcher are fakes).
const spawnTries = [];
for (const name of ['spawn', 'execFile', 'spawnSync', 'execFileSync', 'exec', 'execSync', 'fork']) {
  child_process[name] = (file) => {
    spawnTries.push(path.basename(String(file)));
    throw new Error('Blocked by avatar-e2e');
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
const KEY = `xai-avatar${'k'.repeat(40)}`;
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
process.env.PATH = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(path.delimiter);
delete process.env.ANTHROPIC_API_KEY;
process.env.ORBIT_FAKE_DESKTOP = path.join(ROOT, 'test', 'e2e', 'fake-desktop.mjs');
process.env.PORT = String(PORT);

// A Claude session on disk: "Claude works" and "Claude finished" happen by writing its transcript.
const TITLE = 'Dark mode toggle';
const cwd = path.join(tmp, 'proj', 'app');
fs.mkdirSync(cwd, { recursive: true });
const metaDir = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions', 'acct', 'org');
fs.mkdirSync(metaDir, { recursive: true });
fs.writeFileSync(path.join(metaDir, 'local_s1.json'), JSON.stringify({ sessionId: 'local_s1', cliSessionId: 's1', title: TITLE, cwd, createdAt: Date.now() - 3_600_000, lastFocusedAt: Date.now(), lastActivityAt: Date.now() }));
const transcriptDir = path.join(process.env.USERPROFILE, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(transcriptDir, { recursive: true });
const TRANSCRIPT = path.join(transcriptDir, 's1.jsonl');
const at = () => new Date().toISOString();
fs.writeFileSync(TRANSCRIPT, `${JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: 'earlier' } })}\n${JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })}\n`);
const claudeStarts = () => fs.appendFileSync(TRANSCRIPT, `${JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: 'add a dark mode toggle' } })}\n`);
const claudeFinishes = () => fs.appendFileSync(TRANSCRIPT, `${JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: 'Added it.' }] } })}\n${JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', timestamp: at() })}\n`);

// The fake Claude window: one main window showing that session, far off screen.
globalThis.__orbitE2E = { desktop: { windows: [{ hwnd: 101, kind: 'main', title: TITLE, newPage: null, promptText: '', min: false }], sidebar: [TITLE], folders: ['app'], calls: [], sends: [], chaos: 0, rng: () => 0.5, newCount: 0 } };
const desk = globalThis.__orbitE2E.desktop;

// ---------- fake Grok (calm and predictable: no random errors or drops) ----------
const fake = createFakeGrok({ g: { pick: (a) => a[0], int: (n) => Math.floor(n / 2), chance: () => false } });
await fake.ready;
process.env.XAI_REALTIME_URL = fake.url;
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const consoleErrors = [];
app.on('web-contents-created', (_e, wc) => {
  wc.setAudioMuted(true);
  wc.on('render-process-gone', (_ev, d) => fail('a page crashed', d?.reason));
  wc.on('console-message', (e) => {
    const lvl = e?.level;
    const msg = String(e?.message ?? '');
    if (lvl === 'error') consoleErrors.push(`${wc.getURL().replace(/^.*\/\/[^/]+/, '').slice(0, 30)}: ${msg.slice(0, 200)}`);
  });
});
process.on('uncaughtException', (e) => fail('uncaught exception in the main process', e?.stack || e));
process.on('unhandledRejection', (e) => fail('unhandled rejection in the main process', e?.stack || e));

const { authUrl } = await import('../src/server.js');
const { getConfigDir } = await import('../src/config.js');

out(`Orbit avatar end-to-end: port ${PORT}, profile ${tmp}, frames in ${OUT}`);
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
let page = null; // Orbit's main window
const pjs = (code) => page.webContents.executeJavaScript(code, true);
const avatarWin = (kind) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && new RegExp(`/${kind}\\.html`).test(w.webContents.getURL()));
let qwin = null;
const qjs = (code) => qwin.webContents.executeJavaScript(code, true);
async function waitFor(fn, ms, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await wait(step);
  }
  return false;
}
const clickLabel = (text) => pjs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent || '').includes(${JSON.stringify(text)})); if (b && !b.disabled) b.click(); return !!b; })()`);
const qstate = () => qjs(`(() => { const Q = window.__qubit; const q = Q.q, d = Q.dir; if (!q) return null; const g = d.geometry; return { state: d.state, reaction: d.reaction, life: d.life, mode: q.mode, action: q.taskName || null, idleTask: !!(q.task && q.task.idle), x: Math.round(q.cx), onSurface: g ? Math.round(g.ground - q.sy) : null, air: q.air, input: q.levels.input, output: q.levels.output, eyeH: q.sp.eh.v, low: Q.lowPower, running: Q.running, box: g && g.box, sendAt: g && g.sendAt, confirm: g && g.confirm, watch: g && g.watch, home: g && g.home, W: q.W, H: q.H, side: q.side, voice: Q.state.voice }; })()`);

// Pictures of the strip: each saved as a PNG, with what was going on, for the contact sheets.
const snaps = [];
async function snap(label, win = qwin, kind = 'qubit') {
  const img = await win.webContents.capturePage().catch(() => null);
  if (!img || img.isEmpty()) return fail(`no picture of the strip (${label})`);
  const file = path.join(OUT, `${String(snaps.length).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
  fs.writeFileSync(file, img.toPNG());
  const info = kind === 'qubit' ? await qstate().catch(() => null) : null;
  snaps.push({ label, file, info, kind });
}
/** Frames at about `fps` for `ms` (a film strip of one moment). */
async function film(label, ms, fps = 20, { wide = false, follow = false } = {}) {
  const frames = [];
  const t0 = Date.now();
  for (let n = 0; Date.now() - t0 < ms; n++) {
    const due = t0 + (n * 1000) / fps;
    if (due > Date.now()) await wait(due - Date.now());
    const img = await qwin.webContents.capturePage().catch(() => null);
    if (img && !img.isEmpty()) frames.push(img.toPNG());
  }
  const dir = path.join(OUT, `film-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((b, i) => fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.png`), b));
  const info = await qstate();
  films.push({ label, dir, n: frames.length, box: info?.box, sendAt: info?.sendAt, x: info?.x, wide, follow });
  return frames.length;
}
const films = [];

/** Qubit's renderer CPU (and the GPU process's) over `ms`, as Electron reports it (% of one core). */
async function cpu(label, ms) {
  app.getAppMetrics();
  await wait(ms);
  const m = app.getAppMetrics();
  const pid = qwin.webContents.getOSProcessId();
  const r = m.find((x) => x.pid === pid)?.cpu.percentCPUUsage ?? NaN;
  const gpu = m.find((x) => x.type === 'GPU')?.cpu.percentCPUUsage ?? NaN;
  out(`  cpu  ${label}: Qubit's page ${r.toFixed(2)}%, GPU process ${gpu.toFixed(2)}%`);
  return { r, gpu };
}

/** Motion checks in his page, every frame (film.mjs's pop and contact checks). */
const MOTION = `(() => {
  const Q = window.__qubit, q = Q.q, d = Q.dir;
  if (window.__phys) return true;
  const phys = window.__phys = { samples: 0, pops: 0, popAt: [], sink: 0, float: 0, bad: [], dts: [], geoAt: 0, label: '', paths: [], modes: [], bobPops: 0 };
  q.on('path', (p) => { phys.paths.push([phys.label, Math.round(q.cx), p.path ? p.path.map((m) => m.type + ':' + Math.round(m.to.x)).join(' ') : 'none', Math.round(p.target.x)]); if (phys.paths.length > 60) phys.paths.shift(); });
  const sg = d.setGeometry;
  d.setGeometry = (g) => { phys.geoAt = performance.now(); return sg(g); };
  const C = [[-50, -50], [50, -50], [50, 50], [-50, 50]];
  Q.E.ticker.hooks.add((dt, now) => {
    phys.dts.push(dt); if (phys.dts.length > 4000) phys.dts.splice(0, 2000);
    const m = q.svg.getScreenCTM().inverse().multiply(q.body.getScreenCTM());
    const cs = C.map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
    const calm = now - phys.geoAt > 250 && now - (phys.resumeAt || 0) > 250;
    if (phys.prev && calm) {
      // Per 1/60 s, so an uneven frame (a longer gap) isn't taken for a jump.
      const D = Math.max(...cs.map((p) => Math.min(...phys.prev.map((o) => Math.hypot(p.x - o.x, p.y - o.y))))) * (1 / 60) / Math.max(dt, 1 / 240);
      const d1 = phys.d1 ?? 0, d0 = phys.d0 ?? 0;
      if (d1 > 2.5 && d1 > 3 * Math.max(d0, D, 0.3)) {
        // A known engine issue, counted apart: leaving or entering "thinking" switches its hover bob
        // (a sine of up to 2.4 px) on or off at once.
        const bob = phys.modes.includes('thinking') && new Set(phys.modes).size > 1;
        if (bob) phys.bobPops++;
        else { phys.pops++; if (phys.popAt.length < 30) phys.popAt.push([phys.label, +d1.toFixed(1), q.mode, q.taskName, +(dt * 1000).toFixed(1)]); }
      }
      phys.d0 = d1; phys.d1 = D;
    } else { phys.d0 = phys.d1 = 0; }
    phys.prev = cs;
    phys.modes.push(q.mode); if (phys.modes.length > 4) phys.modes.shift();
    const low = Math.max(...cs.map((p) => p.y));
    const surface = q.ground - q.sy;
    const gap = surface - low; // + floating above it, - sunk into it
    phys.samples++;
    const resting = !q.air && !q.pivot && q.sp.hover.v < 0.5 && !q.M.hover && calm;
    if (resting && gap < phys.sink) phys.sink = gap;
    if (resting && gap > phys.float) phys.float = gap;
    if (resting && Math.abs(gap) > 0.75 && phys.bad.length < 30) phys.bad.push([phys.label, +gap.toFixed(2), q.mode, q.taskName]);
  });
  document.addEventListener('visibilitychange', () => (phys.resumeAt = performance.now()));
  return true;
})()`;
/** Frames he actually drew per second, over a second. */
async function framesPerSecond() {
  const a = await qjs('[window.__phys.samples, performance.now()]');
  await wait(1000);
  const b = await qjs('[window.__phys.samples, performance.now()]');
  return Math.round(((b[0] - a[0]) * 1000) / (b[1] - a[1]));
}
const label = (l) => qjs(`window.__phys && (window.__phys.label = ${JSON.stringify(l)})`);
// His own life (Orbit off): most steps keep him dozing so their sleep checks hold; step 2b lets him live.
const DOZING = '{ dozeS: [900, 900] }';
const keepDozing = () => qjs(`window.__qubit.dir.setLifeTiming(${DOZING})`);
/** What he starts (name, idle or not), from now on. */
const ACTS = '(window.__acts2 = window.__acts2 || (window.__qubit.q.on("action", (a) => window.__acts2.push([a.name, !!(window.__qubit.q.task && window.__qubit.q.task.idle), performance.now()])), [])).length = 0';
/** Each geometry his page gets, with when (Date.now()). */
const BOXLOG = `(() => {
  const d = window.__qubit.dir;
  if (window.__boxlog) return true;
  window.__boxlog = [];
  const sg = d.setGeometry;
  d.setGeometry = (g) => { window.__boxlog.push([Date.now(), g.box ? JSON.stringify(g.box) : null]); if (window.__boxlog.length > 400) window.__boxlog.shift(); return sg(g); };
  return true;
})()`;
/** When (Date.now()) his page first got a box that passes `test`, at or after `since`; 0 if not within `ms`. */
async function boxSeen(test, since, ms = 3000) {
  let hit = 0;
  await waitFor(async () => {
    const log = (await qjs('window.__boxlog')) || [];
    const e = log.find(([t, b]) => t >= since && test(b && JSON.parse(b)));
    hit = e ? e[0] : 0;
    return !!hit;
  }, ms, 10);
  return hit;
}
const latency = {};

async function expectState(name, want, ms = 4000) {
  let s = null;
  const ok = await waitFor(async () => {
    s = await qstate();
    return s && Object.entries(want).every(([k, v]) => (typeof v === 'function' ? v(s[k], s) : s[k] === v));
  }, ms);
  check(ok, name, s ? `state ${s.state}, mode ${s.mode}${s.action ? `, ${s.action}` : ''}, x ${s.x}, surface y ${s.onSurface}${ok ? '' : `, air ${s.air}, box ${JSON.stringify(s.box)}`}` : 'no Qubit');
  if (!ok) out(`       log ${JSON.stringify(await qjs('window.__qubit.dir.log.slice(-12)'))}
       paths ${JSON.stringify(await qjs('window.__phys && window.__phys.paths.slice(-6)'))}`);
  return s;
}
const near = (p, tol = 14) => (x) => p && Math.abs(x - p.x) < tol;

// ---------- the session ----------
async function run() {
  const found = await waitFor(() => (page = BrowserWindow.getAllWindows().find((w) => /^http:\/\/127\.0\.0\.1:\d+\/(#?)$/.test(w.webContents.getURL()))), 20_000);
  if (!found) throw new Error('Orbit\x27s main window never loaded (is the UI built? npm --prefix ui run build)');
  if (!path.resolve(getConfigDir()).startsWith(tmp)) throw new Error(`Orbit is using a config folder outside the temp profile: ${getConfigDir()}`);
  if (authUrl().indexOf(`127.0.0.1:${PORT}`) < 0) throw new Error('Orbit is not on the test port');
  await waitFor(() => pjs(`[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('Start talking'))`), 20_000);

  out('1. Qubit is the avatar: his strip on the Claude window');
  check(await waitFor(() => (qwin = avatarWin('qubit')), 15_000), 'the Qubit window exists');
  check(!avatarWin('buddy'), 'no pixel buddy window');
  await waitFor(() => qjs('!!(window.__qubit && window.__qubit.q)'), 8000);
  await keepDozing();
  await qjs(MOTION);
  // The console check itself works: a probe error on his page is seen (then set aside).
  await qjs('console.error("avatar-e2e probe")');
  check(await waitFor(() => consoleErrors.some((e) => e.includes('avatar-e2e probe')), 2000), 'console errors on his page are caught');
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !e.includes('avatar-e2e probe')));
  const b = qwin.getBounds();
  check(b.x === -4200 && b.width === 1200 && b.height === 240 && b.y === 120 + 800 - 240, 'the strip is the bottom of the Claude window', JSON.stringify(b));
  check(qwin.isVisible() && qwin.isAlwaysOnTop(), 'shown, on top of Claude');
  let s = await qstate();
  check(s.box && s.box.x === 288 && s.box.y === 126 && s.box.w === 624,'he knows the prompt box', JSON.stringify(s.box));
  check(s.W === 1200 && s.H === 240 && s.side === 36, 'his stage is the strip, at size Small', `${s.W}x${s.H}, side ${s.side}`);

  out('2. Asleep (Orbit is off)');
  await label('asleep');
  s = await expectState('asleep at home on the prompt box', { state: 'asleep', mode: 'asleep', onSurface: s.box.y, x: near(s.home) }, 6000);
  await wait(2500);
  await snap('asleep');
  const idleCpu = await cpu('asleep (low power)', 8000);
  s = await qstate();
  let fps = await framesPerSecond();
  check(s.low && fps >= 24 && fps <= 36, 'low power while asleep and still: about 30 fps', `lowPower ${s.low}, ${fps} fps`);

  out('2b. His own life: after a short doze he gets up and lives (Orbit still off)');
  await label('life');
  await qjs(ACTS);
  await qjs('window.__qubit.dir.setLifeTiming({ dozeS: [1.5, 1.5] })');
  s = await expectState('he stirs and gets up by himself', { state: 'asleep', life: 'up', mode: 'idle' }, 8000);
  // How much of the time he's up he's doing something (a move, a fidget, a trick), every frame.
  await qjs(`(() => { const Q = window.__qubit; window.__busy = [0, 0]; Q.E.ticker.hooks.add(() => { if (Q.dir.life === 'up') window.__busy[Q.q.task ? 0 : 1]++; }); })()`);
  const lifeCpu = await cpu('his own life (up and about)', 8000);
  fps = await framesPerSecond();
  check(fps > 55, 'full frame rate while he is up', `${fps} fps`);
  await film('life', 14_000, 12, { wide: true });
  const acts = await qjs('window.__acts2');
  const own = acts.filter((a) => a[1]).map((a) => a[0]);
  out(`  his own: ${own.join(', ')}`);
  const busy = await qjs('window.__busy');
  const busyPct = Math.round((busy[0] / Math.max(1, busy[0] + busy[1])) * 100);
  out(`  up and about: busy ${busyPct}% of the time (moving, fidgeting or a trick)`);
  check(own.length >= 3 && new Set(own).size >= 2 && busyPct >= 50, 'he gets on with things of his own over 23 s (moves, fidgets, tricks)', `${own.length} actions, ${new Set(own).size} kinds, busy ${busyPct}%`);
  const lifePhys = await qjs('({ pops: window.__phys.pops, bad: window.__phys.bad.filter((b) => b[0] === "life"), popAt: window.__phys.popAt })');
  check(lifePhys.pops === 0, 'no jumps of his outline while he lives', JSON.stringify(lifePhys.popAt));
  check(lifePhys.bad.length === 0, 'always on a surface (never sunk in, never floating)', JSON.stringify(lifePhys.bad));
  await snap('his-own-life');

  out('3. Wake (the hotkey, same as the wake word): he attends at once, from wherever he is');
  const hot = [...hotkeys.values()][0];
  check(!!hot, 'the global hotkey is registered');
  await label('waking');
  // Wait for him to be in the middle of something of his own (mid-move, if it comes), then wake Orbit.
  await waitFor(async () => (await qstate()).idleTask && (await qstate()).air, 8000, 30);
  const handoffFilm = film('handoff', 1800, 20, { follow: true });
  const tWake = Date.now();
  hot();
  check(await waitFor(async () => (await qstate()).mode === 'listening', 1500, 20), 'listening at once (his own life gives way)', `${Date.now() - tWake} ms`);
  await qjs(ACTS);
  await handoffFilm;
  await keepDozing();
  await snap('waking');
  check(await waitFor(() => fake.conns.length > 0 && fake.conns.at(-1).configured > 0, 10_000), 'connected to (fake) Grok');
  const c = fake.current();
  await label('listening');
  s = await expectState('listening (cyan, eye wide)', { state: 'listening', mode: 'listening', low: false }, 5000);
  await wait(400);
  await snap('listening');
  fps = await framesPerSecond();
  check(fps > 55, 'full frame rate while awake', `${fps} fps (the off-screen window's own rate)`);
  check((await qjs('window.__acts2')).filter((a) => a[1]).length === 0, 'none of his own life while Orbit listens');

  out('4. You talk: his eye follows the mic level');
  await label('hearing');
  c.send({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0 });
  // The fake microphone (Chromium's) beeps: watch the level he gets.
  let maxIn = 0;
  let maxEye = 0;
  for (let i = 0; i < 25; i++) {
    const q = await qstate();
    maxIn = Math.max(maxIn, q.input);
    maxEye = Math.max(maxEye, q.eyeH);
    await wait(80);
  }
  await snap('hearing');
  check(maxIn > 0, 'the live mic level reaches him (setLevels input)', `max ${maxIn.toFixed(2)}`);
  check(maxEye > 19.5, 'his eye stretches with it', `eye height up to ${maxEye.toFixed(1)} (rest 19)`);

  out('5. Thinking, then speaking with the voice level');
  await label('thinking');
  c.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  c.send({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  await expectState('thinking (violet, hovering, eye spinning)', { state: 'thinking', mode: 'thinking' }, 3000);
  await wait(900);
  await snap('thinking');
  await label('speaking');
  c.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'what is claude doing right now' });
  void fake.respond(c, { calm: true, tools: [], delay: 0 });
  let maxOut = 0;
  await expectState('speaking (amber)', { state: 'speaking', mode: 'speaking' }, 4000);
  for (let i = 0; i < 6; i++) {
    const q = await qstate();
    maxOut = Math.max(maxOut, q.output);
    if (i === 2) await snap('speaking');
    await wait(60);
  }
  check(maxOut > 0.05, 'the live voice level reaches him (setLevels output)', `max ${maxOut.toFixed(2)}`);
  await waitFor(async () => (await qstate()).state === 'listening', 6000);

  out('5c. Feelings while he speaks: cues in Grok\x27s words fire as those words play, never shown');
  await label('emotes');
  // Synthetic speech (tone bursts for words, quiet for pauses), with where each word starts.
  const synth = (text) => {
    const R = 24000;
    const pcm = [];
    const starts = [];
    let inWord = false;
    const add = (s, loud) => { for (let i = 0; i < Math.round(s * R); i++) pcm.push(loud ? Math.round(Math.sin((pcm.length * 2 * Math.PI * 200) / R) * 9000) : 0); };
    for (const ch of text) {
      if (/[A-Za-z']/.test(ch)) { if (!inWord) starts.push(pcm.length / R); inWord = true; add(0.055, true); }
      else { inWord = false; if (ch === ' ') add(0.04, true); else if (ch === ',') add(0.18, false); else if (/[.!?]/.test(ch)) add(0.38, false); }
    }
    return { pcm: Int16Array.from(pcm), starts };
  };
  const saidLine = 'Done! The tests all pass. Want me to send it?';
  const syn = synth(saidLine);
  // In Orbit's page: when each chunk of the voice is scheduled to sound (wall clock), and the
  // captions it shows. In his page: when each feeling arrives.
  await pjs(`(() => { if (window.__starts) return; window.__starts = []; const st = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function (when = 0, ...a) { const ac = this.context; window.__starts.push(Date.now() + (Math.max(when, ac.currentTime) - ac.currentTime + (ac.outputLatency || ac.baseLatency || 0)) * 1000); return st.call(this, when, ...a); }; })()`);
  await pjs('window.__starts.length = 0');
  await qjs(`(() => { const d = window.__qubit.dir; window.__emotes = []; if (!d.__wrapped) { const e = d.emote; d.emote = (n) => { const ok = e(n); window.__emotes.push([n, Date.now(), ok]); return ok; }; d.__wrapped = true; } })()`);
  const emoRid = 'resp_emote';
  c.send({ type: 'response.created', response: { id: emoRid } });
  for (const d of ['<hap', 'py> Done! The tests all pass. <curi', 'ous> Want me to send it?']) c.send({ type: 'response.output_audio_transcript.delta', response_id: emoRid, item_id: `${emoRid}_a`, delta: d });
  for (let i = 0; i < syn.pcm.length; i += 9600) c.send({ type: 'response.output_audio.delta', response_id: emoRid, item_id: `${emoRid}_a`, delta: Buffer.from(syn.pcm.slice(i, i + 9600).buffer).toString('base64') });
  c.send({ type: 'response.output_audio.done', response_id: emoRid, item_id: `${emoRid}_a` });
  c.send({ type: 'response.output_audio_transcript.done', response_id: emoRid, item_id: `${emoRid}_a`, transcript: '<happy> Done! The tests all pass. <curious> Want me to send it?' });
  c.send({ type: 'response.done', response: { id: emoRid, status: 'completed' } });
  const emoFilm = film('emotes', 3200, 20, { follow: true });
  await wait(syn.pcm.length / 24 + 600);
  await emoFilm;
  const emo = await qjs('window.__emotes');
  const voiceStarts = await pjs('window.__starts.slice()');
  const tVoice = voiceStarts[0];
  const emoWant = [['happy', tVoice + syn.starts[0] * 1000], ['curious', tVoice + syn.starts[saidLine.slice(0, saidLine.indexOf('Want')).match(/[A-Za-z']+/g).length] * 1000]];
  check(emo.length === 2 && emo.every((e, i) => e[0] === emoWant[i][0] && e[2]), 'both feelings came, in order, and he showed them', JSON.stringify(emo.map((e) => [e[0], e[2]])));
  const emoErrs = emo.map((e, i) => e[1] - emoWant[i]?.[1]);
  out(`  emote timing (his page vs the words' sound, wall clock): ${emoErrs.map((e) => `${Math.round(e)} ms`).join(', ')}`);
  check(emoErrs.length === 2 && emoErrs.every((e) => Math.abs(e) <= 80), 'each within 80 ms of its words', emoErrs.map(Math.round).join(', '));
  check(await qjs('window.__qubit.dir.log.some((l) => l.what === "emote happy") && window.__qubit.dir.log.some((l) => l.what === "emote curious")'), 'the director showed them (happy, then curious)');
  const capText = await pjs('document.body.innerText');
  check(capText.includes('Done! The tests all pass.') && !/<\w+>|happy>|<curi/.test(capText), 'the caption has the words and no cue', capText.slice(0, 120).replace(/\s+/g, ' '));
  // Claude voice's way: the emote rides the first audio of its words (here the second of two chunks).
  await qjs('window.__emotes.length = 0');
  await pjs('window.__starts.length = 0');
  const cvRid = 'resp_cv';
  const half = Math.floor(syn.pcm.length / 2);
  c.send({ type: 'response.created', response: { id: cvRid } });
  c.send({ type: 'response.output_audio_transcript.delta', response_id: cvRid, item_id: `${cvRid}_a`, delta: 'Done! The tests all pass.' });
  c.send({ type: 'response.output_audio.delta', response_id: cvRid, item_id: `${cvRid}_a`, delta: Buffer.from(syn.pcm.slice(0, half).buffer).toString('base64') });
  c.send({ type: 'response.output_audio.delta', response_id: cvRid, item_id: `${cvRid}_a`, delta: Buffer.from(syn.pcm.slice(half).buffer).toString('base64'), emote: { name: 'nod' } });
  c.send({ type: 'response.done', response: { id: cvRid, status: 'completed' } });
  await wait(syn.pcm.length / 24 + 600);
  const cvEmo = await qjs('window.__emotes');
  const cvStarts = await pjs('window.__starts.slice()');
  const cvErr = cvEmo.length === 1 && cvStarts.length >= 2 ? cvEmo[0][1] - cvStarts[1] : NaN;
  out(`  emote timing, on its chunk (Claude voice's way): ${Math.round(cvErr)} ms`);
  check(cvEmo.length === 1 && cvEmo[0][0] === 'nod' && Math.abs(cvErr) <= 80, 'an emote on an audio chunk fires as that chunk plays', JSON.stringify(cvEmo));
  await expectState('back to listening after he spoke', { state: 'listening' }, 6000);

  out('5b. Talking to Qubit: "do a backflip" (the fast path: no model turn), and a trick by Grok\x27s tool');
  await label('backflip');
  await qjs('(window.__acts = window.__acts || (window.__qubit.q.on("action", (a) => window.__acts.push(a.name)), [])).length = 0');
  const cancelsBefore = c.cancels.length;
  const respBefore = c.responses.length;
  const t5 = Date.now();
  void fake.userSays(c, 'Hey Qubit, do a backflip!', { kind: 'avatar', tools: [{ name: 'avatar', args: { action: 'backflip' } }] });
  check(await waitFor(async () => (await qjs('window.__acts')).includes('flip'), 4000), 'he does a backflip', `${Date.now() - t5} ms from the words starting`);
  await film('backflip', 2200, 20);
  check(await waitFor(() => c.cancels.length > cancelsBefore, 3000), 'Grok\x27s own answer was cancelled');
  await waitFor(() => c.responses.length > respBefore && c.responses.at(-1).doneAt, 3000);
  const r5 = c.responses.slice(respBefore);
  check(r5.length === 1 && r5[0].cancelled && !c.toolCalls.some((t) => t.at > t5 && t.name === 'avatar'), 'no model answer: cancelled before any tool call', JSON.stringify(r5.map((r) => ({ audio: r.audioChunks, cancelled: r.cancelled }))));
  s = await expectState('the backflip landed (no embarrassment) and he is listening again', { state: 'listening', mode: 'listening', air: false, reaction: null }, 8000);
  const flipModes = await qjs('window.__qubit.dir.log.filter((l) => l.what.startsWith("command")).map((l) => l.what)');
  check(flipModes.includes('command backflip'), 'the director ran the command', JSON.stringify(flipModes));
  // Words that aren't only a command: Grok answers, and its avatar tool does it.
  await label('roll');
  const cancels2 = c.cancels.length;
  void fake.userSays(c, 'show me what you can do', { kind: 'other', tools: [{ name: 'avatar', args: { action: 'roll', direction: 'left' } }], followUps: [[]] });
  check(await waitFor(async () => (await qjs('window.__acts')).includes('roll'), 6000), 'Grok\x27s avatar tool: he rolls');
  check(c.cancels.length === cancels2, 'and that answer was not cancelled');
  await expectState('listening again after the roll', { state: 'listening', air: false, reaction: null }, 8000);
  await snap('after-tricks');

  out('6. A draft into Claude\x27s box, then "Send it?"');
  await label('draft');
  void fake.userSays(c, 'tell claude to add a dark mode toggle to settings', { kind: 'draft', tools: [{ name: 'draft_prompt', args: { text: 'add a dark mode toggle to settings' } }], followUps: [[]] });
  check(await waitFor(() => !!desk.windows[0].promptText, 8000), 'the draft is in the (fake) prompt box');
  await expectState('reading the draft', { reaction: 'draft' }, 3000);
  await wait(600);
  await snap('draft');
  s = await expectState('"Send it?": curious (orange), by the Send button', { state: 'confirm', mode: 'curious', x: (x, st) => near(st.confirm, 12)(x), air: false }, 9000);
  check(s.sendAt && Math.abs(s.sendAt.x - 884) <= 1,'the Send button\x27s spot is from UI Automation', JSON.stringify(s.sendAt));
  await wait(1200);
  await snap('confirm');
  // A change by voice retypes the box: only the new draft is in it, never the old one plus the new.
  void fake.userSays(c, 'make it just add a dark mode toggle', { kind: 'draft', tools: [{ name: 'draft_prompt', args: { text: 'add a dark mode toggle' } }], followUps: [[]] });
  check(await waitFor(() => desk.windows[0].promptText === 'add a dark mode toggle', 8000), 'a change retypes the box with the new draft alone', JSON.stringify(desk.windows[0].promptText));
  check(desk.sends.length === 0, 'nothing sent by a change');
  await expectState('"Send it?" again, by the Send button', { state: 'confirm', air: false }, 9000);

  out('7. Yes: sending, the stomp on Send');
  await label('send');
  const landsBefore = await qjs('(window.__lands = window.__lands || (window.__qubit.q.on("land", (d) => window.__lands.push({ x: window.__qubit.q.cx, impact: d.impact, t: performance.now() })), [])).length');
  void fake.userSays(c, 'yes send it', { kind: 'yes', tools: [{ name: 'send_draft' }], followUps: [[]] });
  const frames = film('stomp', 4500, 20);
  check(await waitFor(() => desk.sends.length === 1, 8000), 'the prompt was sent (fake Claude window)');
  await frames;
  const lands = await qjs('window.__lands');
  s = await qstate();
  const stomp = lands.slice(landsBefore).find((l) => s.sendAt && Math.abs(l.x - s.sendAt.x) < 14 && l.impact > 100);
  check(!!stomp, 'he landed a jump on the Send button', JSON.stringify(lands.slice(landsBefore).map((l) => [Math.round(l.x), Math.round(l.impact)])));
  await snap('after-send');

  out('8. Claude works: watching (Claude\x27s orange)');
  await label('watching');
  claudeStarts();
  s = await expectState('watching Claude work', { state: 'watching', mode: 'focused', x: (x, st) => near(st.watch, 14)(x) }, 12_000);
  await wait(1500);
  await snap('watching');

  out('9. Claude finished: he celebrates');
  await label('celebrate');
  claudeFinishes();
  await expectState('celebrating (happy, the colour sweep)', { mode: 'happy', action: 'celebrate' }, 8000);
  await wait(500);
  await snap('celebrate');
  await expectState('then listening again', { state: 'listening' }, 6000);

  out('10. Errors: one from Grok, and a failed send');
  await label('error');
  fake.error(c);
  await expectState('an error: red, a shiver', { mode: 'error' }, 3000);
  await wait(1000); // (his colour glides to red)
  await snap('error');
  await expectState('back to listening', { state: 'listening', mode: 'listening' }, 6000);
  void fake.userSays(c, 'tell claude to write the tests too', { kind: 'draft', tools: [{ name: 'draft_prompt', args: { text: 'write the tests too' } }], followUps: [[]] });
  await waitFor(() => !!desk.windows[0].promptText, 8000);
  await expectState('a second draft: by Send again', { state: 'confirm' }, 9000);
  desk.windows[0].promptText = 'the user typed over it'; // the box changed: the send must refuse
  const sendsBefore = desk.sends.length;
  void fake.userSays(c, 'yes send it', { kind: 'yes', tools: [{ name: 'send_draft' }], followUps: [[]] });
  await expectState('the failed send: error', { mode: 'error' }, 6000);
  check(desk.sends.length === sendsBefore, 'nothing was sent');
  await wait(900);
  await snap('failed-send');
  desk.windows[0].promptText = '';
  void fake.userSays(c, 'no, cancel that', { kind: 'other', tools: [{ name: 'cancel_draft' }], followUps: [[]] });
  await expectState('draft cancelled: listening', { state: 'listening' }, 8000);

  out('11. Mute and unmute');
  await label('mute');
  await clickLabel('Mute microphone');
  await expectState('muted: idle (indigo), the mic level ignored', { state: 'muted', mode: 'idle', input: 0 }, 3000);
  await wait(800);
  await snap('muted');
  await clickLabel('Unmute microphone');
  await expectState('unmuted: listening again', { state: 'listening', mode: 'listening' }, 3000);

  out('12. A quiet call: his seeded idle wander');
  await label('wander');
  const x0 = (await qstate()).x;
  let moved = 0;
  let intents = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 22_000) {
    const q = await qstate();
    moved = Math.max(moved, Math.abs(q.x - x0));
    if (q.state === 'idle' && q.action) intents++;
    await wait(250);
    if (Date.now() - t0 > 14_000 && !snaps.some((x) => x.label === 'idle-wander')) await snap('idle-wander');
  }
  s = await qstate();
  check(s.state === 'idle' && s.mode === 'idle', 'idle after a quiet spell', `state ${s.state}`);
  check(moved > 20 || intents > 3, 'idle life moves him about', `moved up to ${moved} px, ${intents} samples with an idle action`);

  out('13. Go to sleep');
  await label('sleep');
  await clickLabel('Go to sleep');
  await expectState('going to sleep: sleepy (dusk)', { mode: (m) => m === 'sleepy' || m === 'asleep' }, 4000);
  await snap('going-to-sleep');
  // (From wherever idle life took him: across the whole strip and up onto the box, then dozing off.)
  await expectState('asleep at home again', { state: 'asleep', mode: 'asleep', x: (x, st) => near(st.home, 14)(x) }, 35_000);
  await wait(1500);
  await snap('asleep-again');

  out('14. The Claude window moves, resizes and minimizes');
  await label('window');
  // When his page gets each new geometry (Date.now(), comparable with this process's clock).
  await qjs(BOXLOG);
  const t14 = Date.now();
  desk.windows[0].rect = { x: -4600, y: 300, w: 1000, h: 700 };
  desk.nudge?.();
  check(await waitFor(() => { const r = qwin.getBounds(); return r.x === -4600 && r.width === 1000 && r.y === 300 + 700 - 240; }, 4000), 'the strip follows a move and resize', JSON.stringify(qwin.getBounds()));
  s = await expectState('the box re-found for the new size', { box: (bx) => bx && bx.x === 238 && bx.w === 524, W: 1000 }, 5000);
  const resizeMs = (await boxSeen((b) => b && b.x === 238 && b.w === 524, t14)) - t14;
  check(resizeMs >= 0 && resizeMs < 250, 'he has the new box right after the resize (not after a full look)', `${resizeMs} ms`);
  latency.resize = resizeMs;
  await expectState('back asleep at home on the moved box (he sleepwalks there)', { mode: 'asleep', onSurface: (y, st) => st.box && y === st.box.y, x: (x, st) => near(st.home, 14)(x), air: false }, 20_000);
  await snap('resized');
  desk.windows[0].min = true;
  desk.nudge?.();
  check(await waitFor(() => !qwin.isVisible(), 4000), 'hidden while Claude is minimized');
  check(await waitFor(async () => (await qjs('window.__qubit.running')) === false, 3000), 'his frame loop stops while hidden');
  const hiddenCpu = await cpu('hidden', 5000);
  desk.windows[0].min = false;
  desk.nudge?.();
  check(await waitFor(() => qwin.isVisible(), 4000), 'back when Claude is restored');
  check(await waitFor(async () => (await qjs('window.__qubit.running')) === true, 3000), 'his frame loop runs again');

  out('14b. The prompt box changes under him: he moves with it at once');
  await label('box');
  await waitFor(async () => (await qstate()).mode === 'asleep' && !(await qstate()).air, 15_000);
  const base = (await qstate()).box;
  out(`  the box before: ${JSON.stringify(base)}`);
  const bursts0 = desk.bursts || 0;
  // The user types three lines in Claude: the box grows two lines (the caret moves; the helper looks).
  let t = Date.now();
  desk.windows[0].promptText = 'one\ntwo\nthree';
  desk.caret();
  let at = await boxSeen((b) => b && b.h >= base.h + 30, t, 2000);
  check(at > 0 && at - t < 150, 'the user types: he has the taller box within 150 ms', `${at ? at - t : 'never'} ms`);
  latency.userTypes = at ? at - t : null;
  await expectState('he rides it up: on its new top', { onSurface: (y, st) => st.box && y === st.box.y && st.box.h >= base.h + 30, air: false }, 1500);
  // A line more with no caret news (a paste, say): the helper's own look every 150 ms finds it.
  t = Date.now();
  desk.windows[0].promptText = 'one\ntwo\nthree\nfour';
  at = await boxSeen((b) => b && b.h >= base.h + 48, t, 2000);
  check(at > 0 && at - t < 300, 'no caret news: still within 300 ms', `${at ? at - t : 'never'} ms`);
  latency.noEvent = at ? at - t : null;
  desk.windows[0].promptText = '';
  desk.caret();
  await waitFor(async () => (await qstate()).box?.h === base.h, 2000);
  // Orbit types a draft in, and takes it out again: the helper looks every 30 ms meanwhile.
  const { fillDesktop, clearDesktop } = await import('../src/desktop.js');
  const draftText = 'first line\nsecond line\nthird line\nfourth line\nfifth line';
  const filled = await fillDesktop(draftText, { expectTitle: TITLE });
  check(filled.ok && desk.windows[0].promptText === draftText, 'Orbit typed a five-line draft in (fake window)');
  check((desk.bursts || 0) > bursts0, 'Orbit told the window helper first (a burst)');
  at = await boxSeen((b) => b && b.h >= base.h + 65, desk.typedAt, 2000);
  check(at > 0 && at - desk.typedAt < 150, 'Orbit types: he has the taller box within 150 ms', `${at ? at - desk.typedAt : 'never'} ms`);
  latency.orbitTypes = at ? at - desk.typedAt : null;
  await clearDesktop(draftText, { expectTitle: TITLE });
  at = await boxSeen((b) => b && b.h === base.h, desk.typedAt, 2000);
  check(at > 0 && at - desk.typedAt < 150, 'Orbit clears it: back down within 150 ms', `${at ? at - desk.typedAt : 'never'} ms`);
  latency.orbitClears = at ? at - desk.typedAt : null;
  await expectState('he rides it back down', { onSurface: (y, st) => st.box && y === st.box.y && st.box.h === base.h, air: false }, 1500);
  // A sidebar opens: the box moves along with no event at all.
  t = Date.now();
  desk.layout = { promptBoxRect: { x: 420, y: 700, w: 480, h: 24 } };
  at = await boxSeen((b) => b && b.x !== base.x, t, 2000);
  check(at > 0 && at - t < 300, 'the layout changes (a sidebar): he has the moved box within 300 ms', `${at ? at - t : 'never'} ms`);
  latency.layout = at ? at - t : null;
  await expectState('and goes back to his spot on it', { mode: 'asleep', onSurface: (y, st) => st.box && y === st.box.y, x: (x, st) => near(st.home, 14)(x), air: false }, 20_000);
  await snap('box-moved');
  delete desk.layout;
  await waitFor(async () => (await qstate()).box?.x === base.x, 2000);
  await expectState('the box back where it was: him too', { mode: 'asleep', onSurface: (y, st) => st.box && y === st.box.y, x: (x, st) => near(st.home, 14)(x), air: false }, 20_000);
  out(`  latency (change to his page having it): resize ${latency.resize} ms, user types ${latency.userTypes} ms, no event ${latency.noEvent} ms, Orbit types ${latency.orbitTypes} ms, Orbit clears ${latency.orbitClears} ms, layout ${latency.layout} ms`);

  out('15. Active CPU (a call, talking)');
  hot();
  await expectState('awake again', { state: 'listening' }, 8000);
  const c2 = fake.current();
  c2.send({ type: 'input_audio_buffer.speech_started', item_id: 'u9', audio_start_ms: 0 });
  const activeCpu = await cpu('listening, you talking', 5000);
  c2.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'u9' });
  await clickLabel('Go to sleep');
  await expectState('asleep', { state: 'asleep', mode: 'asleep' }, 20_000);

  // Motion over the whole session.
  const phys = await qjs('({ ...window.__phys, prev: undefined, dts: undefined, frames: window.__phys.dts.length })');
  out(`  motion: ${phys.samples} frames checked, pops ${phys.pops}, deepest sink ${phys.sink.toFixed(2)} px, highest float ${phys.float.toFixed(2)} px; known engine hover-bob snaps (into/out of thinking): ${phys.bobPops}`);
  check(phys.pops === 0, 'no single-frame jumps of his outline', JSON.stringify(phys.popAt));
  check(phys.bad.length === 0, 'never sinks into or floats above what he stands on (0.75 px)', JSON.stringify(phys.bad.slice(0, 10)));

  out('15b. Context follows the avatar: switching mid-call updates the live session');
  hot();
  check(await waitFor(() => fake.current() && fake.current().configured > 0, 10_000), 'a call is on');
  const c15 = fake.current();
  const setAvatarTo = (a) => pjs(`fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar: ${JSON.stringify(a)} }) }).then((r) => r.ok)`);
  check(/^Who you are:\n- You are Qubit/.test(c15.instructions || '') && c15.tools.includes('avatar'), 'the call starts as Qubit, with his tool');
  let n15 = c15.configured;
  const q15 = qwin;
  await setAvatarTo('buddy');
  check(await waitFor(() => c15.configured > n15 && /^Who you are:\n- You are Buddy/.test(c15.instructions), 3000), 'Pixel buddy: the live session is Buddy now (session.update, same call)');
  check(c15.tools.includes('avatar') && !/You are Qubit|You are Orbit/.test(c15.instructions), 'with his tool, and no one else\x27s persona');
  check(await waitFor(() => !!avatarWin('buddy'), 4000), 'his window came up');
  check(await waitFor(() => q15.isDestroyed(), 3000), 'Qubit faded out and his window closed');
  n15 = c15.configured;
  await setAvatarTo('none');
  check(await waitFor(() => c15.configured > n15 && /^Who you are:\n- You are Orbit/.test(c15.instructions), 3000), 'None: Orbit is the face again');
  check(!c15.tools.includes('avatar') && !/Qubit|Buddy|Your body/.test(c15.instructions), 'no avatar tool or avatar text');
  await setAvatarTo('qubit');
  check(await waitFor(() => /^Who you are:\n- You are Qubit/.test(c15.instructions) && c15.tools.includes('avatar'), 3000), 'Qubit again');
  check(fake.current() === c15 && c15.ws.readyState === 1, 'all in the one call (no reconnect)');
  check(await waitFor(() => (qwin = avatarWin('qubit')), 4000), 'his window is back');
  await waitFor(() => qjs('!!(window.__qubit && window.__qubit.q)'), 5000);
  await clickLabel('Go to sleep');
  await expectState('asleep after the call', { state: 'asleep', mode: 'asleep', air: false }, 20_000);

  out('16. Switch avatars live (Settings -> Avatar)');
  await pjs(`document.querySelector('button[aria-label="Settings"]').click()`);
  await waitFor(() => pjs(`[...document.querySelectorAll('[role=radio]')].some((b) => b.textContent === 'Pixel buddy')`), 5000);
  const pickAvatar = (name) => pjs(`(() => { const b = [...document.querySelectorAll('[role=radio]')].find((x) => x.textContent === ${JSON.stringify(name)}); b && b.click(); return !!b; })()`);
  check(await pjs(`[...document.querySelectorAll('[role=radio]')].find((x) => x.textContent === 'Qubit')?.getAttribute('aria-checked') === 'true'`), 'Settings shows Qubit chosen');
  // A picture of the Avatar section: Orbit's window shown for a moment, off screen.
  page.setPosition(-4200, 1200);
  realShowInactive.call(page);
  await pjs(`[...document.querySelectorAll('section')].find((x) => x.textContent.startsWith('Avatar'))?.scrollIntoView({ block: 'center' })`);
  await wait(700);
  const settingsImg = await page.webContents.capturePage().catch(() => null);
  if (settingsImg && !settingsImg.isEmpty()) fs.writeFileSync(path.join(OUT, 'settings-avatar.png'), settingsImg.toPNG());
  page.hide();
  const oldQ = qwin;
  await pickAvatar('Pixel buddy');
  let bwin = null;
  check(await waitFor(() => (bwin = avatarWin('buddy')), 4000), 'the pixel buddy window comes up');
  check(!oldQ.isDestroyed(), 'Qubit is still there while he fades out (a handover, not a cut)');
  const fadeOut = await oldQ.webContents.executeJavaScript('document.body.firstElementChild.style.opacity').catch(() => '?');
  check(fadeOut === '0', 'Qubit fades out', `opacity ${fadeOut}`);
  check(await waitFor(() => oldQ.isDestroyed(), 2000), 'then his window closes');
  check(await waitFor(() => bwin.webContents.executeJavaScript('!!document.querySelector("canvas") && document.querySelector("canvas").style.opacity === "1"').catch(() => false), 5000), 'the pixel buddy page loaded and faded in');
  check(await waitFor(() => bwin.isVisible(), 3000) && bwin.getBounds().x === -4600, 'the buddy\x27s strip is on the Claude window', JSON.stringify(bwin.getBounds()));
  await wait(2500);
  await snap('pixel-buddy', bwin, 'buddy');
  check(JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8')).avatar === undefined, 'saved (the default, Pixel buddy, is not written out)');
  await pickAvatar('None');
  check(await waitFor(() => !avatarWin('buddy') && !avatarWin('qubit'), 3000), 'None: no avatar window');
  check(JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8')).avatar === 'none', 'saved: none');
  await pickAvatar('Qubit');
  check(await waitFor(() => (qwin = avatarWin('qubit')), 4000), 'Qubit is back');
  await waitFor(() => qjs('!!(window.__qubit && window.__qubit.q)'), 5000);
  await keepDozing();
  await qjs(MOTION);
  await label('entrance');
  const entered = await qjs('window.__qubit.dir.log.some((l) => l.what === "enter")');
  check(entered, 'switched live, he drops in');
  await film('entrance', 1800, 20);
  await expectState('lands on the box and dozes off', { mode: 'asleep', air: false }, 12_000);
  await snap('entrance-asleep');
  const phys2 = await qjs('({ pops: window.__phys.pops, bad: window.__phys.bad, popAt: window.__phys.popAt })');
  check(phys2.pops === 0 && phys2.bad.length === 0, 'the entrance is smooth too', JSON.stringify(phys2));
  // Size: Big, live (he grows into it).
  await pjs(`(() => { const b = [...document.querySelectorAll('[role=radio]')].find((x) => x.textContent === 'Big'); b && b.click(); })()`);
  await expectState('Big: he grows to 50 px', { side: (v) => Math.abs(v - 50) < 0.5 }, 4000);
  await snap('size-big');

  out('17. The mouse: only he takes clicks');
  await wait(2500);
  const pos = await qjs('(() => { const q = window.__qubit.q; return { x: Math.round(q._rx), y: Math.round(q._ry) }; })()');
  const n0 = ignoreCalls.length;
  qwin.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x - 300, y: pos.y });
  await wait(150);
  check(ignoreCalls.length === n0, 'the cursor away from him: clicks still go through');
  qwin.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
  check(await waitFor(() => ignoreCalls.at(-1) === false, 2000), 'the cursor on him: his window takes the mouse');
  qwin.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  qwin.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await expectState('a click while asleep: he stirs', { action: 'wake' }, 2000);
  await expectState('and dozes off again', { mode: 'asleep', action: null }, 10_000);
  qwin.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x - 300, y: pos.y });
  check(await waitFor(() => ignoreCalls.at(-1) === true, 2000), 'the cursor off him: clicks go through to Claude again');

  out('17b. Show the orb (Settings -> Avatar)');
  const savedOrb = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8')).showOrb;
  const orbSwitch = (click) => pjs(`(() => { const b = document.querySelector('button[role=switch][aria-label="Show the orb"]'); if (b && ${!!click}) b.click(); return b ? b.getAttribute('aria-checked') : null; })()`);
  check((await orbSwitch(false)) === 'true', 'the switch is there, on by default');
  orbShown = false;
  await pjs(`document.querySelector('button[aria-label="Shrink to orb"]').click()`);
  check(await waitFor(() => orbShown, 3000), 'shrinking Orbit brings up the orb');
  await orbSwitch(true);
  check(await waitFor(() => !orbShown, 3000), 'off: the orb goes away');
  check(qwin.isVisible(), 'Qubit stays, standing in for it');
  check(await waitFor(() => savedOrb() === false, 2000), 'saved: showOrb false');
  await pickAvatar('None');
  check(await waitFor(() => orbShown, 3000), 'with no avatar the orb always shows (something stays on screen)');
  await pickAvatar('Qubit');
  check(await waitFor(() => (qwin = avatarWin('qubit')) && !orbShown, 4000), 'Qubit back: the orb goes away again');
  await waitFor(() => qjs('!!(window.__qubit && window.__qubit.q)'), 5000);
  await orbSwitch(true);
  check(await waitFor(() => orbShown, 3000), 'on again: the orb comes back');
  check(await waitFor(() => savedOrb() !== false, 2000), 'saved: showOrb on');

  out('18. Errors on any page');
  const relevant = consoleErrors.filter((e) => !/Failed to load resource.*(api\.x\.ai|x\.ai)/.test(e));
  check(relevant.length === 0, 'no console errors on Orbit\x27s pages, Qubit\x27s or the buddy\x27s', relevant.slice(0, 6).join(' | '));
  check(spawnTries.length === 0, 'no child processes', spawnTries.join(','));
  out(`  cpu summary: asleep ${idleCpu.r.toFixed(2)}% (GPU ${idleCpu.gpu.toFixed(2)}%), his own life ${lifeCpu.r.toFixed(2)}% (GPU ${lifeCpu.gpu.toFixed(2)}%), active ${activeCpu.r.toFixed(2)}% (GPU ${activeCpu.gpu.toFixed(2)}%), hidden ${hiddenCpu.r.toFixed(2)}%`);
  check(lifeCpu.r < 5, 'his own life costs little CPU', `${lifeCpu.r.toFixed(2)}%`);
  check(hiddenCpu.r < 1, 'next to no CPU while hidden', `${hiddenCpu.r.toFixed(2)}%`);
  check(idleCpu.r < Math.max(3, activeCpu.r * 0.8), 'asleep costs less than active', `${idleCpu.r.toFixed(2)}% vs ${activeCpu.r.toFixed(2)}%`);

  await sheets();
}

// ---------- contact sheets (the strip on a mock of the Claude window) ----------
async function sheets() {
  const w = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { offscreen: false, backgroundThrottling: false } });
  await w.loadURL('data:text/html,<body style="margin:0"><canvas id=c></canvas></body>');
  const toData = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
  // States: cells cropped around the prompt box's right half (where he lives), 2 columns.
  const cells = snaps.map((x) => ({ label: x.label, src: toData(x.file), box: x.info?.box || { x: 288, y: 126, w: 624, h: 38 }, send: x.info?.sendAt, kind: x.kind }));
  const sheet = await w.webContents.executeJavaScript(`(async () => {
    const cells = ${JSON.stringify(cells)};
    const CW = 560, CH = 240, LH = 22, COLS = 2;
    const c = document.getElementById('c');
    c.width = CW * COLS; c.height = Math.ceil(cells.length / COLS) * (CH + LH);
    const g = c.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < cells.length; i++) {
      const k = cells[i], X = (i % COLS) * CW, Y = Math.floor(i / COLS) * (CH + LH);
      const img = new Image(); img.src = k.src; await img.decode();
      const ox = Math.max(0, Math.min(img.width - CW, k.box.x + k.box.w - CW + 40));
      g.save(); g.beginPath(); g.rect(X, Y + LH, CW, CH); g.clip();
      g.fillStyle = '#262624'; g.fillRect(X, Y + LH, CW, CH); // Claude's dark page
      g.fillStyle = '#30302e'; g.strokeStyle = '#4a4a46'; g.lineWidth = 1;
      const bx = X + k.box.x - ox, by = Y + LH + k.box.y;
      g.beginPath(); g.roundRect(bx + 0.5, by + 0.5, k.box.w, Math.min(k.box.h, CH - k.box.y - 18), 12); g.fill(); g.stroke();
      g.fillStyle = '#8a8a85'; g.font = '13px sans-serif'; g.fillText('Reply to Claude...', bx + 14, by + 28);
      g.fillStyle = '#d97757'; g.fillRect(X + (k.send ? k.send.x : k.box.x + k.box.w - 28) - ox - 16, by + 40, 32, 32);
      g.drawImage(img, ox, 0, CW, CH, X, Y + LH, CW, CH);
      g.restore();
      g.fillStyle = '#ddd'; g.font = '13px monospace'; g.fillText((i + 1) + '. ' + k.label, X + 8, Y + 15);
    }
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync(path.join(OUT, 'sheet-states.png'), Buffer.from(sheet.split(',')[1], 'base64'));
  // Films: tight crops around him, 10 per row.
  for (const f of films) {
    const files = fs.readdirSync(f.dir).filter((n) => n.endsWith('.png')).sort();
    const pick = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 30)) === 0).slice(0, 30);
    const srcs = pick.map((n) => toData(path.join(f.dir, n)));
    if (f.wide) {
      // The whole strip, every few frames, two to a row: where he goes, not just what he does.
      const all = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 40)) === 0).slice(0, 40).map((n) => toData(path.join(f.dir, n)));
      const wideData = await w.webContents.executeJavaScript(`(async () => {
        const srcs = ${JSON.stringify(all)}, box = ${JSON.stringify(f.box || { x: 288, y: 126, w: 624 })};
        const CW = 600, CH = 120, COLS = 2, K = 0.5;
        const c = document.getElementById('c');
        c.width = CW * COLS; c.height = Math.ceil(srcs.length / COLS) * CH;
        const g = c.getContext('2d');
        for (let i = 0; i < srcs.length; i++) {
          const img = new Image(); img.src = srcs[i]; await img.decode();
          const X = (i % COLS) * CW, Y = Math.floor(i / COLS) * CH;
          g.fillStyle = '#262624'; g.fillRect(X, Y, CW, CH);
          g.fillStyle = '#30302e'; g.fillRect(X + box.x * K, Y + box.y * K, box.w * K, CH - box.y * K - 9 * K);
          g.drawImage(img, 0, 0, img.width, img.height, X, Y, CW, CH);
          g.strokeStyle = '#000'; g.strokeRect(X + 0.5, Y + 0.5, CW - 1, CH - 1);
          g.fillStyle = '#ccc'; g.font = '11px monospace'; g.fillText(String(i), X + 4, Y + 12);
        }
        return c.toDataURL('image/png');
      })()`);
      fs.writeFileSync(path.join(OUT, `sheet-film-${f.label}.png`), Buffer.from(wideData.split(',')[1], 'base64'));
      continue;
    }
    const data = await w.webContents.executeJavaScript(`(async () => {
      const srcs = ${JSON.stringify(srcs)}, box = ${JSON.stringify(f.box || { x: 288, y: 126, w: 624 })}, cx = ${JSON.stringify(!f.follow && f.sendAt ? f.sendAt.x : f.x || 800)};
      const CW = 200, CH = 240, COLS = 10;
      const c = document.getElementById('c');
      c.width = CW * COLS; c.height = Math.ceil(srcs.length / COLS) * CH;
      const g = c.getContext('2d');
      for (let i = 0; i < srcs.length; i++) {
        const img = new Image(); img.src = srcs[i]; await img.decode();
        const X = (i % COLS) * CW, Y = Math.floor(i / COLS) * CH, ox = Math.max(0, Math.min(img.width - CW, cx - CW / 2));
        g.fillStyle = '#262624'; g.fillRect(X, Y, CW, CH);
        g.fillStyle = '#30302e'; g.fillRect(X + box.x - ox, Y + box.y, box.w, CH - box.y - 18);
        g.drawImage(img, ox, 0, CW, CH, X, Y, CW, CH);
        g.strokeStyle = '#000'; g.strokeRect(X + 0.5, Y + 0.5, CW - 1, CH - 1);
        g.fillStyle = '#ccc'; g.font = '11px monospace'; g.fillText(String(i), X + 4, Y + 12);
      }
      return c.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(OUT, `sheet-film-${f.label}.png`), Buffer.from(data.split(',')[1], 'base64'));
  }
  w.destroy();
  out(`  contact sheets: ${OUT}`);
}

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  out(`RESULT ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} failure(s)`);
  try {
    fs.writeFileSync(path.join(OUT, 'result.txt'), `${lines.join('\n')}\n`);
  } catch {}
  await fake.close();
  setTimeout(() => {
    for (let i = 0; i < 5; i++) try { fs.rmSync(path.join(tmp, 'appdata'), { recursive: true, force: true, maxRetries: 3 }); break; } catch {}
    app.exit(failures.length ? 1 : 0);
  }, 500);
}
