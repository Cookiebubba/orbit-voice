// Claude voice (beta): the local stand-in for Grok's realtime socket. Fake speech models and a fake
// Claude Code process: nothing is downloaded, spawned or billed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClaudeRealtime, findToolCall, isJunk, parseToolCall, parseXmlToolCall, speakableText, systemPrompt, takeChunks } from '../src/claude-voice.js';
import { downloadModels, downloadStatus, modelsReady } from '../src/voice-models.js';

test('streamed text is cut into speakable pieces: the first early, sentences whole, numbers intact', () => {
  let r = takeChunks('Sure, I can help with that. It', { first: true, final: false });
  assert.deepEqual(r.chunks, ['Sure, I can help with that.']);
  assert.equal(r.rest, ' It');
  r = takeChunks('The first line should stay short, under fifty characters, and', { first: true, final: false });
  assert.deepEqual(r.chunks, ['The first line should stay short,']);
  r = takeChunks('Version 3.5 is out', { first: false, final: false });
  assert.deepEqual(r.chunks, [], 'a decimal point is not a sentence end');
  r = takeChunks('Paris.', { first: true, final: false });
  assert.deepEqual(r.chunks, [], 'the end of the buffer may not be the end of the sentence');
  r = takeChunks('Paris.', { first: true, final: true });
  assert.deepEqual(r.chunks, ['Paris.']);
  r = takeChunks('a '.repeat(120), { first: false, final: false });
  assert.ok(r.chunks.length >= 1 && r.chunks[0].length <= 180, 'a long run without punctuation still gets spoken');
});

