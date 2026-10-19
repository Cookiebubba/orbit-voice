// Orbit fuzzer. Run: npm run fuzz [-- --seed 123 --iterations 2000]
//
// Everything runs in a throwaway sandbox: home, %APPDATA% and %LOCALAPPDATA% point at a temp folder
// filled with generated (often malformed) Claude sessions and transcripts; Grok is a local fake
// WebSocket server; Claude's window and the `claude` binary are fakes (see loader.mjs). Nothing
// touches the real Claude app, the network or your settings.
//
// Phases:
//   units  - pure functions: settings sanitizing, consent check, log scrubbing, session lookup,
//            transcript parsing, second-brain args, orb anchoring, .env parsing, update errors
//   tools  - the tool runner with random tool names and arguments (consent invariant included)
//   http   - the bridge's HTTP API and static files with random methods, paths, headers, bodies
//   voice  - the /voice WebSocket, both sides random: the page and a fake Grok
//
// Invariants: nothing throws or crashes, no 500s, no secret in any response, no file outside
// public/ served, /api needs the session cookie, and no prompt is ever sent without consent.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeGen } from './gen.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const SEED = Number(arg('seed', Date.now() % 1e9));
const ITER = Number(arg('iterations', 1500));
const ONLY = arg('only', '');
const PORT = Number(arg('port', 4399));

const g = makeGen(SEED);
const failures = [];
let lastBeat = Date.now();
let lastInput = null; // what was being tried when a hang happened
const beat = () => { lastBeat = Date.now(); };
const fail = (phase, what, input) => {
  if (failures.filter((x) => x.phase === phase).length < 30) failures.push({ phase, what, input: typeof input === 'string' ? input.slice(0, 300) : JSON.stringify(input)?.slice(0, 300) });
};
process.on('uncaughtException', (e) => fail('process', `uncaught exception: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => fail('process', `unhandled rejection: ${e?.stack || e}`));
// If the run ends early (e.g. setup threw), say so instead of exiting silently.
let finished = false;
process.on('exit', (code) => {
  if (finished) return;
  console.log(`
✗ [harness] run ended early (exit ${code}), seed ${SEED}`);
  for (const f of failures) console.log(`  ${f.phase}: ${f.what}`.slice(0, 600));
  process.exitCode = 1;
});

// ---------- sandbox ----------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-fuzz-${SEED}-`));
const HOME = path.join(ROOT, 'home');
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.APPDATA = path.join(ROOT, 'appdata');
process.env.LOCALAPPDATA = path.join(ROOT, 'local');
for (const k of Object.keys(process.env)) if (/^(XAI|ORBIT|GVB)_/.test(k) || k === 'ANTHROPIC_API_KEY') delete process.env[k];

const titles = [];
function writeSessions() {
  const dir = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    const cli = g.chance(0.85) ? `cli-${i}-${g.int(1e6)}` : g.pick([123, null, '../../evil', g.str(30), {}]);
    const cwd = g.chance(0.7) ? path.join(ROOT, 'projects', `p${i}`) : g.pick(['', g.str(40), 42, 'C:\\nope']);
    const title = g.chance(0.8) ? `Session ${i} ${g.str(20)}` : g.value();
    if (typeof title === 'string') titles.push(title);
    const meta = { sessionId: g.chance(0.9) ? `local_${i}` : g.value(), cliSessionId: cli, title, cwd, originCwd: g.chance(0.5) ? cwd : g.value(), lastFocusedAt: g.pick([Date.now() - g.int(1e7), 0, -1, 'x', null, 1e309]), lastActivityAt: g.value(), isArchived: g.chance(0.1) };
    fs.writeFileSync(path.join(dir, `local_${i}.json`), g.chance(0.92) ? JSON.stringify(meta) : g.json());
    if (typeof cli === 'string' && /^[\w-]+$/.test(cli)) {
      const enc = (typeof cwd === 'string' && cwd ? cwd.replace(/[^a-zA-Z0-9]/g, '-') : 'misc').slice(0, 80); // keep sandbox paths under Windows' 260-char limit
      const pdir = path.join(HOME, '.claude', 'projects', enc);
      fs.mkdirSync(pdir, { recursive: true });
      if (typeof cwd === 'string' && cwd.startsWith(ROOT)) fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(pdir, `${cli}.jsonl`), transcript());
    }
  }
}

