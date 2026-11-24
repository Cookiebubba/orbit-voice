// Settings, end to end: the real Orbit (electron/main.js, the bridge, the page) in a window far off
// screen, with a fake mic, as the test build (ORBIT_TEST_IDENTITY) in a throwaway profile. It opens
// every room, toggles real settings, reads them back from the settings file and the running core,
// listens for real speech, and takes a picture of every state.
//
//   npm --prefix ui run build
//   npm run e2e:settings -- --out <folder for the pictures> [--port 4431]
//
// Nothing touches real Orbit: APPDATA and friends point into a temp folder, Claude's window is
// test/e2e/fake-desktop.mjs, Claude Code is test/e2e/FakeClaude.cs, and the only thing read from the
// real profile is the speech models folder (copied, so Kitten really speaks).
import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, globalShortcut, shell, Tray } from 'electron';
import { cscArgs } from '../test/e2e/fake-window.mjs';
import { createFakeGrok } from '../test/e2e/fake-grok.mjs';
import { makeGen } from '../test/fuzz/gen.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const PORT = Number(opt('port', 4431));
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'orbit-settings-e2e-shots')));
fs.mkdirSync(OUT, { recursive: true });
const REAL_MODELS = path.join(process.env.APPDATA, 'Orbit', 'claude-voice-models');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-settings-e2e-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what, detail = '') => {
  results.push([!!ok, what]);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  [${String(detail).slice(0, 300)}]` : ''}`);
};
const noteEvery = (s) => console.log(`--- ${s}`);

// The fake Claude Code, signed in.
const CLAUDE_DIR = path.join(tmp, 'claude');
const FAKE_CLAUDE = path.join(tmp, 'bin', 'claude.exe');
fs.mkdirSync(path.join(CLAUDE_DIR, 'pids'), { recursive: true });
fs.mkdirSync(path.dirname(FAKE_CLAUDE), { recursive: true });
{
  const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const r = child_process.spawnSync(csc, cscArgs(FAKE_CLAUDE), { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`could not build the fake claude.exe: ${r.stdout}${r.stderr}`);
  fs.writeFileSync(path.join(CLAUDE_DIR, 'auth.txt'), 'in');
}

// The throwaway profile, with a pretend real Orbit beside the test build's folder.
for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'local'], ['USERPROFILE', 'home'], ['HOME', 'home']]) {
  process.env[k] = path.join(tmp, d);
  fs.mkdirSync(process.env[k], { recursive: true });
}
app.setPath('appData', process.env.APPDATA);
const REAL = path.join(process.env.APPDATA, 'Orbit');
const USER_DATA = path.join(process.env.APPDATA, 'Orbit Test');
fs.mkdirSync(REAL, { recursive: true });
fs.writeFileSync(
  path.join(REAL, 'settings.json'),
  JSON.stringify({ voiceEngine: 'claude', voice: 'ara', wakeHotkey: 'Control+G', avatar: 'qubit', buddySize: 2, showOrb: true, orbStick: true, orbPulse: true, orbPulseGrok: true, orbPulseAmount: 0.02, orbPosition: [3294, 1237], orbStickAnchor: { corner: 'br', dx: 0, dy: 0 }, anywhere: true, anywhereUnderOrbit: ['discord.exe'], brainClaudePath: FAKE_CLAUDE, announce: 'speak', autoUpdate: true }),
);
fs.writeFileSync(path.join(REAL, 'xai-key.bin'), 'not a key: must never be copied');
if (fs.existsSync(REAL_MODELS)) fs.cpSync(REAL_MODELS, path.join(REAL, 'claude-voice-models'), { recursive: true });
const realBefore = JSON.stringify(fs.readdirSync(REAL).sort().map((f) => [f, fs.statSync(path.join(REAL, f)).mtimeMs]));

process.env.PATH = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(path.delimiter);
delete process.env.ANTHROPIC_API_KEY;
process.env.ORBIT_FAKE_CLAUDE_DIR = CLAUDE_DIR;
process.env.ORBIT_FAKE_DESKTOP = path.join(ROOT, 'test', 'e2e', 'fake-desktop.mjs');
process.env.ORBIT_TEST_IDENTITY = '1';
process.env.PORT = String(PORT);
// A call to talk over: the repo's fake Grok, never xAI.
const fakeGrok = createFakeGrok({ g: makeGen(7) });
await fakeGrok.ready;
process.env.XAI_REALTIME_URL = fakeGrok.url;

// Electron stays in the harness. The main window really shows, far off screen: Chromium has to paint it.
const hotkeys = new Map();
globalShortcut.register = (accel, cb) => (hotkeys.set(accel, cb), true);
globalShortcut.isRegistered = (accel) => hotkeys.has(accel);
globalShortcut.unregister = (accel) => hotkeys.delete(accel);
globalShortcut.unregisterAll = () => hotkeys.clear();
shell.openExternal = async () => {};
shell.openPath = async () => '';
dialog.showErrorBox = (t, m) => check(false, `error dialog: ${t}`, m);
const showInactive = BrowserWindow.prototype.showInactive;
const restore = BrowserWindow.prototype.restore;
// The real tray icon and menu, so the checks use the handlers a person would.
let trayIcon = null;
let trayMenu = null;
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
  trayIcon = this;
  trayMenu = menu;
  return setContextMenu.call(this, menu);
};
for (const m of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) {
  BrowserWindow.prototype[m] = function (...a) {
    if (m === 'restore' && this.getTitle() === 'Orbit Test') return restore.apply(this, a);
    if (m === 'show' || m === 'showInactive') {
      if (this.getTitle() === 'Orbit Test') {
        this.setPosition(-4200, 80);
        return showInactive.apply(this, a);
      }
    }
  };
}
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); // off screen still paints
const scriptErrors = [];
app.on('web-contents-created', (_e, wc) => {
  wc.setAudioMuted(true);
  wc.on('console-message', (e, level, message) => {
    const lvl = typeof e?.level === 'string' ? e.level : level === 3 ? 'error' : '';
    if (lvl === 'error') scriptErrors.push(String(e?.message ?? message ?? '').slice(0, 300));
  });
  wc.on('render-process-gone', (_ev, d) => check(false, 'a page crashed', d?.reason));
});
process.on('uncaughtException', (e) => check(false, 'uncaught exception', e?.stack || e));
process.on('unhandledRejection', (e) => check(false, 'unhandled rejection', e?.stack || e));

