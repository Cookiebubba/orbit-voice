// The engine oracle's tool cases (parity/oracle/gen.mjs): the voice's tool runner (src/tools.js and
// src/app-control.js) driven through scripted calls: the user's words arriving, time passing, app
// notifications, Orbit's own spoken offers, settings changing, and tool calls with sensible and junk
// arguments. Run by the JS in a child process on a virtual clock (node:test's mock timers), with the
// recording stand-ins in parity/oracle/stand-ins for Claude's window and Claude Code, and a made-up
// home with Claude Code sessions (sessions.mjs). The Swift engine replays each script with the same
// answers and must make the same calls, send the same notices and return the same results.
//   (as a child) node --import ./parity/oracle/stand-ins/register.mjs parity/oracle/tools.mjs --run <home> <script.json>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T0, tree } from './sessions.mjs';

const HERE = fileURLToPath(import.meta.url);

const SAY = [
  'yes', 'yeah that looks good', 'sure', 'no', 'wait', 'not yet', 'what does it say?', 'make it shorter', 'mhm', 'go for it', 'ship it',
  'tell claude to fix the login bug', 'tell Claude to fix the login bug and send it', 'tell claude to add tests to the parser', 'um, tell it to add a retry to the upload, like three times',
  'tell claude verbatim: run the tests now please', 'stop', 'stop it', "don't stop", 'stop listening', 'switch to the release notes session', 'open the login one', "don't switch",
  'start a new session', 'start a new session in beta', 'the beta one', 'copy that', "copy Claude's answer", 'copy the draft', "don't copy it", 'allow it', 'deny that', 'always allow',
  'the second one', 'go with Postgres', 'should I allow it?', 'use Opus', 'switch to haiku', 'talk quieter', 'louder', 'volume to 50', 'yes please sign me in', 'why is the build so slow',
  'search the web for the latest node version', 'do a backflip', 'open the sidebar', 'switch Claude to Sonnet', 'use plan mode', 'turn on bypass permissions', 'delete this session',
  'rename this session to Login fix', 'archive it', 'yeah good idea', 'yeah, send that to Claude', 'go to sleep', 'what is Claude doing?', 'read me the last message',
];
const SPOKEN = ['I could ask Claude to add retry logic to the upload. Want me to?', 'Claude finished the login fix.', 'I could ask Claude to run the tests. Should I?', 'Sure.'];
const DRAFTS = [
  'Fix the login bug.', 'Add tests to the parser.', 'Add a retry to the upload, like three times.', 'Add retry logic to the upload.', 'run the tests now please', 'Fix the login bug and refactor everything.',
  'Run the tests.', '<happy> Fix the login bug.', '', 'Um, fix the login bug.', 'Clear the cache after each deploy.',
];
const TICKS = [0, 200, 1500, 3500, 5000, 20_000, 61_000, 130_000, 200_000];
const SETTINGS = [
  { brainEnabled: true }, { brainEnabled: false }, { brainModel: 'auto' }, { brainModel: 'haiku' }, { brainConnection: 'api-key' }, { brainConnection: 'claude-code' },
  { avatar: 'qubit' }, { avatar: 'buddy' }, { avatar: 'none' }, { webSearch: true }, { webSearch: false }, { voiceEngine: 'claude' }, { voiceEngine: 'grok' }, { brainExplore: false }, { brainExplore: true },
];
const TITLES = ['Fix the login bug', 'Write the release notes', 'Ask Claude a question', 'Run the build', 'Not on disk yet'];