function transcriptLine() {
  const ts = g.chance(0.8) ? new Date(Date.now() - g.int(1e7)).toISOString() : g.value();
  const r = g.int(12);
  if (r === 0) return g.json();
  if (r === 1) return g.str(300);
  if (r === 2) return JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', timestamp: ts });
  const role = g.chance(0.5) ? 'user' : 'assistant';
  const item = () =>
    g.pick([
      { type: 'text', text: g.str(400) },
      { type: 'text', text: g.value() },
      { type: 'tool_use', name: g.str(20), input: g.value() },
      { type: 'tool_use', name: 'Bash', input: { command: g.str(200) } },
      { type: 'tool_result', content: g.str(100) },
      null,
      g.value(),
    ]);
  const content = g.pick([g.str(500), Array.from({ length: g.int(4) }, item), g.value(), `<system-reminder>${g.str(50)}</system-reminder>${g.str(50)}`]);
  return JSON.stringify({ type: role, isSidechain: g.chance(0.05), timestamp: ts, message: g.chance(0.95) ? { role, content } : g.value() });
}
const transcript = () => Array.from({ length: g.int(30) }, transcriptLine).join(g.chance(0.9) ? '\n' : '\r\n');

writeSessions();

globalThis.__fuzz = {
  rng: g.rng,
  str: () => g.str(),
  calls: [],
  windowTitle: () => (titles.length && g.chance(0.7) ? g.pick(titles) : g.str(60)),
};

// Grok (and anything else) must never reach the real internet from here.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname !== '127.0.0.1') return new Response('{"error":"offline in fuzz"}', { status: 503 });
  return realFetch(url, opts);
};

// ---------- the code under test (imported after the sandbox env is set) ----------
const config = await import('../../src/config.js');
const log = await import('../../src/log.js');
const sessions = await import('../../src/sessions.js');
const tools = await import('../../src/tools.js');
const brain = await import('../../src/brain.js');
const stick = await import('../../electron/orb-stick.js');
const updater = await import('../../electron/updater.js');
const server = await import('../../src/server.js');

const memStore = (value) => ({ kind: 'memory', get: () => value, set: (v) => { value = String(v); } });
const xaiKey = 'xai-FUZZSECRET' + 'Q'.repeat(40);
const anthropicKey = 'sk-ant-api03-FUZZSECRET' + 'R'.repeat(60);
const xaiStore = memStore(xaiKey);
const brainStore = memStore(anthropicKey);
const secrets = () => [xaiKey, anthropicKey, xaiStore.get(), brainStore.get()].filter((s) => s && s.length > 12);

const timed = (phase, label, input, fn) => {
  const t0 = performance.now();
  let out;
  try {
    out = fn();
  } catch (e) {
    fail(phase, `${label} threw: ${e?.message}`, input);
    return undefined;
  }
  const ms = performance.now() - t0;
  if (ms > 250) fail(phase, `${label} took ${Math.round(ms)}ms`, input);
  return out;
};