const { getSetting, getConfigDir, webSearchOn } = await import('../src/config.js');
const { agentContext } = await import('../src/agent.js');
await import(pathToFileURL(path.join(ROOT, 'electron', 'main.js')).href);

let page = null;
const js = (code) => page.webContents.executeJavaScript(code, true);
const until = async (fn, ms = 8000, step = 60) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await wait(step);
  }
};
const saved = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8'));
let shotN = 0;
const shot = async (name) => {
  // An off-screen window paints on demand: frames for the transitions to run, then a settled one.
  for (let i = 0; i < 6; i++) {
    await page.webContents.capturePage();
    await wait(70);
  }
  const img = await page.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`), img.toPNG());
};
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = (sel) => js(`(() => { const el = ${q(sel)}; if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); })()`);
const text = (sel) => js(`${q(sel)}?.textContent ?? null`);
const say = () => text('.qsay p');
const rect = (sel) => js(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`);
const center = async (sel) => {
  const r = await rect(sel);
  return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
};
const mouse = (type, p, extra = {}) => page.webContents.sendInputEvent({ type, x: p.x, y: p.y, ...extra });
const key = (keyCode, modifiers = []) => {
  page.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode.length === 1) page.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
  page.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
};
const openRoom = async (id) => {
  await click(id === 'engine' ? '[data-tile="engine"]' : `.room-head[data-room="${id}"], .sysrow[data-room="${id}"]`);
  await wait(560);
};
const openRoomFromSheet = async (id) => {
  await done();
  await openRoom(id);
};
const done = async () => {
  await click('.sheet-head button');
  await wait(520);
};
const scrollSheet = (top) => js(`(() => { const b = ${q('.sheet-body')}; b.scrollTop = ${top}; return b.scrollHeight - b.clientHeight; })()`);
/** Every hint in the open room fits two lines, and nothing overflows sideways. */
const roomLayout = (name) =>
  js(`(() => {
    const body = ${q('.sheet-body')};
    const long = [...body.querySelectorAll('.h')].filter((h) => h.getBoundingClientRect().height > parseFloat(getComputedStyle(h).lineHeight) * 2 + 1).map((h) => h.textContent);
    return { long, sideways: body.scrollWidth - body.clientWidth };
  })()`).then((r) => {
    check(!r.long.length, `${name}: no hint past two lines`, r.long.join(' | '));
    check(r.sideways <= 0, `${name}: nothing overflows sideways`, r.sideways);
  });
const rowDim = (id) => js(`${q(`[data-row="${id}"]`)}?.classList.contains('dim') ?? null`);
const hintOf = (id) => text(`[data-row="${id}"] .h`);
const clickRowControl = (id) => click(`[data-row="${id}"] .ctl button`);
const searchTools = () => agentContext().tools.map((t) => t.name || t.type).filter((n) => /search/.test(n) && n !== 'ask_second_brain');

/** Requests the page made for spoken lines, and how many of them came back with audio. */
const spy = `(() => {
  if (window.__spy) return;
  const f = window.fetch;
  window.__spy = { lines: [], audio: 0, grok: 0 };
  window.fetch = async (u, o) => {
    if (String(u).includes('/api/claude-voice/preview')) window.__spy.lines.push(JSON.parse(o.body).text || '(sample)');
    if (String(u).includes('/api/voice/preview')) window.__spy.grok++;
    const r = await f(u, o);
    if (String(u).includes('/api/claude-voice/preview') && r.ok) window.__spy.audio++;
    return r;
  };
})()`;

