#!/usr/bin/env node
// Downloads Claude voice's speech models (VAD, Moonshine, Kitten TTS; pinned checksums, about
// 175 MB) once into a cache the parity runner links into each test profile:
//   node parity/fetch-voice-models.mjs [folder]     (default ~/orbit-swift-dev/voice-models)
import os from 'node:os';
import path from 'node:path';
import { downloadModels, modelsReady } from '../src/voice-models.js';

const dir = path.resolve(process.argv[2] || path.join(os.homedir(), 'orbit-swift-dev', 'voice-models'));
if (modelsReady(dir)) {
  console.log(`speech models ready: ${dir}`);
} else {
  await downloadModels(dir, { log: (m) => console.log(m) });
  console.log(modelsReady(dir) ? `speech models ready: ${dir}` : 'download finished but the models are not complete');
}
