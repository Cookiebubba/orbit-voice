// End-to-end check of how Orbit's voice comes out, in the real Orbit page under Electron:
//   npm --prefix ui run build && electron scripts/audio-e2e.mjs
//
// Like scripts/wake-audio-e2e.mjs it never touches a running Orbit: its own bridge on port 4393 (or
// E2E_PORT), a throwaway config, a fake Grok this script drives itself, a hidden window, and a
// stand-in for the Claude window (nothing reads or touches the real one). In the page, everything
// that reaches the speakers is recorded (a tap on the AudioContext's destination), and what the
// level meter for the orb and the avatar reads is noted. Synthetic tones only.
//
// 1. Volume: the voice plays at the gain the setting asks for (squared), changes live mid-call, and
//    the level the orb and avatar move with is read before the volume.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { WebSocketServer } from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-audio-e2e-'));
for (const k of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) process.env[k] = path.join(tmp, k.toLowerCase());
app.setPath('userData', path.join(tmp, 'electron'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const PORT = Number(process.env.E2E_PORT || 4393);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const out = (line) => {
  console.log(line);
  if (process.env.E2E_OUT) fs.appendFileSync(process.env.E2E_OUT, `${line}\n`);
};
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  out(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
};

// The fake Grok: this script sends its events itself.
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => fake.on('listening', r));
process.env.XAI_REALTIME_URL = `ws://127.0.0.1:${fake.address().port}`;
let grok = null;
fake.on('connection', (sock) => (grok = sock));
const send = (e) => grok?.readyState === 1 && grok.send(JSON.stringify(e));
/** pcm16 base64 of `secs` of a tone at `hz`, amplitude `amp` (0..1), from sample `from` of the tone. */
const tone = (secs, hz, amp, from = 0) => {
  const n = Math.round(secs * 24000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * (from + i)) / 24000) * amp * 32767), i * 2);
  return b;
};
let rid = 0;
/** A reply of these pcm pieces (each sent as 100 ms deltas), then its end. */
const reply = (pieces, { done = true } = {}) => {
  const id = `resp_${++rid}`;
  send({ type: 'response.created', response: { id } });
  const all = Buffer.concat(pieces);
  for (let i = 0; i < all.length; i += 4800) send({ type: 'response.output_audio.delta', response_id: id, item_id: `${id}_a`, delta: all.subarray(i, i + 4800).toString('base64') });
  if (done) {
    send({ type: 'response.output_audio.done', response_id: id });
    send({ type: 'response.done', response: { id, status: 'completed', output: [] } });
  }
  return { id, secs: all.length / 2 / 24000 };
};

const listeners = new Set();
const watcher = { on: (fn) => listeners.add(fn), start() {}, working: () => [] };
const { setDesktopDriver } = await import('../src/desktop.js');
setDesktopDriver({ run: async () => ({ ok: false, error: 'claude_window_not_found', message: 'stand-in: no Claude window' }) });
const { startServer, authUrl } = await import('../src/server.js');
const { updateSettings } = await import('../src/config.js');

app.whenReady().then(run).catch((e) => {
  out(`FAIL: ${e?.stack || e}`);
  app.exit(1);
});

// In the page, before the call starts: record what reaches the speakers (with the context clock),
// and the loudest level the orb's meter reads.
const TAP = `(() => {
  if (window.__tap) return true;
  const tap = (window.__tap = { chunks: [], meter: 0, ctx: null });
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const ac = this.context;
    if (dest === ac.destination && !(this instanceof ScriptProcessorNode)) {
      tap.ctx = ac;
      const rec = ac.createScriptProcessor(1024, 1, 1);
      rec.onaudioprocess = (e) => tap.chunks.push({ t: e.playbackTime, d: Float32Array.from(e.inputBuffer.getChannelData(0)) });
      orig.call(this, rec);
      orig.call(rec, ac.destination);
    }
    return orig.call(this, dest, ...rest);
  };
  const get = AnalyserNode.prototype.getFloatTimeDomainData;
  AnalyserNode.prototype.getFloatTimeDomainData = function (buf) {
    get.call(this, buf);
    let s = 0; for (const v of buf) s += v * v;
    tap.meter = Math.max(tap.meter, Math.sqrt(s / buf.length));
  };
  return true;
})()`;

async function run() {
  const mem = (v) => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
  await startServer({ port: PORT, configDir: path.join(tmp, 'cfg'), secrets: mem('xai-' + 'k'.repeat(40)), brainSecrets: mem(''), clipboard: () => {}, models: tmp, watcher });
  updateSettings({ announce: 'off', voiceVolume: 0.5 });
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL(authUrl('main'));
  await wait(2500);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const click = (text) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent || '').includes(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);
  await js(TAP);
  check(await click('Start talking'), 'started a call');
  for (let i = 0; i < 40 && !grok; i++) await wait(100);
  check(!!grok, 'the fake Grok is connected');
  await wait(1500);
  /** Peak and RMS of what reached the speakers between these context times (0 = from the start). */
  const heard = (from = 0, to = 1e9) => js(`(() => { let pk = 0, s = 0, n = 0; for (const c of window.__tap.chunks) { const dt = 1 / c.d.length; for (let i = 0; i < c.d.length; i++) { const t = c.t + i / 24000; if (t < ${from} || t >= ${to}) continue; const v = c.d[i]; pk = Math.max(pk, Math.abs(v)); s += v * v; n++; } } return { pk, rms: n ? Math.sqrt(s / n) : 0, n }; })()`);
  const now = () => js('window.__tap.ctx ? window.__tap.ctx.currentTime : 0');
  const resetMeter = () => js('(window.__tap.meter = 0, true)');

  // ---- 1. Volume ----
  out('1. Volume');
  await resetMeter();
  const t0 = await now();
  reply([tone(1.0, 440, 0.5)]);
  await wait(1800);
  const a = await heard(t0, t0 + 1.5);
  check(Math.abs(a.pk - 0.5 * 0.25) < 0.02, 'at volume 50% the voice plays at gain 0.25', `peak ${a.pk.toFixed(3)}, want 0.125`);
  const meter = await js('window.__tap.meter');
  check(meter > 0.3, 'the orb and avatar read the level before the volume', `meter ${meter.toFixed(3)}, the tone's RMS is 0.354`);
  updateSettings({ voiceVolume: 1 });
  await wait(400);
  const t1 = await now();
  reply([tone(1.0, 440, 0.5)]);
  await wait(1800);
  const b = await heard(t1, t1 + 1.5);
  check(Math.abs(b.pk - 0.5) < 0.03, 'a new volume applies mid-call', `peak ${b.pk.toFixed(3)}, want 0.5`);
  updateSettings({ voiceVolume: 0 });
  await wait(400);
  const t2 = await now();
  reply([tone(0.6, 440, 0.5)]);
  await wait(1200);
  check((await heard(t2, t2 + 1)).pk < 0.002, 'volume 0 is silent');
  updateSettings({ voiceVolume: 0.75 });
  await wait(400);

  out(failures ? `RESULT FAIL: ${failures} failure(s)` : 'RESULT PASS: 0 failure(s)');
  fake.close();
  app.exit(failures ? 1 : 0);
}
