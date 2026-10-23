// Does the voice agent route requests the right way? Real Claude Haiku (low effort, as Claude voice
// runs it), through your own Claude Code: a few short turns per case, run in parallel.
//   node scripts/intent-eval.mjs [runs-per-case] [path/to/alt-server.js]
// For each thing a user might say, it checks the first tool the agent reaches for: work goes to
// Claude as a prompt (draft_prompt), questions get answered, and "I can't do that" never happens.

import { findClaude } from '../src/brain.js';
import { ClaudeProc, parseToolCall, parseXmlToolCall, systemPrompt } from '../src/claude-voice.js';
import { toolDefs } from '../src/tools.js';

const runs = Number(process.argv[2] || 2);
const serverPath = process.argv[3] ? new URL(`file:///${process.argv[3].replace(/\\/g, '/')}`).href : '../src/server.js';
const { instructions } = await import(serverPath);
const exe = findClaude()?.path;
if (!exe) throw new Error('Claude Code not found');
const prompt = systemPrompt({ instructions: instructions(), tools: toolDefs() });

// [what the user says, the first tool expected (null = just answer), optional earlier context]
const CLAUDE_ASKED = '[App notification] Claude just finished in the session titled "Database setup". Its last message asks: "Should I use option one, Redis, or option two, Postgres?"';
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
    if (context) await ask(context);
    const out = await ask(said);
    // Read the call as the engine does: a <tool> line, or the XML Haiku sometimes writes instead.
    const m = out.match(/<tool>([\s\S]*?)<\/tool>/);
    const x = m ? -1 : out.search(/<(?:invoke|parameter\b|function_calls)/);
    const tool = m ? parseToolCall(m[1])?.name || 'bad-call' : x >= 0 ? parseXmlToolCall(out.slice(x))?.name || 'bad-call' : null;
    const spoken = out.replace(/<(tool>|invoke|parameter\b|function_calls)[\s\S]*$/, '').trim();
    return { said, want, tool, spoken, ok: tool === want && !(want && CANT.test(spoken)) && !(!want && CANT.test(spoken)) };
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
