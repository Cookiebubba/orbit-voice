// OpenAI GA Realtime -> Orbit's existing normalized socket runtime. Native process only.
// Wire evidence: openai/openai-node resources/realtime/realtime.ts and realtime/internal-base.ts.
// A legacy /v1/live/sessions + gpt-live-1 dialect is not a documented Realtime contract.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const OPENAI_VOICES = ['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'];
export function openaiSession(session, { model = 'gpt-realtime', voice = 'cedar' } = {}) {
  return {
    type: 'realtime', model, instructions: session.instructions,
    output_modalities: ['audio'],
    tools: (session.tools || []).filter((t) => t.type === 'function'),
    tool_choice: 'auto',
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice },
    },
  };
}
const PASS = new Set(['input_audio_buffer.speech_started','input_audio_buffer.speech_stopped','input_audio_buffer.committed','conversation.item.input_audio_transcription.delta','conversation.item.input_audio_transcription.completed','response.created','response.done','response.output_audio.delta','response.output_audio.done','response.output_audio_transcript.delta','response.output_audio_transcript.done','response.function_call_arguments.done','response.output_item.added']);
export function normalizeOpenAI(evt) {
  if (evt?.type === 'error') return { type: 'error', error: { code: 'openai_realtime_error', message: 'OpenAI Realtime rejected an event. Check the selected model, account access and session settings.' } };
  if (!PASS.has(evt?.type)) return null;
  // Only normalized runtime fields. Provider session metadata/headers/credentials never reach UI.
  const out = { type: evt.type };
  for (const k of ['item_id','response_id','content_index','audio_start_ms','audio_end_ms','delta','transcript','call_id','name','arguments']) if (evt[k] !== undefined) out[k] = evt[k];
  if (evt.type === 'response.created' || evt.type === 'response.done') out.response = { id: evt.response?.id, status: evt.response?.status };
  if (evt.type === 'response.output_item.added') out.item = { id: evt.item?.id, type: evt.item?.type, role: evt.item?.role };
  return out;
}

export function createOpenAIRealtime({ apiKey, model = 'gpt-realtime', voice = 'cedar', Socket = WebSocket }) {
  const api = new EventEmitter();
  const socket = new Socket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` }, maxPayload: 1024 * 1024 });
  const calls = new Set();
  let currentItem = null, responseId = null, audioMs = 0, cancelled = false;
  const interrupted = new Set();
  const raw = (evt) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(evt));
  Object.defineProperty(api, 'readyState', { get: () => socket.readyState });
  api.close = () => socket.close();
  api.send = (json) => {
    let evt;
    try { evt = JSON.parse(json); } catch { return; }
    if (evt.type === 'session.update') return raw({ type: 'session.update', session: openaiSession(evt.session, { model, voice }) });
    if (evt.type === 'orbit.playback_interrupted') {
      if (evt.responseId !== responseId || !currentItem || !Number.isFinite(evt.playedMs)) return;
      // Server VAD cancels generation; the renderer reports what was actually heard for truncation.
      if (!cancelled) { raw({ type: 'response.cancel' }); cancelled = true; }
      return raw({ type: 'conversation.item.truncate', item_id: currentItem, content_index: 0, audio_end_ms: Math.max(0, Math.min(Math.floor(evt.playedMs), Math.floor(audioMs))) });
    }
    if (['input_audio_buffer.append','input_audio_buffer.clear','input_audio_buffer.commit','response.cancel','response.create','conversation.item.create'].includes(evt.type)) raw(evt);
  };
  socket.on('open', () => api.emit('open'));
  socket.on('message', (data, binary) => {
    if (binary) return;
    let evt; try { evt = JSON.parse(data.toString()); } catch { return; }
    if (evt.type === 'response.created') { currentItem = null; responseId = evt.response?.id; audioMs = 0; cancelled = false; }
    if (evt.type === 'response.output_audio.delta' && typeof evt.delta === 'string') { currentItem = evt.item_id; audioMs += Buffer.from(evt.delta, 'base64').length / 48; }
    if (evt.type === 'input_audio_buffer.speech_started' && responseId) {
      interrupted.add(responseId);
      if (interrupted.size > 128) interrupted.delete(interrupted.values().next().value);
    }
    if (evt.type === 'response.done' && evt.response?.status === 'cancelled') cancelled = true;
    if (evt.type === 'error' && cancelled && evt.error?.code === 'response_cancel_not_active') return;
    if (interrupted.has(evt.response_id) && evt.type.startsWith('response.') && evt.type !== 'response.done') {
      if (evt.type === 'response.function_call_arguments.done' && typeof evt.call_id === 'string') raw({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify({ skipped: true, note: 'The response was interrupted; no action was executed.' }) } });
      return;
    }
    if (evt.type === 'response.function_call_arguments.done') {
      if (typeof evt.call_id !== 'string' || calls.has(evt.call_id)) return;
      calls.add(evt.call_id);
      if (calls.size > 512) calls.delete(calls.values().next().value);
    }
    const normalized = normalizeOpenAI(evt);
    if (normalized) api.emit('message', Buffer.from(JSON.stringify(normalized)), false);
  });
  socket.on('unexpected-response', (_req, res) => { res.resume(); api.emit('error', new Error(`OpenAI Realtime connection refused (HTTP ${res.statusCode}).`)); socket.close(); });
  socket.on('error', () => api.emit('error', new Error('OpenAI Realtime connection failed. Check your network and API access.')));
  socket.on('close', (code) => api.emit('close', code, Buffer.from('OpenAI Realtime session closed')));
  return api;
}
