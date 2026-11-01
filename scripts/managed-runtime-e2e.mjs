// Actual electron/main.js + React/useVoice + server, driven by bro's native lifecycle fixture.
// Only this isolated process's windows are captured. Devices/providers/desktop/input are fakes.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { register, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, session, shell } from 'electron';
import { installFakeAudio } from '../test/managed/audio.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const directory = option('acceptance-dir'), descriptor = option('external-host-file');
assert.ok(directory && descriptor && path.isAbsolute(directory) && path.isAbsolute(descriptor));
assert.ok(process.argv.includes('--bro-managed'));
fs.mkdirSync(directory, { recursive: true });
const reportFile = path.join(directory, 'report.json');
const state = globalThis.__managedAcceptance = { providerStarts: 0, providerCloses: 0, tools: [], errors: [],
  showRequests: 0, settingsObserved: false, settingsHidden: false, blockedChildren: 0, clipboardWrites: 0,
  startup: null, renderer: null, rendererIds: [], snapshots: [] };
const writeReport = () => { fs.writeFileSync(`${reportFile}.tmp`, JSON.stringify(state)); fs.renameSync(`${reportFile}.tmp`, reportFile); };
for (const [key, name] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'local'], ['HOME', 'home'], ['USERPROFILE', 'home'],
  ['BRO_DIR', 'bro'], ['CLAUDE_POOL_DIR', 'pool'], ['BRO_CODEX_PROFILES_DIR', 'codex']]) {
  process.env[key] = path.join(directory, name); fs.mkdirSync(process.env[key], { recursive: true });
}
app.setPath('appData', process.env.APPDATA);
const profile = path.join(directory, 'orbit-profile'); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.ORBIT_BRO_PREVIEW_USER_DATA = profile;
process.env.ORBIT_FAKE_DESKTOP = path.join(ROOT, 'test/e2e/fake-desktop.mjs');
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GVB_FAKE_MIC', 'GVB_SNAPSHOT_DIR', 'ORBIT_EXTERNAL_HOST_FILE']) delete process.env[key];
process.env.PATH = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ voiceEngine: 'claude', wakeWord: true, announce: 'speak', announceWake: true,
  wakeOnResults: true, avatar: 'qubit', previewHotkeyEnabled: false, anywhere: false, brainEnabled: false, autoUpdate: false }));
