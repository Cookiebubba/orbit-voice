// The engine oracle's voice relay cases (parity/oracle/gen.mjs): src/server.js's /voice session and
// what the bridge does around it (spoken updates and when Orbit may wake Grok, what Claude finishing
// or waiting means for a call, the resume note between calls), run in a child process on a virtual
// clock with no sockets: the `ws` stand-in lets the script play the page and Grok (or Claude voice's
// stand-in), and Claude's window and Claude Code are the recording stand-ins the tool oracle uses.
// Each step records what went to the page, to the voice, to the event stream, to Claude's window,
// and what was closed. The Swift engine replays the scripts and must do the same.
//   (as a child) node --import ./parity/oracle/stand-ins/register.mjs parity/oracle/relay.mjs --run <home> <script.json>
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T0, tree } from './sessions.mjs';

const HERE = fileURLToPath(import.meta.url);

// What Grok sends.
const ev = (type, extra = {}) => ({ op: 'up', evt: { type, ...extra } });
const speech = (item) => ev('input_audio_buffer.speech_started', { item_id: item });
const heard = (text, item) => ev('conversation.item.input_audio_transcription.completed', { item_id: item, transcript: text });
const reply = (resp, text, item = `${resp}_item`) => [
  ev('response.created', { response: { id: resp } }),
  ev('response.output_audio_transcript.delta', { response_id: resp, item_id: item, delta: text }),
  ev('response.output_audio.delta', { response_id: resp, item_id: item, delta: 'AAAAAAAA' }),
  ev('response.output_audio_transcript.done', { response_id: resp, item_id: item, transcript: text }),
  ev('response.done', { response: { id: resp, status: 'completed', output: [] } }),
];
const call = (resp, name, args, id = `call_${resp}`) => [
  ev('response.created', { response: { id: resp } }),
  ev('response.function_call_arguments.done', { response_id: resp, item_id: `${resp}_fc`, call_id: id, name, arguments: JSON.stringify(args) }),
  ev('response.done', { response: { id: resp, status: 'completed', output: [] } }),
];
const page = (msg) => ({ op: 'page', msg });
const tick = (ms) => ({ op: 'tick', ms });
const finished = (id, title) => ({ op: 'watcher', evt: { type: 'claude.finished', id, title, summary: 'Done.' } });
const waiting = (id, title, kind, tool = 'Bash', toolId = 't1') => ({ op: 'watcher', evt: { type: 'claude.waiting', id, title, kind, tool, toolId, check: 1 } });
const open = (query = '') => [{ op: 'connect', query }, { op: 'upOpen' }];
const hangup = [page({ type: 'ui.bye', reason: 'user', audio: 'running', scheduled: 3.2, played: 3.1, lead: 0.2, cut: 1, kept: 0 }), { op: 'pageClose' }, { op: 'upClose', code: 1000, reason: '' }];

