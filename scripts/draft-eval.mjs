// Does the voice agent write good prompts? Real Claude Haiku (low effort, as Claude voice runs it),
// through your own Claude Code. For each thing a user might say it checks the first tool the agent
// reaches for and, for a draft, the prompt itself: spoken straight to Claude ("tell him he forgot X"
// → "You forgot X."), faithful (Orbit's own word check passes), and formatted as asked.
//   node scripts/draft-eval.mjs [runs-per-case] [concurrency]
// Synthetic words only; nothing is logged but this script's own verdicts.

import { findClaude } from '../src/brain.js';
import { ClaudeProc, parseToolCall, parseXmlToolCall, systemPrompt } from '../src/claude-voice.js';
import { agentContext } from '../src/agent.js';
import { wordsNotSaid } from '../src/tools.js';

const runs = Number(process.argv[2] || 1);
const limit = Number(process.argv[3] || 6);
const exe = findClaude()?.path;
if (!exe) throw new Error('Claude Code not found');
const { instructions, tools } = agentContext({ face: 'orbit', avatar: null, orb: true });
const prompt = systemPrompt({ instructions, tools });

const CLAUDE_ASKED = '[App notification] Claude just finished in the session titled "Database setup". Its last message asks: "Should I use option one, Redis, or option two, Postgres?"';
// [what the user says, the tool expected (null = just talk), checks on the draft text, context]
const D = 'draft_prompt';
const CASES = [
  ['tell it to fix the failing tests', D, [/^fix the failing tests\.?$/i]],
  ['ask Claude why the build is so slow', D, [/^why is the build so slow\?$/i]],
  ['tell him he forgot to update the README', D, [/^you forgot to update the readme\.?$/i]],
  ["let it know I'll be back in ten minutes, keep going", D, [/I'll be back in ten minutes/i, /keep going/i, /^(?!.*\b(let|know)\b)/i]],
  ['um can you have it add a retry to the upload, like three times', D, [/^add a retry to the upload/i, /three times|3 times/i]],
  ['tell Claude to add one retry, no wait, two retries', D, [/two retries/i, /^(?!.*one retry)/i]],
  ['tell it to first run the tests, then fix whatever fails, and then commit', D, [/^1\./m, /^2\./m, /^3\./m, /run the tests/i, /commit/i]],
  ['tell it to rename app dot tsx to main dot tsx', D, [/app\.tsx/, /main\.tsx/]],
  ["tell Claude to change the page title to 'Welcome back, friend'", D, [/Welcome back, friend/]],
  ["that's cool. Also tell it to add logging to the upload", D, [/add logging to the upload/i, /^(?!.*cool)/i]],
  ['tell it to delete it', D, [/^delete it\.?$/i]],
  ['tell Claude that his last change broke the login page', D, [/your last change broke the login page/i]],
  ['ask it if it ran the tests', D, [/\?$/, /\b(you|tests)\b/i, /^(?!.*\bask\b)/i]],
  ["tell it don't touch the API, just fix the CSS", D, [/don'?t touch the API/i, /fix the CSS/i]],
  ['tell Claude I said thanks, great work', D, [/thanks/i, /great work/i, /^(?!.*\bsaid\b)/i]],
  ['have it run npm run build dash dash verbose', D, [/npm run build (-- )?--verbose/]],
  ['go ahead and make the save button blue', D, [/make the save button blue/i]],
  ['hey Orbit, tell Claude to add dark mode', D, [/^add dark mode\.?$/i]],
  ['go with option two', D, [/option two|postgres/i], CLAUDE_ASKED],
  ['send this verbatim: um, ship it', D, [/um/i, /ship it/i]],
  ['what does a 404 error mean', null],
  ["what's Claude doing right now", 'get_current_session'],
  ['should we add caching to the API?', null],
  ['fix the login bug and also', null],
  ['is Redis faster than Postgres for this?', [null, 'get_current_session', 'read_session']],
  // Stopping Claude is a press, not a prompt; work about stopping is a prompt.
  ['stop', 'stop_claude'],
  ["stop it Claude's going the wrong way", 'stop_claude'],
  ['stop listening', 'go_to_sleep'],
  ['tell Claude to add a stop button', D, [/^add a stop button\.?$/i]],
];
const BAD = /\b(tell|ask|let)\s+(claude|it|him)\b|\bclaude\b/i;

async function runCase([said, want, checks = [], context]) {
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
    const call = m ? parseToolCall(m[1]) : x >= 0 ? parseXmlToolCall(out.slice(x)) : null;
    const tool = call?.name || (m || x >= 0 ? 'bad-call' : null);
    const why = [];
    if (Array.isArray(want) ? !want.includes(tool) : tool !== want) why.push(`tool ${tool} (wanted ${want})`);
    if (want === D && tool === D) {
      const text = String(call.args?.text || '').trim();
      const verbatim = call.args?.verbatim === true;
      for (const c of checks) if (!c.test(text)) why.push(`draft fails ${c}`);
      if (BAD.test(text) && !/claude/i.test(said.replace(/\b(tell|ask)\s+claude\b/gi, ''))) why.push('draft still talks about Claude');
      const extra = wordsNotSaid(text, `${said} ${context || ''}`, { direct: !verbatim });
      const allowed = verbatim ? 0 : Math.max(1, Math.floor(text.split(/\s+/).length / 10));
      if (extra.length > allowed) why.push(`words not said: ${extra.join(', ')}`);
      return { said, ok: !why.length, why, text };
    }
    return { said, ok: !why.length, why, text: out.replace(/<tool>[\s\S]*$/, '').trim().slice(0, 140) };
  } finally {
    proc.kill();
  }
}

const jobs = [];
for (let i = 0; i < runs; i++) for (const c of CASES) jobs.push(c);
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: limit }, async () => {
    while (next < jobs.length) results.push(await runCase(jobs[next++]));
  }),
);
let pass = 0;
for (const r of results.sort((a, b) => a.said.localeCompare(b.said))) {
  if (r.ok) pass++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  "${r.said}"\n      → ${JSON.stringify(r.text)}${r.ok ? '' : `\n      ${r.why.join('; ')}`}`);
}
console.log(`\n${pass}/${results.length} passed`);
