// Unit & integration tests for the Alfred persona and Kokoro English local TTS pack.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentContext, CONTEXT_SETTINGS } from '../src/agent.js';
import { DEFAULTS, initConfig, sanitizeSettings, updateSettings } from '../src/config.js';
import { PERSONA_IDS, PERSONA_PRESETS, personaOk, personaPrompt } from '../src/personas.js';
import { KOKORO_EN_VOICES, TTS_IDS, TTS_MODELS, ttsModelConfig, ttsOk, ttsReady, ttsStatus } from '../src/voice-models.js';

const memStore = (initial = '') => {
  let v = initial;
  return { kind: 'mem', get: () => v, set: (k) => (v = k) };
};

test('personas: default vs Alfred catalog, validation, and Gemini Live accent guidance', () => {
  assert.deepEqual(PERSONA_IDS, ['default', 'alfred']);
  assert.equal(personaOk('default'), true);
  assert.equal(personaOk('alfred'), true);
  assert.equal(personaOk('jarvis'), false);
  assert.equal(personaPrompt('default'), '');

  const standard = personaPrompt('alfred', { engine: 'claude' });
  assert.match(standard, /Alfred/);
  assert.match(standard, /aristocratic British/i);
  assert.doesNotMatch(standard, /Received Pronunciation/);

  const live = personaPrompt('alfred', { engine: 'gemini-live' });
  assert.match(live, /Alfred/);
  assert.match(live, /Received Pronunciation/);

  assert.equal(PERSONA_PRESETS.alfred.recommended.claudeVoiceTts, 'kokoro-en');
  assert.equal(PERSONA_PRESETS.alfred.recommended.kokoroVoice, 9);
  assert.equal(PERSONA_PRESETS.alfred.recommended.geminiVoice, 'Charon');
});

test('voice-models: Kokoro English TTS pack catalog, speaker 9 (bm_george), config, and readiness', () => {
  assert.deepEqual(TTS_IDS, ['kitten', 'kokoro-en']);
  assert.equal(ttsOk('kitten'), true);
  assert.equal(ttsOk('kokoro-en'), true);
  assert.equal(ttsOk('unknown'), false);

  const george = KOKORO_EN_VOICES.find((v) => v.id === '9');
  assert.ok(george, 'bm_george (sid 9) present');
  assert.equal(george.speaker, 'bm_george');
  assert.equal(george.accent, 'british');
  assert.equal(KOKORO_EN_VOICES.length, 11);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-kokoro-'));
  try {
    assert.equal(ttsReady(dir, 'kokoro-en'), false);
    const cfg = ttsModelConfig(dir, 'kokoro-en');
    assert.ok(cfg.kokoro.model.endsWith(path.join('kokoro-int8-en-v0_19', 'model.int8.onnx')));
    assert.ok(cfg.kokoro.voices.endsWith('voices.bin'));
    assert.ok(cfg.kokoro.tokens.endsWith('tokens.txt'));
    assert.ok(cfg.kokoro.dataDir.endsWith('espeak-ng-data'));

    // Fake verified unpack
    const kDir = path.join(dir, TTS_MODELS['kokoro-en'].dir);
    fs.mkdirSync(kDir, { recursive: true });
    for (const f of TTS_MODELS['kokoro-en'].files) fs.writeFileSync(path.join(kDir, f), 'ok');
    fs.writeFileSync(path.join(kDir, 'verified.json'), JSON.stringify({ sha256: TTS_MODELS['kokoro-en'].sha256 }));
    assert.equal(ttsReady(dir, 'kokoro-en'), true);
    const st = ttsStatus(dir);
    assert.equal(st['kokoro-en'].state, 'ready');
    assert.equal(st['kokoro-en'].percent, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config + agentContext: Alfred persona injects cleanly and CONTEXT_SETTINGS tracks persona', () => {
  assert.equal(DEFAULTS.persona, 'default');
  assert.equal(DEFAULTS.claudeVoiceTts, 'kitten');
  assert.equal(DEFAULTS.kokoroVoice, 9);
  assert.ok(CONTEXT_SETTINGS.includes('persona'));

  assert.deepEqual(sanitizeSettings({ persona: 'alfred', claudeVoiceTts: 'kokoro-en', kokoroVoice: 10 }), {
    persona: 'alfred',
    claudeVoiceTts: 'kokoro-en',
    kokoroVoice: 10,
  });
  assert.deepEqual(sanitizeSettings({ persona: 'jarvis', claudeVoiceTts: 'bogus', kokoroVoice: 99 }), {});

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-alfred-cfg-'));
  try {
    initConfig({ dir, secrets: memStore(), brainSecrets: memStore(), geminiSecrets: memStore(), t3Secrets: memStore() });
    updateSettings({ persona: 'alfred', voiceEngine: 'gemini-live', avatar: 'qubit' });
    const ctx = agentContext({ face: 'qubit', avatar: 'qubit', orb: false });
    assert.match(ctx.instructions, /Who you are \(Alfred\)/);
    assert.match(ctx.instructions, /Received Pronunciation/);
    // Qubit's physical body rules stay intact while Alfred is the speaking persona.
    assert.match(ctx.instructions, /Your body \(Qubit/);

    updateSettings({ persona: 'default' });
    const defCtx = agentContext({ face: 'qubit', avatar: 'qubit', orb: false });
    assert.doesNotMatch(defCtx.instructions, /Who you are \(Alfred\)/);
    assert.match(defCtx.instructions, /You are Qubit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
