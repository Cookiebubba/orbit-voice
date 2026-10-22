// Voice-to-voice latency of Claude voice (beta), measured through the real bridge:
//   node scripts/claude-voice-latency.mjs
//
// Starts its own bridge (port 4395, a throwaway settings folder), turns on Claude voice, downloads
// the speech models with the real downloader (or reuses CLAUDE_VOICE_MODELS_FROM, a folder that
// already holds a verified download), then acts as Orbit's page: it streams spoken questions into
// /voice in real time, like a microphone, followed by silence, and times from the end of each
// question's speech to the first audio that comes back.
//
// Uses the real Claude Code on this PC with your own sign-in (a few short Haiku turns) and the
// real tools (reading your Claude sessions, read-only). Prints numbers and the transcripts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { authUrl, startServer, stopBackgroundWork } from '../src/server.js';
import { loadSpeech } from '../src/claude-voice.js';

const PORT = Number(process.env.LATENCY_PORT || 4395);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-claude-voice-'));
const modelsDir = path.join(tmp, 'claude-voice-models');
if (process.env.CLAUDE_VOICE_MODELS_FROM) fs.cpSync(process.env.CLAUDE_VOICE_MODELS_FROM, modelsDir, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

const base = await startServer({ port: PORT, configDir: tmp });
const signIn = await fetch(authUrl(), { redirect: 'manual' });
const cookie = String(signIn.headers.get('set-cookie') || '').split(';')[0];
const api = (p, body) => fetch(`${base}${p}`, { method: body ? 'POST' : 'GET', headers: { cookie, origin: base, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

await api('/api/settings', { voiceEngine: 'claude', speed: 1.2 });
let st = await api('/api/claude-voice');
if (st.models.state !== 'ready') {
  log(`downloading speech models (${st.mb} MB)…`);
  await api('/api/claude-voice/download', {});
  const dlStart = Date.now();
  for (;;) {
    await wait(1000);
    st = await api('/api/claude-voice');
    if (st.models.state === 'ready' || st.models.state === 'error') break;
  }
  log(`models: ${st.models.state} in ${((Date.now() - dlStart) / 1000).toFixed(0)}s ${st.models.error || ''}`);
  if (st.models.state !== 'ready') process.exit(1);
  await api('/api/settings', { voiceEngine: 'claude' }); // warms Claude Code + loads the models
}

// The questions, spoken by the same TTS in another voice (24 kHz pcm16).
const speech = await loadSpeech(modelsDir);
const QUESTIONS = [
  { text: 'What is the capital of France?' },
  { text: 'Give me one quick tip for writing good commit messages.' },
  { text: 'What is Claude working on right now?', tool: true },
  { text: 'Thanks. How do I undo my last git commit but keep the changes?' },
  { text: 'Why might a web socket close with code ten oh six?' },
  { text: 'Is it better to use tabs or spaces?' },
  { text: 'What does a closure mean in JavaScript?' },
  { text: 'Okay, that is all for now.' },
];
for (const q of QUESTIONS) {
  const f = await speech.speak(q.text, { speed: 1, sid: 3 });
  const b = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767 * 0.8))), i * 2);
  q.pcm = b;
}
log('waiting 6 s for the warm Claude Code to be ready');
await wait(6000);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/voice`, { headers: { cookie, origin: base } });
const events = [];
ws.on('message', (d) => events.push({ at: Date.now(), e: JSON.parse(String(d)) }));
await new Promise((resolve, reject) => {
  ws.on('error', reject);
  const check = setInterval(() => {
    if (events.some((x) => x.e.type === 'bridge.ready')) (clearInterval(check), resolve());
    const err = events.find((x) => x.e.type === 'bridge.error');
    if (err) (clearInterval(check), reject(new Error(err.e.message)));
  }, 50);
});
log('connected');

const CHUNK = 960; // 20 ms at 24 kHz, like the page's mic chunks
const send = (buf) => ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
const silence = Buffer.alloc(CHUNK * 2);
async function streamPaced(buf) {
  const start = Date.now();
  let sent = 0;
  for (let i = 0; i < buf.length; i += CHUNK * 2) {
    send(buf.subarray(i, i + CHUNK * 2));
    sent++;
    const due = start + sent * 20;
    if (due > Date.now()) await wait(due - Date.now());
  }
}
/** Silence (like a quiet mic) until the reply and anything after it has finished. */
async function silenceUntilQuiet(fromIdx, maxMs = 25000) {
  const start = Date.now();
  let n = 0;
  let lastActivity = Date.now();
  for (;;) {
    send(silence);
    n++;
    const due = start + n * 20;
    if (due > Date.now()) await wait(due - Date.now());
    const recent = events.slice(fromIdx).filter((x) => /^response\.|bridge\.tool/.test(x.e.type));
    if (recent.length) lastActivity = Math.max(lastActivity, recent.at(-1).at);
    const done = recent.some((x) => x.e.type === 'response.done');
    if (done && Date.now() - lastActivity > 2500) return;
    if (Date.now() - start > maxMs) return;
  }
}

const rows = [];
await streamPaced(Buffer.alloc(CHUNK * 2 * 25)); // half a second of quiet first
for (const q of QUESTIONS) {
  const from = events.length;
  await streamPaced(q.pcm);
  await silenceUntilQuiet(from);
  const ev = events.slice(from);
  // The end of your speech as the voice detector placed it in the audio stream (exact to ~30 ms).
  const stopped = ev.find((x) => x.e.type === 'input_audio_buffer.speech_stopped');
  const speechEnd = stopped ? stopped.at - (stopped.e.ended_ms_ago || 0) : Date.now();
  const firstAudio = ev.find((x) => x.e.type === 'response.output_audio.delta');
  // The answer itself: the first audio of a reply that has words (not a reflex "One sec.").
  const answered = new Set(ev.filter((x) => x.e.type === 'response.output_audio_transcript.done' && x.e.transcript).map((x) => x.e.response_id));
  const answerAudio = ev.find((x) => x.e.type === 'response.output_audio.delta' && answered.has(x.e.response_id) && !x.e.reflex);
  const heard = ev.find((x) => x.e.type === 'conversation.item.input_audio_transcription.completed');
  const said = ev.filter((x) => x.e.type === 'response.output_audio_transcript.done').map((x) => x.e.transcript).filter(Boolean);
  const tools = ev.filter((x) => x.e.type === 'bridge.tool').map((x) => x.e.name);
  const secs = (x) => (x ? `${((x.at - speechEnd) / 1000).toFixed(2)}s` : 'none');
  rows.push({ question: q.text, heard: heard?.e.transcript, firstAudio: firstAudio ? firstAudio.at - speechEnd : null, answerAudio: answerAudio ? answerAudio.at - speechEnd : null, tools, reply: said.join(' / ') });
  log(`Q: ${q.text}`);
  log(`   heard: "${heard?.e.transcript}" (transcript ${secs(heard)})`);
  log(`   first audio ${secs(firstAudio)}, answer audio ${secs(answerAudio)} after you stopped${tools.length ? `, tools: ${tools.join(', ')}` : ''}`);
  log(`   reply: ${said.join(' / ')}`);
}

ws.close();
await wait(500);
const logFile = path.join(tmp, 'logs', 'orbit.log');
const turns = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('Claude voice turn')) : [];
console.log('\nBridge timings per turn (from the engine):');
for (const l of turns) {
  const j = JSON.parse(l);
  console.log(`  ${j.message.replace('Claude voice turn: ', '')} (${j.detail})`);
}
const fmt = (xs) => xs.filter((x) => x != null).map((x) => `${(x / 1000).toFixed(2)}s`).join(', ');
console.log(`\nVoice to voice, from the end of your speech:`);
console.log(`  first audio back:  ${fmt(rows.map((r) => r.firstAudio))}`);
console.log(`  the answer itself: ${fmt(rows.map((r) => r.answerAudio))}`);
console.log(`models kept at: ${modelsDir}`);
stopBackgroundWork();
setTimeout(() => process.exit(0), 1500);
