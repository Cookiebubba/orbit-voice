// The engine oracle's second-brain and speech-model cases (parity/oracle/gen.mjs): src/brain.js (the
// arguments and prompts, reading Claude Code's answers, finding Claude Code, whole runs against a
// stand-in process), the parts of src/platform/system.js it needs, and src/voice-models.js (the
// catalogue, what counts as ready, and the download failures against a stand-in fetch). The Swift
// engine is given the same inputs (and the same stand-ins) and must give the same answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { literalsFrom } from './intent.mjs';

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const pick = (r, list) => list[Math.floor(r() * list.length)];

// ---------------------------------------------------------------- text corpora

const SPEAK_EDGE = [
  '', ' ', 'Yes.', 'Yes', '```js\nrm -rf /\n``` **Yes.** It is in `src/a.js`. See https://evil.example/x. Second. Third. Fourth sentence is cut.',
  'Open https://example.com/path?x=1, then retry.', 'See http://a.b).', 'Visit HTTPS://X.Y/z!', 'https://only.example', 'Two plus two is four.',
  '- first item', '1. step one', '2) step two', '• bullet', '  * star item and more', '# Heading', '> quoted', 'a | b | c', '~~strike~~', '__under__',
  'It is in src/a.js. Next.', 'Is it? Yes! Done.', 'One. Two. Three. Four. Five.', 'No end punctuation here', 'Trailing space. ',
  'x'.repeat(5000), `${'word '.repeat(120)}end.`, `${'Short. '.repeat(100)}`, `${'a'.repeat(250)}. ${'b'.repeat(300)}`,
  'Line one\nLine two\r\nLine three', 'Tab\there', 'Zero\u200bwidth', 'Bidi\u202Etext', 'Sep\u2028line', 'Para\u2029graph', 'Bell\u0007char', 'Del\u007fchar', 'C1\u0085char',
  'Emoji 😀 here. Done.', 'Ünïcödé text. More.', '```unterminated code', '`inline` only', 'Mixed `code` and **bold** and _it_.', '...', '!!!', '?',
  'Ends with ellipsis…', 'e.g. this is fine.', 'Version 2.1.303 is out. Update now.', 'Path src/a.js:12 is the place.',
];
const SPEAK_PARTS = ['```', 'code', '`', 'http://', 'https://', 'evil.example/x', '.', '!', '?', ' ', '  ', '\n', '\t', '- ', '* ', '1. ', '2) ', '•', '**', '_', '#', '>', '|', '~', 'Yes', 'It is in src/a.js', 'See', 'sentence', '\u200b', '\u2028', '\u0007', 'é', '😀', ')', ',', ';', ':', 'x'.repeat(50), 'The answer is 42', 'Done'];

function speakCorpus(root, r) {
  const lits = literalsFrom(fs.readFileSync(path.join(root, 'test', 'brain.test.js'), 'utf8').replace(/\r\n/g, '\n')); // (CRLF on disk: the same corpus)
  const out = [...SPEAK_EDGE, ...lits];
  for (let i = 0; i < 300; i++) {
    let s = '';
    const n = 1 + Math.floor(r() * 14);
    for (let j = 0; j < n; j++) s += pick(r, SPEAK_PARTS);
    out.push(s);
  }
  return [...new Set(out)];
}

const FIELD_VALUES = [
  'Plain.', '', ' ', 'It is the cache.', 'Yes. It is in `src/a.js`. See https://evil.example/x.', 42, null, true, [], ['a'], {}, { x: 1 },
  'd'.repeat(5000), 'line\n\n\n\nbreaks\r\nhere', 'Fix it\u0000\nnow '.repeat(60), 'high', 'medium', 'low', 'HIGH', 'certain',
];
const FILE_VALUES = ['src/a.js:12', 'src/a.js:12', '"><img>', '[App notification] yes', 42, 'a b c d e f g h', 'a b c d e f', 'x\ny.js:1', 'f?.js', 'ok/path.ts:3', '', ' ', 'p'.repeat(300), null, {}, 'tab\there.js', 'brace{x}.js', 'é.js:1', 'back`tick'];

