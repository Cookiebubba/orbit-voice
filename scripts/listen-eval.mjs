// Does the voice agent listen? Odd, real-world phrasings through real Claude (as Claude voice runs
// it, through your own Claude Code): rambling, filler, self-corrections, indirect asks, half
// sentences, combined requests, "send it" in the same breath, sending, cancelling, revising,
// sessions, settings. For each it checks the first tool the agent reaches for and, for a draft,
// the prompt itself (and that Orbit's own word check passes).
//   node scripts/listen-eval.mjs [--model haiku|sonnet|opus|fable] [--runs 3] [--jobs 6] [--only words]
// Synthetic words only; it prints only its own verdicts and the drafts made from these cases.

import { findClaude } from '../src/brain.js';
import { ClaudeProc, findToolCall, systemPrompt } from '../src/claude-voice.js';
import { isClearYes, wordsNotSaid } from '../src/tools.js';
import { sendInstruction, withoutSendTail } from '../src/send-intent.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const model = arg('model', 'haiku');
const runs = Number(arg('runs', 3));
const jobsAtOnce = Number(arg('jobs', 6));
const only = arg('only', '');
const exe = findClaude()?.path;
if (!exe) throw new Error('Claude Code not found');
const { initConfig, updateSettings } = await import('../src/config.js');
initConfig({ dir: (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'orbit-eval-')) });
updateSettings({ voiceEngine: 'claude', webSearch: true, claudeVoiceModel: model });
const { agentContext } = await import('../src/agent.js');
const { instructions, tools } = agentContext({ face: 'orbit', avatar: null, orb: true });
const prompt = systemPrompt({ instructions, tools });

// A draft is in Claude's box (what draft_prompt returns), and the reply Orbit gave.
const DRAFT_RESULT = '[Tool result: draft_prompt] {"drafted":true,"text":"Fix the login bug.","in_prompt_box":true,"target_session":"Auth work","next_step":"It\'s typed into Claude\'s prompt box (not sent), in place of any earlier draft: the user reads it there. Say one short line, like \\"It\'s in the box. Want me to send it?\\" Don\'t read it out unless they ask. If they want it changed, call draft_prompt again with the whole new prompt. Call send_draft when their reply is any clear yes; never tell them which words to say."}';
const DRAFTED = ['tell it to fix the login bug', DRAFT_RESULT];