// ---------- phase: units ----------
function fuzzUnits() {
  const keys = Object.keys(config.DEFAULTS);
  for (let i = 0; i < ITER; i++) {
    beat();
    // Settings: anything goes in, only valid settings come out.
    const patch = g.chance(0.5) ? g.value() : Object.fromEntries(Array.from({ length: 1 + g.int(4) }, () => [g.pick(keys), g.value()]));
    timed('units', 'updateSettings', patch, () => config.updateSettings(patch));
    const s = config.getSettings();
    for (const k of Object.keys(s)) if (!keys.includes(k)) fail('units', `unknown setting kept: ${k}`, patch);
    for (const k of keys) {
      const d = config.DEFAULTS[k];
      const v = s[k];
      if (d === null || typeof d === 'object') continue;
      if (typeof v !== typeof d) fail('units', `setting ${k} has type ${typeof v}`, patch);
      if (typeof d === 'number' && !Number.isFinite(v)) fail('units', `setting ${k} not finite: ${v}`, patch);
    }
    if (s.speed < config.LIMITS.minSpeed || s.speed > config.LIMITS.maxSpeed) fail('units', `speed out of range ${s.speed}`, patch);
    if ({}.polluted !== undefined || Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')) fail('units', 'prototype polluted', patch);

    const u = g.str(200);
    const yes = timed('units', 'isClearYes', u, () => tools.isClearYes(u));
    if (typeof yes !== 'boolean') fail('units', 'isClearYes not boolean', u);
    if (yes && /\b(no|not|don'?t|wait|cancel)\b/i.test(u.replace(/[^a-z' ]+/gi, ' '))) fail('units', 'isClearYes accepted a negative', u);

    // Secrets never survive the log scrubber.
    const secret = g.pick([xaiKey, anthropicKey, `Bearer ${'t'.repeat(30)}`]);
    const text = `${g.str(100)} ${secret} ${g.str(100)}`;
    const clean = timed('units', 'scrub', text, () => log.scrub(text));
    if (clean && clean.includes(secret.replace(/^Bearer /, '').slice(0, 30))) fail('units', 'scrub left a secret', text);

    const q = g.chance(0.3) ? g.pick(titles.length ? titles : ['x']).slice(0, g.int(20)) : g.str(80);
    timed('units', 'resolveSession', q, () => sessions.resolveSession(q, { windowTitle: g.chance(0.5) ? g.str(40) : undefined }));

    // brainArgs refuses unknown models on purpose (callers validate first); fuzz the valid ones.
    const model = g.pick(['haiku', 'sonnet', 'opus']);
    const a = timed('units', 'brainArgs', model, () => brain.brainArgs({ model, explore: g.value() }));
    if (a && (!Array.isArray(a) || a.some((x) => typeof x !== 'string'))) fail('units', 'brainArgs returned non-strings', model);
    const bp = { question: g.str(500), context: g.value(), session: g.chance(0.5) ? { title: g.value(), messages: g.value() } : g.value() };
    timed('units', 'brainPrompt', bp, () => brain.brainPrompt(bp));

    const win = { x: g.int(4000) - 2000, y: g.int(3000) - 1000, width: g.int(3000), height: g.int(2000) };
    const anchor = g.chance(0.5) ? stick.DEFAULT_ANCHOR : g.value();
    timed('units', 'isAnchor', anchor, () => stick.isAnchor(anchor));
    if (stick.isAnchor(anchor)) {
      const pos = timed('units', 'orbPositionFor', { win, anchor }, () => stick.orbPositionFor(win, anchor, 128));
      if (pos && ![pos.x, pos.y].every(Number.isFinite)) fail('units', 'orbPositionFor not finite', { win, anchor });
      const back = pos && timed('units', 'anchorFor', { win, pos }, () => stick.anchorFor(win, pos, 128));
      if (back && !stick.isAnchor(back)) fail('units', 'anchorFor made an invalid anchor', { win, pos, back });
    }

    const err = g.str(200);
    const msg = timed('units', 'describeUpdateError', err, () => updater.describeUpdateError(err));
    if (typeof msg !== 'string' || !msg) fail('units', 'describeUpdateError empty', err);
    timed('units', 'hotkeyLabel', err, () => server.hotkeyLabel(err));

    if (i % 10 === 0) {
      const f = path.join(ROOT, `env-${i}.env`);
      fs.writeFileSync(f, Array.from({ length: g.int(8) }, () => `${g.pick(['XAI_API_KEY', '__proto__', 'constructor', g.str(10)])}${g.pick(['=', ' = ', ':', ''])}${g.str(40)}`).join(g.pick(['\n', '\r\n'])));
      const env = timed('units', 'readDotEnv', f, () => config.readDotEnv(f));
      if (env && Object.getPrototypeOf(env) !== Object.prototype && Object.getPrototypeOf(env) !== null) fail('units', 'readDotEnv prototype changed', f);
    }
  }
  // Transcripts: every generated one parses, within limits.
  for (const dir of fs.readdirSync(path.join(HOME, '.claude', 'projects'))) {
    for (const f of fs.readdirSync(path.join(HOME, '.claude', 'projects', dir))) {
      const file = path.join(HOME, '.claude', 'projects', dir, f);
      const lastN = 1 + g.int(10);
      const r = timed('units', 'readTranscriptTail', file, () => sessions.readTranscriptTail(file, { lastN, includeTools: g.chance(0.5), maxCharsPerMessage: 50 + g.int(500) }));
      if (r && (r.turns.length > lastN || r.turns.some((t) => typeof t.text !== 'string'))) fail('units', 'readTranscriptTail returned bad turns', file);
    }
  }
}

