// Gemini Multimodal Live WebSocket voice engine (BidiGenerateContent): translates bidirectionally
// between Orbit's realtime protocol and Gemini's native audio/vision WebSocket wire protocol.
//
//   Orbit page/bridge (24 kHz PCM16, JPEG frames, tools, text)
//     <-> createGeminiLiveRealtime (16 kHz PCM16 up, 24 kHz PCM16 down, setup handshake, tool map)
//     <-> Gemini Live WebSocket (BidiGenerateContent)
//
// Never logs API keys or user words. Enforces 512 KB cap and offLimits refusal on vision frames.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { readable } from '../anywhere/policy.js';
import { GEMINI_LIVE_VOICES } from './auth.js';

export const GEMINI_LIVE_DEFAULTS = Object.freeze({
  model: 'gemini-2.5-flash-native-audio-preview-12-2025',
  voice: 'Aoede',
  inRate: 24000,
  liveInRate: 16000,
  liveOutRate: 24000,
  maxVisionBytes: 512 * 1024,
  baseUrl: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
});

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MAX_QUEUE = 256;

const voiceOk = (v) => typeof v === 'string' && GEMINI_LIVE_VOICES.includes(v);
const modelOk = (m) => typeof m === 'string' && /^gemini-[a-z0-9._-]+$/i.test(m.trim());

/**
 * Linear-interpolation resampler for signed 16-bit little-endian mono PCM buffers.
 * Used for 24 kHz -> 16 kHz upstream mic audio and normalizing downstream PCM if needed.
 */
export function resamplePcm16(buf, fromRate, toRate) {
  if (!buf || buf.length < 2 || !Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    return Buffer.alloc(0);
  }
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const inLen = view.length >> 1;
  if (inLen === 0) return Buffer.alloc(0);
  if (fromRate === toRate) return Buffer.from(view.subarray(0, inLen * 2));
  const outLen = Math.max(1, Math.round((inLen * toRate) / fromRate));
  const ratio = fromRate / toRate;
  const out = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = view.readInt16LE(Math.min(idx, inLen - 1) * 2);
    const s1 = view.readInt16LE(Math.min(idx + 1, inLen - 1) * 2);
    const val = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
  }
  return out;
}

const GEMINI_TYPES = new Set(['OBJECT', 'STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY']);

/** Sanitizes a JSON Schema node to Gemini's Schema protobuf subset. */
function sanitizeSchema(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { type: 'OBJECT', properties: {} };
  const out = {};
  if (typeof node.type === 'string') {
    const up = node.type.toUpperCase();
    if (GEMINI_TYPES.has(up)) out.type = up;
  }
  if (typeof node.description === 'string' && node.description) out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = node.enum.map((v) => String(v));
  if (typeof node.nullable === 'boolean') out.nullable = node.nullable;
  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) {
      out.properties[k] = sanitizeSchema(v);
    }
  }
  if (Array.isArray(node.required) && node.required.length) {
    out.required = node.required.filter((r) => typeof r === 'string');
  }
  if (node.items && typeof node.items === 'object') {
    out.items = sanitizeSchema(node.items);
  }
  if (!out.type && out.properties) out.type = 'OBJECT';
  return out;
}

/**
 * Translates Orbit realtime tool definitions into Gemini Live `setup.tools` format.
 * Drops provider-specific non-function tools (e.g. xAI's `web_search`/`x_search`) and optionally
 * attaches Gemini's native `{ googleSearch: {} }` tool when `webSearch` is true.
 */
export function toGeminiTools(orbitTools, { webSearch = false } = {}) {
  const decls = [];
  for (const t of Array.isArray(orbitTools) ? orbitTools : []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type && t.type !== 'function') continue;
    if (typeof t.name !== 'string' || !t.name.trim()) continue;
    const decl = {
      name: t.name.trim(),
      description: String(t.description || '').trim(),
    };
    if (t.parameters && typeof t.parameters === 'object') {
      const schema = sanitizeSchema(t.parameters);
      if (schema.type || schema.properties) decl.parameters = schema;
    }
    decls.push(decl);
  }
  const out = [];
  if (decls.length) out.push({ functionDeclarations: decls });
  if (webSearch) out.push({ googleSearch: {} });
  return out;
}