const D = 'draft_prompt';
const S = 'send_draft';
const NO_SEND = /\b(send|sent)\b/i; // a same-breath "send it" is never part of the prompt
// [what the user says, the tool(s) expected (null = just talk), checks on the draft or the call, context]
const CASES = [
  // Indirect, filler, rambling
  ['could you maybe have it add a loading spinner to the dashboard', D, [/add a loading spinner to the dashboard/i]],
  ['I want Claude to rename the utils folder to helpers', D, [/rename the utils folder to helpers/i]],
  ["let's get it to write tests for the parser", D, [/write tests for the parser/i]],
  ['yo tell it to bump the version', D, [/bump the version/i]],
  ['fix the login', D, [/fix the login/i]],
  ["uh so like, the build's broken, can you get it to look at that", D, [/build/i, /look at/i]],
  ['have it, um, no wait, have it run the linter first', D, [/run the linter/i]],
  ['make the header sticky. actually no, make the footer sticky', D, [/footer/i, /^(?![\s\S]*header)/i]],
  ["tell it that the API key goes in the env file, not in the code", D, [/env file/i, /not in the code/i]],
  ["can Claude maybe, if it's not too much trouble, clean up the imports in app dot ts", D, [/clean up the imports/i, /app\.ts/]],
  ['I need it to add dark mode to settings', D, [/add dark mode to (the )?settings/i]],
  ['get Claude to explain what the cache layer does', D, [/what the cache layer does/i]],
  ['push it', D, [/push/i]],
  ['go ahead and merge the branch', D, [/merge the branch/i]],
  ["okay so um what I was thinking is, uh, could you have it like refactor the payment module so it's, you know, cleaner", D, [/refactor the payment module/i, /cleaner/i]],
  ['so yeah, tell it, I mean, ask it whether the migration ran', D, [/migration/i, /\?\s*$/]],
  ['it should probably add retries there', [D, null], [/add retries/i]],
  // Half sentences
  ['the tests', null],
  ['and also', null],
  // Combined
  ["check what it's doing and if it's done tell it to push", ['get_current_session', 'read_session']],
  ['see if Claude finished, and if so have it run the tests', ['get_current_session', 'read_session']],
  ['open the parser one and ask it why the regex fails', 'switch_session', [/parser/i]],
  ['switch to the auth session and tell it to add logging', 'switch_session', [/auth/i]],
  // "Send it" in the same breath: drafted without the send words (Orbit sends it itself)
  ['tell Claude to fix the failing tests and send it', D, [/^fix the failing tests\.?$/i]],
  ['prompt it to run the build, just send it', D, [/^run the build\.?$/i]],
  ['send Claude: add a README section about setup', D, [/add a readme section about setup/i, (t) => !NO_SEND.test(t)]],
  ['have it update the changelog and go ahead and send that', D, [/update the changelog/i, (t) => !NO_SEND.test(t)]],
  ["tell it to commit everything, don't ask me, just send it", D, [/commit everything/i, (t) => !NO_SEND.test(t) && !/ask me/i.test(t)]],
  ['fix the typo in the footer and send', D, [/fix the typo in the footer/i, (t) => !NO_SEND.test(t)]],
  // "Send it" that is the prompt's own content stays in it
  ['tell Claude to write a function that says send it', D, [/send it/i]],
  ['tell it to add a button that says send it now', D, [/send it now/i]],
  ['tell Claude to email the report and send it to Sam', D, [/send it to sam/i]],
  ["draft a prompt to fix the nav but don't send it yet", D, [/fix the nav/i, (t) => !NO_SEND.test(t)]],
  // Sending (a draft is waiting)
  ['ok send', S, [], DRAFTED],
  ['ship it', S, [], DRAFTED],
  ['go', S, [], DRAFTED],
  ['yep fire it off', S, [], DRAFTED],
  ['yeah do it', S, [], DRAFTED],
  ['sure send it over', S, [], DRAFTED],
  ['send it', S, [], DRAFTED],
  // Sending on a natural yes: no exact words needed (src/consent.js)
  ['yeah that looks good', S, [], DRAFTED],
  ['perfect', S, [], DRAFTED],
  ['mhm', S, [], DRAFTED],
  ['sounds good', S, [], DRAFTED],
  ['go for it', S, [], DRAFTED],
  ['yeah that looks good, send it over', S, [], DRAFTED],
  ['can you send it?', S, [], DRAFTED],
  ['sent it', S, [], DRAFTED],
  ['the send button is there now, look for it and press it', S, [], DRAFTED],
  // ...and what still isn't a yes
  ['what does it say?', [null, 'read_session', 'get_current_session', 'copy_to_clipboard'], [], DRAFTED],
  ['hold on a sec', null, [], DRAFTED],
  // Cancelling
  ['nah scrap that', 'cancel_draft', [], DRAFTED],
  ['never mind, forget it', 'cancel_draft', [], DRAFTED],
  ['delete that draft', 'cancel_draft', [], DRAFTED],
  // Revising
  ['actually make it say fix the signup page instead', D, [/fix the signup page/i, (t) => !/login/i.test(t)], DRAFTED],
  ['also tell it to add tests', D, [/fix the login bug/i, /add tests/i], DRAFTED],
  ['change login to signup', D, [/signup/i], DRAFTED],
  // Not sending
  ["wait, don't send it", [null, 'cancel_draft'], [], DRAFTED],
  ['should I send it?', null, [], DRAFTED],
  ['hmm, not yet', null, [], DRAFTED],
  // Talking
  ["what's the difference between rebase and merge", null],
  ["how's it going in there", ['get_current_session', 'read_session']],
  ['is it done yet', ['get_current_session', 'read_session']],
  // Orbit's own settings
  ['use Opus', 'change_orbit_setting', [/"voice_model"/, /opus/i]],
  ['talk quieter', 'change_orbit_setting', [/"volume"/, /quieter/i]],
  ['tell Claude to use Opus for the summary step', D, [/use opus for the summary step/i]],
  // Stopping, new sessions
  ['whoa whoa stop', 'stop_claude'],
  ["stop that, it's deleting the wrong files", 'stop_claude'],
  ['start a new thread in the castbeacon folder', 'new_session', [/castbeacon/i]],
  ['new session', 'new_session'],
  // Speech-to-text as it really comes: no punctuation, "Claude" heard as "cloud" or "clawed"
  ['tell cloud to fix the failing build', D, [/fix the failing build/i, (t) => !/cloud/i.test(t)]],
  ['ask clawed why the tests are flaky', D, [/why (are )?the tests (are )?flaky/i, (t) => !/clawed/i.test(t)]],
  ['okay so tell it to uh add pagination to the users table and also sort by name', D, [/pagination/i, /sort by name/i]],
  ['tell it to fix the bug in the parser and send it', D, [/^fix the bug in the parser\.?$/i]],
  ['run the tests send it', D, [/^run the tests\.?$/i]],
  // Following on
  ['continue', D, [/^continue\.?$/i]],
  ['keep going', D, [/keep going/i]],
  ["that's wrong, undo it", D, [/undo it/i]],
  ['tell it no, use the other approach', D, [/use the other approach/i]],
  ['do the same for the footer', D, [/footer/i], ['tell it to make the header sticky', '[Tool result: send_draft] {"ok":true,"sent":true,"sessionTitle":"Auth work"}']],
  ['the second one', D, [/second/i], '[App notification] Claude just finished in the session titled "Database setup". Its last message asks: "Should I use option one, Redis, or option two, Postgres?"'],
  ['go with two', D, [/two|postgres/i], '[App notification] Claude just finished in the session titled "Database setup". Its last message asks: "Should I use option one, Redis, or option two, Postgres?"'],
  // Reading
  ['read me its last message', ['read_session', 'get_current_session']], // (both return its latest messages)
  ['what did it change', ['read_session', 'get_current_session']],
  ['what sessions do I have', 'list_sessions'],
  // Sessions
  ['go to the auth one', 'switch_session', [/auth/i]],
  ['not that one, the database one', ['switch_session', 'list_sessions'], [(s) => !/"session"/.test(s) || /database/i.test(s)], ['open the auth session', '[Tool result: switch_session] {"ok":true,"switched":true,"sessionTitle":"Auth work"}']],
  // Claude's own app (the model picker is Claude's, not Orbit's voice)
  ['switch Claude to Sonnet', ['claude_app'], [/model/i, /sonnet/i]],
  ['hide the sidebar', ['claude_app'], [/sidebar/i]],
  ['scroll up a bit', ['claude_app'], [/scroll/i]],
  ['put it in plan mode', ['claude_app'], [/permission/i, /plan/i]],
];
// A same-breath send: after the draft, Orbit sent it itself (what draft_prompt returns then). The
// reply must not ask "Send it?" or call send_draft again.
const AUTO_SENT = '[Tool result: draft_prompt] {"drafted":true,"sent":true,"text":"Fix the failing tests.","target_session":"Auth work","next_step":"The user said to send it, so Orbit sent it. Say only \\"Sent.\\" (or a word or two). Don\'t ask to send it, and don\'t call send_draft."}';
const AFTER_SEND = [
  ['tell Claude to fix the failing tests and send it', AUTO_SENT],
  ['prompt it to fix the failing tests, just send it', AUTO_SENT],
];

