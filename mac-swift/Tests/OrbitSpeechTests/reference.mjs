// The Node core's speech, as the reference for OrbitSpeechTests: transcripts of the parity clips and
// Kitten's samples for a phrase, made by src/claude-voice.js loadSpeech with the same models.
//   node reference.mjs <models> <clips dir> <out.json>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const [models, clips, out] = process.argv.slice(2);
const { loadSpeech } = await import(pathToFileURL(path.join(ROOT, 'src', 'claude-voice.js')).href);
const sherpa = createRequire(path.join(ROOT, 'package.json'))('sherpa-onnx-node');
const speech = await loadSpeech(models);
const readWav = (f) => {
  const b = fs.readFileSync(f);
  const n = (b.length - 44) / 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(44 + i * 2) / 32768;
  return s;
};
const transcripts = {};
for (const f of fs.readdirSync(clips).filter((x) => x.endsWith('.wav')).sort()) {
  const s24 = readWav(path.join(clips, f));
  transcripts[f] = await speech.transcribe(new sherpa.LinearResampler(24000, 16000).flush(s24));
}
const phrase = "Hi, I'm Orbit. Tell me what you need.";
const tts = await speech.speak(phrase, { sid: 0, speed: 1 });
fs.writeFileSync(out, JSON.stringify({ transcripts, phrase, ttsLength: tts.length, tts: Buffer.from(tts.buffer, tts.byteOffset, tts.byteLength).toString('base64') }));
