// Isolated stage acceptance seam, not the voice app. No provider/config/key/microphone modules.
// Default: hidden Electron compositor + in-memory host/native fixtures (not Windows acceptance).
// --host-file PATH --expected-host-pid PID [--visible]: actual authenticated host + native tracker.
// Captures only this process's Qubit WebContents, never the desktop or another window.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, ipcMain, screen, session } from 'electron';
import { createAvatar } from '../electron/avatar.js';
import { createAvatarHost } from '../electron/avatar-host.js';
import { createExternalAvatarBinding } from '../electron/external-avatar.js';
import { createExternalHost, readDescriptor } from '../src/external-host.js';
import { createWinFocusTracker } from '../src/platform/win/focus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opt = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const hostFile = opt('host-file'), visible = process.argv.includes('--visible');
const expectedPid = Number(opt('expected-host-pid'));
if (hostFile && (!Number.isSafeInteger(expectedPid) || expectedPid <= 0)) throw new Error('Supply the isolated bro GUI PID explicitly.');
if (visible && !hostFile) throw new Error('--visible requires an explicitly identified isolated native host.');
const profile = process.env.ORBIT_BRO_PREVIEW_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stage-profile-'));
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stage-captures-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
let revision = 1, suspended = false, stageAdvertised = true;
const fixtureStage = () => ({ schema: 1, instanceId: 'stage-fixture', revision, available: true, frame: { window: { handle: '123', pid: 42, epoch: 'fixture-1' }, viewport: { width: 900, height: 600, scaleFactor: 1, physicalOrigin: { x: -4200, y: 100 } }, suspended, surfaces: [{ id: 'pane-left', kind: 'oneWay', rect: { x: 90, y: 330, w: 260, h: 20 } }, { id: 'pane-upper-bottom', kind: 'oneWay', rect: { x: 90, y: 321, w: 260, h: 1 } }, { id: 'upper-left-wall', kind: 'solid', rect: { x: 90, y: 0, w: 1, h: 321 } }, { id: 'upper-right-wall', kind: 'solid', rect: { x: 349, y: 0, w: 1, h: 321 } }, { id: 'sidebar-rail', kind: 'solid', rect: { x: 70, y: 0, w: 1, h: 600 } }, { id: 'pane-right', kind: 'oneWay', rect: { x: 390, y: 270, w: 370, h: 20 } }], exclusions: [], preferredSurfaceId: 'pane-left' } });
const token = crypto.randomBytes(32).toString('hex');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname.startsWith('/orbit/v1/')) {
    if (hostFile || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    const json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (u.pathname.endsWith('/host')) return json({ protocol: 1, instanceId: 'stage-fixture', mode: 'attached', window: { handle: '123', pid: 42, epoch: 'fixture-1' }, capabilities: ['sessions.read', 'orchestrator.submit', 'requests.observe', 'avatar.attached', ...(stageAdvertised ? ['avatar.stage.v1'] : [])], sessions: [] });
    if (u.pathname.endsWith('/events')) return json({ events: [], cursor: 0, gap: false });
    if (u.pathname.endsWith('/stage')) {
      if (Number(u.searchParams.get('after')) !== revision) return json(fixtureStage());
      const timer = setTimeout(() => json(fixtureStage()), 900);
      res.on('close', () => clearTimeout(timer)); return;
    }
    res.writeHead(404).end(); return;
  }
  const rel = decodeURIComponent(u.pathname === '/' ? '/qubit.html' : u.pathname);
  const root = path.join(ROOT, 'public'), file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let client, tracker, host, binding;
const errors = [];
const captures = [];
let captureFailure = null, selectedSurface = null;
async function run() {
try {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${base}/`) }));
  if (!hostFile) {
    // Stand-in native geometry; never called Windows/DPI/stacking acceptance.
    screen.screenToDipRect = (_win, r) => r;
    screen.getDisplayMatching = () => ({ workArea: { x: -4200, y: 100, width: 900, height: 600 } });
    screen.getCursorScreenPoint = () => ({ x: -4300, y: 0 });
  }
  host = createAvatarHost({
    makeAvatar: (kind) => createAvatar({ kind, boxless: true, url: () => `${base}/${kind}.html`, webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: !visible }, lockDown: (w) => {
      w.webContents.setAudioMuted(true);
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('will-navigate', (e) => e.preventDefault());
      w.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(String(e.message).slice(0, 300)); });
      if (!visible) { w.showInactive = () => {}; w.isVisible = () => true; }
    }, getDesktopInfo: () => { throw new Error('No UI automation in stage harness'); }, prefs: () => ({ clickTalk: false, throw: true, throwSound: false }) }),
    watch: (hwnds) => tracker?.watch?.(hwnds), current: () => null,
  });
  if (hostFile) {
    tracker = createWinFocusTracker({ onWins: (wins) => host.onWins(wins), onGone: (hwnds) => { if (hwnds.includes(Number(client?.snapshot()?.window?.handle))) binding?.clear(); }, onError: (m) => errors.push(m) });
    tracker.start();
  } else tracker = { describe: async () => ({ hwnd: 123, pid: 42, kind: 'app', x: -4208, y: 70, w: 916, h: 638, client: { x: -4200, y: 100, w: 900, h: 600 }, dpi: 96 }) };
  binding = createExternalAvatarBinding({ avatarHost: host, tracker: () => tracker, platform: 'win32' });
  host.setKind('qubit', 2);
  client = createExternalHost({ descriptor: hostFile ? readDescriptor(path.resolve(hostFile)) : { protocol: 1, instanceId: 'stage-fixture', url: base, token }, onSnapshot: (s) => {
    if (hostFile && s && (s.name !== 'bro' || s.window?.pid !== expectedPid)) { errors.push('Supplied host is not the expected isolated GUI PID'); binding.clear(); return; }
    void binding.sync(s, 'attached');
  }, onStage: (s) => binding.stage(s) });
  await client.start();
  let avatar, win;
  for (let i = 0; i < 100; i++) {
    avatar = host.active(); win = avatar?.window;
    if (win && await win.webContents.executeJavaScript('!!window.__qubit?.q && window.__qubit.frame === "client"')) break;
    await wait(100);
  }
  assert.ok(win && await win.webContents.executeJavaScript('!!window.__qubit?.q && window.__qubit.frame === "client"'), 'Qubit client stage never became usable');
  const js = (code) => win.webContents.executeJavaScript(code);
  const sample = () => js('(() => { const Q = window.__qubit, q = Q.q, a=(q.angle+(q.pivot?0:q._tilt()))*Math.PI/180, [hw,hh]=q._halfExtents(), ex=hw*Math.abs(Math.cos(a))+hh*Math.abs(Math.sin(a)), ey=hh*Math.abs(Math.cos(a))+hw*Math.abs(Math.sin(a)), x=q._rx??q.cx, y=q._ry??q.ground-q.cy, foot=y+ey; const support=Q.dir.geometry.solids.find(s=>!q.air&&!q.pivot&&Math.abs(foot-s.y)<3&&x+ex>s.x&&x-ex<s.x+s.w); return { frame: Q.frame, returning: Q.returning, running: Q.running, body: { x, y, foot, ex, ey, airborne:q.air, pivot:!!q.pivot }, supportId:support?.id??null, home:Q.dir.geometry.home, preferredSurfaceId:Q.dir.geometry.preferredSurfaceId, solids:Q.dir.geometry.solids, reaction:Q.dir.reaction }; })()');
  async function settledSupport(id = null) {
    let last = null, stable = 0;
    for (let i = 0; i < 120; i++) {
      const s = await sample();
      if (s.supportId && (!id || s.supportId === id) && last === s.supportId) stable++; else stable = 0;
      last = s.supportId;
      if (stable >= 3) return s;
      await wait(100);
    }
    throw new Error(`Qubit never settled on an advertised surface${id ? ` (${id})` : ''}`);
  }
  async function capture(label) {
    const state = await sample();
    const png = `${String(captures.length).padStart(2, '0')}-${label}.png`;
    fs.writeFileSync(path.join(output, png), (await win.webContents.capturePage()).toPNG());
    captures.push({ label, png, state, native: avatar.debug() });
  }
  captureFailure = () => capture('failure');
  await settledSupport();
  await capture('perched');
  // Drive this process's renderer directly: no OS input or pointer movement, no talk IPC.
  // Choose a real advertised header with body headroom, and drop onto it through the real throw path.
  const chosen = await js('(() => { const Q=window.__qubit, q=Q.q, g=Q.dir.geometry, half=q.side/2; const safe=g.solids.filter(s=>s.w>q.side*2&&s.y>q.side*1.2).map(s=>({...s,perchX:s.id===g.home.surface?g.home.x:s.x+s.w/2})).filter(s=>!g.solids.some(o=>o.id!==s.id&&!o.oneWay&&o.x<s.perchX+half&&o.x+o.w>s.perchX-half&&o.y<s.y&&o.y+o.h>s.y-q.side*1.2)); return safe.find(s=>s.id===g.preferredSurfaceId&&s.id.includes("header")) || safe.find(s=>s.id.includes("header")) || safe.find(s=>s.id===g.preferredSurfaceId) || safe[0]; })()');
  assert.ok(chosen, 'No advertised surface has enough room for a deterministic landing');
  selectedSurface = chosen;
  // Closely stacked one-way ledges are legal. Start the foot below an earlier ledge rather than
  // claiming a drop from above can pass through it; a soft release cannot bounce onto it again.
  await js(`(() => { const Q=window.__qubit, q=Q.q, s=${JSON.stringify(chosen)}, [hw,hh]=q._halfExtents(), a=(q.angle+q._tilt())*Math.PI/180, ey=hh*Math.abs(Math.cos(a))+hw*Math.abs(Math.sin(a)); const above=Q.dir.geometry.solids.filter(o=>o.id!==s.id&&o.oneWay&&o.y<s.y&&o.x<s.perchX+q.side/2&&o.x+o.w>s.perchX-q.side/2); const foot=Math.max(s.y-60,...above.map(o=>o.y+2)); Q.throw.hold({x:s.perchX,y:Math.min(s.y-2,foot)-ey}); Q.dir.grabbed(); })()`);
  await wait(600); await capture('held-above-header');
  await js('window.__qubit.throw.release({x:0,y:100}); window.__qubit.dir.thrown()');
  for (let i = 0; i < 8; i++) { await wait(200); await capture(`flight-${i}`); }
  await settledSupport(chosen.id); await capture('settled');
  assert.equal(captures.at(-1).state.supportId, chosen.id, 'settled body contacts the chosen sanitized real surface');
  assert.equal(captures.at(-1).state.returning, false);
  assert.equal(avatar.debug().lifted, false, 'persistent stage never uses temporary lift');
  assert.equal(captures.at(-1).state.frame, 'client');
  assert.equal(errors.length, 0, errors.join('\n'));
  if (!hostFile) {
    suspended = true; revision++;
    await wait(1200);
    assert.equal(avatar.debug().stage, null);
    await capture('suspended');
    stageAdvertised = false;
    await wait(1200); await capture('old-host-fallback');
    assert.equal(captures.at(-1).state.frame, 'strip', 'withdrawn capability restores old window-only behavior');
    assert.equal(captures.at(-1).state.solids.length, 0, 'no stale client colliders survive fallback');
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`PASS ${captures.length} compositor frames: ${output}`);
} catch (e) {
  errors.push(String(e.message || e));
  try { if (captureFailure) await Promise.race([captureFailure(), wait(2000)]); } catch {}
  console.error(e.stack); console.error(`Failure evidence: ${output}`); process.exitCode = 1;
} finally {
  // Persist observations before stopping the renderer, on failures as well as passes.
  fs.writeFileSync(path.join(output, 'captures.json'), JSON.stringify({ mode: hostFile ? 'supplied-host-native' : 'offscreen-native-fixture', compositorOnly: true, profile, selectedSurface, captures, errors }, null, 2));
  client?.stop(); binding?.clear(); tracker?.stop?.(); host?.stop();
  server.closeAllConnections(); server.close();
  app.exit(process.exitCode || 0);
}
}
// Do not await app.whenReady at ESM top level: Electron must finish loading this entrypoint first.
void run();
