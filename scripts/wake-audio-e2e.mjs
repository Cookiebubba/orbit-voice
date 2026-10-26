// End-to-end check that Grok is heard on a spoken update, in the real Orbit page under Electron:
//   electron scripts/wake-audio-e2e.mjs        (run `npm --prefix ui run build` first)
//
// It doesn't start Orbit itself (no tray, hotkey or single-instance lock), so it never touches a
// running Orbit: its own bridge on port 4391, a throwaway config, a fake Grok that speaks real
// audio (a 1.5 s tone), and a hidden window like Orbit's in orb mode. First an ordinary call
// lasting a few seconds, hung up with the Sleep button; then Claude "finishes", the bridge asks
// the page to wake Grok, and the page reports at hang-up how much of Grok's audio it scheduled and
// played, and how far ahead of its clock the first chunk was put. Prints the bridge's log lines
// (counts only) and exits 0 if the wake's audio played.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { WebSocketServer } from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wake-audio-'));
for (const k of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) process.env[k] = path.join(tmp, k.toLowerCase());
app.setPath('userData', path.join(tmp, 'electron'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const PORT = Number(process.env.E2E_PORT || 4391);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Results go to stdout and, if E2E_OUT names a file, there too (Electron's stdout can be lost on Windows).
const out = (line) => {
  console.log(line);
  if (process.env.E2E_OUT) fs.appendFileSync(process.env.E2E_OUT, `${line}\n`);
};

// Fake Grok: answers every response.create with 1.5 s of a 440 Hz tone, in 100 ms chunks.
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => fake.on('listening', r));
process.env.XAI_REALTIME_URL = `ws://127.0.0.1:${fake.address().port}`;
const chunk = (i) => {
  const b = Buffer.alloc(2400 * 2);
  for (let n = 0; n < 2400; n++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * (i * 2400 + n)) / 24000) * 8000), n * 2);
  return b.toString('base64');
};
let connections = 0;
fake.on('connection', (sock) => {
  connections++;
  sock.on('message', async (m) => {
    if (JSON.parse(String(m)).type !== 'response.create') return;
    const send = (e) => sock.readyState === 1 && sock.send(JSON.stringify(e));
    send({ type: 'response.created' });
    for (let i = 0; i < 15; i++) send({ type: 'response.output_audio.delta', delta: chunk(i) });
    send({ type: 'response.output_audio_transcript.done', transcript: 'Claude finished.' });
    send({ type: 'response.done' });
  });
});

const listeners = new Set();
const watcher = { on: (fn) => listeners.add(fn), start() {}, working: () => [] };
const { startServer, authUrl, WAKE_LIMITS } = await import('../src/server.js');
WAKE_LIMITS.gapMs = 2000; // the real 30 s spacing after the first call would only slow this down
const { updateSettings } = await import('../src/config.js');
const { recentLog } = await import('../src/log.js');

// The rest runs once Electron is ready (awaiting whenReady at the top of an ESM entry hangs).
app.whenReady().then(run).catch((e) => {
  out(`FAIL: ${e?.stack || e}`);
  app.exit(1);
});

async function run() {
const mem = (v) => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
await startServer({ port: PORT, configDir: path.join(tmp, 'cfg'), secrets: mem('xai-' + 'k'.repeat(40)), brainSecrets: mem(''), clipboard: () => {}, models: tmp, watcher });
updateSettings({ announce: 'speak', announceWake: true });
const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
await win.loadURL(authUrl('main'));
await wait(2500);
const js = (code) => win.webContents.executeJavaScript(code, true);
const click = (text) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent || '').includes(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);

const ended = () => recentLog({ limit: 100, minLevel: 'info' }).filter((e) => /Grok session ended/.test(e.message));
// 1. An ordinary call of a few seconds, hung up with the Sleep button.
out(`start talking: ${await click('Start talking')}`);
// (Chromium's fake microphone on a Mac takes ~10 s to open with echo cancellation; a real one doesn't.)
for (let i = 0; i < 150 && !connections; i++) await wait(100);
await wait(4000);
out(`go to sleep: ${await click('Go to sleep')}`);
for (let i = 0; i < 60 && ended().length < 1; i++) await wait(250);
await wait(1500);
// 2. Claude finishes: the bridge asks the page to wake Grok, which says it.
listeners.forEach((fn) => fn({ type: 'claude.finished', id: 'local_e2e', title: 'E2E session', summary: '' }));
for (let i = 0; i < 120 && ended().length < 2; i++) await wait(250);
const lines = ended().map((e) => `${e.message} :: ${e.detail}`);
for (const l of lines) out(l);
const wake = ended()[1]?.detail || '';
const m = /page scheduled ([\d.]+)s, played ([\d.]+)s, first chunk ([\d.]+)s ahead/.exec(wake);
const ok = !!m && Number(m[2]) >= 1.2 && Number(m[3]) < 1;
out(ok ? 'PASS: the wake\x27s audio played' : 'FAIL: the wake\x27s audio did not play');
fake.close();
app.exit(ok ? 0 : 1);
}