test('tool calls are parsed strictly, and only the spoken text is said', () => {
  assert.deepEqual(parseToolCall('{"name":"read_session","arguments":{"last_n":2}}'), { name: 'read_session', args: { last_n: 2 } });
  assert.deepEqual(parseToolCall('{"name":"go_to_sleep"}'), { name: 'go_to_sleep', args: {} });
  assert.equal(parseToolCall('{"name":"rm -rf"}'), null);
  assert.equal(parseToolCall('not json'), null);
  assert.equal(parseToolCall('{"arguments":{}}'), null);
  // Calls Haiku sometimes writes as XML instead (seen in scripts/draft-eval.mjs): still read.
  assert.deepEqual(parseXmlToolCall('<invoke name="draft_prompt">\n<parameter name="text">Add dark mode.</parameter>\n</invoke>'), { name: 'draft_prompt', args: { text: 'Add dark mode.' } });
  assert.deepEqual(parseXmlToolCall('<invoke_draft_prompt>\n<parameter name="text">Add a retry.</parameter>\n</invoke_draft_prompt>'), { name: 'draft_prompt', args: { text: 'Add a retry.' } });
  assert.deepEqual(parseXmlToolCall('<parameter name="draft_prompt">\n<parameter name="text">Add dark mode.</parameter>\n</invoke>'), { name: 'draft_prompt', args: { text: 'Add dark mode.' } });
  assert.deepEqual(parseXmlToolCall('<invoke_tool>\n<invoke name="read_session">\n<parameter name="last_n">4</parameter>\n<parameter name="include_tool_calls">true</parameter>\n</invoke>'), { name: 'read_session', args: { last_n: 4, include_tool_calls: true } });
  assert.equal(parseToolCall('<invoke name="draft_prompt">\n<parameter name="text">Add dark mode.</parameter>\n</invoke>').name, 'draft_prompt');
  assert.equal(parseXmlToolCall('<invoke_placeholder>\n</invoke_placeholder>'), null);
  assert.deepEqual(parseXmlToolCall('<parameter name="get_current_session">{}</parameter>\n</invoke>'), { name: 'get_current_session', args: {} });
  assert.deepEqual(parseXmlToolCall('<invoke_tool>\n{"name": "get_current_session", "arguments": {}}\n</invoke_tool>\noutput>\n[Tool result: made up]'), { name: 'get_current_session', args: {} });
  assert.equal(parseXmlToolCall('<invoke name="rm -rf"></invoke>'), null);
  // Other wrappers Haiku wrote in scripts/listen-eval.mjs: still the call it meant, never spoken.
  assert.deepEqual(parseXmlToolCall('<tool_call>\n<tool_name>get_current_session</tool_name>\n<parameters>{}</parameters>\n</tool_call>'), { name: 'get_current_session', args: {} });
  assert.deepEqual(parseXmlToolCall('<tool_call><tool_name>read_session</tool_name><arguments>{"last_n": 2}</arguments></tool_call>'), { name: 'read_session', args: { last_n: 2 } });
  assert.deepEqual(parseXmlToolCall('<parse>\n{"tool": "draft_prompt", "text": "Make the footer sticky."}\n</parse>'), { name: 'draft_prompt', args: { text: 'Make the footer sticky.' } });
  assert.deepEqual(parseXmlToolCall('<function>{"name": "switch_session", "parameters": {"session": "auth"}}</function>'), { name: 'switch_session', args: { session: 'auth' } });
  assert.deepEqual(parseToolCall('{"tool": "send_draft"}'), { name: 'send_draft', args: {} });
  assert.equal(parseToolCall('{"tool": "rm -rf /"}'), null);
  assert.equal(parseXmlToolCall('<parse>\n</parse>'), null);
  assert.deepEqual(findToolCall('<draft_prompt>{"text": "Rename the utils folder to helpers."}</draft_prompt>\n=====\n<draft_prompt>\n{"text": "Rena').call, { name: 'draft_prompt', args: { text: 'Rename the utils folder to helpers.' } });
  assert.deepEqual(findToolCall('<send_draft>{}</send_draft>').call, { name: 'send_draft', args: {} });
  assert.deepEqual(findToolCall('<happy> Done! The tests pass.'), { call: null, at: -1 }, 'an emote cue is not a call');
  assert.deepEqual(findToolCall('One sec. <tool>{"name": "list_sessions", "arguments": {}}</tool>'), { call: { name: 'list_sessions', args: {} }, at: 9 });
  assert.deepEqual(findToolCall('Checking. <tool_call><tool_name>list_sessions</tool_name></tool_call>').call, { name: 'list_sessions', args: {} });
  assert.deepEqual(findToolCall('Paris is the capital.'), { call: null, at: -1 });
  assert.equal(speakableText('Run **`git status`** — see https://example.com/x'), 'Run git status — see a link');
  assert.equal(speakableText('git reset --soft HEAD~1'), 'git reset --soft HEAD tilde 1');
  for (const junk of ['_check', '="">', '<invoke', '...', '']) assert.equal(isJunk(junk), true, junk);
  for (const words of ['Paris.', 'OK.', 'Hmm.', '"Fix it" is drafted.', '42 tests passed.']) assert.equal(isJunk(words), false, words);
  const p = systemPrompt({ instructions: 'Be Orbit.', tools: [{ name: 'list_sessions', description: 'Lists sessions.', parameters: { type: 'object' } }] });
  assert.match(p, /^Where you run/, 'first: the environment Claude Code adds is not the user\x27s project');
  assert.match(p, /\n\nBe Orbit\./);
  assert.match(p, /<tool>\{"name": "get_current_session", "arguments": \{\}\}<\/tool>/);
  assert.ok(!/"tool_name"/.test(p), 'no placeholder name to copy (Haiku called a tool "tool_name")');
  assert.match(p, /- list_sessions: Lists sessions\./);
});

