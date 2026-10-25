// Does Claude voice's on-device speech stack work on this machine (sherpa-onnx: Silero VAD,
// Moonshine and Parakeet speech to text, Kitten text to speech)? Downloads the models into a folder
// of your choice if they aren't there (checked against their SHA-256), then: Kitten says a sentence,
// the VAD finds the speech in it, and each recognizer writes it back. No microphone, no network
// beyond the model download, nothing sent anywhere.
//
//   node scripts/voice-stack-check.mjs <models folder> [--stt parakeet-110m]
//
// Exits 0 when every recognizer got most of the words back.

import fs from 'node:fs';
import path from 'node:path';
import { loadRecognizer, loadSpeech } from '../src/claude-voice.js';
import { downloadModels, downloadStt, modelsReady, sttReady } from '../src/voice-models.js';

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: node scripts/voice-stack-check.mjs <models folder> [--stt parakeet-110m]');
  process.exit(2);
}
const sttIds = process.argv.includes('--stt') ? [process.argv[process.argv.indexOf('--stt') + 1]] : [];
fs.mkdirSync(root, { recursive: true });

const t = () => Date.now();
const SENTENCE = 'Please open the release notes and run the tests on my Mac.';
const words = (s) => String(s).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
const overlap = (a, b) => {
  const want = words(a);
  const got = new Set(words(b));
  return want.filter((w) => got.has(w)).length / Math.max(1, want.length);
};

let t0 = t();
if (!modelsReady(root)) {
  console.log('downloading the speech models…');
  await downloadModels(root, { log: () => {} });
}
for (const id of sttIds) if (!sttReady(root, id)) await downloadStt(root, id, { log: () => {} });
console.log(`models ready (${t() - t0} ms)`);

t0 = t();
const speech = await loadSpeech(root);
console.log(`loaded VAD + Moonshine + Kitten (${t() - t0} ms) on ${process.platform}-${process.arch}`);

t0 = t();
const audio = await speech.speak(SENTENCE);
console.log(`Kitten spoke ${(audio.length / 24000).toFixed(2)} s of audio (${t() - t0} ms)`);

// The VAD (16 kHz, as the microphone path feeds it).
const resampler = speech.newResampler();
const pcm16 = resampler.flush(audio);
const vad = speech.newVad();
const WINDOW = 512;
let segments = 0;
let heard = [];
const pad = new Float32Array(16000); // a second of silence after it, so the VAD closes the segment
const all = new Float32Array(pcm16.length + pad.length);
all.set(pcm16, 0);
for (let i = 0; i + WINDOW <= all.length; i += WINDOW) {
  vad.acceptWaveform(all.subarray(i, i + WINDOW));
  while (!vad.isEmpty()) {
    const seg = vad.front();
    heard.push(seg.samples);
    segments++;
    vad.pop();
  }
}
vad.flush?.();
while (!vad.isEmpty()) {
  heard.push(vad.front().samples);
  segments++;
  vad.pop();
}
const speechSamples = heard.reduce((n, s) => n + s.length, 0);
console.log(`VAD: ${segments} segment(s), ${(speechSamples / 16000).toFixed(2)} s of speech`);
const joined = new Float32Array(speechSamples);
let at = 0;
for (const s of heard) {
  joined.set(s, at);
  at += s.length;
}

let ok = segments > 0;
t0 = t();
const text = await speech.transcribe(joined.length ? joined : pcm16);
const score = overlap(SENTENCE, text);
console.log(`Moonshine (${t() - t0} ms): "${text}" (${Math.round(score * 100)}% of the words)`);
ok = ok && score >= 0.7;
for (const id of sttIds) {
  const rec = await loadRecognizer(root, id);
  t0 = t();
  const txt = await rec.transcribe(joined.length ? joined : pcm16);
  const s = overlap(SENTENCE, txt);
  console.log(`${id} (${t() - t0} ms): "${txt}" (${Math.round(s * 100)}% of the words)`);
  ok = ok && s >= 0.7;
}
console.log(ok ? 'VOICE STACK OK' : 'VOICE STACK FAILED');
process.exit(ok ? 0 : 1);