function argsFor(r, name) {
  const pick = (list) => list[Math.floor(r() * list.length)];
  const junk = () => pick(['{', 'null', '[]', '"x"', '42', '{"text": 5}', '{"__proto__": {"x": 1}}', '']);
  if (r() < 0.12) return junk();
  switch (name) {
    case 'draft_prompt': return JSON.stringify(r() < 0.15 ? { text: pick(DRAFTS), verbatim: true } : { text: pick(DRAFTS) });
    case 'read_session': return JSON.stringify(pick([{}, { session: 'login' }, { session: 'release notes', last_n: 2, include_tool_calls: true }, { session: 'nothing like it' }, { last_n: 100 }]));
    case 'list_sessions': return JSON.stringify(pick([{}, { limit: 2 }, { limit: 'x' }]));
    case 'switch_session': return JSON.stringify(pick([{ session: 'release notes' }, { session: 'login' }, { session: '' }, {}]));
    case 'new_session': return JSON.stringify(pick([{}, { project: 'beta' }, { project: 'alpha' }]));
    case 'answer_claude_prompt': return JSON.stringify(pick([{ answer: 'allow' }, { answer: 'deny' }, { answer: 'always_allow' }, { answer: 'option', option: 2 }, { answer: 'option', option: 1 }, { answer: 'skip' }, {}]));
    case 'read_claude_prompt': return JSON.stringify(pick([{}, { session: 'login' }]));
    case 'copy_to_clipboard': return JSON.stringify(pick([{ what: 'text', text: 'npm test' }, { what: 'draft' }, { what: 'claude_last_message' }, { what: 'claude_last_message', session: 'release notes' }, { what: 'text', text: '' }]));
    case 'change_orbit_setting': return JSON.stringify(pick([{ setting: 'voice_model', value: 'opus' }, { setting: 'voice_model', value: 'haiku' }, { setting: 'volume', value: 'quieter' }, { setting: 'volume', value: 'louder' }, { setting: 'volume', value: '50' }, { setting: 'x', value: 'y' }]));
    case 'ask_second_brain': return JSON.stringify(pick([{ question: 'Why is the build so slow?' }, { question: 'Why?', model: 'opus', mode: 'explore' }, { question: 'Where is the cache?', session: 'login', mode: 'think' }, { question: 'x' }]));
    case 'search_web': return JSON.stringify(pick([{ query: 'latest node version' }, { query: 'x' }]));
    case 'avatar': return JSON.stringify(pick([{ action: 'backflip' }, { action: 'roll', direction: 'left' }, { action: 'wave' }, { action: 'fly' }]));
    case 'claude_app': return JSON.stringify(pick([{ action: 'status' }, { action: 'sidebar', value: 'show' }, { action: 'model', value: 'sonnet' }, { action: 'permission', value: 'plan' }, { action: 'permission', value: 'bypass' }, { action: 'delete' }, { action: 'rename', value: 'Login fix' }, { action: 'archive', session: 'release notes' }, { action: 'fly' }]));
    default: return pick(['{}', '', '{"x": 1}']);
  }
}

const NAMES = [
  'get_current_session', 'list_sessions', 'read_session', 'draft_prompt', 'draft_prompt', 'draft_prompt', 'send_draft', 'send_draft', 'send_draft', 'cancel_draft', 'stop_claude', 'read_claude_prompt',
  'answer_claude_prompt', 'answer_claude_prompt', 'switch_session', 'new_session', 'copy_to_clipboard', 'change_orbit_setting', 'go_to_sleep', 'ask_second_brain', 'search_web', 'open_claude_sign_in', 'avatar',
  'claude_app', 'claude_app', 'nope_not_a_tool', 'constructor', 'toString',
];