/** Speech models that hear nothing unless told to, and speak 10 ms of audio per piece. */
function fakeSpeech({ transcript = 'hello' } = {}) {
  const vad = { detected: false, segments: [], acceptWaveform() {}, isDetected() { return this.detected; }, isEmpty() { return !this.segments.length; }, front() { return this.segments[0]; }, pop() { this.segments.shift(); }, reset() { this.segments = []; } };
  return {
    vad,
    said: [],
    newVad: () => vad,
    newResampler: () => ({ resample: (f) => f.subarray(0, Math.floor((f.length * 2) / 3)) }),
    async transcribe() {
      return transcript;
    },
    async speak(text) {
      this.said.push(text);
      return new Float32Array(240);
    },
  };
}

/** A fake `claude` process: records what it's sent and answers each user message with `script`. */
function fakeClaude(script) {
  const calls = [];
  const spawnImpl = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.kill = () => child.emit('close', 0);
    const call = { exe, args, opts, messages: [] };
    calls.push(call);
    let buf = '';
    let chain = Promise.resolve(); // like the real CLI: one turn at a time, in order
    child.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        call.messages.push(msg);
        if (msg.type !== 'user') continue;
        const reply = script(msg.message.content, call.messages.filter((m) => m.type === 'user').length);
        const out = (o) => child.stdout.write(`${JSON.stringify(o)}\n`);
        chain = chain.then(async () => {
          await new Promise((r) => setImmediate(r));
          for (const piece of reply) {
            out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
            await new Promise((r) => setTimeout(r, 2));
          }
          out({ type: 'stream_event', event: { type: 'message_stop' } });
          out({ type: 'result', subtype: 'success', is_error: false, result: reply.join('') });
        });
      }
    });
    return child;
  };
  return { calls, spawnImpl };
}

function collect(sock) {
  const events = [];
  sock.on('message', (d) => events.push(JSON.parse(d)));
  return events;
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const opened = (sock) => new Promise((r) => sock.once('open', r));

test('Claude Code runs with no tools, no settings or MCP, and the user\x27s own login', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-pass';
  const fc = fakeClaude(() => ['Hi.']);
  const sock = createClaudeRealtime({ claudePath: 'C:/x/claude.exe', speech: fakeSpeech(), spawnImpl: fc.spawnImpl });
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'Be Orbit.', tools: [] } }));
  delete process.env.ANTHROPIC_API_KEY;
  const { args, opts } = fc.calls[0];
  const val = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(val('--tools'), '');
  assert.equal(val('--setting-sources'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(val('--model'), 'haiku');
  assert.equal(val('--effort'), 'low');
  assert.equal(val('--input-format'), 'stream-json');
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined, 'never an API key from the environment');
  assert.equal(opts.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(opts.shell, undefined);
  sock.close();
});

test('a reply is spoken piece by piece, and a tool call goes to the bridge and back to Claude', async () => {
  const fc = fakeClaude((text, nth) => (nth === 1 ? ['Let me ', 'check. <to', 'ol>{"name":"get_current_session",', '"arguments":{}}</tool>'] : ['Claude is idle.']));
  const speech = fakeSpeech();
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl: fc.spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [{ name: 'get_current_session', description: 'd', parameters: {} }] } }));
  sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "what's Claude doing?" }] } }));
  sock.send(JSON.stringify({ type: 'response.create' }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  const call = ev.find((e) => e.type === 'response.function_call_arguments.done');
  assert.equal(call.name, 'get_current_session');
  assert.equal(call.arguments, '{}');
  assert.ok(speech.said.includes('Let me check.'), 'the words before the call are spoken');
  assert.ok(!speech.said.some((s) => s.includes('tool')), 'the call itself is never spoken');
  const types = ev.map((e) => e.type);
  assert.ok(types.indexOf('response.output_audio.delta') < types.indexOf('response.function_call_arguments.done'));
  assert.ok(types.indexOf('response.function_call_arguments.done') < types.indexOf('response.done'));

  sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: '{"ok":true,"title":"Fix tests"}' } }));
  sock.send(JSON.stringify({ type: 'response.create' }));
  await until(() => ev.filter((e) => e.type === 'response.done').length === 2);
  const sent = fc.calls[0].messages.filter((m) => m.type === 'user').map((m) => m.message.content);
  assert.equal(sent[1], '[Tool result: get_current_session] {"ok":true,"title":"Fix tests"}');
  assert.equal(ev.filter((e) => e.type === 'response.output_audio_transcript.done').at(-1).transcript, 'Claude is idle.');
  sock.close();
});

