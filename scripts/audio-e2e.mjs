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
    // Only the voice's own context (24 kHz; the chimes have one of their own at the device rate).
    if (dest === ac.destination && ac.sampleRate === 24000 && !(this instanceof ScriptProcessorNode)) {
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
  const t2b = await now();
  reply([tone(0.6, 440, 0.5)]);
  await wait(1200);
  const back = await heard(t2b, t2b + 1);
  check(Math.abs(back.pk - 0.5 * 0.5625) < 0.03, 'and from 0 back to the default it plays again', `peak ${back.pk.toFixed(3)}, want 0.281`);

  // ---- 2. The end of a reply ----
  // A reply whose last 300 ms is a different tone (880 Hz), ending abruptly at full level. What
  // reached the speakers is cut into 10 ms frames and each is checked for that tone (Goertzel).
  out('2. The end of a reply');
  const G = 0.75 * 0.75; // the gain at the default volume
  /** Per 10 ms frame from context time t: [880 Hz level, overall RMS], each relative to the tail tone's RMS at this gain. */
  const frames = (t, secs) =>
    js(`(() => {
      const from = ${t}, to = ${t} + ${secs}, R = 24000, W = 240, n = Math.round((to - from) * R);
      const buf = new Float32Array(n);
      for (const c of window.__tap.chunks) for (let i = 0; i < c.d.length; i++) { const k = Math.round((c.t - from) * R) + i; if (k >= 0 && k < n) buf[k] = c.d[i]; }
      const ref = (0.5 * ${G}) / Math.SQRT2, w = (2 * Math.PI * 880) / R, cw = 2 * Math.cos(w), out = [];
      for (let f = 0; f + W <= n; f += W) {
        let s1 = 0, s2 = 0, e = 0;
        for (let i = 0; i < W; i++) { const x = buf[f + i]; const s0 = x + cw * s1 - s2; s2 = s1; s1 = s0; e += x * x; }
        const p = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - cw * s1 * s2)) / (W / 2) / Math.SQRT2;
        out.push([p / ref, Math.sqrt(e / W) / ref]);
      }
      return out;
    })()`);
  /** Play a reply ending in the 880 Hz tail, optionally with the user starting to talk `talkBeforeEnd` s before its end. */
  const tailReply = async ({ talkBeforeEnd = null, tailAmp = 0.5 } = {}) => {
    const t = await now();
    const r = reply([tone(0.7, 440, 0.5), tone(0.3, 880, tailAmp, 0.7 * 24000)]);
    if (talkBeforeEnd !== null) {
      await wait((r.secs - talkBeforeEnd) * 1000 + 30);
      send({ type: 'input_audio_buffer.speech_started', item_id: `talk_${rid}`, audio_start_ms: 0 });
    }
    await wait(2000);
    const f = await frames(t, 2.2);
    if (process.env.E2E_DEBUG) out(`debug: t ${t} heard ${JSON.stringify(await heard(t, t + 2.2))} chunks ${await js('window.__tap.chunks.length')} last ${await js('JSON.stringify(window.__tap.chunks.at(-1).t)')} now ${await now()}`);
    const tail = f.map((x, i) => [i, x[0], x[1]]).filter((x) => x[1] > 0.5);
    const last = tail.length ? tail.at(-1)[0] : -1;
    return { f, tailMs: tail.length * 10, last };
  };
  const plain = await tailReply();
  if (process.env.E2E_DEBUG) out(`debug: ${JSON.stringify(plain.f.filter((_, i) => i % 10 === 0).map((x) => x.map((v) => +v.toFixed(2))))} heard ${JSON.stringify(await heard(0))}`);
  check(plain.tailMs >= 280, 'the whole 300 ms tail plays', `${plain.tailMs} ms of it`);
  // Answering right as it ends ("yes" over "...send it?") is not an interruption: it plays out.
  const over = await tailReply({ talkBeforeEnd: 0.25 });
  check(over.tailMs >= 280, 'talking over the last 250 ms lets the tail finish', `${over.tailMs} ms of it`);
  // The release: after the last full-level frame, the sound falls away over ~120 ms instead of
  // stopping dead, and only after the end (the last 50 ms before it are still at full level).
  const rel = plain.f.slice(plain.last + 1, plain.last + 16).map((x) => x[1]);
  const before = plain.f.slice(plain.last - 4, plain.last).map((x) => x[1]); // (the last frame may straddle the end)
  check(before.every((x) => x > 0.8), 'nothing is faded before the audio ends', before.map((x) => x.toFixed(2)).join(' '));
  check(rel.length >= 12 && rel[0] > 0.2 && rel[3] > 0.02 && rel[11] < rel[0] / 10 && rel.every((x, i) => i === 0 || x <= rel[i - 1] * 1.3 + 0.01), 'a gentle release of ~120 ms follows the real end', rel.map((x) => x.toFixed(2)).join(' '));
  // Audio that already ends in quiet gets nothing added.
  const quiet = await tailReply({ tailAmp: 0.001 });
  check(quiet.f.slice(110, 140).every((x) => x[1] < 0.02), 'audio that ends in quiet gets no release added');
  // A real interruption (2 s of the reply still to come) still stops it at once.
  const t3 = await now();
  reply([tone(3.0, 440, 0.5)]);
  await wait(800);
  send({ type: 'input_audio_buffer.speech_started', item_id: 'talk_barge', audio_start_ms: 0 });
  await wait(2800);
  const f3 = await frames(t3, 3.4);
  const loud = f3.filter((x) => x[1] > 0.5).length * 10;
  check(loud < 1300, 'talking over the middle of a reply still stops it', `${loud} ms of a 3 s reply played`);

  // ---- 3. Hanging up ----
  // "Go to sleep" while Orbit is still talking: it finishes what it was saying, then hangs up; and
  // the bridge's log says how often a reply was talked over (counts only).
  out('3. Hanging up');
  const t4 = await now();
  reply([tone(1.2, 440, 0.5), tone(0.3, 880, 0.5, 1.2 * 24000)]);
  await wait(300);
  check(await click('Go to sleep'), 'pressed Go to sleep while it talks');
  await wait(3500);
  const f4 = await frames(t4, 1.8);
  check(f4.filter((x) => x[0] > 0.5).length * 10 >= 280, 'the reply plays to its end before the hang-up');
  const { recentLog } = await import('../src/log.js');
  const end = recentLog({ limit: 50, minLevel: 'info' }).find((e) => /session ended by Orbit/.test(e.message));
  check(/talked over: cut 1x, let finish 1x/.test(end?.detail || ''), 'the log counts replies cut and let finish', (end?.detail || 'no log line').replace(/^.*page: /, ''));

  out(failures ? `RESULT FAIL: ${failures} failure(s)` : 'RESULT PASS: 0 failure(s)');
  fake.close();
  app.exit(failures ? 1 : 0);
}
