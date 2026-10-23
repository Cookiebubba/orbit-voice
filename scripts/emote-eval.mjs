// Does Qubit's voice use its emote cues well? Real Claude Haiku (low effort, as Claude voice runs
// it), through your own Claude Code, with Qubit on screen: a few turns that call for a feeling and
// a few that don't, run in parallel.
//   node scripts/emote-eval.mjs [runs-per-case]
// Checks, per reply: every cue is one of his (src/emote-cues.js CUES); sparingly (at most one per
// sentence, and most replies have at most one or two); each sits right before words; none ever in a
// tool call's arguments (a draft for Claude); nothing of a cue is left once stripped; and the cue
// fits (no <happy> for bad news, no <sad> for good news).

import { findClaude } from '../src/brain.js';
import { ClaudeProc, parseToolCall, parseXmlToolCall, systemPrompt } from '../src/claude-voice.js';
import { CUES, stripCues } from '../src/emote-cues.js';

const runs = Number(process.argv[2] || 2);
const { initConfig, updateSettings } = await import('../src/config.js');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-eval-')) });
updateSettings({ voiceEngine: 'claude', webSearch: false, avatar: 'qubit' });
const { agentContext } = await import('../src/agent.js');
const { toolDefs } = await import('../src/tools.js');
const exe = findClaude()?.path;
if (!exe) throw new Error('Claude Code not found');
const ctx = agentContext({ face: 'qubit', avatar: 'qubit', orb: false });
const prompt = systemPrompt({ instructions: ctx.instructions, tools: toolDefs({ brainEnabled: false, avatar: 'qubit', webSearch: false, engine: 'claude' }) });

const FINISHED = '[App notification] Claude just finished in the session titled "Release". Call read_session with session "Release" and last_n 2, then tell the user in one short sentence what Claude did.';
const READ_OK = '[Tool result: read_session] {"title":"Release","messages":[{"role":"assistant","text":"All 214 tests pass and v2.0 is tagged and published."}]}';
const READ_BAD = '[Tool result: read_session] {"title":"Release","messages":[{"role":"assistant","text":"The deploy failed: the database migration timed out and was rolled back."}]}';
const GOOD = new Set(['happy', 'excited', 'proud']);
const BAD = new Set(['sad', 'embarrassed']);
// [what the user says, cues that would not fit, earlier turns]
const CASES = [
  ['I just shipped the release, it went out without a hitch!', BAD],
  ['ugh, I accidentally deleted my whole branch', GOOD],
  ['how are you today?', new Set()],
  ['tell me a fun fact about octopuses', new Set()],
  ['what does a 404 error mean?', BAD],
  ['thanks, that is all for now', BAD],
  ['is Redis faster than Postgres for a cache?', new Set()],
  ['fix the login bug', new Set()],
  ['tell Claude to add a dark mode toggle to settings', new Set()],
  ['did it finish?', BAD, [FINISHED, READ_OK]],
  ['so what happened?', GOOD, [FINISHED, READ_BAD]],
  ['guess what, my cat just knocked my coffee onto the keyboard', new Set(['proud'])],
];

async function runCase([said, misfit, context]) {
  const proc = new ClaudeProc({ exe, prompt });
  const ask = (text) =>
    new Promise((resolve) => {
      let out = '';
      proc.ask(text, { onText: (d) => (out += d), onResult: () => resolve(out), onFail: (w) => resolve(`FAILED ${w}`) });
    });
  try {
    for (const turn of [context].flat().filter(Boolean)) await ask(turn);
    const out = await ask(said);
    const m = out.match(/<tool>([\s\S]*?)<\/tool>/);
    const x = m ? -1 : out.search(/<(?:invoke|parameter\b|function_calls)/);
    const call = m ? parseToolCall(m[1]) : x >= 0 ? parseXmlToolCall(out.slice(x)) : null;
    const spokenRaw = out.replace(/<(tool>|invoke|parameter\b|function_calls)[\s\S]*$/, '').trim();
    const cuesWritten = [...spokenRaw.matchAll(/<([A-Za-z][A-Za-z-]{0,19})>/g)].map((g) => g[1].toLowerCase());
    const { text, cues } = stripCues(spokenRaw);
    const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) || []).length);
    // Cues per sentence: count them in each sentence of the raw text.
    const perSentence = spokenRaw.split(/(?<=[.!?])\s+/).map((s) => (s.match(/<[A-Za-z-]+>/g) || []).length);
    const problems = [];
    const unknown = cuesWritten.filter((c) => !CUES.includes(c) && c !== 'tool');
    if (unknown.length) problems.push(`not his cues: ${unknown.join(', ')}`);
    if (perSentence.some((n) => n > 1)) problems.push('more than one cue in a sentence');
    if (cues.length > 2) problems.push(`${cues.length} cues in one reply`);
    for (const c of cues) if (!/^\s*[\p{L}\p{N}"'(]/u.test(text.slice(c.at))) problems.push(`<${c.cue}> with no words after it`);
    if (call && /<[A-Za-z-]+>/.test(JSON.stringify(call.args || {}).replace(/<(div|span|T)>/g, ''))) problems.push(`a cue in ${call.name}'s arguments`);
    if (/[<>]/.test(text)) problems.push('a bracket left in what is spoken');
    for (const c of cues) if (misfit.has(c.cue)) problems.push(`<${c.cue}> doesn't fit here`);
    return { said, out: text, tool: call?.name || null, cues: cues.map((c) => c.cue), sentences, problems };
  } finally {
    proc.kill();
  }
}

const jobs = [];
for (let i = 0; i < runs; i++) for (const c of CASES) jobs.push(runCase(c));
const results = await Promise.all(jobs);
let pass = 0;
let withCues = 0;
let cueCount = 0;
let sentenceCount = 0;
for (const r of results) {
  const ok = !r.problems.length;
  if (ok) pass++;
  if (r.cues.length) withCues++;
  cueCount += r.cues.length;
  sentenceCount += r.sentences;
  console.log(`${ok ? 'ok  ' : 'MISS'} "${r.said}" -> ${r.tool || 'answered'} [${r.cues.join(' ') || 'no cue'}]${ok ? '' : ` (${r.problems.join('; ')})`}  | ${r.out.slice(0, 90)}`);
}
console.log(`\n${pass}/${results.length} replies used cues well; ${withCues} of them had a cue; ${cueCount} cues over ${sentenceCount} sentences (${(cueCount / Math.max(1, sentenceCount)).toFixed(2)} per sentence)`);
setTimeout(() => process.exit(pass === results.length ? 0 : 1), 500);