test('a call Haiku writes as XML instead still goes to the bridge, and none of it is spoken', async () => {
  const fc = fakeClaude(() => ['On it. <inv', 'oke name="draft_prompt">\n<parameter name="text">Add dark ', 'mode.</parameter>\n</invoke>']);
  const speech = fakeSpeech();
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl: fc.spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [{ name: 'draft_prompt', description: 'd', parameters: {} }] } }));
  sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tell Claude to add dark mode' }] } }));
  sock.send(JSON.stringify({ type: 'response.create' }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  const call = ev.find((e) => e.type === 'response.function_call_arguments.done');
  assert.equal(call?.name, 'draft_prompt');
  assert.deepEqual(JSON.parse(call.arguments), { text: 'Add dark mode.' });
  assert.ok(speech.said.includes('On it.'));
  assert.ok(!speech.said.some((s) => /invoke|parameter|dark mode/.test(s)), 'the call itself is never spoken');
  sock.close();
});

test('speech in becomes a transcript and a reply; talking over a reply cancels it', async () => {
  const fc = fakeClaude(() => ['This is a long answer, ', 'with many words. ', 'And more. '.repeat(50)]);
  const speech = fakeSpeech({ transcript: 'What time is it?' });
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl: fc.spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  const mic = Buffer.alloc(2048 * 2).toString('base64');
  speech.vad.detected = true;
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  assert.ok(ev.some((e) => e.type === 'input_audio_buffer.speech_started'));
  speech.vad.detected = false;
  speech.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  await until(() => ev.some((e) => e.type === 'conversation.item.input_audio_transcription.completed'));
  assert.equal(ev.find((e) => e.type === 'conversation.item.input_audio_transcription.completed').transcript, 'What time is it?');
  await until(() => ev.some((e) => e.type === 'response.output_audio.delta'));
  // The user talks again: the reply stops, and Claude Code is told to stop writing it.
  speech.vad.detected = true;
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  assert.equal(ev.find((e) => e.type === 'response.done').response.status, 'cancelled');
  assert.ok(fc.calls[0].messages.some((m) => m.type === 'control_request' && m.request.subtype === 'interrupt'));
  sock.close();
});

test('a cough (no words) gets no reply', async () => {
  const fc = fakeClaude(() => ['Hi.']);
  const speech = fakeSpeech({ transcript: '' });
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl: fc.spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  speech.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(2048 * 2).toString('base64') }));
  await until(() => ev.some((e) => e.type === 'conversation.item.input_audio_transcription.completed'));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!ev.some((e) => e.type === 'response.created'));
  assert.equal(fc.calls[0].messages.filter((m) => m.type === 'user').length, 0);
  sock.close();
});

test('without Claude Code it reports why and closes', async () => {
  const sock = createClaudeRealtime({ claudePath: '', speech: fakeSpeech() });
  const ev = collect(sock);
  const closed = new Promise((r) => sock.once('close', (code, reason) => r({ code, reason: String(reason) })));
  const c = await closed;
  assert.equal(c.code, 1011);
  assert.match(ev.find((e) => e.type === 'error').error.message, /Claude Code was not found/);
});

