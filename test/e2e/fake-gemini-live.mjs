// A real 127.0.0.1 WebSocketServer stand-in for Gemini's BidiGenerateContent Live API.
// Used by unit and integration tests for src/gemini/live-voice.js. No network access outside 127.0.0.1.

import { WebSocketServer } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 50 ms of a 440 Hz tone as PCM16LE at `rate`. */
function tonePcm(rate = 24000, ms = 50) {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 4000), i * 2);
  }
  return b;
}

export function createFakeGeminiLive({ port = 0, autoSetupComplete = true } = {}) {
  const received = [];
  const conns = [];
  let seq = 0;
  let callSeq = 0;

  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  const ready = new Promise((r) => wss.on('listening', r));

  wss.on('connection', (ws, req) => {
    const c = {
      id: ++seq,
      ws,
      headers: { ...req.headers },
      url: req.url || '',
      received: [],
      setup: null,
      closedAt: 0,
      closeCode: 0,
    };
    conns.push(c);
    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };
    c.send = send;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      c.received.push(msg);
      received.push(msg);
      if (msg && msg.setup) {
        c.setup = msg.setup;
        if (autoSetupComplete) send({ setupComplete: {} });
      }
    });

    ws.on('close', (code) => {
      c.closedAt = Date.now();
      c.closeCode = code;
    });

    ws.on('error', () => {});
  });

  const active = () => [...conns].reverse().find((c) => c.ws.readyState === 1) || null;

  const sendRaw = (obj, conn = active()) => {
    if (!conn || conn.ws.readyState !== 1) return false;
    conn.send(obj);
    return true;
  };

  /**
   * Sends a Gemini `serverContent` audio + transcript reply and finishes with `turnComplete`.
   * Accepts { pcm, chunks, transcript, inputTranscript, rate = 24000, turnComplete = true }.
   */
  const sendAudioReply = ({
    pcm = null,
    chunks = null,
    transcript = 'Hello from Gemini.',
    inputTranscript = '',
    rate = 24000,
    turnComplete = true,
  } = {}, conn = active()) => {
    if (!conn || conn.ws.readyState !== 1) return false;
    if (inputTranscript) {
      conn.send({ serverContent: { inputTranscription: { text: inputTranscript } } });
    }
    const buffers = Array.isArray(chunks)
      ? chunks
      : [Buffer.isBuffer(pcm) ? pcm : typeof pcm === 'string' ? Buffer.from(pcm, 'base64') : tonePcm(rate)];
    for (const buf of buffers) {
      conn.send({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: `audio/pcm;rate=${rate}`, data: buf.toString('base64') } }],
          },
        },
      });
    }
    if (transcript) {
      conn.send({ serverContent: { outputTranscription: { text: transcript } } });
    }
    if (turnComplete) {
      conn.send({ serverContent: { turnComplete: true } });
    }
    return true;
  };

  /** Sends one or more Gemini `toolCall.functionCalls`. */
  const sendToolCall = (calls, conn = active()) => {
    if (!conn || conn.ws.readyState !== 1) return false;
    const list = Array.isArray(calls) ? calls : [calls];
    const functionCalls = list.map((c) => ({
      id: c.id || `gcall_${++callSeq}`,
      name: c.name,
      args: c.args && typeof c.args === 'object' ? c.args : {},
    }));
    conn.send({ toolCall: { functionCalls } });
    return functionCalls;
  };

  /** Sends a Gemini `serverContent.interrupted` barge-in signal. */
  const sendInterrupted = (conn = active()) => sendRaw({ serverContent: { interrupted: true } }, conn);

  /** Manually sends `{ setupComplete: {} }` when created with `autoSetupComplete: false`. */
  const sendSetupComplete = (conn = active()) => sendRaw({ setupComplete: {} }, conn);

  return {
    ready,
    get url() {
      const addr = wss.address();
      return `ws://127.0.0.1:${addr.port}`;
    },
    received,
    conns,
    current: active,
    sendRaw,
    sendSetupComplete,
    sendAudioReply,
    sendToolCall,
    sendInterrupted,
    close: () =>
      Promise.race([
        new Promise((r) => {
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => r());
        }),
        wait(2000),
      ]),
  };
}
