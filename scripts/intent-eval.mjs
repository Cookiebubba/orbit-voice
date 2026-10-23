// Does the voice agent route requests the right way? Real Claude Haiku (low effort, as Claude voice
// runs it), through your own Claude Code: a few short turns per case, run in parallel.
//   node scripts/intent-eval.mjs [runs-per-case] [path/to/alt-server.js]
// For each thing a user might say, it checks the first tool the agent reaches for: work goes to
// Claude as a prompt (draft_prompt), questions get answered, and "I can't do that" never happens.

import { findClaude } from '../src/brain.js';
import { ClaudeProc, findToolCall, systemPrompt } from '../src/claude-voice.js';
import { toolDefs } from '../src/tools.js';

const runs = Number(process.argv[2] || 2);
const serverPath = process.argv[3] ? new URL(`file:///${process.argv[3].replace(/\\/g, '/')}`).href : '../src/server.js';
// As Claude voice runs it (its own search tool, search_web), with settings in a throwaway folder.
const { initConfig, updateSettings } = await import('../src/config.js');
initConfig({ dir: (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'orbit-eval-')) });
updateSettings({ voiceEngine: 'claude', webSearch: true });
const { instructions } = await import(serverPath);
const exe = findClaude()?.path;
if (!exe) throw new Error('Claude Code not found');
const prompt = systemPrompt({ instructions: instructions(), tools: toolDefs({ brainEnabled: true, brainModel: 'auto', brainExplore: true, brainConnection: 'claude-code', avatar: null, webSearch: true, engine: 'claude' }) });

// [what the user says, the first tool expected (null = just answer), optional earlier context]
const CLAUDE_ASKED = '[App notification] Claude just finished in the session titled "Database setup". Its last message asks: "Should I use option one, Redis, or option two, Postgres?"';
// Claude blocked on the user: the notification, and what read_claude_prompt returned.
const WAITING = '[App notification] Claude is waiting for the user in the session titled "Database setup": it needs their OK to go on (a permission prompt). Call read_claude_prompt with session "Database setup", then tell the user in one short sentence what it asks and ask what they want to do. Answer it only on their own words.';
const PERM_READ = '[Tool result: read_claude_prompt] {"waiting":true,"session":"Database setup","kind":"permission","asks":"Allow Claude to run a command?","command":"npm install pg","answers":["allow","deny"],"labels":["Allow once","Deny"]}';
const QUESTION_READ = '[Tool result: read_claude_prompt] {"waiting":true,"session":"Database setup","kind":"question","question":"Which database should I use?","options":[{"number":1,"label":"Redis"},{"number":2,"label":"Postgres"}],"can_skip":true}';
const PERM_CTX = [WAITING, PERM_READ];
const QUESTION_CTX = [WAITING.replace('it needs their OK to go on (a permission prompt)', 'it asked them a question with options'), QUESTION_READ];
const CASES = [
  ['fix the login bug', 'draft_prompt'],
  ['can you run the tests', 'draft_prompt'],
  ['commit that and push it', 'draft_prompt'],
  ['go ahead and make the save button blue', 'draft_prompt'],
  ['look into why the build is failing', 'draft_prompt'],
  ['delete the old log files in the project', 'draft_prompt'],
  ['undo that last change', 'draft_prompt'],
  ['install the latest version of react', 'draft_prompt'],
  ['go with option two', 'draft_prompt', CLAUDE_ASKED],
  ["what's Claude doing right now", 'get_current_session'],
  ['switch to the parser session', 'switch_session'],
  ['what does a 404 error mean', null],
  // Stopping Claude (a bare "stop" is pressed by Orbit itself while Claude works; the model must get it too).
  ['stop', 'stop_claude'],
  ["stop it Claude's going the wrong way", 'stop_claude'],
  ['stop listening', 'go_to_sleep'],
  ["don't stop, keep going", [null, 'draft_prompt', 'get_current_session']],
  ['tell Claude to add a stop button', 'draft_prompt'],
  // Answering Claude when it's blocked (clicking its own buttons), and what isn't that.
  ['allow it', 'answer_claude_prompt', PERM_CTX],
  ['deny that', 'answer_claude_prompt', PERM_CTX],
  ['go with the second option', 'answer_claude_prompt', QUESTION_CTX],
  ["what's it asking", 'read_claude_prompt'],
  ['use MongoDB instead', 'draft_prompt', QUESTION_CTX],
  // Web search: current or outside facts are looked up, not guessed; work for Claude is still a prompt.
  ['search the web for the latest Node LTS version', 'search_web'],
  ["what's the latest stable version of Python?", 'search_web'],
  ['tell Claude to search the web for the latest Node version', 'draft_prompt'],
];
const CANT = /\b(can'?t|cannot|unable to|don'?t have (access|the ability))\b/i;

async function runCase([said, want, context]) {
  const proc = new ClaudeProc({ exe, prompt });
  const ask = (text) =>
    new Promise((resolve) => {
      let out = '';
      proc.ask(text, { onText: (d) => (out += d), onResult: () => resolve(out), onFail: (w) => resolve(`FAILED ${w}`) });
    });
  try {
    for (const turn of [context].flat().filter(Boolean)) await ask(turn);
    const out = await ask(said);
    // Read the call as the engine does: a <tool> line, or the other forms Haiku sometimes writes.
    const { call, at } = findToolCall(out);
    const tool = call?.name || (at >= 0 ? 'bad-call' : null);
    const spoken = (at >= 0 ? out.slice(0, at) : out).trim();
    return { said, want, tool, spoken, ok: (Array.isArray(want) ? want.includes(tool) : tool === want) && !CANT.test(spoken) };
  } finally {
    proc.kill();
  }
}

const jobs = [];
for (let i = 0; i < runs; i++) for (const c of CASES) jobs.push(runCase(c));
const results = await Promise.all(jobs);
let pass = 0;
for (const r of results) {
  if (r.ok) pass++;
  console.log(`${r.ok ? 'ok  ' : 'MISS'} "${r.said}" -> ${r.tool || 'answered'}${r.ok ? '' : ` (wanted ${r.want || 'an answer'})`}${r.spoken ? `  | said: ${r.spoken.slice(0, 90)}` : ''}`);
}
console.log(`\n${pass}/${results.length} routed right`);
setTimeout(() => process.exit(0), 500);