/** Directed scenes: what a call that goes right (and nearly right) looks like. */
const SCENES = [
  [{ op: 'say', text: 'tell claude to fix the login bug' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Fix the login bug."}' }, { op: 'tick', ms: 1500 }, { op: 'say', text: 'yeah that looks good' }, { op: 'run', name: 'send_draft', args: '{}' }],
  [{ op: 'say', text: 'tell Claude to fix the login bug and send it' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Fix the login bug."}' }, { op: 'run', name: 'send_draft', args: '{}' }],
  [{ op: 'say', text: 'tell claude to add tests to the parser' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Add tests to the parser."}' }, { op: 'notify', data: false }, { op: 'say', text: 'yes' }, { op: 'run', name: 'send_draft', args: '{}' }],
  [{ op: 'say', text: 'tell claude to add tests to the parser' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Add tests to the parser."}' }, { op: 'say', text: 'make it shorter' }, { op: 'run', name: 'send_draft', args: '{}' }, { op: 'say', text: 'tell claude to add tests' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Add tests."}' }, { op: 'say', text: 'mhm' }, { op: 'run', name: 'send_draft', args: '{}' }],
  [{ op: 'spoken', text: 'I could ask Claude to add retry logic to the upload. Want me to?' }, { op: 'tick', ms: 2000 }, { op: 'say', text: 'yeah good idea' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Add retry logic to the upload."}' }],
  [{ op: 'spoken', text: 'I could ask Claude to add retry logic to the upload. Want me to?' }, { op: 'tick', ms: 2000 }, { op: 'say', text: 'yeah, send that to Claude' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Add retry logic to the upload."}' }],
  [{ op: 'say', text: 'tell claude to fix the login bug' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Fix the login bug and refactor everything."}' }],
  [{ op: 'say', text: 'tell claude verbatim: run the tests now please' }, { op: 'run', name: 'draft_prompt', args: '{"text":"run the tests now please","verbatim":true}' }],
  [{ op: 'say', text: 'stop it' }, { op: 'run', name: 'stop_claude', args: '{}' }, { op: 'run', name: 'stop_claude', args: '{}' }],
  [{ op: 'run', name: 'read_claude_prompt', args: '{}' }, { op: 'say', text: 'allow it' }, { op: 'run', name: 'answer_claude_prompt', args: '{"answer":"allow"}' }],
  [{ op: 'say', text: 'the second one' }, { op: 'run', name: 'answer_claude_prompt', args: '{"answer":"option","option":2}' }, { op: 'say', text: 'deny that' }, { op: 'run', name: 'answer_claude_prompt', args: '{"answer":"deny"}' }],
  [{ op: 'say', text: 'switch to the release notes session' }, { op: 'run', name: 'switch_session', args: '{"session":"release notes"}' }, { op: 'run', name: 'switch_session', args: '{"session":"release notes"}' }],
  [{ op: 'say', text: 'start a new session' }, { op: 'run', name: 'new_session', args: '{}' }, { op: 'say', text: 'the beta one' }, { op: 'run', name: 'new_session', args: '{"project":"beta"}' }],
  [{ op: 'say', text: "copy Claude's answer" }, { op: 'run', name: 'copy_to_clipboard', args: '{"what":"claude_last_message"}' }, { op: 'say', text: 'copy the draft' }, { op: 'run', name: 'copy_to_clipboard', args: '{"what":"draft"}' }],
  [{ op: 'say', text: 'use Opus' }, { op: 'run', name: 'change_orbit_setting', args: '{"setting":"voice_model","value":"opus"}' }, { op: 'say', text: 'talk quieter' }, { op: 'run', name: 'change_orbit_setting', args: '{"setting":"volume","value":"quieter"}' }, { op: 'say', text: 'volume to 50' }, { op: 'run', name: 'change_orbit_setting', args: '{"setting":"volume","value":"50"}' }],
  [{ op: 'say', text: 'why is the build so slow' }, { op: 'run', name: 'ask_second_brain', args: '{"question":"Why is the build so slow?"}' }, { op: 'say', text: 'yes please sign me in' }, { op: 'run', name: 'open_claude_sign_in', args: '{}' }],
  [{ op: 'say', text: 'search the web for the latest node version' }, { op: 'run', name: 'search_web', args: '{"query":"latest node version"}' }, { op: 'run', name: 'search_web', args: '{"query":"latest node version"}' }],
  [{ op: 'say', text: 'delete this session' }, { op: 'run', name: 'claude_app', args: '{"action":"delete"}' }, { op: 'say', text: 'yes' }, { op: 'run', name: 'claude_app', args: '{"action":"delete"}' }],
  [{ op: 'say', text: 'rename this session to Login fix' }, { op: 'run', name: 'claude_app', args: '{"action":"rename","value":"Login fix"}' }, { op: 'say', text: 'open the sidebar' }, { op: 'run', name: 'claude_app', args: '{"action":"sidebar","value":"show"}' }],
  [{ op: 'say', text: 'turn on bypass permissions' }, { op: 'run', name: 'claude_app', args: '{"action":"permission","value":"bypass"}' }, { op: 'say', text: 'no' }, { op: 'run', name: 'claude_app', args: '{"action":"permission","value":"bypass"}' }],
  [{ op: 'say', text: 'do a backflip' }, { op: 'run', name: 'avatar', args: '{"action":"backflip"}' }, { op: 'run', name: 'avatar', args: '{"action":"wave"}' }],
  [{ op: 'say', text: 'tell claude to fix the login bug' }, { op: 'speech' }, { op: 'run', name: 'draft_prompt', args: '{"text":"Fix the login bug."}' }, { op: 'tick', ms: 200000 }, { op: 'say', text: 'yes' }, { op: 'run', name: 'send_draft', args: '{}' }],
];

/** Seeded scripts: rounds of steps, each round one call's runner. */
export function scripts(rng) {
  const r = rng(31337);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const rounds = [];
  for (let k = 0; k < 40; k++) {
    const steps = [];
    // A few directed scenes (one with each window title), then the random walk.
    for (let j = 0; j < 3; j++) {
      steps.push({ op: 'title', title: pick(TITLES.slice(0, 4)) }, ...SCENES[(k * 3 + j) % SCENES.length]);
    }
    for (let i = 0; i < 25; i++) {
      const x = r();
      if (x < 0.28) steps.push({ op: 'say', text: pick(SAY) });
      else if (x < 0.31) steps.push({ op: 'speech' });
      else if (x < 0.43) steps.push({ op: 'tick', ms: pick(TICKS) });
      else if (x < 0.47) steps.push({ op: 'notify', data: r() < 0.3 });
      else if (x < 0.51) steps.push({ op: 'spoken', text: pick(SPOKEN) });
      else if (x < 0.52) steps.push({ op: 'allow', text: pick(DRAFTS) });
      else if (x < 0.53) steps.push({ op: 'outside' });
      else if (x < 0.56) steps.push({ op: 'setting', patch: pick(SETTINGS) });
      else if (x < 0.58) steps.push({ op: 'title', title: r() < 0.15 ? null : pick(TITLES) });
      else {
        const name = pick(NAMES);
        steps.push({ op: 'run', name, args: argsFor(r, name) });
      }
    }
    rounds.push({ seed: Math.floor(r() * 1e9), steps });
  }
  return rounds;
}

// ---------------------------------------------------------------- the child: the JS runs the scripts

/** mulberry32, as gen.mjs has it (the stand-ins' answers). */
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
  const config = await load('src', 'config.js');
  config.initConfig({ dir: path.join(home, 'orbit-config') });
  config.updateSettings({ brainEnabled: true, brainModel: 'auto', brainExplore: true, brainConnection: 'claude-code', webSearch: true, avatar: 'qubit', voiceEngine: 'grok' });
  const avatar = await load('src', 'avatar-commands.js');
  const clipboard = await load('src', 'clipboard.js');
  const tools = await load('src', 'tools.js');
  const rounds = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  const out = [];
  let windowTitle = 'Fix the login bug';
  globalThis.__oracle = { rng: Math.random, calls: [], windowTitle: () => windowTitle, str: () => 'x' };
  const o = globalThis.__oracle;
  avatar.setAvatarSink((cmd) => {
    const r = [{ ok: true }, { ok: true }, { ok: false, error: 'He is busy.' }][Math.floor(o.rng() * 3)];
    o.calls.push({ name: 'avatar', args: cmd, answer: r });
    return r;
  });
  clipboard.setClipboardWriter((text) => o.calls.push({ name: 'clipboard', args: { text }, answer: null }));

  /** Run a promise to the end on the virtual clock: only its own timers are pending, so each is fired. */
  const settle = async (p) => {
    let done = false;
    let value;
    p.then((v) => {
      done = true;
      value = v;
    });
    for (let i = 0; i < 100000 && !done; i++) {
      await new Promise((res) => setImmediate(res));
      if (!done) mock.timers.runAll();
    }
    return value;
  };

  for (const round of rounds) {
    o.rng = rngOf(round.seed);
    // The call's own memory of the user's words (src/server.js).
    let utterance = { text: '', at: 0 };
    let speechStartedAt = 0;
    const exchanges = [];
    const waiters = new Set();
    const notes = [];
    const utteranceSince = (since) =>
      new Promise((resolve) => {
        const check = () => (utterance.at > since && utterance.text.trim() ? utterance : null);
        if (check() || speechStartedAt <= since) return resolve(check());
        const done = () => {
          const u = check();
          if (u) {
            waiters.delete(done);
            clearTimeout(timer);
            resolve(u);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(done);
          resolve(check());
        }, 4000);
        waiters.add(done);
      });
    const runner = tools.createToolRunner({
      notify: (e) => notes.push(e),
      utteranceSince,
      recentUtterance: () => (utterance.text ? utterance : null),
      userWords: () => [...exchanges.filter((x) => Date.now() - x.at < 10 * 60_000).map((x) => x.text), utterance.text].filter(Boolean).join(' '),
      heardSince: (ts) => speechStartedAt > ts || utterance.at > ts,
      repliesSince: (ts) => exchanges.filter((x) => x.at > ts).length,
    });
    const results = [];
    for (const st of round.steps) {
      o.calls = [];
      notes.length = 0;
      let result = null;
      if (st.op === 'say') {
        speechStartedAt = Date.now();
        utterance = { text: st.text, at: Date.now() };
        exchanges.push({ text: st.text, at: Date.now() });
        for (const w of waiters) w();
      } else if (st.op === 'speech') speechStartedAt = Date.now();
      else if (st.op === 'tick') mock.timers.tick(st.ms);
      else if (st.op === 'notify') runner.noteNotification({ data: st.data });
      else if (st.op === 'spoken') runner.noteSpoken(st.text);
      else if (st.op === 'allow') runner.allowDraft(st.text);
      else if (st.op === 'outside') runner.noteOutsideData();
      else if (st.op === 'setting') config.updateSettings(st.patch);
      else if (st.op === 'title') windowTitle = st.title;
      else if (st.op === 'run') result = await settle(runner.run(st.name, st.args));
      results.push({ result: result ?? null, notes: JSON.parse(JSON.stringify(notes)), calls: JSON.parse(JSON.stringify(o.calls)), now: Date.now() - T0, draft: runner.getDraft() ?? null });
    }
    runner.dispose();
    out.push(results);
    avatar.resetAvatarRuns?.();
  }
  process.stdout.write(JSON.stringify(out));
}

export function toolsFixtures(rng) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-tools-home-'));
  try {
    const files = tree();
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), content);
    }
    const rounds = scripts(rng);
    const scriptFile = path.join(home, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(rounds));
    const register = pathToFileURL(path.join(path.dirname(HERE), 'stand-ins', 'register.mjs')).href;
    const out = execFileSync(process.execPath, ['--no-warnings', '--import', register, HERE, '--run', home, scriptFile], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', maxBuffer: 256 << 20 });
    fs.rmSync(scriptFile);
    return { t0: T0, files, rounds, results: JSON.parse(out) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--run' && path.resolve(process.argv[1]) === HERE) await runChild(process.argv[3], process.argv[4]);