test('the model download refuses a file that fails its checksum, and keeps nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-voice-models-'));
  const fetchImpl = async () => new Response('not the model');
  await assert.rejects(downloadModels(root, { fetchImpl }), /checksum/);
  assert.equal(downloadStatus(root).state, 'error');
  assert.equal(modelsReady(root), false);
  assert.deepEqual(fs.readdirSync(root), [], 'no partial or unverified file left behind');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the chosen voice is the one spoken with, and a change applies mid-call', async () => {
  const fc = fakeClaude(() => ['Hello there.']);
  const speech = fakeSpeech();
  const sids = [];
  const speak = speech.speak.bind(speech);
  speech.speak = (text, opts = {}) => (sids.push(opts.sid), speak(text, opts));
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl: fc.spawnImpl, sid: 3 });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  const ask = async (n) => {
    sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }));
    sock.send(JSON.stringify({ type: 'response.create' }));
    await until(() => ev.filter((e) => e.type === 'response.done').length === n);
  };
  await ask(1);
  assert.equal(sids.at(-1), 3);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [], claude_voice: 6 } }));
  await ask(2);
  assert.equal(sids.at(-1), 6);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [], claude_voice: 99 } }));
  await ask(3);
  assert.equal(sids.at(-1), 6, 'an out-of-range voice is ignored');
  sock.close();
});

test('a turn handled locally (an avatar command) never reaches Claude; its note joins the next turn', async () => {
  const fc = fakeClaude(() => ['Sure.']);
  const speech = fakeSpeech({ transcript: 'do a backflip' });
  const seen = [];
  const sock = createClaudeRealtime({
    claudePath: 'claude',
    speech,
    spawnImpl: fc.spawnImpl,
    localTurn: (text) => (seen.push(text), /backflip/.test(text) ? { note: '[Orbit note: the avatar did it.]' } : null),
  });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  const mic = Buffer.alloc(2048 * 2).toString('base64');
  speech.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  await until(() => ev.some((e) => e.type === 'conversation.item.input_audio_transcription.completed'));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, ['do a backflip']);
  assert.ok(!ev.some((e) => e.type === 'response.created'), 'no reply at all: no tokens, no wait');
  assert.equal(fc.calls[0].messages.filter((m) => m.type === 'user').length, 0, 'Claude was not asked');
  // The next thing said goes to Claude as usual, with the note before it.
  speech.transcribe = async () => 'what is Claude doing';
  speech.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  const asked = fc.calls[0].messages.filter((m) => m.type === 'user').map((m) => m.message.content);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\[Orbit note: the avatar did it\.\]\n\nwhat is Claude doing$/);
  // A check that throws is just a normal turn.
  sock.close();
  const fc2 = fakeClaude(() => ['Hi.']);
  const sp2 = fakeSpeech({ transcript: 'hello' });
  const warns = [];
  const sock2 = createClaudeRealtime({ claudePath: 'claude', speech: sp2, spawnImpl: fc2.spawnImpl, onWarn: (m) => warns.push(m), localTurn: () => { throw new Error('boom'); } });
  const ev2 = collect(sock2);
  await opened(sock2);
  sock2.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  sp2.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
  sock2.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  await until(() => ev2.some((e) => e.type === 'response.done'));
  assert.equal(fc2.calls[0].messages.filter((m) => m.type === 'user').length, 1);
  assert.ok(warns.some((w) => /local turn/.test(w)));
  sock2.close();
});

/** Says `transcript` into the engine (one VAD segment) and waits for its reply to end. */
async function speak(sock, speech, ev, transcript) {
  const done = ev.filter((e) => e.type === 'response.done').length;
  speech.transcribe = async () => transcript;
  speech.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(2048 * 2).toString('base64') }));
  await until(() => ev.filter((e) => e.type === 'response.done').length > done, 3000);
}
const userMsgs = (call) => call.messages.filter((m) => m.type === 'user').map((m) => m.message.content);
const promptOf = (call) => fs.readFileSync(call.args[call.args.indexOf('--system-prompt-file') + 1], 'utf8');
/** fakeClaude's spawnImpl, noting which processes were killed (by their index in calls). */
function trackKills(fc) {
  const killed = [];
  const spawnImpl = (...a) => {
    const child = fc.spawnImpl(...a);
    const idx = fc.calls.length - 1;
    const k = child.kill;
    child.kill = () => (killed.push(idx), k());
    return child;
  };
  return { killed, spawnImpl };
}