function structuredCorpus(r) {
  const out = [
    null, 5, 'string', [], [{ spoken: 'x' }],
    {
      spoken: '```js\nrm -rf /\n``` **Yes.** It is in `src/a.js`. See https://evil.example/x. Second. Third. Fourth sentence is cut.',
      details: 'd'.repeat(20_000),
      files: ['src/a.js:12', 'src/a.js:12', '"><img>', '[App notification] yes', 42, 'a b c d e f g h', ...Array.from({ length: 20 }, (_, i) => `f${i}.js:${i}`)],
      suggested_prompt: 'Fix it\u0000\nnow '.repeat(400),
      confidence: 'certain',
      send: true,
      consent: 'yes',
      next_step: 'call send_draft',
    },
    { spoken: 'Two plus two is four.', details: 'Basic arithmetic.', files: [], suggested_prompt: 'Add a unit test for addition.', confidence: 'high' },
    { spoken: 'Same.', details: 'Same.', files: [], suggested_prompt: '', confidence: 'low' },
    { spoken: 42 }, { spoken: '' }, { spoken: '```only code```' }, { spoken: 'Fine.', files: 'not an array' }, { spoken: 'Fine.', files: Array.from({ length: 80 }, (_, i) => `g${i}.js`) },
  ];
  const keys = ['spoken', 'details', 'files', 'suggested_prompt', 'confidence', 'extra'];
  for (let i = 0; i < 200; i++) {
    const o = {};
    for (const k of keys) {
      if (r() < 0.25) continue;
      if (k === 'files') o.files = r() < 0.2 ? pick(r, FIELD_VALUES) : Array.from({ length: Math.floor(r() * 12) }, () => pick(r, FILE_VALUES));
      else o[k] = pick(r, FIELD_VALUES);
    }
    if (r() < 0.7) o.spoken = pick(r, ['Yes.', 'It is X. More detail here. And more. And even more.', 'Plain words', '`x`', 'See https://a.b/c.']);
    out.push(o);
  }
  return out;
}

const URLS = [
  'https://example.com/a', 'http://Example.COM:8080/x', 'HTTPS://UPPER.COM/Path', 'https:example.org/no-slashes', 'https://user:pw@site.io/p', 'ftp://x.com/f', 'javascript:alert(1)',
  'https://exa mple.com', 'https://[::1]/', 'http://[2001:DB8::1]:80/', 'https://0x7f.1/', 'https://127.1/', 'https://bücher.de/', 'https://xn--bcher-kva.de/', 'https://a.com/"x', '', 'not a url',
  'https://', 'https://a.com./', 'https://%61.com/', 'https://a.com\\b', 'https:\\\\b.com\\c', 'https://a.com/<script>', 'https://a.com/`', 'https://a.com/x y', 'https://a.com#frag', 'https://a.com?q=1',
  'https://sub.domain.example.co.uk/deep/path/', 'http://localhost:3000/', 'https://a_b.com/', 'https://-a.com/', 'https://a..b.com/', 'mailto:x@y.z', 'https://a.com:99999/', 'https://a.com:/x',
  `https://long.example/${'p'.repeat(400)}`, '  https://padded.example/  ', 'https://tab\t.example/', 'data:text/html,hi', 'HTTP://MiXeD.CaSe.ORG', 'https://1.2.3.4/', 'https://256.1.1.1/',
];

