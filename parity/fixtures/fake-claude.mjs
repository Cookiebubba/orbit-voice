// A stand-in for Claude Code in `claude -p` stream-json mode (what Claude voice talks to, see
// src/claude-voice.js ClaudeProc), for the parity suite's voice scenarios: the speech side is real
// (on-device VAD, speech to text and text to speech, through each app's own microphone and speakers
// path), and only the model's replies are scripted, so a scenario is deterministic.
//
// The runner writes a `claude` wrapper (the core only runs a file named claude) that execs this with
// the Node it runs on. Scripted replies come from $PARITY_FAKE_CLAUDE_RULES (JSON):
//   { "rules": [ { "when": "regex (case-insensitive) on the user's turn", "reply": "text, may end in <tool>{...}</tool>",
//                  "once": true } ], "fallback": "Okay." }
// The first rule whose `when` matches the newest user message wins (a used `once` rule is skipped).
// Every turn it sees and every reply it gives is appended to $PARITY_RECORD_DIR/fake-claude.jsonl
// (test phrases only: these are the scenario's own synthetic words).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('2.1.0 (Claude Code, parity stand-in)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}

const record = process.env.PARITY_RECORD_DIR ? path.join(process.env.PARITY_RECORD_DIR, 'fake-claude.jsonl') : '';
const log = (o) => record && fs.appendFileSync(record, JSON.stringify({ at: Date.now(), pid: process.pid, ...o }) + '\n');
let rules = { rules: [], fallback: 'Okay.' };
try {
  rules = { ...rules, ...JSON.parse(fs.readFileSync(process.env.PARITY_FAKE_CLAUDE_RULES, 'utf8')) };
} catch {}
const used = new Set();
const model = argv[argv.indexOf('--model') + 1] || '';
log({ kind: 'start', model, stream: argv.includes('stream-json') });

const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
out({ type: 'system', subtype: 'init', model, tools: [] });

let queue = Promise.resolve();
let interrupted = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function replyFor(text) {
  if (/^\[Orbit warm-up/.test(text)) return 'OK';
  for (let i = 0; i < rules.rules.length; i++) {
    const r = rules.rules[i];
    if (r.once && used.has(i)) continue;
    if (new RegExp(r.when, 'i').test(text)) {
      used.add(i);
      return r.reply;
    }
  }
  return rules.fallback;
}

async function answer(text) {
  interrupted = false;
  const reply = replyFor(text);
  log({ kind: 'turn', text: text.slice(-2000), reply });
  await sleep(120); // a first token a little later, like the real one
  // Words in small pieces, the tool line in one go (as the model tends to write it).
  const pieces = reply.split(/(<tool>.*<\/tool>)/s).flatMap((p) => (p.startsWith('<tool>') ? [p] : p.match(/\S+\s*/g) || []));
  for (const p of pieces) {
    if (interrupted) break;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } } });
    await sleep(15);
  }
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: 200, total_cost_usd: 0 });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
    interrupted = true;
    log({ kind: 'interrupt' });
    return;
  }
  if (m.type !== 'user') return;
  const c = m.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('') : '';
  queue = queue.then(() => answer(text));
});
process.stdin.on('end', () => queue.then(() => process.exit(0)));
