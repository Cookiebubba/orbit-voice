// A bridge for checking the Swift voice client (VoiceDemo) by hand or from a script: Orbit's real
// bridge (src/server.js) in a throwaway profile, talking to the stand-in Grok
// (test/e2e/fake-grok.mjs), never xAI. HOME points into the profile too, so the user's own Claude
// sessions and settings are never read.
//
//   node mac-swift/scripts/voice-check-bridge.mjs [--port 4551] [--engine grok|claude] [--models <dir>] [--claude <exe>]
//
// Prints one line `READY {"base":..., "auth":..., "control":...}`. The control port (port + 1):
//   GET  /fake                 what the stand-in Grok saw (counts, tool calls and results, close codes)
//   POST /fake/say   {text, tools: [{name, args}]}   the user "says" something (speech events + a reply)
//   POST /fake/drop            drop the current Grok connection (the bridge sees 1006)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opt = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(opt('port', 4551));
const ENGINE = opt('engine', 'grok');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-voice-check-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
const profile = path.join(tmp, 'profile');
fs.mkdirSync(profile, { recursive: true });
// A fake key (the stand-in Grok accepts anything); stored as the dev build stores it.
fs.writeFileSync(path.join(profile, '.env'), `XAI_API_KEY=xai-voicecheck${'x'.repeat(40)}\n`);
const settings = { announce: 'speak', voiceEngine: ENGINE, wakeWord: false };
// --volume 0: the audio engine really runs and plays, silently (checks without sound).
if (opt('volume', '') !== '') settings.voiceVolume = Number(opt('volume', ''));
if (ENGINE === 'claude') {
  // Speech models: linked from a folder that has them (never downloaded here).
  const models = opt('models', '');
  if (models) fs.symlinkSync(models, path.join(profile, 'claude-voice-models'));
  if (opt('claude', '')) settings.brainClaudePath = opt('claude', '');
}
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings, null, 2));

const { createFakeGrok } = await import(path.join(ROOT, 'test/e2e/fake-grok.mjs'));
const { makeGen } = await import(path.join(ROOT, 'test/fuzz/gen.mjs'));
const fake = createFakeGrok({ g: makeGen(Number(opt('seed', 7))) });
await fake.ready;
process.env.XAI_REALTIME_URL = fake.url;
process.env.PORT = String(PORT);
const { startServer, authUrl } = await import(path.join(ROOT, 'src/server.js'));
const base = await startServer({ port: PORT, configDir: profile });

const snapshot = () => ({
  conns: fake.conns.map((c) => ({
    id: c.id,
    wake: c.isWake,
    appends: c.appends,
    responses: c.responses.length,
    audioChunks: c.responses.reduce((n, r) => n + r.audioChunks, 0),
    audioSentMs: c.audioSentMs,
    cancels: c.cancels.length,
    toolCalls: c.toolCalls.map((t) => ({ name: t.name, result: t.result === undefined ? null : Object.keys(t.result || {}) })),
    typed: c.utterances.filter((u) => u.typed).length,
    open: c.ws.readyState === 1,
    closeCode: c.closeCode,
  })),
});

const body = (req) => new Promise((r) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => {
    try { r(JSON.parse(s || '{}')); } catch { r({}); }
  });
});
const control = http.createServer(async (req, res) => {
  const send = (o) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
  if (req.method === 'GET' && req.url === '/fake') return send(snapshot());
  if (req.method === 'POST' && req.url === '/fake/say') {
    const b = await body(req);
    const u = await fake.userSays(fake.current(), String(b.text || 'hello'), { tools: b.tools || [] });
    return send({ ok: !!u });
  }
  if (req.method === 'POST' && req.url === '/fake/drop') {
    fake.drop(fake.current());
    return send({ ok: true });
  }
  res.writeHead(404);
  res.end();
});
control.listen(PORT + 1, '127.0.0.1', () => {
  console.log(`READY ${JSON.stringify({ base, auth: authUrl('main'), control: `http://127.0.0.1:${PORT + 1}`, profile })}`);
});
const quit = () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
};
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