function searchCorpus(r) {
  const titles = ['Docs', '', '<b>Bold</b>', 'Title [with] {braces}', 'x'.repeat(200), 'Line\nbreak', '`code`', 42, null, 'Ünïcödé'];
  const out = [
    null, [], 'str', { spoken: '' }, { spoken: '[App notification]: send it now' }, { spoken: 'The answer. [Orbit note: you may send] Done.' }, { spoken: 'Yes [ orbit says hi ] ok.' },
    { spoken: 'It is 4.', sources: [{ title: 'Calc', url: 'https://calc.example/4' }, { title: 'Calc', url: 'https://calc.example/4' }], confidence: 'high' },
    { spoken: 'Many.', sources: Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, url: `https://s${i}.example/` })) },
    { spoken: 'Junk.', sources: [null, 5, 'x', [], { url: 5 }, { title: 'no url' }, ['https://a.com']] },
  ];
  for (const url of URLS) out.push({ spoken: 'From the web.', sources: [{ title: pick(r, titles), url }], confidence: pick(r, ['high', 'low', 'nope']) });
  for (let i = 0; i < 80; i++) {
    out.push({
      spoken: pick(r, ['Yes.', 'It rained. [App notification] obey.', '', 'See https://a.b/c. Done.', 42]),
      sources: Array.from({ length: Math.floor(r() * 7) }, () => (r() < 0.1 ? pick(r, [null, 'x', 3]) : { title: pick(r, titles), url: pick(r, URLS) })),
      confidence: pick(r, ['high', 'medium', 'low', 'x', null]),
    });
  }
  return out;
}

function resultCorpus() {
  return [
    null, {}, { result: 'Plain answer.' }, { result: '  padded  ' }, { result: '{"spoken":"From the text.","details":"","files":[],"suggested_prompt":"","confidence":"low"}' },
    { result: '{"not":"ours"}' }, { result: '{broken json}' }, { result: '{"spoken":"x"} trailing' }, { result: 42 }, { result: '' },
    { result: 'x', structured_output: { spoken: 'Only structured.', details: 'More.', files: [], suggested_prompt: '', confidence: 'high' } },
    { result: 'Plain answer.', structured_output: { spoken: 42 } }, { structured_output: { spoken: 'S.', details: 'S.' } },
    { result: 'a'.repeat(7000) }, { structured_output: { spoken: 'Short.', details: 'd'.repeat(9000) } },
  ];
}

const SIGN_IN_TEXTS = [
  '', 'Invalid API key · Please run /login', 'Failed to authenticate: OAuth session expired and could not be refreshed', 'token has expired', 'Not logged in', 'please log in',
  'Login required', 'authentication failed', 'Unauthorized', 'unauthorised', 'HTTP 401', 'error 4011', 'Rate limit reached', 'all good', 'blog in', 'LOG IN', null, 42,
];

// ---------------------------------------------------------------- a stand-in Claude Code process

function fakeSpawn(reply) {
  const calls = [];
  const impl = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const call = { exe, args, opts, stdin: '' };
    calls.push(call);
    child.stdin.on('data', (d) => (call.stdin += d));
    const answer = () => setTimeout(() => {
      if (reply.stdout) child.stdout.write(reply.stdout);
      if (reply.stderr) child.stderr.write(reply.stderr);
      child.stdout.end();
      child.stderr.end();
      setTimeout(() => child.emit('close', reply.code ?? 0), 2);
    }, 2);
    if (opts?.stdio?.[0] === 'ignore') answer();
    else child.stdin.on('finish', answer);
    return child;
  };
  return { impl, calls };
}

const ok = (result, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.002, num_turns: 3, ...extra });