test('new instructions mid-call (the avatar changed): a new Claude Code takes over between turns, with the call so far', async () => {
  const fc = fakeClaude((text) => (/Orbit warm-up/.test(text) ? ['OK'] : ['Sure.']));
  const { killed, spawnImpl } = trackKills(fc);
  const speech = fakeSpeech();
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'You are Orbit.', tools: [] } }));
  assert.equal(fc.calls.length, 1);
  assert.match(promptOf(fc.calls[0]), /You are Orbit\./);
  await speak(sock, speech, ev, 'what is Claude doing');
  // The user picks Qubit in Settings mid-call.
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'You are Qubit.', tools: [{ name: 'avatar', description: 'Tricks.', parameters: {} }] } }));
  assert.equal(fc.calls.length, 2, 'a new process, at once');
  assert.match(promptOf(fc.calls[1]), /You are Qubit\.[\s\S]*- avatar: Tricks\./);
  await until(() => userMsgs(fc.calls[1]).length === 1);
  const warm = userMsgs(fc.calls[1])[0];
  assert.match(warm, /^\[Orbit warm-up, not the user: your instructions or settings changed/);
  assert.match(warm, /In: what is Claude doing\nYou said: Sure\./, 'it knows the call so far');
  await until(() => killed.includes(0), 2000);
  // From here on the new one answers; the old one is gone.
  await speak(sock, speech, ev, 'and now');
  assert.deepEqual(userMsgs(fc.calls[0]), ['what is Claude doing']);
  assert.equal(userMsgs(fc.calls[1]).at(-1), 'and now');
  // The same instructions again: nothing restarts.
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'You are Qubit.', tools: [{ name: 'avatar', description: 'Tricks.', parameters: {} }] } }));
  assert.equal(fc.calls.length, 2);
  sock.close();
});

test('new instructions while the new process is still warming: the old one answers, and the new one hears what it missed', async () => {
  // The warm-up reply takes a while (long), so the user speaks before it's ready.
  const fc = fakeClaude((text) => (/Orbit warm-up/.test(text) ? Array.from({ length: 60 }, () => 'OK ') : ['Fine.']));
  const { killed, spawnImpl } = trackKills(fc);
  const speech = fakeSpeech();
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'A', tools: [] } }));
  await speak(sock, speech, ev, 'first');
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'B', tools: [] } }));
  await speak(sock, speech, ev, 'second');
  assert.deepEqual(userMsgs(fc.calls[0]), ['first', 'second'], 'the old one answered meanwhile (nobody waited)');
  assert.ok(!killed.includes(0));
  await until(() => killed.includes(0), 5000); // the warm-up finished: the new one took over
  await speak(sock, speech, ev, 'third');
  const last = userMsgs(fc.calls[1]).at(-1);
  assert.match(last, /^\[Orbit, not the user: in this call since then, for context only:\nIn: second\nYou said: Fine\.\n\]\n\nthird$/);
  sock.close();
});