async function run() {
  page = await until(() => BrowserWindow.getAllWindows().find((w) => /^http:\/\/127\.0\.0\.1:\d+\/(#?)$/.test(w.webContents.getURL())), 30000);
  if (!page) throw new Error('the main window never loaded (npm --prefix ui run build?)');
  await until(() => js(`!!document.querySelector('button[aria-label="Settings"]')`), 20000);

  noteEvery('identity');
  check(app.getName() === 'Orbit Test', 'app name is Orbit Test', app.getName());
  check(path.basename(app.getPath('userData')) === 'Orbit Test', 'userData is its own folder', app.getPath('userData'));
  check(path.resolve(getConfigDir()) === path.resolve(USER_DATA), 'the core reads that folder too', getConfigDir());
  check((await until(() => page.getTitle() === 'Orbit Test')) === true, 'window title says Orbit Test', page.getTitle());
  check((await text('.wordmark')) === 'Orbit Test', 'the wordmark says Orbit Test', await text('.wordmark'));
  const seeded = saved();
  check(seeded.wakeHotkey === 'Control+Alt+Shift+G', 'its own hotkey', seeded.wakeHotkey);
  check(seeded.anywhereUnderOrbit === undefined, 'no apps under Orbit were carried over');
  check(fs.existsSync(path.join(USER_DATA, 'claude-voice-models')), 'speech models copied');
  check(!fs.existsSync(path.join(USER_DATA, 'xai-key.bin')), 'no key copied');
  check([...hotkeys.keys()].includes('Control+Alt+Shift+G'), 'it registered that hotkey', [...hotkeys.keys()]);

  await js(spy);
  await click('button[aria-label="Settings"]');
  await until(() => js(`!!${q('.oset .tile')}`));
  await wait(500);
  noteEvery('no orb in the settings, and an old file with it loads cleanly');
  const ORB_KEYS = ['showOrb', 'orbStick', 'orbStickAnchor', 'orbPosition', 'orbPulse', 'orbPulseGrok', 'orbPulseAmount'];
  check(ORB_KEYS.every((k) => k in seeded), 'the old file really had them all', Object.keys(seeded).join());
  check(ORB_KEYS.every((k) => getSetting(k) === undefined), 'it loaded, and ignored them');
  check(getSetting('voice') === 'ara' && getSetting('avatar') === 'qubit' && getSetting('voiceEngine') === 'claude', 'and kept the rest');
  const cfg = await js(`fetch('/api/config').then((r) => r.json())`);
  check(ORB_KEYS.every((k) => !(k in cfg.settings) && !(k in cfg.defaults)), 'neither the page nor the defaults have them');
  noteEvery('home');
  await shot('home');
  const avatarCard = await rect('[data-tile="avatar"]');
  check(avatarCard.w > 320 && (await js(`document.querySelectorAll('.tile').length`)) === 9, 'nine cards, and the Avatar card spans the full width', avatarCard.w);
  check(!(await js(`!!${q('[data-tile="orb"]')}`)), 'no Orb card');
  const engineTile = await rect('[data-tile="engine"]');
  check(Math.abs((await rect('.oset')).h - 536) < 1, 'settings fills the window under the title bar', (await rect('.oset')).h);
  check(engineTile.w > 150, 'tiles keep their width', engineTile.w);
  const art = await js(`(() => {
    const svg = ${q('.qmount svg')};
    const all = [...svg.querySelectorAll('*')];
    const body = all.filter((e) => e.tagName.toLowerCase() === 'path');
    const bad = all.filter((e) => ['linearGradient', 'radialGradient', 'filter', 'mask', 'circle', 'line', 'pattern'].includes(e.tagName));
    const p = body[0];
    const cs = p && getComputedStyle(p);
    return { paths: body.length, bad: bad.map((e) => e.tagName), rule: p?.getAttribute('fill-rule') || cs?.fillRule, stroke: cs?.stroke, filter: cs?.filter + getComputedStyle(svg).filter, shadow: getComputedStyle(svg).boxShadow, d: p?.getAttribute('d')?.slice(0, 40) };
  })()`);
  check(art.paths === 1 && !art.bad.length, 'Qubit is one path, nothing else', JSON.stringify(art));
  check(art.rule === 'evenodd', 'his eye is a real hole in that one even-odd path', art.rule);
  check(art.stroke === 'none' && !/url|blur|drop/.test(art.filter) && art.shadow === 'none', 'no outline, shadow, filter or gradient', JSON.stringify(art));

  noteEvery('rooms');
  for (const [id, h] of [['engine', 470], ['voice', 470], ['listening', 470], ['brain', 470], ['finish', 470], ['reach', 470], ['presence', 470], ['app', 290]]) {
    await openRoom(id);
    const sheet = await rect('.sheet');
    check(Math.abs(sheet.h - h) < 1, `${id}: sheet is ${h} tall`, sheet.h);
    await shot(`room-${id}`);
    await roomLayout(id);
    const room = await js(`(() => {
      const s = window.__settings.strip.q;
      const ctm = s.svg.getScreenCTM().inverse().multiply(s.body.getScreenCTM());
      const bottom = Math.max(...[[-50,50],[50,50]].map(([x,y]) => new DOMPoint(x,y).matrixTransform(ctm).y));
      const sv = s.svg.getBoundingClientRect();
      const scale = sv.height / s.svg.viewBox.baseVal.height;
      return { feet: sv.top + bottom * scale, band: ${q('.oset')}.classList.contains('band') };
    })()`);
    if (h === 470) {
      check(room.band, `${id}: he lifts with a full sheet`);
      check(Math.abs(room.feet - sheet.y) < 2.5, `${id}: he stands on the sheet's top edge`, `feet ${room.feet.toFixed(1)}, edge ${sheet.y}`);
    }
    const max = await scrollSheet(9999);
    if (max > 0) {
      await shot(`room-${id}-end`);
      await scrollSheet(0);
    }
    await done();
  }
  const scrim = await js(`getComputedStyle(${q('.scrim')}).backgroundImage`);
  check(/84px/.test(scrim), 'the scrim starts below the strip', scrim);

  noteEvery('open paths');
  await js(`${q('.room-head[data-room="voice"]')}.focus()`);
  await openRoom('voice');
  key('Escape');
  await wait(520);
  check((await js(`window.__settings.room`)) === null, 'Escape closes a sheet');
  check((await js(`document.activeElement?.dataset?.room`)) === 'voice', 'and focus goes back to what opened it', await js(`document.activeElement?.className`));
  noteEvery('every card opens its room, at its own row');
  page.webContents.debugger.attach('1.3');
  const press = async (key, code, vk, autoRepeat = false) => {
    for (const type of ['rawKeyDown', 'char', 'keyUp']) {
      if (type === 'char' && key === 'Escape') continue;
      const chr = key === 'Enter' ? '\r' : key;
      await page.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, autoRepeat, text: type === 'char' ? chr : undefined });
    }
  };
  const scene = () => js(`JSON.stringify(window.__settings.s)`);
  /** The sheet is at the card's row, with focus on that row's first control, and nothing painted on it. */
  const landed = (id) =>
    js(`(() => {
      const body = ${q('.sheet-body')};
      const row = body.querySelector('[data-row="${id}"]');
      if (!row) return { missing: true };
      const r = row.getBoundingClientRect(), b = body.getBoundingClientRect();
      const first = row.querySelector('.ctl button, .ctl input');
      return { inView: r.top >= b.top - 1 && r.top < b.bottom - 20, off: Math.round(r.top - b.top), atEnd: body.scrollTop >= body.scrollHeight - body.clientHeight - 1, top: body.scrollTop, max: body.scrollHeight - body.clientHeight, focused: document.activeElement === first, paint: getComputedStyle(row).backgroundColor };
    })()`);
  const isLanded = (l) => !l.missing && l.inView && (Math.abs(l.off) <= 8 || l.atEnd) && l.focused && l.paint === 'rgba(0, 0, 0, 0)';
  const CARDS = { engine: 'engine', voice: 'voice', listen: 'listening', wake: 'listening', brain: 'brain', web: 'brain', anywhere: 'reach', mouse: 'reach', avatar: 'presence' };
  const CHOICES = ['engine', 'voice', 'avatar'];
  const before = await scene();
  const only = opt('cards', ''); // --cards web,avatar: just those cards, then stop (for chasing one)
  for (const [id, menu] of Object.entries(CARDS).filter(([k]) => !only || only.split(',').includes(k))) {
    const sel = `[data-tile="${id}"]`;
    const a11y = await js(`(() => { const t = ${q(sel)}; return { tag: t.tagName, role: t.getAttribute('role'), pop: t.getAttribute('aria-haspopup'), expanded: t.hasAttribute('aria-expanded'), checked: t.hasAttribute('aria-checked'), corner: !!t.querySelector('.corner, [data-open]'), caret: !!t.querySelector('.caret'), name: t.textContent }; })()`);
    check(a11y.tag === 'BUTTON' && a11y.pop === 'dialog' && !a11y.role && !a11y.checked && !a11y.expanded, `${id}: a button with aria-haspopup dialog, no switch role`, JSON.stringify(a11y));
    check(!a11y.corner && a11y.caret === CHOICES.includes(id), `${id}: no corner arrow, a caret only on a choice`);
    check(/On|Off|Shown|Hidden|Always|One question|Claude|Voice \d|Qubit/.test(a11y.name), `${id}: its state is in its name`, a11y.name);
    const toCard = async () => {
      await js(`${q(sel)}.scrollIntoView({ block: 'center' })`);
      await wait(60);
      return rect(sel);
    };
    for (const [where, dx, dy] of [['the middle', 0.5, 0.5], ['the top right, where the arrow was', 0.93, 0.15], ['the left edge', 0.04, 0.5]]) {
      const r = await toCard();
      const at = { x: Math.round(r.x + r.w * dx), y: Math.round(r.y + r.h * dy) };
      const n = await js(`window.__settings.opened`);
      mouse('mouseMove', at);
      await wait(40);
      mouse('mouseDown', at, { button: 'left', clickCount: 1 });
      mouse('mouseUp', at, { button: 'left', clickCount: 1 });
      await wait(320);
      check((await js(`window.__settings.room`)) === menu, `${id}: a real click on ${where} opens ${menu}`, await js(`window.__settings.room`));
      check((await js(`window.__settings.opened`)) === n + 1 && (await js(`!!${q('.pop')}`)) === false, `${id}: once, with no popover`);
      const l = await landed(id);
      check(isLanded(l), `${id}: at its own row, focus on its control, no highlight`, JSON.stringify(l));
      await press('Escape', 'Escape', 27);
      await wait(520);
      check((await js(`document.activeElement?.dataset?.tile`)) === id, `${id}: focus returns to the card`, await js(`document.activeElement?.dataset?.tile`));
    }
    await js(`${q(sel)}.focus()`);
    await press('Enter', 'Enter', 13);
    await wait(320);
    check((await js(`window.__settings.room`)) === menu && isLanded(await landed(id)), `${id}: Return opens it at the row`);
    await press('Enter', 'Enter', 13, true); // the same key, still held
    await wait(120);
    check((await scene()) === before, `${id}: a key still held changes nothing`);
    await press('Escape', 'Escape', 27);
    await wait(520);
    check((await js(`document.activeElement?.dataset?.tile`)) === id, `${id}: and focus returns from the keyboard too`);
    await js(`${q(sel)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))`);
    await wait(320);
    check((await js(`window.__settings.room`)) === menu && isLanded(await landed(id)), `${id}: right-click opens it at the row`);
    await press('Escape', 'Escape', 27);
    await wait(520);
    await toCard();
    const c = await center(sel);
    const n = await js(`window.__settings.opened`);
    mouse('mouseMove', c);
    await wait(60);
    mouse('mouseDown', c, { button: 'left', clickCount: 1 });
    await wait(620);
    check((await js(`window.__settings.room`)) === menu, `${id}: holding opens it`);
    mouse('mouseUp', c, { button: 'left', clickCount: 1 });
    await wait(320);
    check((await js(`window.__settings.opened`)) === n + 1, `${id}: a hold opens it once, not twice`, (await js(`window.__settings.opened`)) - n);
    check((await js(`window.__settings.room`)) === menu && (await scene()) === before, `${id}: it stays open, and nothing flipped`);
    await press('Escape', 'Escape', 27);
    await wait(520);
    check((await js(`window.__settings.room`)) === null, `${id}: Escape closes it`);
  }
  if (only) return;
  check(saved().listenMode === undefined && saved().wakeWord === undefined && saved().brainEnabled === undefined, 'no card changed a setting on the way');
  await js(`${q('.oset .screen')}.scrollTop = 0`);
  check((await js(`document.querySelectorAll('.room-head .ic').length`)) === 6, 'the six room labels keep their arrows');
  check((await js(`document.querySelectorAll('.oset .corner, .oset [data-open]').length`)) === 0, 'and no card has one');
  await js(`${q('[data-tile="wake"]')}.focus()`);
  await press(' ', 'Space', 32);
  await wait(320);
  check((await js(`document.activeElement?.getAttribute('aria-label')`)) === 'Hey Orbit', 'keyboard: Space on a card lands on its switch', await js(`document.activeElement?.getAttribute('aria-label')`));
  await press(' ', 'Space', 32);
  await until(() => saved().wakeWord === true);
  check(saved().wakeWord === true, 'and Space again switches it, and it saves');
  await press('Escape', 'Escape', 27);
  await wait(520);
  check(/On/.test(await text('[data-tile="wake"] .val')) && (await js(`${q('[data-tile="wake"]')}.classList.contains('on')`)), 'the card shows it, black means on', await text('[data-tile="wake"] .val'));
  await press(' ', 'Space', 32);
  await wait(320);
  await press(' ', 'Space', 32);
  await until(() => saved().wakeWord === undefined);
  await press('Escape', 'Escape', 27);
  await wait(520);

  noteEvery('speech (real Kitten)');
  await js(`window.__spy.lines = []; window.__spy.audio = 0;`);
  await click('[data-finish="chime"]');
  await wait(300);
  const asked = Date.now();
  await click('[data-finish="speak"]');
  await until(() => js(`window.__spy.audio > 0`), 20000, 10);
  console.log(`     (first line came back in ${Date.now() - asked} ms, models warm)`);
  const heard = await until(() => js(`window.__settings.strip.q.talking === true`), 8000, 20);
  const spoken = await js(`window.__spy.lines`);
  check(spoken.includes('Claude finished billing. Tests pass.'), 'Qubit asks for his line', JSON.stringify(spoken));
  check(heard === true, 'a real clip plays and his mouth follows it');
  await wait(600);
  check((await until(() => js(`window.__settings.strip.mood === 'working'`), 1500)) === true, 'he holds his mood while he talks', await js(`window.__settings.strip.mood`));

  noteEvery('volume and speed');
  const dial = await rect('.dial');
  const y = Math.round(dial.y + dial.h / 2);
  mouse('mouseDown', { x: Math.round(dial.x + dial.w * 0.25), y }, { button: 'left', clickCount: 1 });
  mouse('mouseMove', { x: Math.round(dial.x + dial.w * 0.4), y });
  mouse('mouseUp', { x: Math.round(dial.x + dial.w * 0.4), y }, { button: 'left', clickCount: 1 });
  await until(() => saved().voiceVolume !== undefined);
  check(Math.abs(saved().voiceVolume - 0.4) < 0.03, 'dragging the dial saves the volume', saved().voiceVolume);
  check(Math.abs(getSetting('voiceVolume') - 0.4) < 0.03, 'and the core has it', getSetting('voiceVolume'));

  noteEvery('Web search needs Second brain');
  check(webSearchOn() === true, 'search is on to begin with');
  check(searchTools().length > 0, 'the voice has a search tool', searchTools());
  await openRoom('brain');
  await click('[data-row="brain"] .sw');
  await until(() => saved().brainEnabled === false);
  check(saved().brainEnabled === false, 'Second brain off saves');
  check(webSearchOn() === false, 'Web search is really off: the core says so');
  check(searchTools().length === 0, 'and the voice has no search tool', searchTools());
  check(!/Web search/.test(agentContext().instructions), 'nor any word of it in its instructions');
  check(getSetting('webSearch') === true && saved().webSearch === undefined, 'the saved Web search value is left alone');
  await done();
  await until(() => js(`getComputedStyle(${q('[data-tile="web"]')}).opacity === '0.4'`));
  check((await js(`getComputedStyle(${q('[data-tile="web"]')}).opacity`)) === '0.4', 'the Web tile fades to 40%', await js(`getComputedStyle(${q('[data-tile="web"]')}).opacity`));
  check((await js(`${q('[data-tile="web"]')}.getAttribute('aria-description')`)) === 'Turn on Second brain to change this.', 'and a screen reader hears why');
  await shot('home-brain-off');
  await click('[data-tile="web"]');
  await wait(320);
  check((await js(`window.__settings.room`)) === 'brain' && isLanded(await landed('web')), 'a faded card still opens its room, at its row', JSON.stringify(await landed('web')));
  check((await hintOf('web')) === 'Turn on Second brain to change this.', 'where the row says what turns it back on', await hintOf('web'));
  await click('[data-row="web"] .sw');
  await wait(200);
  check((await say()) === 'Turn on Second brain first.', 'a click on the faded switch says so too', await say());
  check(getSetting('webSearch') === true, 'and changes nothing');
  for (const id of ['brainModel', 'readProject', 'web', 'connection', 'brainTest']) check((await rowDim(id)) === true, `${id} fades`, await hintOf(id));
  await scrollSheet(9999);
  await shot('brain-off');
  await scrollSheet(0);
  await click('[data-row="brain"] .sw');
  await until(() => saved().brainEnabled === undefined);
  await done();
  check(webSearchOn() === true && searchTools().length > 0, 'Second brain on: search comes back', searchTools());

  noteEvery('every other dependency');
  await openRoom('reach');
  await click('[data-row="anywhere"] .sw');
  await until(() => saved().anywhere === false);
  check(getSetting('anywhere') === false, 'Orbit anywhere off saves and takes effect');
  check(!agentContext().tools.some((t) => t.name === 'list_windows'), 'its tools go');
  for (const id of ['see', 'mouse', 'cdp', 'apps']) check((await rowDim(id)) === true, `${id} fades`, await hintOf(id));
  await shot('reach-anywhere-off');
  await click('[data-row="anywhere"] .sw');
  await until(() => saved().anywhere === undefined);
  await done();

  await click('[data-finish="off"]');
  await until(() => saved().announce === 'off');
  await openRoom('finish');
  for (const id of ['wakeToSay', 'wakeReady']) check((await rowDim(id)) === true, `${id} fades`, await hintOf(id));
  await shot('finish-off');
  await done();
  await click('[data-finish="speak"]');
  await until(() => saved().announce === undefined);

  await openRoom('presence');
  await clickRowControl('throwIt');
  await until(() => saved().avatarThrow === false);
  check((await until(() => rowDim('wheee'))) === true, 'Wheee fades with Throw off', await hintOf('wheee'));
  await clickRowControl('throwIt');
  await clickRowControl('noAvatar');
  await until(() => saved().avatar === 'none');
  check(getSetting('avatar') === 'none', 'Avatar None is reachable and takes effect');
  for (const id of ['size', 'clickTalk', 'throwIt', 'wheee']) check((await until(() => rowDim(id))) === true, `${id} fades with no avatar`, await hintOf(id));
  await shot('presence-no-avatar');
  await click('[data-row="avatar"] .sseg button:nth-child(2)');
  await until(() => saved().avatar === 'buddy' || getSetting('avatar') === 'buddy');
  check(getSetting('avatar') === 'buddy', 'Pixel buddy takes');
  await wait(300);
  check((await js(`${q('.qbuddy')}.hidden`)) === false && (await js(`${q('.qmount')}.hidden`)) === true, 'the strip shows the buddy');
  await shot('presence-buddy');
  await click('[data-row="avatar"] .sseg button:nth-child(1)');
  await until(() => getSetting('avatar') === 'qubit');
  await done();

  noteEvery('what lives in which sheet (Claude)');
  await openRoom('voice');
  check((await js(`[...document.querySelectorAll('.sheet [data-row]')].map((r) => r.dataset.row).join()`)) === 'voice,speed,volume', 'the Voice room is voice, speed and volume', await js(`[...document.querySelectorAll('.sheet [data-row]')].map((r) => r.dataset.row).join()`));
  check((await js(`!!${q('[data-row="voice"] button[aria-label="Preview this voice"]')}`)) === true, 'Preview is there');
  await done();
  await openRoom('engine');
  check((await text('#sheetTitle')) === 'Voice engine', 'the sheet is titled Voice engine', await text('#sheetTitle'));
  const engineHeight = (await rect('.sheet')).h;
  const claudeRows = await js(`[...document.querySelectorAll('.sheet [data-row]')].map((r) => r.dataset.row).join()`);
  check(claudeRows === 'engine,claudeCode,claudePath,speechModels', 'Claude: the engine, then Claude Code, its location and the speech models', claudeRows);
  check((await until(() => js(`/Signed in to Claude Code/.test(${q('[data-row="claudeCode"]')}.textContent)`))) === true, 'it knows Claude Code is signed in', await text('[data-row="claudeCode"]'));
  check((await hintOf('speechModels')) === 'Ready, kept on this PC.', 'and the speech models are ready', await hintOf('speechModels'));
  check(!(await js(`!!${q('[data-row="usage"]')}`)) && !(await js(`!!${q('[data-row="xaiKey"]')}`)), 'no xAI key or Usage on the Claude screen');
  check(!!(await js(`${q('[data-row="engine"] .beta')}`)), 'BETA stays with the engine');
  await shot('engine-claude');
  await done();
  await openRoom('brain');
  const brainRows = await js(`[...document.querySelectorAll('.sheet [data-row]')].map((r) => r.dataset.row).join()`);
  check(brainRows.includes('connection,brainTest') && !brainRows.includes('claudePath') && !brainRows.includes('claudeCode'), 'Brain keeps the connection and its test, and nothing of Claude Code itself', brainRows);
  await done();

  noteEvery('Claude Code missing, and signed out');
  const setClaudePath = (p) => js(`fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ brainClaudePath: p }))} }).then((r) => r.ok)`);
  await setClaudePath('');
  await until(() => getSetting('brainClaudePath') === '');
  await openRoom('engine');
  await until(() => js(`/Claude Code isn't on this PC yet/.test(${q('[data-row="claudeCode"]')}?.textContent || '')`));
  check(/irm https:\/\/claude\.ai\/install\.ps1/.test(await text('[data-row="claudeCode"]')), 'Claude Code missing: the install help is here', (await text('[data-row="claudeCode"]')).slice(0, 120));
  check(/Check again/.test(await text('[data-row="claudeCode"]')) && /Setup guide/.test(await text('[data-row="claudeCode"]')), 'with Check again and the setup guide');
  await js(`[...document.querySelectorAll('[data-row="claudeCode"] button')].find((b) => b.textContent === 'Check again').click()`);
  await until(() => js(`/Still not found/.test(${q('[data-row="claudeCode"]')}.textContent)`));
  check(/Still not found/.test(await text('[data-row="claudeCode"]')), 'Check again looks again, honestly');
  await shot('engine-claude-missing');
  await done();
  await openRoom('brain');
  await until(() => js(`/Set up in Voice engine/.test(${q('[data-row="connection"]')}.textContent)`));
  check(/Claude Code not found/.test(await text('[data-row="connection"]')), 'Brain says so too', await text('[data-row="connection"]'));
  await shot('brain-claude-missing');
  await js(`[...document.querySelectorAll('[data-row="connection"] button')].find((b) => /Set up/.test(b.textContent)).click()`);
  await wait(320);
  check((await js(`window.__settings.room`)) === 'engine' && (await text('#sheetTitle')) === 'Voice engine', 'Set up in Voice engine lands there');
  await done();
  await setClaudePath(FAKE_CLAUDE);
  await until(() => getSetting('brainClaudePath') === FAKE_CLAUDE);
  fs.writeFileSync(path.join(CLAUDE_DIR, 'auth.txt'), 'out');
  await wait(5200); // (the bridge re-checks the sign-in at most every 5 s)
  await openRoom('engine');
  await until(() => js(`[...document.querySelectorAll('[data-row="claudeCode"] button')].some((b) => b.textContent === 'Sign in')`));
  check(/isn't signed in/.test(await text('[data-row="claudeCode"]')), 'signed out: Sign in is here', await text('[data-row="claudeCode"]'));
  await shot('engine-claude-signed-out');
  await done();
  fs.writeFileSync(path.join(CLAUDE_DIR, 'auth.txt'), 'in');
  await wait(5200);

  noteEvery('Grok: caption only');
  await js(`window.__spy.lines = []; window.__spy.grok = 0;`);
  await click('[data-tile="engine"]');
  await wait(560);
  await click('[data-row="engine"] .sseg button:nth-child(2)');
  await until(() => getSetting('voiceEngine') === 'grok');
  await wait(300);
  check((await rect('.sheet')).h === engineHeight, 'the Voice engine sheet keeps its height on both engines', (await rect('.sheet')).h);
  check((await js(`${q('.oset')}.classList.contains('band')`)) === true, 'and Qubit stays in the band');
  const grokRows = await js(`[...document.querySelectorAll('.sheet [data-row]')].map((r) => r.dataset.row).join()`);
  check(grokRows === 'engine,xaiKey,usage,rate', 'Grok: the engine, the xAI key, Usage and the price', grokRows);
  await shot('engine-grok');
  await done();
  check(saved().voiceEngine === 'grok', 'Grok saves');
  await wait(500);
  check(/I cost/.test(await say()), 'he gives the caption', await say());
  await openRoom('listening');
  await click('[data-row="wake"] .sw');
  await wait(400);
  await click('[data-row="wake"] .sw');
  await wait(400);
  await done();
  check((await js(`window.__spy.lines.length`)) === 0, 'and on Grok, no speech at all', JSON.stringify(await js(`window.__spy.lines`)));
  check((await js(`window.__spy.grok`)) === 0, 'and nothing goes to xAI');
  await openRoom('voice');
  await shot('voice-grok');
  check(!(await js(`!!${q('[data-row="usage"]')}`)) && !(await js(`!!${q('input[aria-label="xAI API key"]')}`)), 'neither the key nor Usage is in the Voice room any more');
  await done();
  await setClaudePath('');
  await until(() => getSetting('brainClaudePath') === '');
  await openRoom('engine');
  await until(() => js(`!!${q('[data-row="claudeCode"]')}`));
  check(/Second brain uses it/.test(await hintOf('claudeCode')), 'on Grok, the Claude Code help shows when Second brain needs it', await hintOf('claudeCode'));
  await shot('engine-grok-brain-needs-claude');
  await done();
  await setClaudePath(FAKE_CLAUDE);
  await until(() => getSetting('brainClaudePath') === FAKE_CLAUDE);
  await openRoom('engine');
  await wait(400);
  check(!(await js(`!!${q('[data-row="claudeCode"]')}`)), 'and not when it does not');
  await done();
  await openRoom('brain');
  for (const id of ['voiceModel', 'effort', 'stt']) check((await rowDim(id)) === true, `${id} fades on Grok`, await hintOf(id));
  await shot('brain-grok');
  await done();

  noteEvery('the needs-a-key path');
  await click('button[aria-label="Settings"]');
  await until(() => js(`!!document.querySelector('button[aria-label="Start talking"]')`));
  await wait(300);
  await click('button[aria-label="Start talking"]');
  await until(() => js(`document.body.innerText.includes('needs an xAI key')`));
  await shot('main-needs-key');
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Open Settings').click()`);
  await until(() => js(`window.__settings?.room === 'engine'`));
  await wait(620);
  check((await js(`window.__settings?.room`)) === 'engine', 'Open Settings lands in the Voice engine sheet', await js(`window.__settings?.room`));
  check((await js(`document.activeElement?.getAttribute('aria-label')`)) === 'xAI API key', 'with the key field focused', await js(`document.activeElement?.getAttribute('aria-label')`));
  await shot('voice-needs-key');

  noteEvery('during a call: the live dot, and captions only');
  page.webContents.insertText('xai-fake-settings-e2e-key-0123456789');
  await wait(120);
  await js(`${q('form button')}.click()`);
  await until(() => js(`!!${q('input[aria-label="xAI API key"]')} === false`));
  await done();
  check((await js(`${q('.live')}.hidden`)) === true, 'no live dot with no call', 'Orbit is off');
  await click('button[aria-label="Settings"]');
  await until(() => js(`!!document.querySelector('button[aria-label="Start talking"]')`));
  await click('button[aria-label="Start talking"]');
  await until(() => js(`document.body.innerText.includes('Listening')`), 15000);
  check(/Listening/.test(await js(`document.body.innerText`)), 'a call starts');
  await click('button[aria-label="Settings"]');
  await until(() => js(`!!${q('.oset .tile')}`));
  await wait(300);
  check((await js(`${q('.live')}.hidden`)) === false, 'the Listening tile has its live dot while Orbit listens');
  const dot = await rect('.live');
  const listenCard = await rect('[data-tile="listen"]');
  check(listenCard.r - dot.r < 16 && dot.y - listenCard.y < 16, 'in the corner the arrow left', JSON.stringify({ right: listenCard.r - dot.r, top: dot.y - listenCard.y }));
  await shot('home-live-dot');
  await js(`window.__spy.lines = []; window.__spy.audio = 0;`);
  await click('[data-tile="engine"]');
  await wait(560);
  await click('[data-row="engine"] .sseg button:nth-child(1)');
  await until(() => getSetting('voiceEngine') === 'claude');
  await done();
  check((await js(`window.__spy.lines.length`)) === 0, 'choosing an engine stays silent during a call');
  await click('[data-finish="chime"]');
  await wait(300);
  await click('[data-finish="speak"]');
  await wait(500);
  check((await say()) === 'Claude finished billing. Tests pass.', 'he still gives the caption during a call', await say());
  check((await js(`window.__spy.lines.length`)) === 0, 'and says nothing over it', JSON.stringify(await js(`window.__spy.lines`)));
  await click('button[aria-label="Settings"]');
  await until(() => js(`!![...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Go to sleep'))`));
  await js(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Go to sleep')).click()`);
  await until(() => js(`!!document.querySelector('button[aria-label="Start talking"]')`), 15000);
  await click('button[aria-label="Settings"]');
  await until(() => js(`!!${q('.oset .tile')}`));
  await wait(300);

  noteEvery('the voice Preview');
  await openRoom('voice');
  await js(`window.__spy.lines = []; window.__spy.audio = 0;`);
  await clickRowControl('voice');
  await until(() => js(`window.__spy.audio > 0`), 20000);
  check((await js(`window.__spy.lines`)).includes('(sample)'), 'the voice Preview button plays a real sample');
  await wait(400);
  await click('[data-row="voice"] .ctl button:nth-child(2)');
  await wait(300);
  await shot('voice-picker');
  await click('.pop button:nth-child(3)');
  await until(() => getSetting('claudeVoice') === 2);
  check(saved().claudeVoice === 2, 'a voice from the list saves');
  await done();

  noteEvery('the wake hotkey');
  await openRoom('listening');
  await click('[data-hotkey-recorder]');
  await wait(120);
  key('K', ['control', 'alt']);
  await until(() => saved().wakeHotkey === 'Control+Alt+K');
  check(saved().wakeHotkey === 'Control+Alt+K', 'recording a hotkey saves', saved().wakeHotkey);
  check(hotkeys.has('Control+Alt+K') && !hotkeys.has('Control+Alt+Shift+G'), 'and registers it', [...hotkeys.keys()]);
  await js(`[...document.querySelectorAll('.linkish')].find((b) => /Reset to/.test(b.textContent)).click()`);
  await until(() => saved().wakeHotkey === 'Control+Alt+Shift+G');
  check(saved().wakeHotkey === 'Control+Alt+Shift+G', "Reset goes back to the test build's own hotkey");
  await done();

  noteEvery('app room');
  await openRoom('app');
  check(/Off in this test build/.test(await hintOf('updates')), 'updates say they are off here', await hintOf('updates'));
  check((await rowDim('autoUpdate')) === true, 'Update automatically fades');
  check(!!(await js(`${q('[data-row="login"]')}`)), 'Start with Windows is reachable');
  await click('[data-row="about"] .ctl button');
  await wait(200);
  await shot('app-about');
  check(/Orbit Test/.test(await hintOf('about')), 'About names this build', await hintOf('about'));
  await done();

  noteEvery('reduced motion');
  await page.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.webContents.capturePage();
  await wait(400);
  check((await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`)) === true, 'the page sees reduced motion');
  check((await js(`window.QubitEngine.MODES.idle.breathe`)) == null, 'no breathing', await js(`window.QubitEngine.MODES.idle.breathe`));
  await openRoom('reach');
  await openRoomFromSheet('listening');
  await click('[data-row="wake"] .sw');
  await wait(150);
  check((await js(`window.__settings.strip.mood`)) === 'listening', 'colour and mood still change', await js(`window.__settings.strip.mood`));
  await shot('reduced-motion');
  await click('[data-row="wake"] .sw');
  await done();
  await page.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });
  await page.webContents.capturePage(); // (a media change lands with a frame, and this window paints on demand)
  check(await until(() => js(`window.QubitEngine.MODES.idle.breathe != null`), 3000), 'and it comes back');
  page.webContents.debugger.detach();

  noteEvery('Qubit stays planted while thinking');
  await openRoom('brain');
  await click('[data-row="brain"] .sw');
  await wait(100);
  await click('[data-row="brain"] .sw');
  await wait(40);
  const hover = await js(`new Promise((ok) => {
    const s = window.__settings.strip.q;
    let top = 0, n = 0;
    const t = setInterval(() => { top = Math.max(top, Math.abs(s.sp.hover.v)); if (++n > 60) { clearInterval(t); ok({ top, mode: s.mode }); } }, 20);
  })`);
  check(hover.top === 0, 'no hover at all in thinking', JSON.stringify(hover));
  await shot('thinking-planted');
  await done();

  noteEvery('the home, all of it, and other window sizes');
  await js(`${q('.oset .screen')}.scrollTop = 9999`);
  await shot('home-end');
  const strip = await rect('.qlive');
  check(strip.y === (await rect('.oset')).y, 'the strip stays pinned while the grid scrolls under it', strip.y);
  check(!!(await js(`${q('.sysrow')}`)) && /Updates off/.test(await text('.sysrow')), 'the App line is there', await text('.sysrow'));
  await js(`${q('.oset .screen')}.scrollTop = 0`);
  const size = page.getContentSize();
  page.setMinimumSize(320, 480);
  for (const [w, h] of [[320, 480], [360, 820]]) {
    page.setContentSize(w, h);
    await wait(250);
    await shot(`size-${w}x${h}-home`);
    await openRoom('brain');
    const sheet = await rect('.sheet');
    await shot(`size-${w}x${h}-brain`);
    const room = await js(`(() => { const s = window.__settings.strip.q; const ctm = s.svg.getScreenCTM().inverse().multiply(s.body.getScreenCTM()); const bottom = Math.max(...[[-50,50],[50,50]].map(([x,y]) => new DOMPoint(x,y).matrixTransform(ctm).y)); const sv = s.svg.getBoundingClientRect(); return sv.top + bottom * (sv.height / s.svg.viewBox.baseVal.height); })()`);
    check(Math.abs(room - sheet.y) < 2.5, `${w} by ${h}: he still stands on the sheet`, `feet ${room.toFixed(1)}, edge ${sheet.y}`);
    await roomLayout(`${w} by ${h}`);
    await done();
    await openRoom('app');
    const half = await rect('.sheet');
    check(Math.abs(half.h - 290) < 1, `${w} by ${h}: a half sheet is still 290`, half.h);
    await done();
    const sideways = await js(`(() => { const s = ${q('.oset .screen')}; return s.scrollWidth - s.clientWidth; })()`);
    check(sideways <= 0, `${w} by ${h}: the home fits`, sideways);
  }
  page.setContentSize(...size);
  await wait(200);

  noteEvery('no orb: Orbit minimizes to the taskbar and stays reachable, avatar or not');
  const orbWindows = () => BrowserWindow.getAllWindows().filter((w) => / orb$/i.test(w.getTitle()) || /#orb$|view=orb/.test(w.webContents.getURL()));
  check(orbWindows().length === 0, 'no orb window exists');
  await openRoom('presence');
  const presenceRows = await js(`[...document.querySelectorAll('.sheet [data-row]')].map((r) => r.dataset.row).join()`);
  check(presenceRows === 'avatar,noAvatar,size,clickTalk,throwIt,wheee', 'Presence has no orb, stick or pulse rows', presenceRows);
  check(!/\borb\b/i.test(await js(`document.querySelector('.sheet').textContent`)), 'and no word of the orb', await hintOf('noAvatar'));
  await done();
  check(!/\borb\b/i.test(await js(`document.body.textContent`)), 'nor anywhere on the home');
  const minimizeBack = async (how, back) => {
    await click('button[aria-label="Minimize"]');
    check(await until(() => page.isMinimized(), 3000), `${how}: minimizing puts it on the taskbar`);
    check(orbWindows().length === 0 && !BrowserWindow.getAllWindows().some((w) => w !== page && w.isVisible() && !/^Orbit (Qubit|buddy|mouse)/.test(w.getTitle())), `${how}: and nothing opens in its place`, BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.getTitle()).join());
    back();
    check(await until(() => !page.isMinimized() && page.isVisible(), 3000), `${how}: the way back opens it`);
  };
  check(trayMenu?.items[0].label === 'Open Orbit Test' && !trayMenu.items.some((i) => /\borb\b/i.test(i.label || '')), 'the tray menu opens Orbit Test', trayMenu?.items.map((i) => i.label).join(' | '));
  await minimizeBack('with Qubit', () => trayIcon.emit('click'));
  await minimizeBack('with Qubit, the tray menu', () => trayMenu.items[0].click());
  await minimizeBack('with Qubit, the taskbar', () => page.restore());
  await openRoom('presence');
  await clickRowControl('noAvatar');
  await until(() => getSetting('avatar') === 'none');
  await done();
  await minimizeBack('with no avatar', () => trayIcon.emit('click'));
  await minimizeBack('with no avatar, the taskbar', () => page.restore());
  await openRoom('presence');
  await clickRowControl('noAvatar');
  await until(() => getSetting('avatar') === 'qubit');
  await done();

  noteEvery('leaving');
  await click('button[aria-label="Settings"]');
  await until(() => js(`!!document.querySelector('button[aria-label="Start talking"]')`));
  await wait(400);
  await shot('main');
  const hero = await js(`(() => { const h = window.__hero; if (!h) return null; h.q.setMode('thinking', { instant: true }); return true; })()`);
  await wait(1200);
  check(hero === true && (await js(`window.__hero.q.sp.hover.v`)) === 0, 'the main-window Qubit stays on his floor too');
  await js(`window.__hero.q.setMode('idle'); 0`);
  check((await js(`window.QubitEngine.MODES.idle.breathe`)) != null, 'the shared engine is left as it was found');

  noteEvery('real profile');
  check(JSON.stringify(fs.readdirSync(REAL).sort().map((f) => [f, fs.statSync(path.join(REAL, f)).mtimeMs])) === realBefore, 'the pretend real Orbit folder is untouched');
  check(!scriptErrors.length, 'no script errors on any page', scriptErrors.slice(0, 5).join(' | '));
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await run();
  } catch (e) {
    check(false, `harness: ${e?.stack || e}`);
  }
  const bad = results.filter(([ok]) => !ok);
  console.log(`\nRESULT ${bad.length ? 'FAIL' : 'PASS'}: ${results.length - bad.length}/${results.length} checks, pictures in ${OUT}`);
  for (const [, what] of bad) console.log(`  FAILED: ${what}`);
  code = bad.length ? 1 : 0;
  setTimeout(() => app.exit(code), 400);
});
