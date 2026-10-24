// Long speech in pieces (src/stt-chunks.js): Moonshine answers nothing past ~9 s, so long speech is
// cut at quiet moments into pieces it can take. With the real models on this PC (Claude voice's
// download), a 20-second utterance must still come back as words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { joinTranscripts, splitForStt } from '../src/stt-chunks.js';

const RATE = 16000;
/** "Speech" (a tone) with silent gaps at the given seconds. */
function speech(seconds, gaps = []) {
  const x = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  for (const g of gaps) x.fill(0, Math.round(g * RATE), Math.round((g + 0.3) * RATE));
  return x;
}

test('short speech is one piece; long speech is cut into pieces under the limit, at the quiet gaps', () => {
  assert.equal(splitForStt(speech(5), 8).length, 1);
  const long = speech(20, [6.5, 13.0]);
  const pieces = splitForStt(long, 8);
  assert.ok(pieces.length >= 3, `${pieces.length} pieces`);
  for (const p of pieces) assert.ok(p.length <= 8 * RATE, `a piece of ${(p.length / RATE).toFixed(1)} s`);
  assert.equal(pieces.reduce((n, p) => n + p.length, 0), long.length, 'nothing lost or doubled');
  // The first cut lands in the silent gap at 6.5 s (6.5 to 6.8).
  const first = pieces[0].length / RATE;
  assert.ok(first > 6.4 && first < 6.9, `first cut at ${first.toFixed(2)} s`);
  assert.equal(joinTranscripts([' hello ', '', 'there  you are ']), 'hello there you are');
});

const models = path.join(process.env.APPDATA || '', 'Orbit', 'claude-voice-models');
const moon = path.join(models, 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27');
test('with the real Moonshine: 20 s of speech comes back as words, not nothing', { skip: !fs.existsSync(path.join(moon, 'test_wavs', '0.wav')) && 'Claude voice models not downloaded here' }, async () => {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: RATE, featureDim: 80 }, modelConfig: { moonshine: { encoder: path.join(moon, 'encoder_model.ort'), mergedDecoder: path.join(moon, 'decoder_model_merged.ort') }, tokens: path.join(moon, 'tokens.txt'), numThreads: 2 } });
  const w = sherpa.readWave(path.join(moon, 'test_wavs', '0.wav'));
  const one = w.sampleRate === RATE ? w.samples : new sherpa.LinearResampler(w.sampleRate, RATE).flush(w.samples);
  const gap = new Float32Array(RATE / 2);
  const parts = [];
  for (let t = 0; t < 20 * RATE; t += one.length + gap.length) parts.push(one, gap);
  const long = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (long.set(p, at), (at += p.length));
  const decode = (s) => {
    const st = rec.createStream();
    st.acceptWaveform({ samples: s, sampleRate: RATE });
    rec.decode(st);
    return String(rec.getResult(st).text || '').trim();
  };
  const whole = decode(long);
  const pieced = joinTranscripts(splitForStt(long, 8).map(decode));
  assert.ok(pieced.split(/\s+/).length >= 10, `pieced: ${pieced.length} chars`);
  // (What the old path got: usually nothing at all for this length.)
  assert.ok(pieced.length > whole.length, 'pieces recover what one long decode loses');
});