test('the brain behind the voice: its model and effort, and a change mid-call swaps the process between turns', async () => {
  const fc = fakeClaude((text) => (/Orbit warm-up/.test(text) ? ['OK'] : ['Sure.']));
  const { killed, spawnImpl } = trackKills(fc);
  const speech = fakeSpeech();
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl, model: 'sonnet', effort: 'medium' });
  const ev = collect(sock);
  await opened(sock);
  const val = (call, flag) => call.args[call.args.indexOf(flag) + 1];
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'You are Orbit.', tools: [] } }));
  assert.equal(val(fc.calls[0], '--model'), 'sonnet');
  assert.equal(val(fc.calls[0], '--effort'), 'medium');
  await speak(sock, speech, ev, 'hello');
  // "use Opus": the same instructions, a new model.
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'You are Orbit.', tools: [], claude_model: 'opus', claude_effort: 'low' } }));
  assert.equal(fc.calls.length, 2, 'a new process for the new model');
  assert.equal(val(fc.calls[1], '--model'), 'opus');
  assert.equal(val(fc.calls[1], '--effort'), 'low');
  await until(() => userMsgs(fc.calls[1]).length === 1);
  assert.match(userMsgs(fc.calls[1])[0], /In: hello\nYou said: Sure\./, 'it knows the call so far');
  await until(() => killed.includes(0), 2000);
  await speak(sock, speech, ev, 'and now');
  assert.equal(userMsgs(fc.calls[1]).at(-1), 'and now', 'Opus answers from here on');
  // Unknown models and efforts are ignored; the same model again restarts nothing.
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'You are Orbit.', tools: [], claude_model: 'gpt-9', claude_effort: 'max' } }));
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'You are Orbit.', tools: [], claude_model: 'opus' } }));
  assert.equal(fc.calls.length, 2);
  sock.close();
});

test('an unknown model or effort at the start falls back to Haiku, low', async () => {
  const fc = fakeClaude(() => ['Hi.']);
  const sock = createClaudeRealtime({ claudePath: 'claude', speech: fakeSpeech(), spawnImpl: fc.spawnImpl, model: 'gpt-9', effort: 'ultra' });
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  const { args } = fc.calls[0];
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  sock.close();
});

test('new instructions before anything was said: a plain restart with them', async () => {
  const fc = fakeClaude(() => ['Hi.']);
  const sock = createClaudeRealtime({ claudePath: 'claude', speech: fakeSpeech(), spawnImpl: fc.spawnImpl });
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'A', tools: [] } }));
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'B', tools: [] } }));
  assert.equal(fc.calls.length, 2);
  assert.match(promptOf(fc.calls[1]), /\n\nB\n\n/);
  assert.equal(fc.calls[1].messages.length, 0, 'no warm-up needed: nothing to carry over');
  sock.close();
});

test('words that plainly go on wait a moment for the rest: one turn for a dictation with breaths in it', async () => {
  const { soundsUnfinished, CLAUDE_VOICE } = await import('../src/claude-voice.js');
  for (const t of ['Tell Claude that I would like to be able to.', 'and also', 'So, um', 'in some of these apps,']) assert.equal(soundsUnfinished(t), true, t);
  for (const t of ['Fix the login bug.', 'What time is it?', 'Yeah, send it.', 'Thank you.', '']) assert.equal(soundsUnfinished(t), false, t);
  const fc = fakeClaude(() => ['OK.']);
  const speech = fakeSpeech();
  const texts = ['Tell Claude that the inputs in some apps are not,', 'mapped very well.'];
  speech.transcribe = async () => texts.shift() || '';
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl: fc.spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  const mic = Buffer.alloc(2048 * 2).toString('base64');
  const utter = () => {
    speech.vad.detected = true;
    sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
    speech.vad.detected = false;
    speech.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
    sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  };
  utter();
  await until(() => ev.filter((e) => e.type === 'conversation.item.input_audio_transcription.completed').length === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!ev.some((e) => e.type === 'response.created'), 'no turn yet: the words went on');
  utter(); // the rest, after a breath
  await until(() => ev.some((e) => e.type === 'response.done'), CLAUDE_VOICE.unfinishedHoldMs + 2000);
  assert.equal(ev.filter((e) => e.type === 'response.created').length, 1, 'one turn');
  const asked = fc.calls[0].messages.filter((m) => m.type === 'user').map((m) => m.message.content).join('\n');
  assert.match(asked, /are not,\n\nmapped very well\./, 'both parts in that one turn');
  // Unfinished words and then nothing more: they still get their reply after the hold.
  texts.push('and also');
  utter();
  await until(() => ev.filter((e) => e.type === 'response.created').length === 2, CLAUDE_VOICE.unfinishedHoldMs + 2000);
  sock.close();
});