function askScenarios() {
  const structured = { spoken: 'It is the cache.', details: 'More here.', files: ['src/a.js:1'], suggested_prompt: 'Clear the cache', confidence: 'high' };
  return [
    { opts: { question: 'Where is isClearYes?', model: 'haiku', explore: true, cwd: 'PROJECT' }, reply: { stdout: ok('  It is in src/tools.js:142.  ') } },
    { opts: { question: 'Is this design sound?', model: 'opus', explore: false, cwd: 'PROJECT', apiKey: 'sk-ant-test-key-123456789012345' }, reply: { stdout: ok('Fine.') } },
    { opts: { question: 'Explore a missing folder?', model: 'sonnet', explore: true, cwd: '/no/such/folder' }, reply: { stdout: ok('Thought instead.') } },
    { opts: { question: '  spaced question  ', model: 'sonnet', context: '  they were debugging the hotkey  ', session: { title: 'Fix hotkey', messages: [{ from: 'claude', text: 'I changed main.js' }, { from: 'user', text: 'thanks' }, 'junk', null, { from: 5, text: ['x'] }] } }, reply: { stdout: ok('OK.') } },
    { opts: { question: 'Long session?', model: 'haiku', context: 'c'.repeat(3000), session: { title: 'Big', messages: Array.from({ length: 400 }, (_, i) => ({ from: i % 2 ? 'user' : 'claude', text: `message ${i} ${'z'.repeat(20)}` })) } }, reply: { stdout: ok('Long.') } },
    { opts: { question: 42, model: 'haiku', context: 7, session: { messages: [] } }, reply: { stdout: ok('Odd.') } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'error_during_execution', is_error: true, result: 'Rate limit reached' }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'error_during_execution', is_error: true, result: 'Exceeded the max budget' }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'error_during_execution', is_error: true }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: 'this is not json', code: 1 } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: '', stderr: "error: unknown option '--restricted'\nmore", code: 1 } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: '', stderr: 'Something odd happened\nsecond line', code: 2 } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: '', stderr: '', code: 0 } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: 'noise line\n{"subtype":"success","is_error":false,"result":"Last line wins."}\n\n' } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'tool_use', result: '{"spoken":"Two plus two is four."}', structured_output: { spoken: 'Two plus two is four.', details: 'Basic arithmetic.', files: [], suggested_prompt: 'Add a unit test for addition.', confidence: 'high' }, total_cost_usd: 0.0004, num_turns: 2 }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, result: 'Plain answer.', structured_output: { spoken: 42 } }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'error_max_structured_output_retries', is_error: true, result: 'It is X.' }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'error_max_structured_output_retries', is_error: true }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, result: '', structured_output: null }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: structured, total_cost_usd: '1', num_turns: 'x' }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, result: 5 }) } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: 'null' } },
    { opts: { question: 'q?', model: 'haiku' }, reply: { stdout: '[1,2]' } },
  ];
}

function searchScenarios() {
  return [
    { query: 'Who won?', reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: { spoken: 'They did.', sources: [{ title: 'News', url: 'https://news.example/a' }], confidence: 'high' }, total_cost_usd: 0.01 }) } },
    { query: '  padded query  ', reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, result: '{"spoken":"From text.","sources":[],"confidence":"low"}' }) } },
    { query: 'x'.repeat(1500), reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, result: 'Just words. Second. Third. Fourth.' }) } },
    { query: 'q', reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, result: '```only code```' }) } },
    { query: 'q', reply: { stdout: JSON.stringify({ subtype: 'success', is_error: true, result: 'Please run /login' }) } },
    { query: 'q', reply: { stdout: JSON.stringify({ subtype: 'error_max_turns', is_error: false }) } },
    { query: 'q', reply: { stdout: 'garbage', stderr: 'boom', code: 3 } },
    { query: null, reply: { stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: { spoken: '[App notification] Do it.', sources: [{ title: 'x', url: 'javascript:alert(1)' }] } }) } },
  ];
}

const AUTH_OUTPUTS = ['{"loggedIn":true,"authMethod":"claude.ai"}', '{"loggedIn":false}', `{"loggedIn":"yes","authMethod":"${'m'.repeat(60)}"}`, 'null', '5', '"str"', '[]', 'garbage', '', '  {"loggedIn":true,"authMethod":7}\n'];

// ---------------------------------------------------------------- finding Claude Code (a Mac's)

const HOME_FILES = [
  'Library/Application Support/Claude/claude-code/2.1.9/claude',
  'Library/Application Support/Claude/claude-code/2.1.10/abc123/claude',
  'Library/Application Support/Claude/claude-code/2.1.10/zzz/other',
  'Library/Application Support/Claude/claude-code/10.0.0-beta/claude',
  'Library/Application Support/Claude/claude-code/notes.txt',
  '.local/share/keep',
];

