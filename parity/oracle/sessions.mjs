// The engine oracle's session cases (parity/oracle/gen.mjs): src/sessions.js and src/watcher.js on a
// made-up home folder (session metadata and transcripts, damaged ones too) and a script of steps
// (file writes and appends, clock ticks, reads), run by the JS in a child process whose HOME is that
// folder and whose clock is the script's. The Swift engine runs the same script and must see the same.
//   (as a child) node parity/oracle/sessions.mjs --run <home> <script.json>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOTS = 'Library/Application Support/Claude/claude-code-sessions';
const T0 = 1_800_000_000_000;

const meta = (o) => JSON.stringify(o);
const line = (o) => `${JSON.stringify(o)}\n`;
const iso = (ms) => new Date(ms).toISOString();

/** The made-up home: relative path -> content. */
function tree() {
  const files = {};
  const acc = `${ROOTS}/acct-1/org-1`;
  const acc2 = `${ROOTS}/acct-2/org-9`;
  files[`${acc}/local_a.json`] = meta({ sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Fix the login bug', cwd: '/Users/me/code/app', lastFocusedAt: T0 - 1000, lastActivityAt: T0 - 60_000, createdAt: T0 - 9e6, model: 'opus', branch: 'main', permissionMode: 'default' });
  files[`${acc}/local_b.json`] = meta({ sessionId: 'local_b', cliSessionId: 'cli-b', title: 'Write the release notes', cwd: '/Users/me/code/docs', originCwd: '/Users/me/code/notes', lastFocusedAt: T0 - 5000, lastActivityAt: T0 - 120_000, createdAt: T0 - 8e6, permissionMode: 'bypassPermissions' });
  files[`${acc}/local_c.json`] = meta({ cliSessionId: 'cli-c', title: '', cwd: '', lastFocusedAt: T0 - 9000, createdAt: T0 - 7e6 });
  files[`${acc}/local_d.json`] = meta({ sessionId: 'local_d', cliSessionId: 'cli-d', title: 'Archived thing', isArchived: true, lastFocusedAt: T0 - 2000 });
  files[`${acc}/local_e.json`] = meta({ sessionId: 'local_e', cliSessionId: '../escape', title: 'Bad id' });
  files[`${acc}/local_f.json`] = '{ not json';
  files[`${acc}/notes.txt`] = 'ignored';
  files[`${acc}/local_g.json`] = meta({ sessionId: 'local_g', cliSessionId: 'cli-g', title: 'Plan viewer alpha', cwd: '/Users/me/code/viewer', lastFocusedAt: T0 - 7000, lastActivityAt: T0 - 4 * 3600_000, createdAt: T0 - 6e6 });
  files[`${acc2}/local_a.json`] = meta({ sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Fix the login bug (older copy)', cwd: '/Users/me/code/app', lastFocusedAt: T0 - 50_000, lastActivityAt: T0 - 90_000 });
  files[`${acc2}/local_h.json`] = meta({ sessionId: 'local_h', cliSessionId: 'cli-h', title: 'Ask Claude a question', cwd: '/Users/me/code/q', lastFocusedAt: T0 - 11000, lastActivityAt: T0 - 30_000, createdAt: T0 - 5e6 });
  files[`${acc2}/local_i.json`] = meta({ sessionId: 'local_i', cliSessionId: 'cli-i', title: 'Run the build', cwd: '/Users/me/code/b', lastFocusedAt: T0 - 13000, lastActivityAt: T0 - 20_000, createdAt: T0 - 4e6 });
  const p = '.claude/projects';
  files[`${p}/-Users-me-code-app/cli-a.jsonl`] =
    line({ type: 'user', timestamp: iso(T0 - 70_000), message: { role: 'user', content: 'Please fix the <system-reminder>secret</system-reminder> login bug' } }) +
    line({ type: 'assistant', timestamp: iso(T0 - 65_000), message: { content: [{ type: 'text', text: 'Looking at it.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/login.js' } }] } }) +
    line({ type: 'user', timestamp: iso(T0 - 64_000), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file' }] } }) +
    'not json\n' +
    line({ type: 'assistant', timestamp: iso(T0 - 60_000), isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } });
  files[`${p}/elsewhere/cli-b.jsonl`] = line({ type: 'user', timestamp: iso(T0 - 130_000), message: { content: [{ type: 'text', text: '<command-name>x</command-name>Write <pasted_content id=1>the notes</pasted_content> please' }] } }) + line({ type: 'assistant', timestamp: iso(T0 - 125_000), message: { content: [{ type: 'text', text: 'Done: notes written.' }] } });
  files[`${p}/-Users-me-code-q/cli-h.jsonl`] = line({ type: 'user', timestamp: iso(T0 - 40_000), message: { content: 'Which DB?' } }) + line({ type: 'assistant', timestamp: iso(T0 - 30_000), message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { description: 'Pick one' } }] } });
  files[`${p}/-Users-me-code-b/cli-i.jsonl`] = line({ type: 'user', timestamp: iso(T0 - 25_000), message: { content: 'build it' } }) + line({ type: 'assistant', timestamp: iso(T0 - 20_000), message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run build && npm test -- --long-flag '.repeat(5) } }] } });
  files[`${p}/-Users-me-code-viewer/cli-g.jsonl`] = line({ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(T0 - 4 * 3600_000) });
  return files;
}

/** The steps: reads, writes and ticks on the script's clock. */
function script() {
  const s = [];
  const read = (op, args = {}) => s.push({ op, args });
  read('list');
  read('list', { includeArchived: true });
  for (const q of ['', 'current', 'login', 'notes', 'cli-h', 'local_i', 'release notes app', 'nothing here at all', 'x']) read('resolve', { query: q, windowTitle: q === 'current' ? 'Run the build' : null });
  for (const t of ['fix the LOGIN bug!', 'Plan viewer alpha', '', 'missing']) read('byTitle', { title: t });
  for (const [cli, cwd] of [['cli-a', '/Users/me/code/app'], ['cli-b', '/somewhere/else'], ['cli-z', ''], ['cli-h', null]]) read('find', { cli, cwd });
  for (const f of ['.claude/projects/-Users-me-code-app/cli-a.jsonl', '.claude/projects/elsewhere/cli-b.jsonl', '.claude/projects/-Users-me-code-q/cli-h.jsonl', '.claude/projects/-Users-me-code-b/cli-i.jsonl', '.claude/projects/-Users-me-code-viewer/cli-g.jsonl']) {
    read('tail', { file: f });
    read('tail', { file: f, lastN: 1, includeTools: true, maxCharsPerMessage: 10, maxBytes: 300 });
  }
  for (const ms of [0, T0 - 5000, T0 - 600_000, T0 - 7_200_000, T0 - 4 * 86_400_000]) read('ago', { ms });
  // The watcher, over time.
  let now = T0;
  const tick = () => s.push({ op: 'tick', now });
  tick();
  now += 3000;
  tick();
  now += 10_000;
  tick();
  s.push({ op: 'append', file: '.claude/projects/-Users-me-code-app/cli-a.jsonl', content: line({ type: 'assistant', timestamp: iso(now), message: { content: [{ type: 'text', text: 'Fixed the bug.' }] } }) });
  now += 2000;
  tick();
  now += 7000;
  tick();
  s.push({ op: 'append', file: '.claude/projects/-Users-me-code-b/cli-i.jsonl', content: line({ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(now) }) });
  now += 2000;
  tick();
  now += 16_000;
  tick();
  s.push({ op: 'append', file: '.claude/projects/-Users-me-code-q/cli-h.jsonl', content: line({ type: 'user', timestamp: iso(now), message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'Postgres' }] } }) + line({ type: 'assistant', timestamp: iso(now + 10), message: { content: [{ type: 'tool_use', id: 'q2', name: 'ExitPlanMode', input: {} }] } }) });
  for (let k = 0; k < 6; k++) {
    now += 2500;
    tick();
  }
  s.push({ op: 'working' });
  return s;
}

