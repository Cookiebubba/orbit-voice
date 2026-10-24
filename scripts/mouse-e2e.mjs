// End-to-end test of Orbit's mouse (a second, visual cursor of Orbit's own) on our own test windows
// only: the WinForms and WPF test app (test/e2e/FakeApp.cs) and the Discord-like Slate app
// (test/e2e/slate-input), never another app. The real overlay (electron/orbit-mouse.js, the built
// page public/mouse.html), the real UI Automation and focus helpers, Orbit's own voice tools.
//
//   npm --prefix ui run build          (once: the page it draws with)
//   npm run e2e:mouse
//
// Checks: point_at puts the drawn tip on the control (measured against where the app itself says the
// control is) and rests there, never clicks; acts lead with it (and how long that adds); it never
// activates and never takes clicks (Windows' own hit test goes through it to the window under it;
// with nobody using the PC, or ORBIT_TEST_FOCUS=1, a real click through it lands in the test app);
// a covered window gets no cursor; an app under Orbit is placed through the pipe; how much CPU it
// takes. A throwaway settings folder; the bridge isn't started (a tiny local server serves the page).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, screen } from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mouse-e2e-'));
app.setPath('userData', path.join(tmp, 'userdata'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const out = (line) => console.log(line);
const check = (ok, what, detail) => {
  if (ok) out(`  ok   ${what}${detail ? ` (${detail})` : ''}`);
  else {
    failures.push(what);
    out(`  FAIL ${what}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`);
  }
};
const report = [];
const note = (line) => (report.push(line), out(`  ..   ${line}`));
process.on('unhandledRejection', (e) => check(false, 'unhandled rejection', e?.stack || e));

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ps = (script) => String(execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })).trim();
const exStyle = (hwnd) => Number(ps(`Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);'; [W.U]::GetWindowLongPtr([IntPtr]${hwnd}, -20).ToInt64()`));
/** A real left click at a screen point (the user's cursor goes back where it was). */
const realClick = (x, y) =>
  ps(`Add-Type -Namespace W -Name M -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point p); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);' -ReferencedAssemblies System.Drawing; $p = New-Object System.Drawing.Point; [void][W.M]::GetCursorPos([ref]$p); [void][W.M]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}); Start-Sleep -Milliseconds 60; [W.M]::mouse_event(2,0,0,0,[IntPtr]::Zero); [W.M]::mouse_event(4,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 60; [void][W.M]::SetCursorPos($p.X, $p.Y)`);

const hwndOf = (win) => {
  const b = win.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
};