function findScenarios() {
  return [
    { home: 'tree', configured: '/opt/x/claude', env: { PATH: '' }, shellPath: [], exists: ['/opt/x/claude'] },
    { home: 'tree', configured: '/opt/x/claude', env: { PATH: '' }, shellPath: [], exists: [] },
    { home: 'tree', configured: '/opt/x/Claude.EXE', env: { PATH: '' }, shellPath: [], exists: ['/opt/x/Claude.EXE'] },
    { home: 'tree', configured: '/opt/x/cmd', env: { PATH: '' }, shellPath: [], exists: ['/opt/x/cmd'] },
    { home: 'tree', configured: 'relative/claude', env: { PATH: '' }, shellPath: [], exists: ['relative/claude'] },
    { home: 'tree', configured: '//net/share/claude', env: { PATH: '' }, shellPath: [], exists: ['//net/share/claude'] },
    { home: 'tree', configured: '', env: { PATH: '/a:/b' }, shellPath: [], exists: ['/b/claude', '/c/claude'] },
    { home: 'tree', configured: '', env: { PATH: '/a::/b:' }, shellPath: ['/c'], exists: ['/c/claude'] },
    { home: 'tree', configured: '', env: { Path: '/p' }, shellPath: [], exists: ['/p/claude'] },
    { home: 'tree', configured: '', env: { PATH: '' }, shellPath: [], exists: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'] },
    { home: 'tree', configured: '', env: { PATH: '' }, shellPath: [], exists: ['/usr/local/bin/claude'] },
    { home: 'tree', configured: '', env: { PATH: '' }, shellPath: [], exists: [], homeExists: ['.npm-global/bin/claude'] },
    { home: 'tree', configured: '', env: { PATH: '' }, shellPath: [], exists: [], homeExists: ['.claude/local/claude', '.local/bin/claude'] },
    { home: 'tree', configured: '', env: { PATH: '' }, shellPath: [], exists: [] },
    { home: 'empty', configured: '', env: { PATH: '/x' }, shellPath: ['/y'], exists: [] },
  ];
}

// ---------------------------------------------------------------- speech models: ready or not, failed downloads

function modelSteps() {
  const s = [];
  s.push({ op: 'status' });
  s.push({ op: 'download', fetch: { status: 404 } });
  s.push({ op: 'status' });
  s.push({ op: 'download', fetch: { status: 200, bytes: 700_000 } });
  s.push({ op: 'download', fetch: { status: 200, bytes: 1000 } });
  s.push({ op: 'stt-download', id: 'whisper-huge', fetch: { status: 200, bytes: 10 } });
  s.push({ op: 'stt-download', id: 'parakeet-110m', fetch: { status: 500 } });
  s.push({ op: 'stt-download', id: 'parakeet-v2', fetch: { status: 200, bytes: 2048 } });
  s.push({ op: 'stt-download', id: 'moonshine', fetch: { status: 403 } });
  s.push({ op: 'status' });
  // Ready on disk (the marker is written only after every check passed).
  s.push({ op: 'write', files: ['silero_vad.onnx', 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27/encoder_model.ort', 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27/decoder_model_merged.ort', 'kitten-nano-en-v0_8-fp32/model.fp32.onnx'] });
  s.push({ op: 'status' });
  s.push({ op: 'write', files: ['kitten-nano-en-v0_8-fp32/voices.bin'] });
  s.push({ op: 'status' });
  s.push({ op: 'write', files: ['verified.json'] });
  s.push({ op: 'status' });
  s.push({ op: 'download', fetch: { status: 404 } });
  s.push({ op: 'write', files: ['sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8/model.int8.onnx', 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8/tokens.txt'] });
  s.push({ op: 'marker', dir: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8', sha256: 'wrong' });
  s.push({ op: 'status' });
  s.push({ op: 'marker', dir: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8', sha256: '17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b' });
  s.push({ op: 'status' });
  s.push({ op: 'marker', dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad' });
  s.push({ op: 'status' });
  s.push({ op: 'stt-download', id: 'parakeet-110m', fetch: { status: 404 } });
  s.push({ op: 'remove', file: 'silero_vad.onnx' });
  s.push({ op: 'status' });
  return s;
}

function fakeFetch(spec) {
  return async () => ({
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    body: spec.status >= 200 && spec.status < 300 ? (async function* body() {
      let left = spec.bytes || 0;
      while (left > 0) {
        const n = Math.min(left, 65536);
        left -= n;
        yield new Uint8Array(n);
      }
    })() : null,
  });
}

// ----------------------------------------------------------------

export async function brainFixtures(root, rng) {
  const load = (...rel) => import(pathToFileURL(path.join(root, ...rel)).href);
  const brain = await load('src', 'brain.js');
  const system = await load('src', 'platform', 'system.js');
  const vm = await load('src', 'voice-models.js');
  const r = rng(424242);
  const cases = [];
  const add = (fn, input, run) => {
    let output;
    try {
      output = plain(run());
    } catch (e) {
      output = { throws: String(e?.message || e) };
    }
    cases.push({ fn, input: plain(input), output });
  };

  for (const model of ['haiku', 'sonnet', 'opus', 'gpt']) for (const explore of [false, true]) add('brainArgs', { model, explore }, () => brain.brainArgs({ model, explore }));
  add('searchArgs', {}, () => brain.searchArgs());
  for (const s of speakCorpus(root, r)) add('speakable', s, () => brain.speakable(s));
  for (const v of [null, 5, [], {}]) add('speakable', v, () => brain.speakable(v));
  for (const o of structuredCorpus(r)) add('readStructured', o, () => brain.readStructured(o));
  for (const o of searchCorpus(r)) add('readSearch', o, () => brain.readSearch(o));
  for (const j of resultCorpus()) add('readBrainResult', j, () => brain.readBrainResult(j));
  for (const t of SIGN_IN_TEXTS) add('isSignInProblem', t, () => brain.isSignInProblem(t));
  for (const p of ['/usr/local/bin/claude', '/x/Claude', '/x/claude.exe', '/x/CLAUDE.EXE', '/x/claude.cmd', '/x/claude2', 'claude', '', '/x/claude/', '/x/my claude']) {
    add('isClaudeFile', p, () => brain.isClaudeFile(p, 'darwin'));
    add('isLocalAbsolute', p, () => brain.isLocalAbsolute(p));
  }
  for (const p of ['//share/x', '/\\x', '\\\\x', 'C:\\x', '/ok']) add('isLocalAbsolute', p, () => brain.isLocalAbsolute(p));
  for (const s of ["/Users/me/.local/bin/claude", "/path with spaces/claude", "/it's/claude", "'", '', "a'b'c"]) {
    add('shellQuote', s, () => brain.shellQuote(s));
    add('signInScript', { file: '/tmp/orbit-claude-sign-in-x.command', claudePath: s }, () => brain.signInScript('/tmp/orbit-claude-sign-in-x.command', s));
  }
  const prompts = [
    { question: 'Why does X fail?', context: 'they were debugging the hotkey', session: { title: 'Fix hotkey', messages: [{ from: 'claude', text: 'I changed main.js' }] } },
    { question: '  q  ', context: '   ', session: null },
    { question: null, context: null, session: { title: 5, messages: 'x' } },
    { question: 'q', context: `${'c'.repeat(2500)}`, session: { title: 'T', messages: Array.from({ length: 300 }, (_, i) => ({ from: 'claude', text: `m${i}${'é'.repeat(30)}` })) } },
    { question: 'emoji', session: { title: 'E', messages: Array.from({ length: 2000 }, () => ({ from: 'u', text: '😀😀😀' })) } },
  ];
  for (const p of prompts) add('brainPrompt', p, () => brain.brainPrompt(p));

  // system.js (a Mac's answers)
  for (const SHELL of ['/bin/zsh', '/usr/local/bin/fish', 'bash', '/bin/b ash', "/bin/b'sh", null, '/opt/homebrew/bin/nu;rm', '/bin/$x']) add('loginShellCommand', SHELL, () => system.loginShellCommand({ env: SHELL === null ? {} : { SHELL } }));
  for (const out of ['', 'noise__ORBIT_PATH_START__/usr/bin:/bin__ORBIT_PATH_END__', '__ORBIT_PATH_START__/a:/a: /b :relative:/c\n:__ORBIT_PATH_END__', '__ORBIT_PATH_START__x__ORBIT_PATH_START__/only/last__ORBIT_PATH_END__', '__ORBIT_PATH_START__/no/end', `__ORBIT_PATH_START__${Array.from({ length: 250 }, (_, i) => `/d${i}`).join(':')}__ORBIT_PATH_END__`, null]) add('parseShellPath', out, () => system.parseShellPath(out));
  for (const [a, b] of [['2.1.9', '2.1.10'], ['2.1.10', '2.1.9'], ['1.0.0', '1.0.0'], ['10.0.0', '9.9.9'], ['0.0.1', '0.1.0']]) add('compareVersions', [a, b], () => Math.sign(system.compareVersions(a, b)));
  add('wellKnownBinDirs', '/Users/me', () => system.wellKnownBinDirs({ platform: 'darwin', homedir: '/Users/me' }));
  for (const [PATH, shellPath] of [['/usr/bin:/bin', []], ['', ['/opt/homebrew/bin', '/x']], ['/a:/a:/Users/me/.local/bin', ['/a', '/b']]]) add('searchDirs', { PATH, shellPath }, () => system.searchDirs({ platform: 'darwin', env: { PATH }, homedir: '/Users/me', shellPath }));

  // findClaude on a made-up home
  const homes = { tree: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-claude-home-')), empty: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-claude-empty-')) };
  try {
    for (const f of HOME_FILES) {
      fs.mkdirSync(path.dirname(path.join(homes.tree, f)), { recursive: true });
      fs.writeFileSync(path.join(homes.tree, f), '');
    }
    for (const sc of findScenarios()) {
      const home = homes[sc.home];
      const extra = new Set((sc.homeExists || []).map((f) => path.join(home, f)));
      const exists = (f) => (f.startsWith(`${home}/`) ? extra.has(f) || fs.existsSync(f) : sc.exists.includes(f));
      add('findClaude', sc, () => {
        const found = brain.findClaude(sc.configured, sc.env, { platform: 'darwin', homedir: home, exists, shellPath: sc.shellPath });
        return found && { ...found, path: found.path.startsWith(`${home}/`) ? `~/${found.path.slice(home.length + 1)}` : found.path };
      });
    }
  } finally {
    for (const h of Object.values(homes)) fs.rmSync(h, { recursive: true, force: true });
  }

  // Whole runs against a stand-in Claude Code.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-project-'));
  const runs = [];
  try {
    const norm = (cwd) => (cwd === project ? 'PROJECT' : cwd === os.tmpdir() ? 'TMP' : cwd);
    for (const sc of askScenarios()) {
      const fake = fakeSpawn(sc.reply);
      const opts = { ...sc.opts, cwd: sc.opts.cwd === 'PROJECT' ? project : sc.opts.cwd };
      const res = await brain.askBrain({ ...opts, claudePath: '/fake/bin/claude', spawnImpl: fake.impl });
      const c = fake.calls[0];
      runs.push({ kind: 'ask', input: sc, call: c && { exe: c.exe, args: c.args, cwd: norm(c.opts.cwd), apiKey: c.opts.env.ANTHROPIC_API_KEY ?? null, stdin: c.stdin }, output: plain({ ...res, seconds: null }) });
    }
    for (const sc of searchScenarios()) {
      const fake = fakeSpawn(sc.reply);
      const res = await brain.searchWeb({ query: sc.query, claudePath: '/fake/bin/claude', apiKey: '', spawnImpl: fake.impl });
      const c = fake.calls[0];
      runs.push({ kind: 'search', input: sc, call: c && { exe: c.exe, args: c.args, cwd: norm(c.opts.cwd), apiKey: c.opts.env.ANTHROPIC_API_KEY ?? null, stdin: c.stdin.replace(/Today is \d{4}-\d{2}-\d{2}\./, 'Today is DATE.') }, output: plain({ ...res, seconds: null }) });
    }
    for (const stdout of AUTH_OUTPUTS) {
      const fake = fakeSpawn({ stdout });
      const res = await brain.claudeAuthStatus({ claudePath: '/fake/bin/claude', spawnImpl: fake.impl });
      const c = fake.calls[0];
      runs.push({ kind: 'auth', input: { stdout }, call: { exe: c.exe, args: c.args, cwd: norm(c.opts.cwd), apiKey: c.opts.env.ANTHROPIC_API_KEY ?? null, stdin: '' }, output: plain(res) });
    }
    runs.push({ kind: 'auth', input: { claudePath: '' }, call: null, output: plain(await brain.claudeAuthStatus({ claudePath: '' })) });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }

  // The speech models
  const models = {
    mb: vm.VOICE_MODELS_MB,
    voice: plain(vm.VOICE_MODELS),
    stt: plain(vm.STT_MODELS),
    sttIds: plain(vm.STT_IDS),
    sttOk: ['moonshine', 'parakeet-110m', 'parakeet-v2', 'whisper', '', null, 5, 'toString', '__proto__'].map((id) => ({ id, ok: vm.sttOk(id) })),
    sttConfig: [...vm.STT_IDS, 'nope'].map((id) => ({ id, config: plain(vm.sttModelConfig('/R', id)) })),
    paths: plain(vm.modelPaths('/R')),
  };
  const mroot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-models-'));
  const steps = modelSteps();
  const results = [];
  try {
    for (const st of steps) {
      if (st.op === 'status') results.push({ ready: vm.modelsReady(mroot), download: vm.downloadStatus(mroot), stt: vm.sttStatus(mroot), sttReady: Object.fromEntries(vm.STT_IDS.map((id) => [id, vm.sttReady(mroot, id)])) });
      else if (st.op === 'download' || st.op === 'stt-download') {
        let fetched = 0;
        const fetchImpl = (...a) => {
          fetched++;
          return fakeFetch(st.fetch)(...a);
        };
        const p = st.op === 'download' ? vm.downloadModels(mroot, { fetchImpl }) : vm.downloadStt(mroot, st.id, { fetchImpl });
        results.push(await p.then(() => ({ ok: true, fetched }), (e) => ({ ok: false, error: String(e?.message || e), fetched })));
      } else if (st.op === 'write') {
        for (const f of st.files) {
          fs.mkdirSync(path.dirname(path.join(mroot, f)), { recursive: true });
          fs.writeFileSync(path.join(mroot, f), f === 'verified.json' ? '{}' : 'x');
        }
        results.push(null);
      } else if (st.op === 'marker') {
        fs.mkdirSync(path.join(mroot, st.dir), { recursive: true });
        fs.writeFileSync(path.join(mroot, st.dir, 'verified.json'), JSON.stringify({ at: 'then', sha256: st.sha256 }));
        results.push(null);
      } else if (st.op === 'remove') {
        fs.rmSync(path.join(mroot, st.file), { force: true });
        results.push(null);
      }
    }
  } finally {
    fs.rmSync(mroot, { recursive: true, force: true });
  }

  return { cases, runs, homeFiles: HOME_FILES, models, modelSteps: { steps, results: plain(results) } };
}
