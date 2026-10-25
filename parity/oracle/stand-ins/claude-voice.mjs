// The relay oracle's stand-in for src/claude-voice.js: the real helpers, while Claude voice's
// realtime "socket" is a recorded stand-in the oracle's script plays (as it plays Grok), and the warm
// spare and speech models are only recorded (parity/oracle/relay.mjs).
import { EventEmitter } from 'node:events';

export * from '../../../src/claude-voice.js?real';

const o = () => globalThis.__relay;

export function createClaudeRealtime(opts = {}) {
  const sock = new EventEmitter();
  sock.readyState = 0;
  sock.send = (data) => o().upstreamSent(sock, String(data));
  sock.close = (code, reason) => o().upstreamClosed(sock, code ?? null, reason ?? null);
  o().localTurn = opts.localTurn || null;
  o().upstreamCreated(sock, {
    kind: 'claude',
    claudePath: opts.claudePath ?? null,
    speed: opts.speed ?? null,
    sid: opts.sid ?? null,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    stt: opts.stt ?? null,
    localSpeech: !!opts.localSpeech,
  });
  return sock;
}

export function keepSpare(opts = {}) {
  o().record({ kind: 'keepSpare', model: opts.model ?? null, effort: opts.effort ?? null });
}

export function stopClaudeVoice() {}

export function loadSpeech() {
  return Promise.resolve({ speak: async () => new Float32Array(2400) });
}

export function loadRecognizer() {
  return Promise.resolve({ transcribe: async () => '' });
}
