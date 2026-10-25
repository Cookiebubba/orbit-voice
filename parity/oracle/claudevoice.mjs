// The engine oracle's Claude voice cases (parity/oracle/gen.mjs): src/claude-voice.js's realtime
// stand-in (createClaudeRealtime, with the app's own speech: localSpeech) driven by scripts of what
// the bridge sends it and what Claude Code writes back, on a virtual clock (node:test's mock timers),
// with a stand-in Claude Code process that records how it was started and every line it was sent.
// The Swift engine replays each script and must emit the same messages, start the same processes and
// write the same lines, at the same virtual times.
//   (as a child) node parity/oracle/claudevoice.mjs --run <script.json>
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const T0 = 1_800_000_000_000;

// What Claude Code writes (stream-json).
const text = (t) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } });
const stop = () => ({ type: 'stream_event', event: { type: 'message_stop' } });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'x', ...extra });
const init = () => ({ type: 'system', subtype: 'init', model: 'haiku', tools: [] });
const words = (s) => (s.match(/\S+\s*|\s+/g) || []).map(text);

const TOOLS = [
  { type: 'function', name: 'get_current_session', description: 'Find out which session is open.', parameters: { type: 'object', properties: {}, required: [] } },
  { type: 'function', name: 'draft_prompt', description: 'Draft a prompt.\n  It types it.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'The prompt.' }, verbatim: { type: 'boolean' } }, required: ['text'] } },
  { type: 'web_search' },
];
const update = (extra = {}) => ({ type: 'session.update', session: { instructions: 'You are Orbit.\nBe brief.', tools: TOOLS, audio: { output: { speed: 1.1 } }, claude_voice: 2, claude_model: 'haiku', claude_effort: 'low', claude_stt: 'moonshine', ...extra } });
const said = (t, ended = 300) => [{ op: 'send', msg: { type: 'orbit.speech_started' } }, { op: 'send', msg: { type: 'orbit.transcript', transcript: t, ended_ms_ago: ended, stt: 'moonshine' } }];
const out = (lines, proc = -1) => ({ op: 'out', proc, lines });
const reply = (s, proc = -1) => [out(words(s), proc), out([stop(), result()], proc)];

/** Scenes: one call each. */
function scenes() {
  const S = [];
  const open = (opts = {}) => [{ op: 'open', opts }, { op: 'send', msg: update() }, out([init()], 0), out([text('OK'), stop(), result()], 0)];
  // An ordinary turn.
  S.push([...open(), ...said('what is Claude doing'), { op: 'tick', ms: 400 }, ...reply('Claude is fixing the login bug. It should be done soon.'), { op: 'tick', ms: 100 }, { op: 'close' }]);
  // Words arriving in one chunk, a cue, and a long reply cut at commas.
  S.push([...open(), ...said('tell me a story'), out([text('<happy> Once upon a time, in a land far away from here and everything, there lived a very small cube. '), text('It hopped. <curious> Why? Nobody knew!')]), out([stop(), result()]), { op: 'close' }]);
  // A tool call: a filler first, then the call.
  S.push([...open(), ...said('what is my session'), out([text('<tool>{"name": "get_current_session", "arguments": {}}</tool>')]), out([stop(), result()]),
    { op: 'send', msg: { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_REF', output: '{"open_in_app":"Fix the login bug"}' } } }, { op: 'send', msg: { type: 'response.create' } },
    ...reply('You are in Fix the login bug.'), { op: 'close' }]);
  // Words, then a tool call in the same reply; text after the call is ignored.
  S.push([...open(), ...said('draft fix the tests'), out([text('Sure. <tool>{"name": "draft_prompt", "arguments": {"text": "Fix the tests."}}</tool> and more')]), out([stop(), result()]), { op: 'close' }]);
  // An XML call, read when the message ends.
  S.push([...open(), ...said('list them'), out([text('<invoke name="draft_prompt"><parameter name="text">Fix it.</parameter></invoke>')]), out([stop(), result()]), { op: 'close' }]);
  // Slow to start: the slow filler after 1.5 s, then the words.
  S.push([...open(), ...said('why is the build slow'), { op: 'tick', ms: 1600 }, ...reply('Because of the cache.'), { op: 'close' }]);
  // Sounds unfinished: held a moment, then more words join it.
  S.push([...open(), ...said('tell Claude that I would like to'), { op: 'tick', ms: 600 }, ...said('add tests'), ...reply('Okay.'), { op: 'close' }]);
  // Sounds unfinished, nothing more: answered after the hold.
  S.push([...open(), ...said('and also'), { op: 'tick', ms: 1100 }, ...reply('Go on.'), { op: 'close' }]);
  // Talked over: the user speaks while the reply is coming.
  S.push([...open(), ...said('read me the news'), out(words('Here is the first thing, which is quite long and goes on, ')), { op: 'send', msg: { type: 'orbit.speech_started' } }, out(words('and more. ')), out([stop(), result()]), ...said('stop'), ...reply('Stopped.'), { op: 'close' }]);
  // Cancelled by the bridge.
  S.push([...open(), ...said('do something'), out(words('Doing it now, ')), { op: 'send', msg: { type: 'response.cancel' } }, out([stop(), result()]), { op: 'close' }]);
  // A cough: no words, no reply; and the fast path handling a turn here.
  S.push([...open(), ...said('...'), { op: 'tick', ms: 100 }, ...said('do a backflip'), { op: 'tick', ms: 100 }, ...said('what was that'), ...reply('A backflip.'), { op: 'close' }]);
  // An Orbit note and a response asked for by the bridge.
  S.push([...open(), { op: 'send', msg: { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[App notification] Claude finished.' }] } } }, { op: 'send', msg: { type: 'response.create' } }, ...reply('Claude finished.'), { op: 'close' }]);
  // Two turns asked for at once: the second waits for the first.
  S.push([...open(), ...said('first question'), ...said('second question'), ...reply('First answer.'), ...reply('Second answer.'), { op: 'close' }]);
  // New instructions mid-call: a new process warms up with the call so far and takes over between turns.
  S.push([...open(), ...said('hello'), ...reply('Hi.'), { op: 'send', msg: update({ instructions: 'You are Qubit.' }) }, out([init()], 1), ...said('who are you'), out([text('OK'), stop(), result()], 1), ...reply('I am Orbit.', 0), ...said('and now'), ...reply('I am Qubit.', 1), { op: 'close' }]);
  // New instructions before anything was said: just start over.
  S.push([...open(), { op: 'send', msg: update({ instructions: 'You are Buddy.' }) }, out([init()], 1), out([text('OK'), stop(), result()], 1), ...said('hi'), ...reply('Hello.', 1), { op: 'close' }]);
  // A new brain (model) mid-call, then back again before it took over.
  S.push([...open(), ...said('hello'), ...reply('Hi.'), { op: 'send', msg: update({ claude_model: 'opus' }) }, { op: 'send', msg: update() }, ...said('still there'), ...reply('Yes.'), { op: 'close' }]);
  // The warm-up of a new process fails: the old one carries on.
  S.push([...open(), ...said('hello'), ...reply('Hi.'), { op: 'send', msg: update({ instructions: 'You are Qubit.' }) }, out([text('nope'), stop(), result({ is_error: true, result: 'boom' })], 1), ...said('again'), ...reply('Still Orbit.', 0), { op: 'close' }]);
  // Claude Code reports an error (signed out), and another kind.
  S.push([...open(), ...said('hello'), out([stop(), result({ is_error: true, result: 'Invalid API key · Please run /login' })]), ...said('again'), out([stop(), result({ is_error: true, subtype: 'error_during_execution', result: 'Overloaded' })]), { op: 'close' }]);
  // Claude Code stops mid-turn: the call fails.
  S.push([...open(), ...said('hello'), out(words('Partly ')), { op: 'exit', proc: 0, stderr: 'boom\nsegfault in the thing' }, { op: 'tick', ms: 10 }]);
  // Claude Code stops between turns (the next turn fails at once).
  S.push([...open(), { op: 'exit', proc: 0 }, ...said('hello'), { op: 'tick', ms: 10 }]);
  // Settings carried in session.update: voice, speed, a bad model and effort ignored.
  S.push([{ op: 'open', opts: { model: 'nope', effort: 'max', sid: 9, speed: 1 } }, { op: 'send', msg: update({ claude_voice: 5, claude_model: 'gpt', claude_effort: 'insane', audio: { output: { speed: 0.8 } } }) }, out([init()], 0), ...said('hi'), ...reply('Hi there.'), { op: 'close' }]);
  // A tool result then a cue with nothing after it.
  S.push([...open(), ...said('celebrate'), out([text('Done! <happy>')]), out([stop(), result()]), { op: 'close' }]);
  // Junk before a call is not said.
  S.push([...open(), ...said('check'), out([text('_check <tool>{"name":"get_current_session","arguments":{}}</tool>')]), out([stop(), result()]), { op: 'close' }]);
  // The result arrives without a message_stop.
  S.push([...open(), ...said('quick'), out([...words('Quick answer.'), result()]), { op: 'close' }]);
  // Markdown and links aren't read out.
  S.push([...open(), ...said('show me'), ...reply('See **this** at https://example.com/x and `code`. Then HEAD~1.'), { op: 'close' }]);
  // Closing mid-turn.
  S.push([...open(), ...said('long one'), out(words('This goes on ')), { op: 'close' }]);
  // Messages before open, and junk.
  S.push([{ op: 'open', opts: {} }, { op: 'send', msg: { type: 'nonsense' } }, { op: 'send-raw', data: '{not json' }, { op: 'send', msg: update() }, ...said(''), ...said('hi'), ...reply('Hi.'), { op: 'close' }]);
  return S;
}

// ---------------------------------------------------------------- the child

async function runChild(scriptFile) {
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
  const root = path.resolve(path.dirname(HERE), '..', '..');
  const cv = await import(pathToFileURL(path.join(root, 'src', 'claude-voice.js')).href);
  const calls = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const all = [];
  for (const steps of calls) {
    const procs = [];
    let sock = null;
    const log = [];
    const results = [];
    const spawnImpl = (exe, args, opts) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 0;
      child.kill = () => log.push({ kind: 'kill', proc: procs.indexOf(child) });
      const i = procs.length;
      procs.push(child);
      const promptAt = args.indexOf('--system-prompt-file');
      const prompt = promptAt >= 0 ? fs.readFileSync(args[promptAt + 1], 'utf8') : null;
      const shown = args.map((a, k) => (k === promptAt + 1 ? 'PROMPT_FILE' : a));
      log.push({ kind: 'spawn', proc: i, exe, args: shown, prompt, cwd: opts.cwd === path.join(os.tmpdir(), 'orbit-voice-not-a-project') ? 'VOICE_CWD' : opts.cwd, quiet: opts.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null, apiKey: opts.env.ANTHROPIC_API_KEY ?? null });
      let buf = '';
      child.stdin.on('data', (d) => {
        buf += d;
        let n;
        while ((n = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, n);
          buf = buf.slice(n + 1);
          log.push({ kind: 'stdin', proc: i, line: line.replace(/"request_id":"int_[0-9a-f]{8}"/, '"request_id":"int_ID"') });
        }
      });
      return child;
    };
    for (const st of steps) {
      log.length = 0;
      if (st.op === 'open') {
        sock = cv.createClaudeRealtime({
          claudePath: '/fake/bin/claude',
          localSpeech: true,
          spawnImpl,
          ...st.opts,
          localTurn: (t, itemId) => {
            log.push({ kind: 'localTurn', text: t, itemId });
            return /backflip/i.test(t) ? { note: '[Orbit note: Orbit did a backflip itself.]' } : null;
          },
          onMetrics: (m) => log.push({ kind: 'metrics', m: { ...m, endedAt: m.endedAt - T0, heardAt: m.heardAt - T0, textAt: m.textAt - T0, firstTokenAt: m.firstTokenAt ? m.firstTokenAt - T0 : null, firstAudioAt: m.firstAudioAt ? m.firstAudioAt - T0 : null, fillerAt: m.fillerAt ? m.fillerAt - T0 : null } }),
          onWarn: (what) => log.push({ kind: 'warn', what }),
        });
        sock.on('message', (data) => log.push({ kind: 'emit', msg: JSON.parse(data) }));
        sock.on('open', () => log.push({ kind: 'open' }));
        sock.on('close', (code, reason) => log.push({ kind: 'close', code, reason: String(reason) }));
        sock.on('error', () => {});
      } else if (st.op === 'send') sock.send(st.data);
      else if (st.op === 'send-raw') sock.send(st.data);
      else if (st.op === 'out') {
        const p = procs.at(st.proc);
        p?.stdout.emit('data', Buffer.from(st.lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
      } else if (st.op === 'exit') {
        const p = procs.at(st.proc);
        if (st.stderr) p?.stderr.emit('data', Buffer.from(st.stderr));
        p?.emit('close', 1);
      } else if (st.op === 'tick') mock.timers.tick(st.ms);
      else if (st.op === 'close') sock.close();
      await flush();
      results.push({ log: JSON.parse(JSON.stringify(log)), now: Date.now() - T0, readyState: sock?.readyState ?? null });
    }
    all.push(results);
  }
  process.stdout.write(JSON.stringify(all));
}

export function claudeVoiceFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-cv-'));
  try {
    // Each message as its exact JSON text too (its keys' order is what the system prompt carries).
    const calls = scenes().map((steps) => steps.map((st) => (st.op === 'send' ? { ...st, data: JSON.stringify(st.msg) } : st)));
    const file = path.join(dir, 'script.json');
    fs.writeFileSync(file, JSON.stringify(calls));
    const out = execFileSync(process.execPath, ['--no-warnings', HERE, '--run', file], { encoding: 'utf8', maxBuffer: 256 << 20 });
    return { t0: T0, calls, results: JSON.parse(out) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--run' && path.resolve(process.argv[1]) === HERE) await runChild(process.argv[3]);