function parsePcmRate(mimeType, fallback = GEMINI_LIVE_DEFAULTS.liveOutRate) {
  const m = /;\s*rate=(\d+)/i.exec(String(mimeType || ''));
  const r = m ? Number(m[1]) : fallback;
  return Number.isFinite(r) && r > 0 ? r : fallback;
}

function scrubKey(text, key) {
  const s = String(text || '');
  return key ? s.split(key).join('[redacted]') : s;
}

/**
 * Creates a realtime socket adapter speaking Orbit's realtime protocol on the front and Gemini's
 * `BidiGenerateContent` WebSocket protocol on the back.
 */
export function createGeminiLiveRealtime({
  apiKey = '',
  model = GEMINI_LIVE_DEFAULTS.model,
  voice = GEMINI_LIVE_DEFAULTS.voice,
  webSearch = false,
  liveUrl = '',
  wsImpl = WebSocket,
  onWarn = () => {},
  now = () => Date.now(),
} = {}) {
  const sock = new EventEmitter();
  sock.readyState = CONNECTING;

  let activeModel = modelOk(model) ? model.trim() : GEMINI_LIVE_DEFAULTS.model;
  let activeVoice = voiceOk(voice) ? voice : GEMINI_LIVE_DEFAULTS.voice;
  let activeWebSearch = !!webSearch;
  let instructions = '';
  let tools = [];

  let ws = null;
  let setupSent = false;
  let setupComplete = false;
  let pendingSetup = false;
  const outQueue = [];
  const callNames = new Map(); // call_id -> tool name
  let seq = 0;
  const id = (p) => `${p}_${++seq}`;
  const sessionId = id('gemini_live');

  let activeResp = null; // { id, itemId, transcript, hasOutputTranscription }
  let suppressUntilTurnComplete = false;
  let justSentToolResponse = false;

  // Input speech / transcription tracking
  let inputItemId = null;
  let inputTranscript = '';
  let inputSpeechStarted = false;

  const emit = (obj) => {
    if (sock.readyState === OPEN) sock.emit('message', JSON.stringify(obj), false);
  };

  const fail = (message, code = 1011) => {
    const clean = scrubKey(message, apiKey).slice(0, 240);
    if (sock.readyState === CLOSED) return;
    if (sock.readyState === OPEN) emit({ type: 'error', error: { message: clean } });
    sock.close(code, clean);
  };

  const sendRaw = (obj) => {
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  };

  /** Sends a Gemini frame if setupComplete has arrived; otherwise buffers it in order. */
  const sendOrQueue = (obj, { audio = false } = {}) => {
    if (sock.readyState !== OPEN) return;
    if (setupComplete && ws?.readyState === OPEN) {
      sendRaw(obj);
      return;
    }
    if (outQueue.length >= MAX_QUEUE) {
      // Drop the oldest audio frame first so control/tool frames are preserved.
      const idx = outQueue.findIndex((q) => q.audio);
      if (idx >= 0) outQueue.splice(idx, 1);
      else outQueue.shift();
    }
    outQueue.push({ obj, audio });
  };

  const flushQueue = () => {
    while (outQueue.length && ws?.readyState === OPEN && setupComplete) {
      const next = outQueue.shift();
      sendRaw(next.obj);
    }
  };

  const buildSetup = () => {
    const geminiTools = toGeminiTools(tools, { webSearch: activeWebSearch });
    const setup = {
      model: activeModel.startsWith('models/') ? activeModel : `models/${activeModel}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: activeVoice },
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (instructions) setup.systemInstruction = { parts: [{ text: instructions }] };
    if (geminiTools.length) setup.tools = geminiTools;
    return { setup };
  };

  const sendSetupIfNeeded = () => {
    if (setupSent) return;
    if (!ws || ws.readyState !== OPEN) {
      pendingSetup = true;
      return;
    }
    setupSent = true;
    pendingSetup = false;
    sendRaw(buildSetup());
  };

  const ensureResponse = () => {
    if (!activeResp) {
      activeResp = { id: id('resp'), itemId: id('item'), transcript: '', hasOutputTranscription: false, startedAt: now() };
      emit({ type: 'response.created', response: { id: activeResp.id } });
    }
    return activeResp;
  };

  const flushInputTranscription = () => {
    if (!inputSpeechStarted && !inputTranscript) return;
    const itemId = inputItemId || id('item');
    const transcript = inputTranscript.trim();
    inputItemId = null;
    inputTranscript = '';
    inputSpeechStarted = false;
    emit({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
    emit({ type: 'input_audio_buffer.committed', item_id: itemId });
    emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript });
  };

  const finishActiveResponse = (status = 'completed') => {
    if (!activeResp) return;
    const r = activeResp;
    activeResp = null;
    emit({ type: 'response.output_audio_transcript.done', response_id: r.id, item_id: r.itemId, transcript: r.transcript });
    emit({ type: 'response.done', response: { id: r.id, status, output: [] } });
  };

  // --- Gemini -> Orbit ------------------------------------------------------
  const onUpstreamMessage = (raw) => {
    if (sock.readyState !== OPEN) return;
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (Object.hasOwn(msg, 'setupComplete')) {
      setupComplete = true;
      emit({ type: 'session.updated', session: { id: sessionId } });
      flushQueue();
      return;
    }

    if (msg.goAway) {
      onWarn('Gemini Live: server requested reconnect (goAway)', String(msg.goAway.timeLeft || ''));
      return;
    }

    if (msg.toolCallCancellation && Array.isArray(msg.toolCallCancellation.ids)) {
      for (const cid of msg.toolCallCancellation.ids) callNames.delete(String(cid));
      return;
    }

    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
      justSentToolResponse = false;
      suppressUntilTurnComplete = false;
      flushInputTranscription();
      const resp = ensureResponse();
      for (const fc of msg.toolCall.functionCalls) {
        if (!fc || typeof fc.name !== 'string' || !fc.name) continue;
        const call_id = String(fc.id || id('call'));
        callNames.set(call_id, fc.name);
        const args = fc.args && typeof fc.args === 'object' ? fc.args : {};
        emit({
          type: 'response.function_call_arguments.done',
          response_id: resp.id,
          item_id: id('item'),
          call_id,
          name: fc.name,
          arguments: JSON.stringify(args),
        });
      }
      finishActiveResponse('completed');
      return;
    }

    if (msg.serverContent && typeof msg.serverContent === 'object') {
      const sc = msg.serverContent;

      if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
        if (!inputSpeechStarted) {
          inputSpeechStarted = true;
          inputItemId = id('item');
          emit({ type: 'input_audio_buffer.speech_started', item_id: inputItemId, audio_start_ms: 0 });
        }
        inputTranscript += sc.inputTranscription.text;
        if (sc.inputTranscription.finished === true) flushInputTranscription();
      }

      if (sc.interrupted === true) {
        suppressUntilTurnComplete = false;
        if (!inputSpeechStarted) {
          inputSpeechStarted = true;
          inputItemId = id('item');
          emit({ type: 'input_audio_buffer.speech_started', item_id: inputItemId, audio_start_ms: 0 });
        }
        finishActiveResponse('cancelled');
        return;
      }

      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        justSentToolResponse = false;
        flushInputTranscription();
        if (!suppressUntilTurnComplete) {
          const resp = ensureResponse();
          for (const part of sc.modelTurn.parts) {
            if (!part || typeof part !== 'object') continue;
            if (part.inlineData && typeof part.inlineData.data === 'string' && part.inlineData.data) {
              const mime = String(part.inlineData.mimeType || 'audio/pcm;rate=24000');
              if (mime.toLowerCase().startsWith('audio/pcm')) {
                const rate = parsePcmRate(mime, GEMINI_LIVE_DEFAULTS.liveOutRate);
                const delta =
                  rate === GEMINI_LIVE_DEFAULTS.liveOutRate
                    ? part.inlineData.data
                    : resamplePcm16(Buffer.from(part.inlineData.data, 'base64'), rate, GEMINI_LIVE_DEFAULTS.liveOutRate).toString('base64');
                if (delta) {
                  emit({ type: 'response.output_audio.delta', response_id: resp.id, item_id: resp.itemId, delta });
                }
              }
            } else if (typeof part.text === 'string' && part.text && !part.thought && !resp.hasOutputTranscription) {
              resp.transcript += part.text;
              emit({ type: 'response.output_audio_transcript.delta', response_id: resp.id, item_id: resp.itemId, delta: part.text });
            }
          }
        }
      }

      if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string' && sc.outputTranscription.text) {
        justSentToolResponse = false;
        flushInputTranscription();
        if (!suppressUntilTurnComplete) {
          const resp = ensureResponse();
          resp.hasOutputTranscription = true;
          resp.transcript += sc.outputTranscription.text;
          emit({
            type: 'response.output_audio_transcript.delta',
            response_id: resp.id,
            item_id: resp.itemId,
            delta: sc.outputTranscription.text,
          });
        }
      }

      if (sc.turnComplete === true) {
        flushInputTranscription();
        if (suppressUntilTurnComplete) {
          suppressUntilTurnComplete = false;
          return;
        }
        finishActiveResponse('completed');
      }
    }
  };

  // --- Orbit -> Gemini ------------------------------------------------------
  const handleVisionFrame = (msg) => {
    if (msg.offLimits === true) {
      onWarn('Gemini Live: refused vision frame from off-limits window', 'offLimits');
      return;
    }
    const win = msg.window || msg.win;
    if (win && typeof win === 'object') {
      const check = readable(win);
      if (!check.ok) {
        onWarn('Gemini Live: refused vision frame from off-limits window', check.reason || 'policy');
        return;
      }
    }
    const mimeType = typeof msg.mimeType === 'string' ? msg.mimeType.toLowerCase() : 'image/jpeg';
    if (mimeType !== 'image/jpeg') {
      onWarn('Gemini Live: refused non-JPEG vision frame', mimeType.slice(0, 40));
      return;
    }
    const b64 = typeof msg.data === 'string' ? msg.data : typeof msg.image === 'string' ? msg.image : typeof msg.jpeg === 'string' ? msg.jpeg : '';
    if (!b64) return;
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) return;
    if (bytes.length > GEMINI_LIVE_DEFAULTS.maxVisionBytes) {
      onWarn('Gemini Live: vision frame exceeds 512KB cap', `${bytes.length} bytes`);
      return;
    }
    sendOrQueue({
      realtimeInput: {
        mediaChunks: [{ mimeType: 'image/jpeg', data: b64 }],
      },
    });
  };

  sock.send = (data) => {
    if (sock.readyState !== OPEN) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'session.update': {
        const s = msg.session || {};
        const prevInstructions = instructions;
        if (typeof s.instructions === 'string') instructions = s.instructions;
        if (Array.isArray(s.tools)) tools = s.tools;
        if (voiceOk(s.gemini_voice)) activeVoice = s.gemini_voice;
        else if (voiceOk(s.voice)) activeVoice = s.voice;
        if (modelOk(s.gemini_model)) activeModel = s.gemini_model.trim();
        if (typeof s.web_search === 'boolean') activeWebSearch = s.web_search;

        if (!setupSent) {
          sendSetupIfNeeded();
        } else if (setupComplete) {
          if (instructions && instructions !== prevInstructions) {
            sendOrQueue({
              clientContent: {
                turns: [{ role: 'user', parts: [{ text: `[Orbit updated instructions: ${instructions}]` }] }],
                turnComplete: false,
              },
            });
          }
          emit({ type: 'session.updated', session: { id: sessionId } });
        }
        return;
      }

      case 'input_audio_buffer.append': {
        if (typeof msg.audio !== 'string' || !msg.audio) return;
        const pcm24 = Buffer.from(msg.audio, 'base64');
        const pcm16 = resamplePcm16(pcm24, GEMINI_LIVE_DEFAULTS.inRate, GEMINI_LIVE_DEFAULTS.liveInRate);
        if (!pcm16.length) return;
        sendOrQueue(
          {
            realtimeInput: {
              mediaChunks: [{ mimeType: `audio/pcm;rate=${GEMINI_LIVE_DEFAULTS.liveInRate}`, data: pcm16.toString('base64') }],
            },
          },
          { audio: true },
        );
        return;
      }

      case 'input_audio_buffer.clear': {
        for (let i = outQueue.length - 1; i >= 0; i--) {
          if (outQueue[i].audio) outQueue.splice(i, 1);
        }
        return;
      }

      case 'orbit.vision_frame':
        return handleVisionFrame(msg);

      case 'conversation.item.create': {
        const item = msg.item || {};
        if (item.type === 'function_call_output') {
          const callId = String(item.call_id || '');
          const name = callNames.get(callId) || 'tool';
          let responseObj;
          if (item.output && typeof item.output === 'object' && !Array.isArray(item.output)) {
            responseObj = item.output;
          } else {
            const rawStr = String(item.output ?? '');
            try {
              const parsed = JSON.parse(rawStr);
              responseObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: parsed };
            } catch {
              responseObj = { result: rawStr };
            }
          }
          justSentToolResponse = true;
          sendOrQueue({
            toolResponse: {
              functionResponses: [{ id: callId, name, response: responseObj }],
            },
          });
          return;
        }
        if (item.type === 'message') {
          const text = (Array.isArray(item.content) ? item.content : [])
            .map((c) => (typeof c?.text === 'string' ? c.text : ''))
            .join('\n')
            .trim();
          if (!text) return;
          justSentToolResponse = false;
          sendOrQueue({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text }] }],
              turnComplete: false,
            },
          });
        }
        return;
      }

      case 'response.create': {
        if (justSentToolResponse) {
          // Gemini Live resumes generation automatically upon receiving toolResponse.
          justSentToolResponse = false;
          return;
        }
        sendOrQueue({ clientContent: { turnComplete: true } });
        return;
      }

      case 'response.cancel': {
        if (activeResp) {
          suppressUntilTurnComplete = true;
          finishActiveResponse('cancelled');
        }
        return;
      }
    }
  };

  sock.close = (code = 1000, reason = '') => {
    if (sock.readyState === CLOSED) return;
    sock.readyState = CLOSING;
    outQueue.length = 0;
    const u = ws;
    ws = null;
    if (u) {
      u.removeAllListeners?.();
      u.on?.('error', () => {});
      try {
        if (u.readyState === OPEN || u.readyState === CONNECTING) u.close(code === 1011 ? 1000 : code);
      } catch {
        try {
          u.terminate?.();
        } catch {}
      }
    }
    sock.readyState = CLOSED;
    setImmediate(() => sock.emit('close', code, Buffer.from(String(reason))));
  };

  // --- connect upstream -----------------------------------------------------
  setImmediate(() => {
    if (sock.readyState === CLOSED) return;
    if (!apiKey) {
      sock.readyState = OPEN;
      return fail('Gemini API key is missing. Add it in Settings to use Gemini Live.');
    }
    const url = liveUrl || GEMINI_LIVE_DEFAULTS.baseUrl;
    try {
      ws = new wsImpl(url, { headers: { 'x-goog-api-key': apiKey } });
    } catch (e) {
      sock.readyState = OPEN;
      return fail(`Couldn't connect to Gemini Live: ${String(e?.message || e)}`);
    }

    ws.on('open', () => {
      if (sock.readyState !== CONNECTING) return;
      sock.readyState = OPEN;
      sock.emit('open');
      emit({ type: 'session.created', session: { id: sessionId } });
      if (pendingSetup) sendSetupIfNeeded();
    });

    ws.on('message', onUpstreamMessage);

    ws.on('error', (e) => {
      const clean = scrubKey(e?.message || e || 'Gemini Live connection error', apiKey).slice(0, 200);
      onWarn('Gemini Live: socket error', clean);
      if (sock.readyState === OPEN) emit({ type: 'error', error: { message: clean } });
      if (sock.listenerCount('error') > 0) sock.emit('error', new Error(clean));
    });

    ws.on('close', (code, reason) => {
      if (sock.readyState === CLOSED) return;
      ws = null;
      outQueue.length = 0;
      sock.readyState = CLOSED;
      sock.emit('close', code || 1000, Buffer.isBuffer(reason) ? reason : Buffer.from(String(reason || '')));
    });
  });

  return sock;
}
