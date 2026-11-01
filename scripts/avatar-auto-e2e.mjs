// Isolated hidden real Qubit renderer. Source modules served directly: no UI build/manifest changes.
// No voice/config/provider/microphone imports, OS input or user-window manipulation.
// Optional --host-file PATH --expected-host-pid PID authenticates only a caller-owned inactive bro.
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
const option = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
if (process.argv.includes('--visible')) throw new Error('This harness is hidden-only.');
const hostFile = option('host-file'), expectedPid = Number(option('expected-host-pid'));
if (hostFile && (!Number.isSafeInteger(expectedPid) || expectedPid <= 0)) throw new Error('Supply the caller-owned isolated bro PID.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-auto-profile-'));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-auto-captures-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, label) => { for (let i = 0; i < 240; i++) { if (await fn()) return; await delay(50); } throw new Error(label); };
const workArea = { x: -1800, y: 40, width: 1200, height: 800 };
let native = { hwnd: 123, pid: 42, kind: 'app', x: -1510, y: 120, w: 620, h: 540, client: { x: -1500, y: 140, w: 600, h: 500 }, dpi: 96 };
let hostRevision = 1, stageAvailable = true, headerY = 300;
const caps = ['sessions.read', 'orchestrator.submit', 'requests.observe', 'avatar.attached', 'avatar.stage.v1', 'avatar.roam.v1'];
const hostSnapshot = () => ({ protocol: 1, instanceId: 'auto-fixture', name: 'bro', mode: 'attached', avatarRoam: { schema: 1, policy: 'auto' }, capabilities: caps, window: { handle: '123', pid: 42, epoch: 'w1' }, sessions: [] });
const stageSnapshot = () => ({ schema: 1, instanceId: 'auto-fixture', revision: hostRevision, available: stageAvailable, frame: stageAvailable ? { window: hostSnapshot().window, viewport: { width: 600, height: 500, scaleFactor: 1, physicalOrigin: { x: native.client.x, y: native.client.y } }, suspended: false, surfaces: [{ id: 'header', kind: 'oneWay', rect: { x: 40, y: headerY, w: 500, h: 12 } }], exclusions: [], preferredSurfaceId: 'header' } : null });
const token = crypto.randomBytes(32).toString('hex');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const json = (v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
  if (u.pathname.startsWith('/orbit/v1/')) {
    if (hostFile || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (u.pathname.endsWith('/host')) return json(hostSnapshot());
    if (u.pathname.endsWith('/events')) return json({ events: [], cursor: 0, gap: false });
    if (u.pathname.endsWith('/stage')) return json(stageSnapshot());
    res.writeHead(404).end(); return;
  }
  if (u.pathname === '/qubit.html') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"><title>Hidden Qubit Automatic acceptance</title></head><body><script type="module" src="/qubit/main.js"></script></body></html>'); return; }
  const root = path.join(ROOT, 'ui', 'src'), file = path.resolve(root, `.${decodeURIComponent(u.pathname)}`);
  if (!file.startsWith(root + path.sep) || !file.endsWith('.js') || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', 'text/javascript'); fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let host, binding, client, tracker, avatar, win, gestureSink = null, activeGestureId = null;
let made = 0, talk = 0, front = 123, failureCapture = null;
const voiceConnection = Object.freeze({ id: crypto.randomUUID(), fake: true });
const errors = [], captures = [], checks = [];
async function run() {
  try {
    await app.whenReady();
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(base + '/') }));
    if (!hostFile) {
      const display = { id: 9876, scaleFactor: 1, workArea, bounds: workArea };
      screen.screenToDipRect = (_w, r) => r; screen.screenToDipPoint = (p) => p;
      screen.getDisplayMatching = () => display; screen.getPrimaryDisplay = () => display; screen.getAllDisplays = () => [display];
      screen.getCursorScreenPoint = () => ({ x: -9999, y: -9999 });
    }
    host = createAvatarHost({ current: () => ({ hwnd: front }), watch: (ids) => tracker?.watch?.(ids), makeAvatar: (kind) => {
      made++;
      return createAvatar({ kind, boxless: true, url: () => `${base}/qubit.html`, prefs: () => ({ clickTalk: true, throw: true, throwSound: false }), getDesktopInfo: () => { throw new Error('UI automation not authorized'); }, watchGesture: (id, cb) => { activeGestureId = id; gestureSink = cb; return () => { if (activeGestureId === id) { activeGestureId = null; gestureSink = null; } }; }, webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false }, lockDown: (w) => {
        w.webContents.setAudioMuted(true); w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        w.webContents.on('will-navigate', (e) => e.preventDefault());
        w.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(String(e.message).slice(0, 300)); });
        w.showInactive = () => {}; w.isVisible = () => true;
      } });
    } });
    if (hostFile) { tracker = createWinFocusTracker({ onWins: (wins) => host.onWins(wins), onFocus: (w) => { front = w.hwnd; host.onFocus(); }, onError: (m) => errors.push(m) }); tracker.start(); }
    else tracker = { describe: async () => native };
    binding = createExternalAvatarBinding({ avatarHost: host, tracker: () => tracker, platform: 'win32' });
    host.setKind('qubit'); host.onVoice({ phase: 'speaking', output: 0.2 });
    const target = (e) => host.guestFor(e.sender);
    ipcMain.on('buddy:hit', (e, r) => target(e)?.hit(r));
    ipcMain.on('buddy:hover', (e, on, held) => target(e)?.hover(on, held));
    ipcMain.on('buddy:gesture', (e, m) => target(e)?.gesture(m));
    ipcMain.on('buddy:talk', () => { talk++; });
    client = createExternalHost({ descriptor: hostFile ? readDescriptor(path.resolve(hostFile)) : { protocol: 1, instanceId: 'auto-fixture', url: base, token }, onSnapshot: (s) => {
      if (hostFile && s && (s.name !== 'bro' || s.window?.pid !== expectedPid)) { errors.push('Descriptor does not identify the supplied isolated bro'); return; }
      void binding.sync(s, 'auto');
    }, onStage: (s) => binding.stage(s) });
    await client.start();
    await waitFor(async () => { avatar = host.active(); win = avatar?.window; return win && win.webContents.executeJavaScript('!!window.__qubit?.q && window.__qubit.frame === "auto"'); }, 'Automatic renderer never started');
    const wc = win.webContents.id;
    const js = (s) => win.webContents.executeJavaScript(s);
    await js('window.__autoIdentity={q:__qubit.q,controller:__qubit.throw,director:__qubit.dir,connection:{fake:true}};void 0');
    const sample = () => js('(()=>{const Q=__qubit,q=Q.q;return {frame:Q.frame,domain:Q.domain,returning:Q.returning,held:Q.throw.held,flying:Q.throw.flying,press:!!Q.press,x:q.cx,y:q.ground-q.cy,air:q.air,revision:Q.state.stage.revision,eligible:Q.state.stage.eligible,solids:Q.dir.geometry.solids,identity:__autoIdentity.q===q&&__autoIdentity.controller===Q.throw&&__autoIdentity.director===Q.dir&&!!__autoIdentity.connection.fake}})()');
    const capture = async (label) => { const state = await sample(); const file = path.join(output, `${captures.length}-${label}.png`); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); captures.push({ label, file, state, native: avatar.debug() }); };
    failureCapture = () => capture('failure');
    const assertIdentity = async (label) => { assert.equal(host.active(), avatar); assert.equal(win.webContents.id, wc); assert.equal(made, 1); assert.equal((await sample()).identity, true); assert.equal(voiceConnection.fake, true); checks.push(label); };
    await delay(250); await capture('initial');
    if (hostFile) {
      // Native descriptor inventory only. Inactive/covered bro must not be falsely called eligible.
      assert.equal(avatar.debug().stage.automatic, true); await assertIdentity('supplied-native-owner');
      binding.clear(); await delay(80); await assertIdentity('supplied-host-loss');
      assert.equal((await sample()).eligible, false);
    } else {
      assert.equal(avatar.debug().bounds.height, workArea.height); assert.equal(avatar.debug().lifted, false);
      const point = async (x, y) => js(`(()=>{const Q=__qubit,q=Q.q; Q.throw.recover(); Q.dir.homeAgain(); q.cx=${x};q.cy=q.ground-${y};q.sy=0;q.air=true;q.angle=0;q._rx=null;q._ry=null;})()`);
      const down = async () => js('(()=>{const Q=__qubit,q=Q.q,b=Q.state.bounds,x=q.cx,y=q.ground-q.cy;dispatchEvent(new PointerEvent("pointerdown",{pointerId:77,button:0,clientX:x,clientY:y,screenX:b.x+x,screenY:b.y+y}));})()');
      const nativeSample = (x, y, down = true) => { assert.ok(gestureSink, 'gesture watch not active'); gestureSink({ x: workArea.x + x, y: workArea.y + y, down }); };
      await point(600, 300); await delay(50); await down(); await waitFor(() => !!gestureSink, 'active gesture not registered');
      nativeSample(100, 280); await delay(180); await js('dispatchEvent(new PointerEvent("lostpointercapture",{pointerId:77}))');
      nativeSample(85, 280); await delay(160);
      assert.equal((await sample()).held, true); assert.equal((await sample()).domain, 'desktop'); await capture('capture-lost-outside');
      const heldBeforeGeometry = await sample(), gestureBeforeGeometry = activeGestureId;
      headerY += 8; hostRevision++; binding.stage(stageSnapshot()); await delay(50);
      nativeSample(85, 280); await delay(60);
      assert.equal(activeGestureId, gestureBeforeGeometry, 'valid semantic geometry revision stranded native capture');
      assert.equal((await sample()).held, true);
      const hitBeforeStale = avatar.debug().hit;
      avatar.hit({ x: 9999, y: 9999, w: 10, h: 10, revision: heldBeforeGeometry.revision });
      assert.deepEqual(avatar.debug().hit, hitBeforeStale, 'stale frame hit was accepted');
      checks.push('active-geometry-revision-stale-hit');
      const beforeMove = await sample(); native = { ...native, client: { ...native.client, x: native.client.x + 80 }, x: native.x + 80 }; hostRevision++; host.onWins([native]); binding.stage(stageSnapshot());
      await delay(80); const moved = await sample(); assert.ok(Math.abs(moved.x - beforeMove.x) < 3 && Math.abs(moved.y - beforeMove.y) < 3, 'host movement changed held screen pose');
      nativeSample(550, 250); await delay(220); await capture('reentered-same-gesture'); assert.equal((await sample()).domain, 'bro', JSON.stringify(await sample()));
      for (let i = 0; i < 3; i++) {
        nativeSample(85, 250); await delay(140); assert.equal((await sample()).domain, 'desktop');
        nativeSample(550, 250); await delay(140); assert.equal((await sample()).domain, 'bro');
        assert.equal(activeGestureId, gestureBeforeGeometry);
      }
      checks.push('rapid-crossings-same-native-gesture');
      nativeSample(550, 250, false); await delay(80); assert.equal((await sample()).held, false); assert.equal(talk, 0);
      // Late up/cancel cannot finish twice or start talking.
      await js('dispatchEvent(new PointerEvent("pointerup",{pointerId:77,button:0}));dispatchEvent(new PointerEvent("pointercancel",{pointerId:77}))');
      await delay(80); assert.equal(talk, 0); await assertIdentity('drag-crossings-native-release');
      // Active helper failure safely releases a hold, never talks.
      await point(100, 250); await delay(50); await down(); await waitFor(() => !!gestureSink, 'second gesture not registered'); nativeSample(150, 220); await delay(80); gestureSink({ cancel: true });
      await delay(60); assert.equal((await sample()).held, false); assert.equal((await sample()).press, false); assert.equal(talk, 0); await assertIdentity('helper-cancel-no-talk');
      // Reachable walking shares the same floor/navigation across the open client boundary.
      await js('(()=>{const Q=__qubit,q=Q.q;Q.throw.recover();Q.dir.homeAgain();q.cx=100;q.sy=0;q.cy=q.side/2;q.air=false;window.__walk=q.goTo(650,q.ground-1);})()');
      await waitFor(async () => (await sample()).x > 620, 'reachable floor walk did not cross'); await capture('walk-crossing'); await assertIdentity('reachable-walk');
      // Swept throw from bro to desktop, no watchdog/home placement.
      await js('(()=>{const Q=__qubit,q=Q.q;Q.throw.recover();q.cx=550;q.cy=q.ground-240;Q.throw.hold({x:550,y:240});Q.dir.grabbed();Q.throw.release({x:-1700,y:-100});Q.dir.thrown();})()');
      await delay(350); assert.equal((await sample()).returning, false); await capture('throw-outside'); await assertIdentity('swept-throw');
      // Stage expiry revokes geometry/entry, outside owner persists. Avoid polling lease renewal.
      client.stop(); binding.stage(stageSnapshot()); await delay(2100);
      assert.equal((await sample()).eligible, false); assert.ok((await sample()).solids.every((s) => s.id === '__excluded')); await assertIdentity('stage-expiry'); await capture('expired');
      binding.clear(); await delay(80); assert.equal((await sample()).solids.length, 0); await assertIdentity('host-loss');
      // Safe active-display removal rebuilds placement but not renderer/controller/voice.
      screen.getAllDisplays = () => [{ id: 9877, scaleFactor: 1.25, workArea, bounds: workArea }]; screen.getPrimaryDisplay = () => screen.getAllDisplays()[0]; screen.getDisplayMatching = () => screen.getPrimaryDisplay();
      screen.emit('display-removed'); await delay(100); assert.equal((await sample()).held, false); await assertIdentity('display-recovery'); await capture('display-recovered');
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(`PASS hidden Automatic compositor: ${checks.join(', ')}; captures ${output}`);
  } catch (e) { try { await failureCapture?.(); } catch {} errors.push(String(e.stack || e)); console.error(e.stack); console.error(`Failure captures: ${output}`); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(output, 'captures.json'), JSON.stringify({ compositorOnly: true, suppliedHost: !!hostFile, profile, captures, checks, errors, talk, made, fakeVoiceConnectionId: voiceConnection.id }, null, 2));
    client?.stop(); binding?.clear(); tracker?.stop?.(); host?.stop(); if (win && !win.isDestroyed()) win.destroy();
    server.closeAllConnections(); server.close(); app.exit(process.exitCode || 0);
  }
}
void run();
