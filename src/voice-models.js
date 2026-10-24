// Speech models for the Claude voice engine (beta), downloaded only when the user turns it on:
// Silero VAD (hears when you start and stop talking), Moonshine base (speech to text) and Kitten
// nano (text to speech). About 175 MB from sherpa-onnx's GitHub releases, each file checked
// against a pinned SHA-256 before it's unpacked or used. Nothing is downloaded otherwise.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tarPath } from './platform/system.js';

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

// ---------------------------------------------------------------- speech-to-text choices
//
// Claude voice's speech to text (Settings → Voice engine → Speech to text). Moonshine base comes with
// the download above and is always the fallback; the others download when chosen, each checked
// against a pinned SHA-256 like the rest. (Grok's engine transcribes on xAI's side: this is Claude
// voice only.)
//
// Measured on the owner's PC (2026-10-24, CPU, 4 threads) on 41 utterances from a real recorded
// session, the same made quieter and muffled ("mumbled"), and 26 synthetic commands. Word error rate
// against a large Whisper reference, and mean time to transcribe one utterance:
//   Moonshine base          owner 14%, mumbled 21%   about 0.1 s
//   Parakeet TDT-CTC 110M   owner 13%, mumbled 16%   about 0.1 s
//   Parakeet TDT 0.6B v2    owner 11%, mumbled 13%   about 0.4 s
// (Whisper small and distil-small and SenseVoice were measured too: slower for no gain, or less accurate.)
export const STT_MODELS = Object.freeze({
  moonshine: Object.freeze({ label: 'Moonshine base', bundled: true, maxSeconds: 8, mb: 0 }),
  'parakeet-110m': Object.freeze({
    label: 'Parakeet 110M',
    file: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2',
    dir: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8',
    url: `${BASE}/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2`,
    sha256: '17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b',
    size: 104337827,
    files: ['model.int8.onnx', 'tokens.txt'],
    maxSeconds: 28,
  }),
  'parakeet-v2': Object.freeze({
    label: 'Parakeet 0.6B v2',
    file: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    url: `${BASE}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    size: 482468385,
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    maxSeconds: 28,
  }),
});
export const STT_IDS = Object.freeze(Object.keys(STT_MODELS));
export const sttOk = (id) => typeof id === 'string' && Object.hasOwn(STT_MODELS, id);

/** sherpa-onnx's modelConfig for a speech-to-text choice (Moonshine: the bundled one). */
export function sttModelConfig(root, id) {
  if (!sttOk(id) || id === 'moonshine') {
    const p = modelPaths(root).stt;
    return { moonshine: { encoder: p.encoder, mergedDecoder: p.mergedDecoder }, tokens: p.tokens };
  }
  const d = path.join(root, STT_MODELS[id].dir);
  if (id === 'parakeet-110m') return { nemoCtc: { model: path.join(d, 'model.int8.onnx') }, tokens: path.join(d, 'tokens.txt') };
  return { transducer: { encoder: path.join(d, 'encoder.int8.onnx'), decoder: path.join(d, 'decoder.int8.onnx'), joiner: path.join(d, 'joiner.int8.onnx') }, tokens: path.join(d, 'tokens.txt'), modelType: 'nemo_transducer' };
}

/** Is this speech-to-text choice on disk and verified? (Moonshine: with the rest of Claude voice.) */
export function sttReady(root, id) {
  if (!sttOk(id) || !root) return false;
  const m = STT_MODELS[id];
  if (m.bundled) return modelsReady(root);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, m.dir, 'verified.json'), 'utf8'));
    return marker?.sha256 === m.sha256 && m.files.every((f) => fs.existsSync(path.join(root, m.dir, f)));
  } catch {
    return false;
  }
}

const sttJobs = new Map(); // id -> promise
const sttProgress = new Map(); // id -> { state, percent, error }

/** { [id]: { state: 'idle' | 'downloading' | 'ready' | 'error', percent, error, mb } } */
export function sttStatus(root) {
  const out = {};
  for (const id of STT_IDS) {
    const p = sttProgress.get(id);
    const mb = Math.round((STT_MODELS[id].size || 0) / 1048576);
    out[id] = p?.state === 'downloading' ? { ...p, mb } : sttReady(root, id) ? { state: 'ready', percent: 100, error: '', mb } : { ...(p || { state: 'idle', percent: 0, error: '' }), mb };
  }
  return out;
}

/** Download, verify and unpack one speech-to-text choice into `root` (one job per model at a time). */
export function downloadStt(root, id, { fetchImpl = fetch, log = () => {} } = {}) {
  if (!sttOk(id)) return Promise.reject(new Error('Unknown speech-to-text model'));
  const m = STT_MODELS[id];
  if (m.bundled) return downloadModels(root, { fetchImpl, log });
  if (sttReady(root, id)) return Promise.resolve();
  if (sttJobs.has(id)) return sttJobs.get(id);
  sttProgress.set(id, { state: 'downloading', percent: 0, error: '' });
  const job = (async () => {
    fs.mkdirSync(root, { recursive: true });
    const dest = path.join(root, m.file);
    const part = `${dest}.part`;
    const res = await fetchImpl(m.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    const out = fs.createWriteStream(part);
    let got = 0;
    try {
      for await (const chunk of res.body) {
        got += chunk.length;
        if (got > m.size * 1.01 + 1024) throw new Error('Download was larger than expected');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        sttProgress.set(id, { state: 'downloading', percent: Math.min(99, Math.floor((got / m.size) * 100)), error: '' });
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    const hash = await sha256File(part);
    if (hash !== m.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`${m.label} failed its checksum`);
    }
    fs.renameSync(part, dest);
    fs.rmSync(path.join(root, m.dir), { recursive: true, force: true });
    await untar(dest, root);
    fs.rmSync(dest, { force: true });
    if (!m.files.every((f) => fs.existsSync(path.join(root, m.dir, f)))) throw new Error(`${m.label} unpacked without its model files`);
    fs.writeFileSync(path.join(root, m.dir, 'verified.json'), JSON.stringify({ at: new Date().toISOString(), sha256: m.sha256 }));
    sttProgress.set(id, { state: 'ready', percent: 100, error: '' });
    log(`Claude voice: ${m.label} ready`);
  })()
    .catch((e) => {
      sttProgress.set(id, { state: 'error', percent: 0, error: String(e?.message || e).slice(0, 200) });
      throw e;
    })
    .finally(() => sttJobs.delete(id));
  sttJobs.set(id, job);
  return job;
}