/** Runs the script here (the child): HOME is the made-up home, the clock is the script's. */
async function runChild(home, scriptFile) {
  const root = path.resolve(path.dirname(HERE), '..', '..');
  let clock = T0;
  Date.now = () => clock;
  const sessions = await import(pathToFileURL(path.join(root, 'src', 'sessions.js')).href);
  const { createSessionWatcher } = await import(pathToFileURL(path.join(root, 'src', 'watcher.js')).href);
  const steps = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  const w = createSessionWatcher();
  const events = [];
  w.on((e) => events.push(e));
  const out = [];
  const rel = (p) => (p ? path.relative(home, p) : null);
  for (const st of steps) {
    const a = st.args || {};
    if (st.op === 'list') out.push(sessions.listDesktopSessions(a));
    else if (st.op === 'resolve') out.push(sessions.resolveSession(a.query, { windowTitle: a.windowTitle }));
    else if (st.op === 'byTitle') out.push(sessions.findSessionByTitle(a.title));
    else if (st.op === 'find') out.push(rel(sessions.findTranscript(a.cli, a.cwd)));
    else if (st.op === 'tail') out.push(sessions.readTranscriptTail(path.join(home, a.file), { ...a, file: undefined }));
    else if (st.op === 'ago') out.push(sessions.ago(a.ms));
    else if (st.op === 'append') {
      fs.appendFileSync(path.join(home, st.file), st.content);
      out.push(null);
    } else if (st.op === 'tick') {
      clock = st.now;
      events.length = 0;
      // (One tick, as the timer's: start() runs the first, then stop() keeps any timer from firing.)
      w.start();
      w.stop();
      out.push(events.splice(0));
    } else if (st.op === 'working') out.push(w.working());
  }
  process.stdout.write(JSON.stringify(out));
}

export function sessionsFixtures() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oracle-home-'));
  try {
    const files = tree();
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), content);
    }
    const steps = script();
    const scriptFile = path.join(home, 'script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(steps));
    const out = execFileSync(process.execPath, [HERE, '--run', home, scriptFile], { env: { ...process.env, HOME: home }, encoding: 'utf8', maxBuffer: 64 << 20 });
    fs.rmSync(scriptFile);
    return { t0: T0, files, steps, results: JSON.parse(out) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--run') await runChild(process.argv[3], process.argv[4]);
