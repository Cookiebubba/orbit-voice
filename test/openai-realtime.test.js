import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenAIRealtime, normalizeOpenAI, openaiSession } from '../src/openai-realtime.js';
import { engineFor, initConfig, getSetting, getOpenAIKey, setOpenAIKey, updateSettings } from '../src/config.js';
import { canTalk, talkNotice } from '../ui/src/talk.js';
class FakeSocket extends EventEmitter {
  static last;
  readyState = 1;
  sent = [];
  constructor(url, options) { super(); this.url = url; this.options = options; FakeSocket.last = this; }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = 3; this.emit('close', 1000); }
  event(evt) { this.emit('message', Buffer.from(JSON.stringify(evt)), false); }
}

test('OpenAI is optional; new installs and migrated Grok defaults remain unchanged', () => {
  assert.equal(engineFor(), 'claude');
  assert.equal(engineFor({ hadFile: true }), 'grok');
  assert.equal(engineFor({ saved: 'openai' }), 'openai');
  assert.equal(canTalk({ hasKey: true, settings: { voiceEngine: 'openai' } }), true);
  assert.match(talkNotice('grok-key', { hasKey: false, settings: { voiceEngine: 'openai' } }, null).text, /OpenAI/);
});

test('OpenAI secrets use explicit sealed store, never settings or automatic env import', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sealed = '';
  initConfig({ dir, importEnv: false, secrets: { get: () => '', set() {} }, brainSecrets: { get: () => '', set() {} }, openaiSecrets: { get: () => sealed, set: (k) => sealed = k } });
  assert.equal(getSetting('voiceEngine'), 'claude');
  assert.equal(getSetting('previewHotkeyEnabled'), false);
  assert.equal(getOpenAIKey(), '');
  setOpenAIKey('sk-fixture-secret');
  updateSettings({ voiceEngine: 'openai', openaiModel: 'gpt-realtime-mini', openaiVoice: 'marin' });
  assert.equal(getOpenAIKey(), 'sk-fixture-secret');
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('sk-fixture-secret'), false);
  updateSettings({ openaiModel: 'unreviewed-live-dialect', externalAvatarMode: 'unknown' });
  assert.equal(getSetting('openaiModel'), 'gpt-realtime-mini');
  assert.equal(getSetting('externalAvatarMode'), 'desktop');
});

test('GA realtime session uses verified nested audio config, tool calling and server VAD', () => {
  const config = openaiSession({ instructions: 'Fixture', tools: [{ type: 'function', name: 'draft_prompt' }, { type: 'web_search' }] });
  assert.equal(config.type, 'realtime');
  assert.equal(config.model, 'gpt-realtime');
  assert.deepEqual(config.output_modalities, ['audio']);
  assert.equal(config.audio.input.format.rate, 24000);
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
  assert.equal(config.audio.output.voice, 'cedar');
  assert.deepEqual(config.tools.map((x) => x.name), ['draft_prompt']);
  assert.equal(config.voice, undefined);
});

test('continuous audio, normalized tools, duplicate provider calls and native-only credentials', () => {
  const upstream = createOpenAIRealtime({ apiKey: 'sk-never-to-renderer', Socket: FakeSocket });
  const s = FakeSocket.last, received = [];
  upstream.on('message', (d) => received.push(JSON.parse(d)));
  upstream.on('error', () => {});
  assert.equal(s.url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime');
  assert.equal(s.url.includes('sk-'), false);
  assert.equal(s.options.headers.Authorization, 'Bearer sk-never-to-renderer');
  upstream.send(JSON.stringify({ type: 'session.update', session: { instructions: 'Speak briefly', tools: [] } }));
  upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
  upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
  s.event({ type: 'session.created', session: { secret: 'sk-never-to-renderer' } });
  const call = { type: 'response.function_call_arguments.done', call_id: 'call-a', name: 'draft_prompt', arguments: '{"text":"Run tests"}' };
  s.event(call); s.event(call);
  s.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'heard-a', transcript: 'Run tests' });
  s.event({ type: 'response.output_audio.delta', response_id: 'r', item_id: 'said-a', delta: 'AAAA' });
  assert.equal(s.sent.filter((x) => x.type === 'input_audio_buffer.append').length, 2);
  assert.equal(received.filter((x) => x.type === call.type).length, 1);
  assert.equal(received.some((x) => x.transcript === 'Run tests'), true);
  assert.equal(JSON.stringify(received).includes('sk-never-to-renderer'), false);
  upstream.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call-a', output: '{"queued":true}' } }));
  upstream.send(JSON.stringify({ type: 'response.create' }));
  assert.equal(s.sent.at(-2).item.type, 'function_call_output');
  assert.equal(s.sent.at(-1).type, 'response.create');
  upstream.close();
});

test('barge-in cancels output and truncates exactly the heard playback, not queued audio or work', () => {
  const upstream = createOpenAIRealtime({ apiKey: 'fixture', Socket: FakeSocket });
  const s = FakeSocket.last;
  s.event({ type: 'response.created', response: { id: 'reply-a' } });
  s.event({ type: 'response.output_audio.delta', item_id: 'voice-a', response_id: 'reply-a', delta: Buffer.alloc(48000).toString('base64') });
  s.event({ type: 'input_audio_buffer.speech_started', item_id: 'speech-b' });
  upstream.send(JSON.stringify({ type: 'orbit.playback_interrupted', responseId: 'foreign', playedMs: 250 }));
  assert.equal(s.sent.length, 0);
  upstream.send(JSON.stringify({ type: 'orbit.playback_interrupted', responseId: 'reply-a', playedMs: 250 }));
  assert.deepEqual(s.sent, [{ type: 'response.cancel' }, { type: 'conversation.item.truncate', item_id: 'voice-a', content_index: 0, audio_end_ms: 250 }]);
  upstream.send(JSON.stringify({ type: 'orbit.playback_interrupted', responseId: 'reply-a', playedMs: 5000 }));
  assert.equal(s.sent.at(-1).audio_end_ms, 1000);
  assert.equal(s.sent.filter((x) => x.type === 'response.cancel').length, 1);
  assert.equal(s.sent.some((x) => x.type.includes('request') || x.type.includes('stop_claude')), false);
  upstream.close();
});

test('normalization sanitizes provider errors and does not leak provider-native session metadata', () => {
  assert.equal(normalizeOpenAI({ type: 'session.updated', secret: 'never' }), null);
  assert.equal(JSON.stringify(normalizeOpenAI({ type: 'error', error: { message: 'private key sk-secret' } })).includes('sk-secret'), false);
  assert.equal(normalizeOpenAI({ type: 'response.created', response: { id: 'r', status: 'in_progress', private: 'never' } }).response.private, undefined);
});
