// A stand-in for xAI's Grok realtime voice API, for scripts/fuzz-e2e.mjs, reached through
// XAI_REALTIME_URL. It speaks the same events the real one does (session.created/updated,
// response.created/done, audio and transcript deltas, function calls, input transcriptions,
// errors) with randomized but realistic timing: steady, bursty or slow audio, slow starts, an
// occasional error or an abrupt close (1006). It records everything the bridge sends it, so the
// harness can check what Orbit did. 127.0.0.1 only.

import { WebSocketServer } from 'ws';

const RATE = 24000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 100 ms of a 440 Hz tone as base64 PCM16 (real audio the page schedules and plays). */
function chunk(i) {
  const n = RATE / 10;
  const b = Buffer.alloc(n * 2);
  for (let k = 0; k < n; k++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * (i * n + k)) / RATE) * 6000), k * 2);
  return b.toString('base64');
}
const CHUNKS = Array.from({ length: 10 }, (_, i) => chunk(i));

export function createFakeGrok({ g, port = 0 }) {
  const conns = [];
  let seq = 0;
  let calls = 0;
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  const ready = new Promise((r) => wss.on('listening', r));

  wss.on('connection', (ws, req) => {
    const c = {
      id: ++seq,
      ws,
      openedAt: Date.now(),
      closedAt: 0,
      closeCode: 0,
      auth: String(req.headers.authorization || ''),
      configured: 0, // session.update count
      isWake: false,
      notifications: [], // when an "[App notification]" (or resume note / held answer) arrived
      resumeNote: false,
      firstAppendAt: 0,
      appends: 0,
      responses: [], // { at, doneAt, audioChunks, tools: [names], chaos }
      firstDoneAt: 0,
      audioSentMs: 0,
      utterances: [], // { text, kind, speechAt, transcriptAt, heard, typed }
      results: new Map(), // call_id -> { name, output, at }
      toolCalls: [], // { name, call_id, args, at, expect }
      followUps: [], // tool lists for the responses that follow a tool call
      responding: false,
      chaos: false, // this connection was dropped or errored on purpose
      dropped: false,
    };
    conns.push(c);
    const send = (e) => ws.readyState === 1 && ws.send(JSON.stringify(e));
    c.send = send;
    send({ type: 'session.created', session: { id: `sess_${c.id}` } });
    ws.on('message', (m) => {
      let e;
      try {
        e = JSON.parse(String(m));
      } catch {
        return;
      }
      if (!e || typeof e.type !== 'string') return;
      if (e.type === 'session.update') {
        c.configured++;
        c.tools = (e.session?.tools || []).map((t) => t.name);
        send({ type: 'session.updated', session: { id: `sess_${c.id}` } });
      } else if (e.type === 'input_audio_buffer.append') {
        if (!c.firstAppendAt) c.firstAppendAt = Date.now();
        c.appends++;
      } else if (e.type === 'conversation.item.create') {
        const item = e.item || {};
        if (item.type === 'function_call_output') {
          let output = null;
          try {
            output = JSON.parse(item.output);
          } catch {}
          const call = c.toolCalls.find((t) => t.call_id === item.call_id);
          c.results.set(item.call_id, { name: call?.name, output, at: Date.now() });
          if (call) call.result = output;
          return;
        }
        const text = item.content?.[0]?.text;
        if (typeof text !== 'string') return;
        if (text.includes('woke only for this')) c.isWake = true;
        if (text.startsWith('[App notification]') || text.startsWith('[Orbit held answer]')) c.notifications.push(Date.now());
        else if (text.startsWith('[Orbit resume note')) (c.resumeNote = true), c.notifications.push(Date.now());
        else {
          // Typed in Orbit's text box: the user's words, like speech. Grok's planned answer belongs to them.
          const u = { text, kind: kindOf(text), speechAt: Date.now(), transcriptAt: Date.now(), heard: true, typed: true };
          c.utterances.push(u);
          for (const t of c.followUps.flat()) if (!t.utterance) t.utterance = u;
        }
      } else if (e.type === 'response.create') {
        void respond(c, { tools: c.followUps.shift() || [] });
      }
    });
    ws.on('close', (code) => {
      c.closedAt = Date.now();
      c.closeCode = code;
    });
    ws.on('error', () => {});
  });

  // What each kind of utterance asks for (by construction; the harness picks the words).
  const KINDS = new Map();
  const kindOf = (text) => KINDS.get(text) || 'other';

  /** Grok answers: maybe a slow start, audio in some rhythm, a transcript, function calls, done. */
  async function respond(c, opts = {}) {
    if (c.ws.readyState !== 1) return;
    // One response at a time, like the real one: a request during a response waits its turn.
    if (c.responding) return void (c.queued ??= []).push(opts);
    const { tools = [], wake = c.isWake, calm = false, delay = null } = opts;
    c.responding = true;
    const r = { at: Date.now(), doneAt: 0, audioChunks: 0, tools: tools.map((t) => t.name), chaos: '' };
    c.responses.push(r);
    try {
      const chaotic = !calm && !wake;
      // Slow or bursty starts.
      await wait(delay ?? g.pick([0, 0, 10, 50, 200, g.int(1500)]));
      if (chaotic && g.chance(0.04)) {
        r.chaos = 'error';
        c.chaos = true;
        c.send({ type: 'error', error: { type: 'invalid_request_error', code: 'fuzz', message: 'A fuzzed error from the fake Grok.' } });
        return;
      }
      const id = `resp_${c.id}_${c.responses.length}`;
      c.send({ type: 'response.created', response: { id } });
      const n = wake ? 15 + g.int(10) : tools.length && g.chance(0.5) ? 0 : 3 + g.int(12);
      const rhythm = wake ? g.pick(['steady', 'burst']) : g.pick(['steady', 'burst', 'slow']);
      for (let i = 0; i < n; i++) {
        if (c.ws.readyState !== 1) return;
        c.send({ type: 'response.output_audio.delta', response_id: id, item_id: `${id}_a`, delta: CHUNKS[i % CHUNKS.length] });
        r.audioChunks++;
        c.audioSentMs += 100;
        if (rhythm === 'steady') await wait(20 + g.int(40));
        else if (rhythm === 'slow') await wait(90 + g.int(60));
        else if (i % 8 === 7) await wait(g.int(120));
        if (chaotic && g.chance(0.006)) {
          r.chaos = 'drop';
          c.chaos = c.dropped = true;
          c.ws.terminate(); // an abrupt close: the bridge sees 1006
          return;
        }
      }
      c.send({ type: 'response.output_audio_transcript.done', response_id: id, item_id: `${id}_a`, transcript: wake ? 'Claude finished something.' : 'Okay.' });
      for (const t of tools) {
        const call_id = `call_${++calls}`;
        const args = typeof t.args === 'string' ? t.args : JSON.stringify(t.args || {});
        c.toolCalls.push({ name: t.name, call_id, args, at: Date.now(), expect: t.expect || '', utterance: t.utterance || null });
        c.send({ type: 'response.function_call_arguments.done', response_id: id, item_id: `${id}_f${call_id}`, call_id, name: t.name, arguments: args });
        await wait(g.int(30));
      }
      c.send({ type: 'response.done', response: { id, status: 'completed' } });
      r.doneAt = Date.now();
      if (!c.firstDoneAt) c.firstDoneAt = r.doneAt;
    } finally {
      c.responding = false;
      const next = c.queued?.shift();
      if (next) void respond(c, next);
    }
  }

  /**
   * The user says something (the server's voice detection and transcription), then Grok answers
   * with `tools` (and `followUps` for the responses after them). `heard`: whether the bridge
   * forwards it (on a spoken update, only once the page opened its listening window).
   */
  async function userSays(c, text, { kind = 'other', tools = [], followUps = [], startDelay = null } = {}) {
    if (!c || c.ws.readyState !== 1) return null;
    KINDS.set(text, kind);
    const item_id = `item_${c.id}_${c.utterances.length + 1}_${g.int(1e6)}`;
    // On a spoken update, Grok gets no mic audio until the page opens its listening window: speech
    // before that is never heard (like the real one, it can't transcribe audio it never got).
    const u = { text, kind, speechAt: Date.now(), transcriptAt: 0, heard: !c.isWake || !!c.firstAppendAt, typed: false };
    c.utterances.push(u);
    if (!u.heard) return u;
    c.send({ type: 'input_audio_buffer.speech_started', item_id, audio_start_ms: 0 });
    await wait(100 + g.int(500));
    c.send({ type: 'input_audio_buffer.speech_stopped', item_id });
    c.send({ type: 'input_audio_buffer.committed', item_id });
    await wait(30 + g.int(300));
    c.send({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: text });
    u.transcriptAt = Date.now();
    // Grok's server-side voice detection answers on its own.
    for (const t of tools) t.utterance = u;
    c.followUps = followUps.map((f) => f.map((t) => ({ ...t, utterance: u })));
    void respond(c, { tools, calm: true, delay: startDelay });
    return u;
  }

  return {
    ready,
    get url() {
      return `ws://127.0.0.1:${wss.address().port}`;
    },
    conns,
    open: () => conns.filter((c) => c.ws.readyState === 1),
    current: () => [...conns].reverse().find((c) => c.ws.readyState === 1) || null,
    userSays,
    respond,
    noteKind: (text, kind) => KINDS.set(text, kind),
    drop(c) {
      if (c?.ws.readyState !== 1) return;
      c.chaos = c.dropped = true;
      c.ws.terminate();
    },
    error(c) {
      if (c?.ws.readyState !== 1) return;
      c.chaos = true;
      c.send({ type: 'error', error: { type: 'server_error', code: 'fuzz', message: 'A fuzzed server error.' } });
    },
    // Ends every connection first (a server close otherwise waits for them), and never hangs.
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