// ---------- a tiny server for the built page (the bridge isn't needed) ----------
const PUB = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(PUB, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(PUB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

app.whenReady().then(() => run().catch((e) => check(false, 'HARNESS ERROR', e?.stack || e)).finally(finish));
app.on('window-all-closed', () => {});

let cleanup = [];
async function run() {
  if (process.platform !== 'win32') throw new Error('Windows only');
  if (!fs.existsSync(path.join(PUB, 'mouse.html'))) throw new Error('public/mouse.html is missing: npm --prefix ui run build');
  const { lockDesktop } = await imp('test/e2e/desktop-lock.mjs');
  await lockDesktop();
  const { initConfig, updateSettings } = await imp('src/config.js');
  initConfig({ dir: path.join(tmp, 'config') });
  updateSettings({ anywhere: true, anywhereMouse: true, anywhereMouseLeadMs: 220 });
  const { focus, startFocusTracking, startUia, stopUia, uiaRequest, listWindows } = await imp('src/platform/index.js');
  const { lastLead, setMouseSink } = await imp('src/anywhere/mouse.js');
  const { createOrbitMouse } = await imp('electron/orbit-mouse.js');
  const { createToolRunner } = await imp('src/tools.js');
  const { startFakeApp, userIdleMs } = await imp('test/e2e/fake-app.mjs');
  const { setKeeperLauncher, startUnderKeeper } = await imp('src/anywhere/keeper.js');
  const { SLATE_MAIN } = await imp('test/e2e/slate-input.mjs');

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PAGE = `http://127.0.0.1:${server.address().port}/mouse.html`;
  let focusEvents = 0;
  const made = [];
  const mouse = createOrbitMouse({
    url: () => PAGE,
    webPreferences: { preload: path.join(ROOT, 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    lockDown: (w) => {
      made.push(w);
      w.on('focus', () => focusEvents++);
    },
  });
  setMouseSink(mouse);
  cleanup.push(() => mouse.stop());
  startUia({ cacheDir: path.join(tmp, 'cache') });
  cleanup.push(() => stopUia());
  const tracker = startFocusTracking();
  cleanup.push(() => tracker?.stop());

  const said = [];
  const latest = () => said.at(-1) || null;
  const runner = createToolRunner({ notify: () => {}, recentUtterance: latest, utteranceSince: async (ts) => (latest() && latest().at > ts ? latest() : null), userWords: () => said.map((u) => u.text).join(' ') });
  const say = async (text) => (await wait(5), said.push({ text, at: Date.now() }));
  const tool = (name, args) => runner.run(name, JSON.stringify(args));

  /** Where the page draws the tip, in physical screen pixels (and its window). */
  const drawn = async () => {
    for (const pg of mouse.debug().pages) {
      if (!pg.shown || pg.win.isDestroyed()) continue;
      const s = await pg.win.webContents.executeJavaScript('(() => { const m = window.__mouse; return m && { pos: m.pos, opacity: m.opacity, drawn: m.drawn, presses: m.presses, frames: m.frames, running: m.running, fill: m.fill, mode: m.mode }; })()', true).catch(() => null);
      if (!s?.pos) continue;
      const b = pg.win.getBounds();
      const p = screen.dipToScreenPoint({ x: b.x + s.pos.x, y: b.y + s.pos.y });
      if (pg.area && (p.x < pg.area.x || p.x >= pg.area.x + pg.area.w || p.y < pg.area.y || p.y >= pg.area.y + pg.area.h)) continue;
      return { ...s, x: p.x, y: p.y, win: pg.win, id: pg.id };
    }
    return null;
  };
  /** The drawn cursor once it has arrived (the glide done, fully shown), or null after 2.5 s. */
  const arrived = async () => {
    for (let i = 0; i < 25; i++) {
      const d = await drawn();
      if (d && d.opacity === 1 && !d.running) return d;
      await wait(100);
    }
    return drawn();
  };
  const centerOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const off = (a, b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 10) / 10;

  // ---------- 1. The WinForms test app: point_at ----------
  out('1. "Show me where Save is": the cursor glides there and rests on it, never clicks');
  const title = `ORBIT-MOUSE-FORMS-${process.pid}`;
  const forms = await startFakeApp('winforms', title, { onscreen: true });
  cleanup.push(() => forms.close());
  await forms.send({ topmost: true }); // (our test window in front, so it isn't covered by whatever is open)
  for (let i = 0; i < 40 && !focus.current; i++) await wait(50);
  await say(`in ${title} show me where the save button is`);
  const t0 = Date.now();
  let r = await tool('point_at', { window: title, control: 'Save' });
  const pointMs = Date.now() - t0;
  check(r.pointed === true, 'point_at pointed', JSON.stringify(r));
  note(`point_at answered in ${pointMs} ms (scan, place, hit test), then the glide plays`);
  const truth = await forms.rectOf('Save');
  let d = await arrived();
  check(!!d, 'the overlay draws the cursor');
  const err1 = d && off(d, centerOf(truth));
  check(d && err1 <= 3, 'the tip is on Save (the app\x27s own place for it) within 3 px', `${err1} px off; Save ${JSON.stringify(truth)}`);
  note(`WinForms accuracy: ${err1} px from the middle of Save`);
  check(d?.opacity === 1, 'fully shown');
  check(/^oklch\([\d.]+ [\d.]+ [\d.]+\)$/.test(String(d?.fill)), 'one solid, fully opaque OKLCH fill', d?.fill);
  const tags = (d?.drawn || []).map(([t]) => t).join(' ');
  check(tags === 'svg g g path' && !(d?.drawn || []).some(([, a]) => Object.keys(a).some((k) => /stroke|filter|paint-order/.test(k))), 'only the arrow is drawn: no stroke, outline or ring', tags);
  check(d?.presses === 0, 'pointing never presses');
  check(!forms.events.some((e) => e.event === 'click'), 'nothing was clicked');

  out('2. It never activates and never takes clicks');
  const ov = d.win;
  const ex = exStyle(hwndOf(ov));
  const has = (bit) => (ex & bit) === bit;
  check(has(0x08000000) && has(0x20) && has(0x80000) && has(0x8), 'the overlay is no-activate, transparent to the mouse, layered and topmost', `exstyle 0x${ex.toString(16)}`);
  const c = centerOf(truth);
  const hit = await uiaRequest('hit', { hwnd: forms.hwnd, points: [[Math.round(c.x), Math.round(c.y)]] });
  check(hit?.ok && hit.hits[0].on === true && hit.hits[0].pid !== process.pid, "Windows' hit test at the cursor goes through it to the test app", JSON.stringify(hit));
  check(!ov.isFocused() && focusEvents === 0, 'never focused');
  check(focus.current?.hwnd !== hwndOf(ov), 'never the foreground window');
  const idle = process.env.ORBIT_TEST_FOCUS === '1' || userIdleMs() > 60_000;
  if (idle) {
    await say(`in ${title} where is save`);
    await tool('point_at', { window: title, control: 'Save' });
    await wait(700);
    realClick(c.x, c.y);
    const got = await forms.waitFor((e) => e.event === 'click' && e.name === 'Save', 3000);
    check(!!got, 'a real click on the cursor lands on Save in the test app under it');
    check(focusEvents === 0 && !ov.isFocused(), 'and the overlay still never took focus');
  } else out('  skip a real click through it (someone is using this PC; ORBIT_TEST_FOCUS=1 runs it)');

  out('3. Acts: the cursor glides to the control and presses first');
  const presses0 = (await drawn())?.presses ?? 0;
  await say(`in ${title} type hello there into the message box`);
  const ta = Date.now();
  r = await tool('act_in_window', { window: title, control: 'Message', action: 'set_text', text: 'hello there' });
  const withMouse = Date.now() - ta;
  check(r.done === true, 'typed', JSON.stringify(r));
  await wait(150);
  d = await drawn();
  const truthMsg = await forms.rectOf('Message');
  const err2 = d && off(d, centerOf(truthMsg));
  check(d && err2 <= 3, 'the cursor is on the Message box', `${err2} px off; lead ${JSON.stringify(lastLead())}`);
  check(d && d.presses > presses0, 'and it pressed there');
  check((await forms.state()).Message === 'hello there', 'the text went in (through UI Automation, not the mouse)');
  await say(`in ${title} tick agree`);
  r = await tool('act_in_window', { window: title, control: 'Agree', action: 'toggle' });
  check(r.done === true, 'ticked', JSON.stringify(r));
  await wait(150);
  d = await drawn();
  check(d && off(d, centerOf(await forms.rectOf('Agree'))) <= 3, 'the cursor moved on to Agree');
  // How long the lead-in adds: the same act with the mouse off.
  updateSettings({ anywhereMouse: false });
  await say(`in ${title} type hello there into the message box`);
  const tb = Date.now();
  await tool('act_in_window', { window: title, control: 'Message', action: 'set_text', text: 'hello there' });
  const withoutMouse = Date.now() - tb;
  updateSettings({ anywhereMouse: true });
  note(`an act took ${withMouse} ms with Orbit's mouse, ${withoutMouse} ms without (lead-in 220 ms)`);
  check(withMouse - withoutMouse < 450, 'the lead-in adds about the lead time, no more', `${withMouse - withoutMouse} ms`);
  check(!forms.events.some((e) => e.event === 'activated') || idle, 'the test app never activated (but by the real click)');

  out('4. Idle: it fades and hides');
  await wait(2200);
  check(mouse.debug().pages.every((p) => !p.shown), 'all overlay windows hidden after the last act', JSON.stringify(mouse.debug().pages.map((p) => p.shown)));

  out('5. WPF, and a covered window gets no cursor');
  const wtitle = `ORBIT-MOUSE-WPF-${process.pid}`;
  const wpf = await startFakeApp('wpf', wtitle, { onscreen: true });
  cleanup.push(() => wpf.close());
  await wait(500);
  await say(`in ${wtitle} where is save`);
  r = await tool('point_at', { window: wtitle, control: 'Save' });
  check(r.pointed === false && /front of it/.test(r.why), 'covered by the WinForms window: not shown, said why', JSON.stringify(r));
  await forms.send({ topmost: false });
  await wpf.send({ topmost: true });
  await wait(300);
  await say(`in ${wtitle} where is save`);
  r = await tool('point_at', { window: wtitle, control: 'Save' });
  check(r.pointed === true, 'in front now: pointed', JSON.stringify(r));
  d = await arrived();
  const wtruth = await wpf.rectOf('Save');
  const err3 = d && off(d, centerOf(wtruth));
  check(d && err3 <= 3, 'the tip is on the WPF Save within 3 px', `${err3} px off`);
  note(`WPF accuracy: ${err3} px from the middle of Save`);
  await wpf.send({ minimize: true });
  await wait(400);
  await say(`in ${wtitle} where is save`);
  r = await tool('point_at', { window: wtitle, control: 'Save' });
  check(r.pointed === false && /minimized/.test(r.why), 'minimized: not shown', JSON.stringify(r));

  out('6. CPU');
  const cpuOf = async (ms, during = null) => {
    const pids = () => new Set(mouse.debug().pages.map((p) => (p.win.isDestroyed() ? 0 : p.win.webContents.getOSProcessId())));
    const before = new Map(app.getAppMetrics().map((x) => [x.pid, x.cpu.cumulativeCPUUsage ?? 0]));
    let stop = false;
    const job = during ? (async () => { while (!stop) await during(); })() : null;
    await wait(ms);
    stop = true;
    await job;
    const m = app.getAppMetrics();
    const mine = pids();
    // CPU seconds used in the window, as a share of one core.
    const used = (pred) => m.filter(pred).reduce((a, x) => a + (x.cpu.cumulativeCPUUsage ?? 0) - (before.get(x.pid) ?? x.cpu.cumulativeCPUUsage ?? 0), 0) / (ms / 1000) * 100;
    const renderer = used((x) => mine.has(x.pid));
    const gpu = used((x) => x.type === 'GPU');
    const browser = used((x) => x.type === 'Browser');
    return { renderer: Math.round(renderer * 10) / 10, gpu: Math.round(gpu * 10) / 10, main: Math.round(browser * 10) / 10 };
  };
  app.getAppMetrics(); // (the first reading has nothing to compare with)
  await wait(2500);
  const idleCpu = await cpuOf(3000);
  note(`hidden: overlay page ${idleCpu.renderer}%, GPU ${idleCpu.gpu}%, main ${idleCpu.main}% (of one core)`);
  check(idleCpu.renderer < 1, 'hidden, its page does nothing', `${idleCpu.renderer}%`);
  await wpf.send({ restore: true });
  await wait(400);
  await say(`in ${wtitle} where is save`);
  await tool('point_at', { window: wtitle, control: 'Save' });
  await wait(1200);
  const still = await cpuOf(2000);
  note(`shown, still (resting on the control): page ${still.renderer}%, GPU ${still.gpu}%`);
  const framesNow = async () => (await drawn())?.frames ?? NaN;
  let flip = 0;
  let f0 = await framesNow();
  const glides = await cpuOf(3000, async () => {
    const tr = await wpf.rectOf(flip++ % 2 ? 'Save' : 'Message');
    mouse.glide({ x: tr.x + tr.w / 2, y: tr.y + tr.h / 2, ms: 300, holdMs: 6000 });
    await wait(320);
  });
  const glideFps = Math.round(((await framesNow()) - f0) / 3);
  note(`gliding back and forth: page ${glides.renderer}%, GPU ${glides.gpu}%, main ${glides.main}% (${glideFps} frames a second)`);
  let k = 0;
  const seenOpacity = [];
  f0 = await framesNow();
  const speaking = await cpuOf(3000, async () => {
    mouse.onVoice({ phase: 'speaking', output: 0.5 + 0.5 * Math.sin(k++ / 2) });
    if (k % 8 === 0) seenOpacity.push((await drawn())?.opacity);
    await wait(50);
  });
  check(seenOpacity.length > 3 && seenOpacity.every((o) => o === 1), 'no flicker: fully opaque throughout', JSON.stringify(seenOpacity));
  const pulseFps = Math.round(((await framesNow()) - f0) / 3);
  mouse.onVoice({ phase: 'listening' });
  note(`pulsing with the voice: page ${speaking.renderer}%, GPU ${speaking.gpu}%, main ${speaking.main}% (${pulseFps} frames a second)`);
  check(speaking.renderer < 25 && glides.renderer < 25, 'moving, it stays light');
  check(glideFps <= 62 && pulseFps <= 34, 'at most 60 frames a second gliding, 30 pulsing', `${glideFps}, ${pulseFps}`);
  // Its colour glides back to listening cyan (a couple of seconds, like Qubit's), then nothing moves.
  const sv = await wpf.rectOf('Save');
  mouse.glide({ x: sv.x + sv.w / 2, y: sv.y + sv.h / 2, ms: 300, holdMs: 10_000 });
  await wait(4500);
  const fr0 = await framesNow();
  await wait(1500);
  const fr1 = await framesNow();
  check(fr1 - fr0 <= 2, 'shown but still and not speaking: no frames drawn', `${fr1 - fr0} frames in 1.5 s`);

  out('7. An app under Orbit: placed through the pipe');
  const node = process.env.npm_node_execpath || 'node';
  setKeeperLauncher({ execPath: node, preArgs: [path.join(ROOT, 'src', 'anywhere', 'keeper-node.mjs')] });
  const stitle = `ORBIT-MOUSE-SLATE-${process.pid}`;
  process.env.SLATE_X = '760';
  process.env.SLATE_Y = '140';
  process.env.SLATE_TOP = '1'; // (in front of whatever is open, like the other test windows)
  // (Inside Electron, require('electron') is its API, not its path: this process is Electron itself.)
  const state = await startUnderKeeper({ exe: process.execPath, args: [SLATE_MAIN, stitle, `--user-data-dir=${fs.mkdtempSync(path.join(tmp, 'slate-'))}`], app: 'slate' });
  cleanup.push(() => {
    try {
      process.kill(state.appPid);
    } catch {}
  });
  let swin = null;
  for (let i = 0; i < 60 && !swin; i++) {
    swin = (await listWindows()).find((w) => w.pid === state.appPid && w.title === stitle) || null;
    if (!swin) await wait(250);
  }
  check(!!swin, 'the Slate app is up, under Orbit');
  await wpf.send({ topmost: false });
  await wait(2500); // its page loads
  const sscan = await uiaRequest('scan', { hwnd: swin.hwnd, maxNodes: 4000 });
  const box = sscan?.nodes?.find((n) => n.n === 'Message #general');
  await say(`in ${stitle} where do I type a message`);
  r = await tool('point_at', { window: stitle, control: 'Message #general' });
  check(r.pointed === true, 'point_at pointed in the app under Orbit', JSON.stringify(r));
  d = await arrived();
  if (box?.r) {
    const ub = { x: box.r[0], y: box.r[1], w: box.r[2], h: box.r[3] };
    const err4 = d && off(d, centerOf(ub));
    check(d && err4 <= 4, 'the tip (placed through the pipe) is on the box UI Automation sees, within 4 px', `${err4} px off`);
    note(`Slate under Orbit (pipe): ${err4} px from the middle of the box as UI Automation places it`);
  } else check(false, 'UI Automation found the Slate box', JSON.stringify(sscan).slice(0, 200));
  await say(`in ${stitle} type hello from orbit into the message box`);
  r = await tool('act_in_window', { window: stitle, control: 'Message #general', action: 'set_text', text: 'hello from orbit' });
  check(r.done === true, 'typed through the pipe, the cursor leading', JSON.stringify(r));
  check(focusEvents === 0, 'the overlay never took focus, start to end');
}

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {}
  }
  server.close();
  out('');
  for (const l of report) out(`  ${l}`);
  out(`RESULT ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} failure(s)`);
  setTimeout(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
    app.exit(failures.length ? 1 : 0);
  }, 400);
}
