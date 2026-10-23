// Speech models for the Claude voice engine (beta), downloaded only when the user turns it on:
// Silero VAD (hears when you start and stop talking), Moonshine base (speech to text) and Kitten
// nano (text to speech). About 175 MB from sherpa-onnx's GitHub releases, each file checked
// against a pinned SHA-256 before it's unpacked or used. Nothing is downloaded otherwise.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tarPath } from './platform.js';

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export const VOICE_MODELS = Object.freeze([
  { id: 'vad', file: 'silero_vad.onnx', url: `${BASE}/asr-models/silero_vad.onnx`, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6', size: 643854 },
  {
    id: 'stt',
    file: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2',
    dir: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27',
    url: `${BASE}/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`,
    sha256: '43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891',
    size: 111266225,
  },
  {
    id: 'tts',
    file: 'kitten-nano-en-v0_8-fp32.tar.bz2',
    dir: 'kitten-nano-en-v0_8-fp32',
    url: `${BASE}/tts-models/kitten-nano-en-v0_8-fp32.tar.bz2`,
    sha256: '16092117bfe591ddcd58d078e1454603b8e1caea46f85653b2c2efae76bd883e',
    size: 63815222,
  },
]);
export const VOICE_MODELS_MB = Math.round(VOICE_MODELS.reduce((n, m) => n + m.size, 0) / 1048576);

/** Paths the engine loads, under `root`. */
export function modelPaths(root) {
  const stt = path.join(root, VOICE_MODELS[1].dir);
  const tts = path.join(root, VOICE_MODELS[2].dir);
  return {
    vad: path.join(root, VOICE_MODELS[0].file),
    stt: { encoder: path.join(stt, 'encoder_model.ort'), mergedDecoder: path.join(stt, 'decoder_model_merged.ort'), tokens: path.join(stt, 'tokens.txt') },
    tts: { model: path.join(tts, 'model.fp32.onnx'), voices: path.join(tts, 'voices.bin'), tokens: path.join(tts, 'tokens.txt'), dataDir: path.join(tts, 'espeak-ng-data') },
  };
}

/** True when every model is unpacked and verified (a marker is written only after all checks pass). */
export function modelsReady(root) {
  if (!root) return false;
  try {
    const p = modelPaths(root);
    return fs.existsSync(path.join(root, 'verified.json')) && [p.vad, p.stt.encoder, p.stt.mergedDecoder, p.tts.model, p.tts.voices].every((f) => fs.existsSync(f));
  } catch {
    return false;
  }
}

// Windows' own tar.exe by full path (a tar planted on PATH is never used); /usr/bin/tar on macOS.
const TAR = tarPath();

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject));
  return h.digest('hex');
}

function untar(archive, into) {
  return new Promise((resolve, reject) => {
    const child = spawn(TAR, ['-xjf', archive, '-C', into], { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking failed (tar exit ${code})`))));
  });
}

let job = null; // one download at a time
let progress = { state: 'idle', percent: 0, error: '' };

/** { state: 'idle' | 'downloading' | 'ready' | 'error', percent, error } */
export function downloadStatus(root) {
  if (progress.state !== 'downloading' && modelsReady(root)) return { state: 'ready', percent: 100, error: '' };
  return { ...progress };
}

/**
 * Download, verify and unpack every model into `root`. Resolves when done (or rejects); calling it
 * again while it runs returns the same job. `fetchImpl` is for tests.
 */
export function downloadModels(root, { fetchImpl = fetch, log = () => {} } = {}) {
  if (modelsReady(root)) return Promise.resolve();
  if (job) return job;
  const total = VOICE_MODELS.reduce((n, m) => n + m.size, 0);
  let done = 0;
  progress = { state: 'downloading', percent: 0, error: '' };
  job = (async () => {
    fs.mkdirSync(root, { recursive: true });
    for (const m of VOICE_MODELS) {
      const dest = path.join(root, m.file);
      const part = `${dest}.part`;
      const res = await fetchImpl(m.url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
      const out = fs.createWriteStream(part);
      let got = 0;
      for await (const chunk of res.body) {
        got += chunk.length;
        if (got > m.size * 1.01 + 1024) throw new Error('Download was larger than expected');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        progress.percent = Math.min(99, Math.floor(((done + got) / total) * 100));
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      const hash = await sha256File(part);
      if (hash !== m.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error(`${m.id} model failed its checksum`);
      }
      fs.renameSync(part, dest);
      if (m.dir) {
        fs.rmSync(path.join(root, m.dir), { recursive: true, force: true });
        await untar(dest, root);
        fs.rmSync(dest, { force: true });
      }
      done += m.size;
      log(`Claude voice: ${m.id} model ready`);
    }
    fs.writeFileSync(path.join(root, 'verified.json'), JSON.stringify({ at: new Date().toISOString(), models: VOICE_MODELS.map((m) => m.sha256) }));
    progress = { state: 'ready', percent: 100, error: '' };
  })()
    .catch((e) => {
      progress = { state: 'error', percent: 0, error: String(e?.message || e).slice(0, 200) };
      throw e;
    })
    .finally(() => {
      job = null;
    });
  return job;
}