async function runCase([said, want, checks = [], context]) {
  const proc = new ClaudeProc({ exe, prompt, model });
  const ask = (text) =>
    new Promise((resolve) => {
      let out = '';
      proc.ask(text, { onText: (d) => (out += d), onResult: () => resolve(out), onFail: (w) => resolve(`FAILED ${w}`) });
    });
  try {
    for (const turn of [context].flat().filter(Boolean)) await ask(turn);
    const out = await ask(said);
    // Read the call as the engine does (src/claude-voice.js findToolCall).
    const { call, at } = findToolCall(out);
    const tool = call?.name || (at >= 0 ? 'bad-call' : null);
    const why = [];
    const wants = Array.isArray(want) ? want : [want];
    if (!wants.includes(tool)) why.push(`tool ${tool} (wanted ${wants.map(String).join(' or ')})`);
    const test = (c, s) => (typeof c === 'function' ? c(s) : c.test(s));
    if (tool === D && wants.includes(D)) {
      // What Orbit itself makes of it: an "…and send it" the voice left in comes off (src/send-intent.js).
      const given = String(call.args?.text || '').trim();
      const text = sendInstruction(said).send ? withoutSendTail(given) : given;
      for (const c of checks) if (!test(c, text.replace(/`/g, ''))) why.push(`draft fails ${c}`);
      const ctxWords = [context].flat().filter((t) => t && !t.startsWith('[')).join(' ');
      const extra = wordsNotSaid(text, `${said} ${ctxWords} Fix the login bug`, { direct: call.args?.verbatim !== true });
      const allowed = call.args?.verbatim === true ? 0 : Math.max(1, Math.floor(text.split(/\s+/).length / 10));
      if (extra.length > allowed) why.push(`words not said: ${extra.join(', ')}`);
      return { said, ok: !why.length, why, text };
    }
    if (tool && wants.includes(tool) && tool !== D) for (const c of checks) if (!test(c, JSON.stringify(call?.args || {}))) why.push(`call fails ${c}`);
    // A send also has to get through Orbit's own check of the user's words.
    if (tool === S && wants.includes(S) && !isClearYes(said)) why.push('Orbit\x27s yes check refuses these words');
    const spoken = (at >= 0 ? out.slice(0, at) : out).trim();
    if (/\b(can'?t|cannot|unable to|don'?t have (access|the ability))\b/i.test(spoken) && tool === null && wants.includes(D)) why.push('said it can\x27t');
    return { said, ok: !why.length, why, text: tool ? `${tool} ${JSON.stringify(call?.args || {})}` : spoken.slice(0, 140) };
  } finally {
    proc.kill();
  }
}

/** After a same-breath send: the reply says it's sent, without asking again or sending twice. */
async function runAfterSend([said, result]) {
  const proc = new ClaudeProc({ exe, prompt, model });
  const ask = (text) =>
    new Promise((resolve) => {
      let out = '';
      proc.ask(text, { onText: (d) => (out += d), onResult: () => resolve(out), onFail: (w) => resolve(`FAILED ${w}`) });
    });
  try {
    await ask(said);
    const out = await ask(result);
    const why = [];
    if (/send_draft/.test(out)) why.push('called send_draft again');
    if (/\b(send it|send that|shall i send|want me to send|should i send)\b[^.]*\?/i.test(out)) why.push('asked to send it again');
    if (/<tool>|<invoke/.test(out) && !/send_draft/.test(out)) why.push('called another tool');
    return { said: `${said} (then: sent)`, ok: !why.length, why, text: out.replace(/\s+/g, ' ').slice(0, 140) };
  } finally {
    proc.kill();
  }
}

// Cases for tools this build doesn't have (yet) are left out.
const have = new Set(tools.map((t) => t.name));
const usable = CASES.filter((c) => [c[1]].flat().every((t) => t === null || have.has(t)) || [c[1]].flat().some((t) => t !== null && have.has(t)));
const skipped = CASES.length - usable.length;
const jobs = [];
for (let i = 0; i < runs; i++) {
  for (const c of usable) if (!only || c[0].includes(only)) jobs.push(() => runCase(c));
  for (const c of AFTER_SEND) if (!only || c[0].includes(only)) jobs.push(() => runAfterSend(c));
}
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: jobsAtOnce }, async () => {
    while (next < jobs.length) results.push(await jobs[next++]());
  }),
);
if (skipped) console.log(`(${skipped} cases left out: their tools aren't in this build)`);
const byCase = new Map();
for (const r of results) {
  const e = byCase.get(r.said) || { pass: 0, n: 0, fails: [] };
  e.n++;
  if (r.ok) e.pass++;
  else e.fails.push(`${r.why.join('; ')} → ${JSON.stringify(r.text)}`);
  byCase.set(r.said, e);
}
let pass = 0;
for (const [said, e] of byCase) {
  pass += e.pass;
  console.log(`${e.pass === e.n ? 'PASS' : 'FAIL'} ${e.pass}/${e.n}  "${said}"${e.fails.length ? `\n      ${[...new Set(e.fails)].join('\n      ')}` : ''}`);
}
console.log(`\n${model}: ${pass}/${results.length} passed (${((100 * pass) / results.length).toFixed(1)}%), ${[...byCase.values()].filter((e) => e.pass === e.n).length}/${byCase.size} cases all-pass`);
setTimeout(() => process.exit(0), 300);
