// Isolated hidden real Qubit renderer. Source modules served directly: no UI build/manifest changes.
// No voice/config/provider/microphone imports, OS input or user-window manipulation.
// Optional --host-file PATH --expected-host-pid PID authenticates only a caller-owned inactive host.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, ipcMain, screen, session } from 'electron';
import { createAvatar } from '../electron/avatar.js';
import { setTestCursor } from '../electron/avatar-hover.js';
import { createAvatarHost } from '../electron/avatar-host.js';
import { createExternalAvatarBinding } from '../electron/external-avatar.js';
import { createExternalHost, readDescriptor } from '../src/external-host.js';
import { createWinFocusTracker } from '../src/platform/win/focus.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
if (process.argv.includes('--visible')) throw new Error('This harness is hidden-only.');
const hostFile = option('host-file'), expectedPid = Number(option('expected-host-pid'));
const interactionsOnly = process.argv.includes('--interactions-only');
const reducedMotion = process.argv.includes('--reduced-motion');
if (reducedMotion) app.commandLine.appendSwitch('force-prefers-reduced-motion');
if (hostFile && (!Number.isSafeInteger(expectedPid) || expectedPid <= 0)) throw new Error('Supply the caller-owned isolated host PID.');
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
const hostSnapshot = () => ({ protocol: 1, instanceId: 'auto-fixture', name: 'Fixture host', mode: 'attached', avatarRoam: { schema: 1, policy: 'auto' }, capabilities: caps, window: { handle: '123', pid: 42, epoch: 'w1' }, sessions: [] });
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
let made = 0, talk = 0, settingsOpened = 0, front = 123, failureCapture = null;
const voiceActions = [], orbActions = [];
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
    ipcMain.on('buddy:settings', (e) => { if (target(e)) settingsOpened++; });
    ipcMain.on('buddy:voice', (e, action) => { if (target(e)) voiceActions.push(action); });
    ipcMain.on('orb:action', (_e, action) => orbActions.push(action));
    client = createExternalHost({ descriptor: hostFile ? readDescriptor(path.resolve(hostFile)) : { protocol: 1, instanceId: 'auto-fixture', url: base, token }, onSnapshot: (s) => {
      if (hostFile && s && s.window?.pid !== expectedPid) { errors.push('Descriptor does not identify the supplied isolated host'); return; }
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
      // Native descriptor inventory only. An inactive/covered host must not be falsely called eligible.
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
      nativeSample(550, 250); await delay(220); await capture('reentered-same-gesture'); assert.equal((await sample()).domain, 'host', JSON.stringify(await sample()));
      for (let i = 0; i < 3; i++) {
        nativeSample(85, 250); await delay(140); assert.equal((await sample()).domain, 'desktop');
        nativeSample(550, 250); await delay(140); assert.equal((await sample()).domain, 'host');
        assert.equal(activeGestureId, gestureBeforeGeometry);
      }
      checks.push('rapid-crossings-same-native-gesture');
      nativeSample(550, 250, false); await delay(80); assert.equal((await sample()).held, false); assert.equal(talk, 0);
      // Late up/cancel cannot finish twice or start talking.
      await js('dispatchEvent(new PointerEvent("pointerup",{pointerId:77,button:0}));dispatchEvent(new PointerEvent("pointercancel",{pointerId:77}))');
      await delay(80); assert.equal(talk, 0); await assertIdentity('drag-crossings-native-release');
      // A working DOM capture survives native-helper failure. Actual movement renews the bounded
      // gesture; losing capture after the helper fails releases safely, without waking voice.
      await point(600, 300); await delay(50); await down(); await waitFor(() => !!gestureSink, 'second gesture not registered');
      gestureSink({ cancel: true });
      const move = (x, y) => js(`(()=>{const b=__qubit.state.bounds;dispatchEvent(new PointerEvent('pointermove',{pointerId:77,buttons:1,clientX:${x},clientY:${y},screenX:b.x+${x},screenY:b.y+${y}}));})()`);
      for (let i = 0; i < 12; i++) { await move(600 + i * 4, 280); await delay(110); }
      assert.equal((await sample()).held, true); assert.equal((await sample()).press, true);
      assert.ok(Math.abs((await sample()).x - 644) < 4, 'real DOM movement failed to carry Qubit');
      await capture('dom-drag-native-unavailable');
      await js('dispatchEvent(new PointerEvent("lostpointercapture",{pointerId:77}))');
      await waitFor(async () => !(await sample()).press, 'lost capture after helper failure did not release');
      assert.equal((await sample()).held, false); assert.equal(talk, 0); await assertIdentity('dom-drag-helper-failure');

      // Real renderer presses, not direct calls to the throw controller. Opening settings must
      // never also wake voice, including Chromium's dblclick following the second pointerup.
      const click = async () => {
        await point(600, 300);
        await js(`(()=>{const b=__qubit.state.bounds;for(const type of ['pointerdown','pointerup'])dispatchEvent(new PointerEvent(type,{pointerId:77,button:0,clientX:600,clientY:300,screenX:b.x+600,screenY:b.y+300}));})()`);
      };
      await click(); await delay(90); await click();
      await js('dispatchEvent(new MouseEvent("dblclick",{clientX:600,clientY:300}))');
      await delay(650); assert.equal(settingsOpened, 1); assert.equal(talk, 0); checks.push('double-click-settings-no-voice');
      // A native up racing Chromium's up does not swallow a real single click.
      await point(600, 300); await delay(50); await down(); await waitFor(() => !!gestureSink, 'click gesture not registered');
      nativeSample(600, 300, false);
      await js(`(()=>{const q=__qubit.q,b=__qubit.state.bounds,x=q._rx??q.cx,y=q._ry??q.ground-q.cy;dispatchEvent(new PointerEvent('pointerup',{pointerId:77,button:0,clientX:x,clientY:y,screenX:b.x+x,screenY:b.y+y}));})()`);
      await delay(650); assert.equal(talk, 1); checks.push('single-click-native-release-race');
      await js('dispatchEvent(new MouseEvent("contextmenu",{clientX:__qubit.q._rx??__qubit.q.cx,clientY:__qubit.q._ry??__qubit.q.ground-__qubit.q.cy,cancelable:true}))');
      await delay(50); assert.deepEqual(orbActions, ['toggle-sleep']);

      // The visible control follows actual capture + gate state and sends fixed start/stop actions.
      const control = () => js(`(()=>{const box=document.querySelector('.qubit-voice'),b=box.getBoundingClientRect();return {label:box.querySelector('[role=status]').textContent,button:box.querySelector('button').textContent,listening:box.dataset.listening,hidden:box.hidden,inBounds:b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight};})()`);
      for (const [voice, label, button, action] of [
        [{phase:'off',microphone:'off',listening:false},'Mic off','Start','start'],
        [{phase:'listening',microphone:'active',listening:true},'Listening','Stop','stop'],
        [{phase:'listening',microphone:'active',muted:true,listening:false},'Mic muted','Unmute','start'],
        [{phase:'speaking',microphone:'active',listening:false},'Speaking · mic off','Stop','stop'],
        [{phase:'listening',microphone:'active',asleep:true,listening:false},'Mic off','Start','start'],
      ]) {
        host.onVoice(voice); await waitFor(async () => (await control()).label === label, `missing mic state: ${label}`);
        const c = await control(); assert.equal(c.button, button); assert.equal(c.hidden, false); assert.equal(c.inBounds, true);
        assert.equal(c.listening, String(voice.listening));
        await js('document.querySelector(".qubit-voice button").click()');
        await waitFor(() => voiceActions.length > 0, 'voice control did not send an action');
        assert.equal(voiceActions.pop(), action);
        await capture(`mic-${button.toLowerCase()}-${voice.phase}`);
      }
      checks.push('visible-mic-state-and-controls');
      if (reducedMotion) assert.equal(await js('matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
      if (interactionsOnly) { console.log(`PASS hidden interaction compositor${reducedMotion ? ' (reduced motion)' : ''}: ${checks.join(', ')}; captures ${output}`); return; }
      // Reachable walking shares the same floor/navigation across the open client boundary.
      await js('(()=>{const Q=__qubit,q=Q.q;Q.throw.recover();Q.dir.homeAgain();q.cx=100;q.sy=0;q.cy=q.side/2;q.air=false;window.__walk=q.goTo(650,q.ground-1);})()');
      await waitFor(async () => (await sample()).x > 620, 'reachable floor walk did not cross'); await capture('walk-crossing'); await assertIdentity('reachable-walk');
      // Swept throw from host to desktop, no watchdog/home placement.
      await js('(()=>{const Q=__qubit,q=Q.q;Q.throw.recover();q.cx=550;q.cy=q.ground-240;Q.throw.hold({x:550,y:240});Q.dir.grabbed();Q.throw.release({x:-1700,y:-100});Q.dir.thrown();})()');
      await delay(350); assert.equal((await sample()).returning, false); await capture('throw-outside'); await assertIdentity('swept-throw');
      // Stage expiry revokes geometry/entry, outside owner persists. Avoid polling lease renewal.
      client.stop(); binding.stage(stageSnapshot()); await delay(2100);
      assert.equal((await sample()).eligible, false); assert.ok((await sample()).solids.every((s) => s.id === '__excluded')); await assertIdentity('stage-expiry'); await capture('expired');
      binding.clear(); await delay(80); assert.equal((await sample()).solids.length, 0); await assertIdentity('host-loss');
      // Safe active-display removal rebuilds placement but not renderer/controller/voice.
      screen.getAllDisplays = () => [{ id: 9877, scaleFactor: 1.25, workArea, bounds: workArea }]; screen.getPrimaryDisplay = () => screen.getAllDisplays()[0]; screen.getDisplayMatching = () => screen.getPrimaryDisplay();
      screen.emit('display-removed'); await delay(100); assert.equal((await sample()).held, false); await assertIdentity('display-recovery'); await capture('display-recovered');
      // Escape turned off: a contained page reports revision 0. Its hit and press must still be
      // accepted after Automatic, or the window stays click-through and Qubit can't be grabbed.
      avatar.onStage(null, null, false);
      const containedBounds = win.getBounds();
      setTestCursor({ x: containedBounds.x + 120, y: containedBounds.y + 120 });
      try {
        avatar.hit({ x: 100, y: 100, w: 40, h: 40, revision: 0 });
        assert.equal(avatar.debug().hit?.x, 100, 'contained hit after Automatic was dropped');
        assert.equal(avatar.takingMouse, true, 'contained Qubit stayed click-through after Automatic');
        assert.equal(avatar.gesture({ phase: 'begin', id: 1e9, revision: 0 }), true, 'contained press after Automatic was refused');
        assert.equal(avatar.gesture({ phase: 'end', id: 1e9, revision: 0 }), true);
      } finally { setTestCursor(null); }
      checks.push('contained-after-automatic-grab');
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