globalThis.__fuzz = { calls: [], rng: () => 0, str: () => 'fixture', windowTitle: () => 'Do not automate' };
globalThis.__orbitE2E = { desktop: { windows: [], sidebar: [], folders: [], calls: [], sends: [], rng: () => 0, chaos: 0 } };
// Allow only the fixed ACL validator for this exact descriptor; never a desktop/input helper.
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, ...rest) => {
  const script = args?.[2] === '-EncodedCommand' ? Buffer.from(args[3], 'base64').toString('utf16le') : '';
  if (path.basename(file).toLowerCase() === 'powershell.exe' && args?.[0] === '-NoProfile' && args?.[1] === '-NonInteractive'
    && script.includes('Get-Acl -LiteralPath') && script.includes(Buffer.from(descriptor).toString('base64'))) return execFileSync(file, args, ...rest);
  state.blockedChildren++; throw new Error('Unexpected child process in managed acceptance');
};
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork']) childProcess[method] = () => {
  state.blockedChildren++; throw new Error('Unexpected child process in managed acceptance');
};
const local = (host) => ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(host);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === 'number') options = { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (options && typeof options === 'object' && !options.path && !local(options.host || 'localhost')) throw new Error('Nonlocal connection blocked');
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = (host, ...rest) => { if (!local(String(host))) throw new Error('Nonlocal DNS blocked'); return lookup(host, ...rest); };
const fetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => { if (!local(new URL(url).hostname)) return Promise.reject(new Error('Nonlocal fetch blocked')); return fetch(url, ...rest); };
syncBuiltinESMExports();
clipboard.writeText = () => { state.clipboardWrites++; };
clipboard.readText = () => '';
for (const method of ['register', 'isRegistered']) globalShortcut[method] = () => false;
globalShortcut.unregister = globalShortcut.unregisterAll = () => {};
shell.openExternal = shell.openPath = async () => { throw new Error('External UI blocked'); };
dialog.showErrorBox = () => state.errors.push('unexpected-dialog');
for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'restore', 'setSkipTaskbar']) BrowserWindow.prototype[method] = function () {
  if (method === 'show') state.showRequests++;
};
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); // second guard if renderer injection fails
ipcMain.on('managed:status', (_event, value) => {
  state.voiceStatus = { rendererReady: value?.rendererReady, phase: value?.phase, microphone: value?.microphone,
    credentialAvailable: value?.credentialAvailable, failure: value?.failure };
});
ipcMain.on('managed:ack', (_event, _id, applied) => { state.lastApplied = applied; });
let main = null, sampling = false, closingSettings = false;
const audio = async () => main.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.__managedAudio))');
app.on('web-contents-created', (_event, contents) => {
  contents.setAudioMuted(true);
  contents.on('render-process-gone', () => state.errors.push('renderer-gone'));
  contents.on('console-message', (event) => { if (event.level === 'error') state.errors.push('renderer-console-error'); });
  contents.on('dom-ready', async () => {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/(?:[?#]|$)/.test(contents.getURL())) return;
    try {
      if (!await contents.executeJavaScript('window.desktop?.managed === true')) return;
      main = BrowserWindow.fromWebContents(contents);
      state.rendererIds.push(contents.id);
      await contents.executeJavaScript(`(${installFakeAudio.toString()})()`);
      assert.equal(main.isVisible(), false);
      state.startup = { ...await audio(), providerStarts: state.providerStarts, visible: main.isVisible() };
      writeReport();
    } catch { state.errors.push('renderer-fixture-failed'); writeReport(); }
  });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(?:http|ws):\/\/127\.0\.0\.1:\d+\//.test(details.url) }));
  const timer = setInterval(async () => {
    if (!main || main.isDestroyed() || sampling) return;
    sampling = true;
    try {
      state.renderer = await audio();
      assert.equal(main.isVisible(), false);
      if (state.showRequests && !closingSettings && await main.webContents.executeJavaScript('Array.from(document.querySelectorAll("h2")).some(h => h.textContent === "Settings" && h.getClientRects().length > 0)')) {
        closingSettings = true; state.settingsObserved = true;
        await main.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const screenshot = path.join(directory, 'advanced-settings.png');
        fs.writeFileSync(screenshot, (await main.webContents.capturePage()).toPNG()); state.snapshots.push('advanced-settings.png');
        await main.webContents.executeJavaScript('window.desktop.close()');
        state.settingsHidden = !main.isVisible() && !main.isDestroyed();
      }
      writeReport();
    } catch { state.errors.push('renderer-sample-failed'); writeReport(); }
    finally { sampling = false; }
  }, 100);
  timer.unref();
});
app.on('before-quit', () => { state.desktopCalls = globalThis.__fuzz.calls.length; writeReport(); });
setTimeout(() => { state.errors.push('acceptance-deadline'); writeReport(); app.exit(2); }, 60000).unref();
process.on('uncaughtException', () => { state.errors.push('uncaught-exception'); writeReport(); app.exit(2); });
process.on('unhandledRejection', () => { state.errors.push('unhandled-rejection'); writeReport(); app.exit(2); });
register('../test/managed/loader.mjs', import.meta.url);
// Occupy the requested port. Managed startup must choose its own port without
// interfering with another local service or opening an uncaught-error dialog.
const probe = net.createServer();
app.on('before-quit', () => probe.close());
probe.listen(0, '127.0.0.1', () => { process.env.PORT = String(probe.address().port); void import('../electron/main.js'); });