// ---------- phase: tools ----------
async function fuzzTools() {
  const names = [...tools.TOOL_DEFS.map((t) => t.name), 'ask_second_brain', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', g.str(20)];
  for (let round = 0; round < Math.max(5, ITER / 50); round++) {
    beat();
    const consent = g.chance(0.5);
    const notes = [];
    let utter = null; // { text, at }
    const sayPool = consent ? ['yes', 'yes send it', 'ok', 'sure', g.str(30)] : ['no', 'wait', g.str(30), 'what?', 'copy that'];
    const say = () => {
      let t = g.pick(sayPool);
      if (!consent && tools.isClearYes(t)) t = 'no';
      utter = { text: t, at: Date.now() };
    };
    const runner = tools.createToolRunner({ notify: (e) => notes.push(e), utteranceSince: async (since) => (utter && utter.at >= since ? utter : null), recentUtterance: () => utter });
    globalThis.__fuzz.calls = [];
    const drafted = new Set();
    for (let i = 0; i < 50; i++) {
      if (g.chance(0.3)) say();
      const name = g.pick(names);
      const args = g.chance(0.2) ? g.str(50) : g.json(name === 'draft_prompt' && g.chance(0.6) ? { text: g.str(200) } : g.value());
      if (name === 'draft_prompt') {
        try {
          const t = String(JSON.parse(args)?.text ?? '').trim().slice(0, 8000);
          if (t) drafted.add(t);
        } catch {}
      }
      let r;
      try {
        r = await runner.run(name, args);
      } catch (e) {
        fail('tools', `run(${name}) threw: ${e?.message}`, args);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call({ ...Object.fromEntries(names.slice(0, -6).map((n) => [n, 1])) }, name) && !(r && /Unknown tool/.test(r.error || ''))) fail('tools', `unknown tool "${name}" was not refused`, { name, r });
      if (g.chance(0.1)) {
        const d = runner.getDraft();
        if (d && g.chance(0.5)) {
          const t = g.str(100);
          runner.editFromUi(d.id, t);
          if (t.trim()) drafted.add(t.trim().slice(0, 8000));
        }
        if (consent && d) await runner.sendFromUi(g.chance(0.8) ? d.id : g.int(5));
      }
    }
    const crashed = log.recentLog({ minLevel: 'error', limit: 300 }).filter((e) => /crashed/.test(e.message));
    for (const c of crashed.splice(0)) fail('tools', `tool crashed: ${c.message} ${c.detail || ''}`.slice(0, 400));
    const sends = globalThis.__fuzz.calls.filter((c) => c.name === 'send');
    if (!consent && sends.length) fail('tools', `${sends.length} prompt(s) sent without consent`, sends[0]);
    for (const s of sends) if (!drafted.has(s.args.text)) fail('tools', 'sent text that was never drafted', s.args.text);
    runner.dispose();
  }
}

// ---------- phase: http ----------
function request({ method, path: p, headers, body }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, agent: false }, (res) => {
      if (String(res.headers['content-type'] || '').startsWith('text/event-stream')) {
        req.destroy();
        return resolve({ status: res.statusCode, body: '' });
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      res.on('error', () => resolve({ status: -1, body: data }));
    });
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: -2, body: '' });
    });
    req.on('error', (e) => resolve({ status: -1, body: String(e.message) }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let cookie = '';
const host = `127.0.0.1:${PORT}`;
const origin = `http://${host}`;

async function signIn() {
  const url = new URL(server.authUrl());
  const r = await request({ method: 'GET', path: `${url.pathname}${url.search}`, headers: { host } });
  cookie = String(r.headers?.['set-cookie']?.[0] || '').split(';')[0];
  if (!cookie) fail('http', 'sign-in gave no cookie', r.status);
}

const ROUTES = ['GET /api/config', 'POST /api/key', 'POST /api/settings', 'GET /api/sessions', 'POST /api/switch', 'GET /api/brain', 'POST /api/brain/key', 'POST /api/brain/test', 'GET /api/logs', 'GET /api/usage', 'GET /api/events', 'GET /api/voice', 'POST /api/voice/preview', 'GET /', 'GET /index.html', 'GET /auth'];
const EVIL_PATHS = ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%5c..%5cpackage.json', '/..\\..\\src\\server.js', '//etc/passwd', '/%00', '/%', '/%E0%A4%A', '/index.html%00.png', '/C:/Windows/win.ini', '/\\\\server\\share', '/' + 'a/'.repeat(300), '/api/../package.json', '/api/%2e%2e/src/server.js', '/auth?t=' + 'f'.repeat(64), '/auth?t[]=1&t=2'];

async function fuzzHttp() {
  await signIn();
  for (let i = 0; i < ITER; i++) {
    beat();
    const route = g.chance(0.7) ? g.pick(ROUTES) : `${g.pick(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])} ${g.pick(EVIL_PATHS)}`;
    let [method, p] = route.split(' ');
    if (g.chance(0.15)) p += g.pick(['?', '?x=', '#', '/']) + Buffer.from(g.str(30)).toString('hex').replace(/(..)/g, '%$1');
    const authed = g.chance(0.8);
    const headers = { host: g.chance(0.95) ? host : g.pick(['evil.com', 'localhost:1', '', `${host}.evil.com`]) };
    if (authed) headers.cookie = g.chance(0.95) ? cookie : g.pick(['orbit_session=' + '0'.repeat(64), 'orbit_session=', g.str(80).replace(/[^\x20-\x7e]/g, '')]);
    if (g.chance(0.8)) headers.origin = g.chance(0.9) ? origin : g.pick(['http://evil.com', 'null', `${origin}.evil.com`]);
    if (g.chance(0.5)) headers['sec-fetch-site'] = g.pick(['same-origin', 'none', 'cross-site', 'same-site', g.str(10).replace(/[^\x20-\x7e]/g, '')]);
    let body;
    if (method === 'POST' || g.chance(0.1)) {
      body = g.chance(0.05) ? 'x'.repeat(70 * 1024) : g.json(route === 'POST /api/settings' ? Object.fromEntries([[g.pick(Object.keys(config.DEFAULTS)), g.value()]]) : route.includes('key') ? { key: g.pick([g.str(60), 'xai-' + 'Z'.repeat(50), 'sk-ant-' + 'Y'.repeat(60)]) } : g.value());
      headers['content-type'] = 'application/json';
    }
    lastInput = { method, p, headers: { ...headers, cookie: headers.cookie === cookie ? '<valid>' : headers.cookie }, bodyLen: body?.length };
    const tq = Date.now();
    if (process.env.FUZZ_DEBUG) process.stderr.write(`> ${i} ${method} ${p.slice(0, 60)} ${body?.length || 0}
`);
    const r = await request({ method, path: p, headers, body });
    if (process.env.FUZZ_DEBUG) process.stderr.write(`< ${r.status} ${Date.now() - tq}ms
`);
    const input = { method, p, headers: { ...headers, cookie: headers.cookie === cookie ? '<valid>' : headers.cookie }, body: body?.slice(0, 200) };
    if (r.status === 500) fail('http', `500 response: ${(log.recentLog({ minLevel: 'error', limit: 1 })[0]?.detail || '').slice(0, 300)}`, input);
    if (r.status === -2) fail('http', 'request hung (5s)', input);
    // The server sees the normalized path (/api/../x is /x). An oversized body may be cut off
    // (connection reset) once the server has answered, which is fine.
    let normPath = '';
    try { normPath = new URL(p, origin).pathname; } catch {}
    const cutOff = r.status === -1 && body !== undefined; // the server answered before reading the body
    if (normPath.startsWith('/api/') && headers.host === host && headers.cookie !== cookie && r.status !== 401 && !cutOff) fail('http', `api answered ${r.status} without a valid session`, input);
    if (r.status === -1 && !cutOff) fail('http', `connection failed: ${r.body}`, input);
    for (const s of secrets()) if (r.body.includes(s)) fail('http', 'response contains a secret', input);
    if (/"name":\s*"orbit-voice"|startServer\(|\[extensions\]|for 16-bit app support/.test(r.body)) fail('http', 'served a file from outside public/', input);
  }
  // Still alive?
  const alive = await request({ method: 'GET', path: '/api/config', headers: { host, cookie } });
  if (alive.status !== 200) fail('http', `server not answering after fuzzing (${alive.status})`);
}

// ---------- phase: voice ----------
const { WebSocket, WebSocketServer } = await import('ws');
let upstreamScript = null; // (socket) => void, set per round

async function fuzzVoice() {
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => fake.on('listening', r));
  process.env.XAI_REALTIME_URL = `ws://127.0.0.1:${fake.address().port}`;
  fake.on('connection', (sock, req) => {
    if (req.headers.authorization !== `Bearer ${xaiStore.get()}`) fail('voice', 'upstream got the wrong Authorization header', req.headers.authorization?.slice(0, 20));
    sock.on('error', () => {});
    upstreamScript?.(sock);
  });

  // Unauthenticated sockets are refused.
  for (const h of [{ origin }, { origin: 'http://evil.com', cookie }, { cookie }, {}]) {
    const ok = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${host}/voice`, { headers: h });
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    if (ok && !(h.origin === origin && h.cookie === cookie)) fail('voice', 'socket opened without full auth', h);
  }

  const toolNames = [...tools.TOOL_DEFS.map((t) => t.name), 'ask_second_brain', '__proto__', g.str(10)];
  for (let round = 0; round < Math.max(5, ITER / 40); round++) {
    beat();
    const consent = g.chance(0.5);
    globalThis.__fuzz.calls = [];
    const drafted = new Set();
    const said = () => {
      let t = consent ? g.pick(['yes', 'yes send it', 'okay', g.str(40)]) : g.pick(['no', 'wait what', g.str(40), 'copy that please']);
      if (!consent && tools.isClearYes(t)) t = 'no';
      return t;
    };
    upstreamScript = (sock) => {
      let n = 0;
      const tick = () => {
        if (sock.readyState !== WebSocket.OPEN || n++ > 60) return;
        const id = `item${g.int(5)}`;
        const evts = [
          { type: 'session.created' },
          { type: 'input_audio_buffer.speech_started' },
          { type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: said() },
          { type: 'response.created' },
          { type: 'response.done' },
          { type: 'response.output_audio.delta', delta: Buffer.from(g.str(40)).toString('base64') },
          { type: 'error', error: g.value() },
          () => {
            const name = g.pick(toolNames);
            const a = name === 'draft_prompt' ? { text: g.str(150) } : g.value();
            if (name === 'draft_prompt') { const t = String(a.text).trim().slice(0, 8000); if (t) drafted.add(t); }
            return { type: 'response.function_call_arguments.done', name, call_id: `c${g.int(1e6)}`, arguments: g.chance(0.9) ? JSON.stringify(a) : g.str(30) };
          },
          { type: g.str(30), [g.str(5)]: g.value() },
        ];
        let e = g.pick(evts);
        if (typeof e === 'function') e = e();
        try {
          if (g.chance(0.03)) sock.send(Buffer.from(g.str(50)), { binary: true });
          else sock.send(g.chance(0.03) ? g.str(100) : JSON.stringify(e));
        } catch {}
        setTimeout(tick, g.int(8));
      };
      tick();
    };

    const page = new WebSocket(`ws://${host}/voice`, { headers: { origin, cookie } });
    page.on('error', () => {});
    let lastDraftId = null;
    page.on('message', (m) => {
      try {
        const e = JSON.parse(String(m));
        if (e.type === 'bridge.draft') lastDraftId = e.draft?.id ?? null;
        if (e.type === 'bridge.draft' && e.draft?.text) drafted.add(e.draft.text);
        if (typeof m === 'string' || Buffer.isBuffer(m)) for (const s of secrets()) if (String(m).includes(s)) fail('voice', 'page received a secret', e.type);
      } catch {}
    });
    await new Promise((r) => { page.on('open', r); page.on('close', r); });
    for (let i = 0; i < 40 && page.readyState === WebSocket.OPEN; i++) {
      const msgs = [
        { type: 'input_audio_buffer.append', audio: g.chance(0.8) ? Buffer.from(Array.from({ length: g.int(200) }, () => g.int(256))).toString('base64') : g.value() },
        { type: 'input_audio_buffer.commit' },
        { type: 'ui.state', asleep: g.value() },
        { type: 'ui.text', text: g.chance(0.7) ? said() : g.value() },
        { type: 'ui.cancel_draft', id: g.value() },
        { type: 'ui.edit_draft', id: g.chance(0.7) ? lastDraftId : g.value(), text: g.str(100) },
        ...(consent ? [{ type: 'ui.send_draft', id: g.chance(0.8) ? lastDraftId : g.value() }] : []),
        { type: 'session.update', session: g.value() }, // not forwardable: must be dropped
        { type: g.str(20), x: g.value() },
      ];
      let msg = g.pick(msgs);
      if (msg.type === 'ui.edit_draft' && typeof msg.text === 'string' && msg.text.trim()) drafted.add(msg.text.trim().slice(0, 8000));
      try {
        page.send(g.chance(0.05) ? g.str(200) : g.chance(0.01) ? 'x'.repeat(1.5 * 1024 * 1024) : JSON.stringify(msg));
      } catch {}
      await new Promise((r) => setTimeout(r, g.int(10)));
    }
    page.close();
    await new Promise((r) => setTimeout(r, 120));
    const sends = globalThis.__fuzz.calls.filter((c) => c.name === 'send');
    if (!consent && sends.length) fail('voice', `${sends.length} prompt(s) sent without consent`, sends[0]);
    for (const s of sends) if (!drafted.has(s.args.text)) fail('voice', 'sent text that was never drafted or edited', s.args.text);
    const crashed = log.recentLog({ minLevel: 'error', limit: 300 }).filter((e) => /crashed|Request failed|Message handling failed/.test(e.message));
    for (const c of crashed) fail('voice', `${c.message} ${c.detail || ''}`.slice(0, 400));
  }
  upstreamScript = null;
  fake.close();
}

// ---------- run ----------
const t0 = Date.now();
const phases = { units: fuzzUnits, tools: fuzzTools, http: fuzzHttp, voice: fuzzVoice };
// A phase that stops making progress is a bug too (a hang): report where, then exit.
let current = 'startup';
const watchdog = setInterval(() => {
  if (Date.now() - lastBeat > 60_000) {
    console.log(`
✗ [${current}] no progress for 60s (hang). seed ${SEED}
  input: ${JSON.stringify(lastInput)?.slice(0, 400)}`);
    process.exit(2);
  }
}, 5000);
watchdog.unref();
try {
  await server.startServer({ port: PORT, configDir: path.join(ROOT, 'config'), secrets: xaiStore, brainSecrets: brainStore, clipboard: () => {}, models: path.join(ROOT, 'models') });
} catch (e) {
  console.error(`Could not start the bridge on port ${PORT}: ${e.message}. Is another fuzz run still going?`);
  process.exit(3);
}
for (const [name, fn] of Object.entries(phases)) {
  if (ONLY && !ONLY.split(',').includes(name)) continue;
  const before = failures.length;
  const p0 = Date.now();
  current = name;
  try {
    await fn();
  } catch (e) {
    fail(name, `harness phase crashed: ${e?.stack || e}`);
  }
  console.log(`  ${name.padEnd(6)} ${failures.length - before ? `${failures.length - before} failure(s)` : 'ok'}  (${((Date.now() - p0) / 1000).toFixed(1)}s)`);
}
console.log(`\nseed ${SEED}, ${ITER} iterations, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const seen = new Set();
for (const f of failures) {
  const key = `${f.phase}:${f.what.slice(0, 80)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`\n✗ [${f.phase}] ${f.what}\n  input: ${f.input}`);
}
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
finished = true;
process.exit(failures.length ? 1 : 0);