function scenes() {
  const S = [];
  // An ordinary call: Grok answers, a tool runs, the call ends.
  S.push([{ op: 'setting', patch: { announce: 'speak', announceWake: true, wakeOnResults: true, avatar: 'qubit', listenMode: 'always' } }, ...open(),
    speech('i1'), heard("what's Claude doing", 'i1'), ...reply('r1', "Claude's fixing the login bug."), tick(2000),
    speech('i2'), heard('tell claude to fix the login bug', 'i2'), ...call('r2', 'draft_prompt', { text: 'Fix the login bug.' }), tick(1000),
    ...reply('r3', "It's in the box. Send it?"), tick(1500), speech('i3'), heard('yeah', 'i3'), ...call('r4', 'send_draft', {}), ...reply('r5', 'Sent.'), tick(500), ...hangup]);
  // The resume note in the next call; a notification for the prompt the user is waiting on.
  S.push([tick(40_000), ...open(), speech('i1'), heard('where were we', 'i1'), ...reply('r1', 'You sent a prompt.'), finished('local_a', 'Fix the login bug'), tick(100), ...reply('r2', 'Claude finished the login bug.'), tick(300), ...hangup]);
  // Fast paths: go to sleep; the avatar; stop while Claude works.
  S.push([tick(40_000), ...open(), speech('i1'), ev('response.created', { response: { id: 'r1' } }), heard('do a backflip', 'i1'),
    ev('response.output_audio_transcript.delta', { response_id: 'r1', item_id: 'x', delta: 'Sure!' }), ev('response.function_call_arguments.done', { response_id: 'r1', item_id: 'f', call_id: 'c1', name: 'avatar', arguments: '{"action":"backflip"}' }),
    ev('error', { error: { message: 'Unknown event response.cancel', code: 'unknown_event' } }), ev('response.done', { response: { id: 'r1' } }), tick(3000),
    { op: 'working', list: [{ id: 'local_i', title: 'Run the build' }] }, speech('i2'), heard('stop it', 'i2'), tick(50), ...reply('r2', 'Stopped.'), { op: 'working', list: [] }, tick(500),
    speech('i3'), heard('go to sleep', 'i3'), tick(200), ...hangup]);
  // A spoken update: Claude finishes while no call is on, Orbit asks the page to wake Grok, which says it, then listens.
  S.push([tick(40_000), finished('local_h', 'Ask Claude a question'), tick(100), ...open('?announce=1'), tick(50),
    ...reply('a1', 'Claude finished in Ask Claude a question.'), tick(100), page({ type: 'ui.listen_window' }), page({ type: 'input_audio_buffer.append', audio: 'AAAAAAAA' }), tick(1000),
    speech('i1'), heard('thanks', 'i1'), page({ type: 'input_audio_buffer.append', audio: 'AQABAAEA' }), ...reply('a2', 'You are welcome.'), tick(80_000), ...hangup]);
  // A spoken update nobody answers: the window closes and Orbit hangs up.
  S.push([tick(40_000), finished('local_i', 'Run the build'), tick(100), ...open('?announce=1'), ...reply('a1', 'The build finished.'), tick(10), page({ type: 'ui.listen_window' }), tick(5000), { op: 'pageClose' }, { op: 'upClose', code: 1000, reason: '' }]);
  // A spoken update that isn't allowed: too soon, then turned off.
  // (A refused spoken update opens no socket to Grok.)
  S.push([finished('local_a', 'Fix the login bug'), { op: 'connect', query: '?announce=1' }, { op: 'pageClose' }, tick(31_000), { op: 'setting', patch: { announce: 'chime' } }, { op: 'connect', query: '?announce=1' }, { op: 'pageClose' }, { op: 'setting', patch: { announce: 'speak' } }, tick(60_000), ...open('?announce=1'), tick(100), ...reply('a1', 'Login fixed.'), tick(65_000), { op: 'pageClose' }]);
  // Claude waiting on the user mid-call (a permission prompt), and a question.
  S.push([tick(40_000), ...open(), speech('i1'), heard('hello', 'i1'), ...reply('r1', 'Hi.'), waiting('local_i', 'Run the build', 'tool'), tick(100), ...call('r2', 'read_claude_prompt', {}), ...reply('r3', 'It wants to run npm test. Allow it?'),
    speech('i2'), heard('allow it', 'i2'), ...call('r4', 'answer_claude_prompt', { answer: 'allow' }), ...reply('r5', 'Allowed.'), waiting('local_h', 'Ask Claude a question', 'question', 'AskUserQuestion', 'q1'), tick(100), ...reply('r6', 'Claude asks which DB.'), ...hangup]);
  // Typed text, a page error code, Grok closing on its own.
  S.push([tick(40_000), ...open(), page({ type: 'ui.text', text: '  tell claude to add tests  ' }), ...call('r1', 'draft_prompt', { text: 'Add tests.' }), ...reply('r2', 'In the box.'), page({ type: 'ui.state', asleep: true }),
    finished('local_g', 'Plan viewer alpha'), tick(100), page({ type: 'ui.state', asleep: false }), { op: 'upClose', code: 1006, reason: 'gone' }, { op: 'pageClose' }]);
  // xAI refuses the connection; a connection error; no key.
  S.push([tick(40_000), { op: 'connect', query: '' }, { op: 'upRefused', status: 401, body: 'Unauthorized: bad key' }, { op: 'pageClose' }, { op: 'connect', query: '' }, { op: 'upError', message: 'getaddrinfo ENOTFOUND api.x.ai' }, { op: 'upClose', code: 1006, reason: '' }, { op: 'pageClose' }]);
  // xAI doesn't take its own search tools: Orbit switches to search_web.
  S.push([tick(40_000), { op: 'setting', patch: { webSearch: true } }, ...open(), ev('error', { error: { message: 'Invalid tool type web_search', type: 'invalid_request_error' } }), tick(100), speech('i1'), heard('search the web for the latest node version', 'i1'), ...reply('r1', 'Let me look that up.'), ...hangup]);
  // Emote cues in Grok's words, a settings change mid-call, Grok's own response cancelled for a fast path.
  S.push([tick(40_000), ...open(), speech('i1'), heard('how are you', 'i1'), ev('response.created', { response: { id: 'r1' } }),
    ev('response.output_audio_transcript.delta', { response_id: 'r1', item_id: 'm1', delta: '<happy> Great, ' }), ev('response.output_audio_transcript.delta', { response_id: 'r1', item_id: 'm1', delta: 'thanks! <cur' }),
    ev('response.output_audio_transcript.delta', { response_id: 'r1', item_id: 'm1', delta: 'ious> You?' }), ev('response.output_audio_transcript.done', { response_id: 'r1', item_id: 'm1', transcript: '<happy> Great, thanks! <curious> You?' }), ev('response.done', { response: { id: 'r1', output: [{ type: 'message', role: 'assistant', content: [{ type: 'audio', transcript: '<happy> Great!' }] }] } }),
    { op: 'setting', patch: { avatar: 'buddy' } }, tick(100), { op: 'setting', patch: { speed: 1.2 } }, ...hangup]);
  // Claude voice: its stand-in, its own fast path (localTurn) and Claude's settings in session.update.
  S.push([tick(40_000), { op: 'setting', patch: { voiceEngine: 'claude', claudeVoiceModel: 'haiku', avatar: 'qubit' } }, ...open('?speech=local'), { op: 'localTurn', text: 'do a backflip', item: 'item_1' }, { op: 'localTurn', text: 'what is up', item: 'item_2' },
    ...reply('resp_1', 'Not much.'), page({ type: 'orbit.speech_started' }), page({ type: 'orbit.transcript', transcript: 'hello there', ended_ms_ago: 300, stt: 'moonshine' }), page({ type: 'input_audio_buffer.append', audio: 'AAAA' }),
    { op: 'setting', patch: { claudeVoiceModel: 'opus' } }, { op: 'localTurn', text: 'go to sleep', item: 'item_3' }, tick(100), ...hangup, { op: 'setting', patch: { voiceEngine: 'grok' } }]);
  // A wake that's due while a call is on joins it; wakes per hour.
  S.push([tick(40_000), ...open(), finished('local_b', 'Write the release notes'), tick(100), ...reply('r1', 'Release notes done.'), ...hangup, tick(31_000), finished('local_i', 'Run the build'), tick(100),
    ...open('?announce=1'), ...reply('a1', 'Build done.'), page({ type: 'ui.listen_window' }), tick(6000), { op: 'pageClose' }, tick(31_000), finished('local_a', 'Fix the login bug'), tick(31_000), tick(31_000)]);
  return S;
}

