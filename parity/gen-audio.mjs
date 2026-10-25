#!/usr/bin/env node
// Makes the voice scenarios' clips (parity/voice-clips.json) with Claude voice's own text to speech
// (Kitten, on this Mac) and checks each one with its speech to text (Moonshine), so a scenario never
// fails because the clip itself was unclear. WAV, 24 kHz mono 16-bit, with silence around the words
// (a lead-in, and enough after for the end of the turn to be heard).
//   node parity/gen-audio.mjs [--models <folder>] [--out <folder>]
// Defaults: ~/orbit-swift-dev/voice-models, parity/out/audio. Does nothing for clips already made.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadSpeech } from '../src/claude-voice.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const opt = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const models = path.resolve(opt('models', path.join(os.homedir(), 'orbit-swift-dev', 'voice-models')));
const out = path.resolve(opt('out', path.join(HERE, 'out', 'audio')));
const RATE = 24000;

export function wav(samples, rate = RATE) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { clips } = JSON.parse(fs.readFileSync(path.join(HERE, 'voice-clips.json'), 'utf8'));
  fs.mkdirSync(out, { recursive: true });
  const speech = await loadSpeech(models);
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  let bad = 0;
  for (const c of clips) {
    const file = path.join(out, `${c.id}.wav`);
    if (fs.existsSync(file)) continue;
    const words = await speech.speak(c.text, { sid: c.sid ?? 3, speed: 1 });
    const pad = (s) => new Float32Array(Math.round(RATE * s));
    const all = new Float32Array(pad(0.4).length + words.length + pad(1.6).length);
    all.set(words, pad(0.4).length);
    const heard = await speech.transcribe(new sherpa.LinearResampler(RATE, 16000).flush(words));
    const ok = heard.toLowerCase().includes(c.expect.toLowerCase());
    console.log(`${ok ? 'ok ' : 'BAD'} ${c.id}: "${heard.trim()}" (${(words.length / RATE).toFixed(2)} s)`);
    if (!ok) {
      bad++;
      continue;
    }
    fs.writeFileSync(file, wav(all));
  }
  process.exit(bad ? 1 : 0);
}