// ---------------------------------------------------------------- the child

/** mulberry32 (the stand-ins' answers). */
function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runChild(home, scriptFile) {
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 + 60_000 });
  const root = path.resolve(path.dirname(HERE), '..', '..');
  const load = (...rel) => import(pathToFileURL(path.join(root, ...rel)).href);
  const scenes = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  let log = [];
  const upstreams = [];
  let working = [];
  const watcherFns = new Set();
  globalThis.__oracle = { rng: rngOf(9001), calls: [], windowTitle: () => 'Fix the login bug', str: () => 'x' };
  globalThis.__relay = {
    record: (e) => log.push(e),
    upstreamCreated: (sock, info) => {
      upstreams.push(sock);
      log.push({ kind: 'upNew', i: upstreams.length - 1, ...info });
    },
    upstreamSent: (sock, data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        msg = data;
      }
      log.push({ kind: 'up', i: upstreams.indexOf(sock), msg });
    },
    upstreamClosed: (sock, code, reason) => {
      if (sock.readyState < 2) sock.readyState = 2;
      log.push({ kind: 'upClose', i: upstreams.indexOf(sock), code, reason });
    },
  };
  const r = globalThis.__relay;
  const config = await load('src', 'config.js');
  const avatar = await load('src', 'avatar-commands.js');
  const clipboard = await load('src', 'clipboard.js');
  const server = await load('src', 'server.js');
  const mem = (value) => ({ kind: 'memory', get: () => value, set: (v) => { value = String(v); } });
  const configDir = path.join(home, 'orbit-config');
  // Claude voice's models "downloaded" (its connect checks for them).
  const models = path.join(configDir, 'claude-voice-models');
  for (const f of ['verified.json', 'silero_vad.onnx', 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27/encoder_model.ort', 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27/decoder_model_merged.ort', 'kitten-nano-en-v0_8-fp32/model.fp32.onnx', 'kitten-nano-en-v0_8-fp32/voices.bin']) {
    fs.mkdirSync(path.dirname(path.join(models, f)), { recursive: true });
    fs.writeFileSync(path.join(models, f), '{}');
  }
  const watcher = { on: (fn) => watcherFns.add(fn), start() {}, working: () => working };
  await server.startServer({ port: 0, configDir, secrets: mem('xai-oracle-key-0000000000000000'), brainSecrets: mem(''), watcher, speechInShell: true, clipboard: (t) => log.push({ kind: 'clipboard', text: t }) });
  avatar.setAvatarSink((cmd) => {
    log.push({ kind: 'avatar', cmd });
    return { ok: true };
  });
  server.tapBroadcast((evt) => {
    // (settings.changed carries every setting: only which changed matters here)
    log.push({ kind: 'broadcast', evt: evt.type === 'settings.changed' ? { type: evt.type, changed: evt.changed } : evt });
  });
  config.updateSettings({ anywhere: false, webSearch: false, brainEnabled: true, voiceEngine: 'grok' });

  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((res) => setImmediate(res));
  };
  await flush();
  const out = [];
  let browser = null;
  for (const steps of scenes) {
    const results = [];
    for (const st of steps) {
      log = [];
      globalThis.__oracle.calls = [];
      if (st.op === 'connect') {
        browser = new EventEmitter();
        browser.readyState = 1;
        const b = browser;
        browser.send = (data) => log.push({ kind: 'page', msg: JSON.parse(data) });
        browser.close = () => {
          if (b.readyState >= 2) return;
          b.readyState = 2;
          log.push({ kind: 'pageClosing' });
          setImmediate(() => {
            b.readyState = 3;
            b.emit('close');
          });
        };
        r.wss.emit('connection', browser, { url: `/voice${st.query}`, headers: {} });
      } else if (st.op === 'page') browser.emit('message', Buffer.from(JSON.stringify(st.msg)), false);
      else if (st.op === 'pageClose') {
        if (browser.readyState < 3) {
          browser.readyState = 3;
          browser.emit('close');
        }
      } else if (st.op === 'upOpen') {
        const u = upstreams.at(-1);
        u.readyState = 1;
        u.emit('open');
      } else if (st.op === 'up') upstreams.at(-1).emit('message', Buffer.from(JSON.stringify(st.evt)), false);
      else if (st.op === 'upClose') {
        const u = upstreams.at(-1);
        u.readyState = 3;
        u.emit('close', st.code, Buffer.from(st.reason));
      } else if (st.op === 'upError') upstreams.at(-1).emit('error', new Error(st.message));
      else if (st.op === 'upRefused') {
        const res = new EventEmitter();
        res.statusCode = st.status;
        upstreams.at(-1).emit('unexpected-response', {}, res);
        res.emit('data', Buffer.from(st.body));
        res.emit('end');
      } else if (st.op === 'watcher') for (const fn of watcherFns) fn(st.evt);
      else if (st.op === 'working') working = st.list;
      else if (st.op === 'tick') mock.timers.tick(st.ms);
      else if (st.op === 'setting') config.updateSettings(st.patch);
      else if (st.op === 'localTurn') log.push({ kind: 'localTurnResult', result: r.localTurn ? r.localTurn(st.text, st.item) ?? null : null });
      await flush();
      results.push({ log: JSON.parse(JSON.stringify([...log, ...globalThis.__oracle.calls.map((c) => ({ kind: 'desktop', ...c }))])), now: Date.now() - T0 });
    }
    out.push(results);
  }
  // (to a file: the core prints its own lines on stdout)
  fs.writeFileSync(`${scriptFile}.out`, JSON.stringify(out));
  process.exit(0);
}

export function relayFixtures() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-relay-home-'));
  try {
    const files = tree();
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), content);
    }
    const calls = scenes();
    const scriptFile = path.join(home, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(calls));
    const register = pathToFileURL(path.join(path.dirname(HERE), 'stand-ins', 'register.mjs')).href;
    execFileSync(process.execPath, ['--no-warnings', '--import', register, HERE, '--run', home, scriptFile], { env: { ...process.env, HOME: home, USERPROFILE: home, XAI_REALTIME_URL: '' }, stdio: 'ignore' });
    return { t0: T0, files, calls, results: JSON.parse(fs.readFileSync(`${scriptFile}.out`, 'utf8')) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--run' && path.resolve(process.argv[1]) === HERE) await runChild(process.argv[3], process.argv[4]);
