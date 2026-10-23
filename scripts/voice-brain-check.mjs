// Does each brain answer through Claude voice's kept-open Claude Code, and how fast?
//   node scripts/voice-brain-check.mjs [models...] [--turns N]
// Real Claude Code with your own sign-in: per model, a warm process (as the spare is), then a few
// short synthetic turns, timing the first word. Prints models, times and whether a tool call came back.

import { findClaude } from '../src/brain.js';
import { CLAUDE_VOICE_MODELS, ClaudeProc, parseToolCall, systemPrompt } from '../src/claude-voice.js';

const args = process.argv.slice(2);
const ti = args.indexOf('--turns');
const turns = ti >= 0 ? Number(args.splice(ti, 2)[1]) : 3;
const models = args.length ? args : Object.keys(CLAUDE_VOICE_MODELS);
const exe = findClaude()?.path;
if (!exe) throw new Error('Claude Code not found');
const { initConfig, updateSettings } = await import('../src/config.js');
initConfig({ dir: (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'orbit-eval-')) });
updateSettings({ voiceEngine: 'claude' });
const { agentContext } = await import('../src/agent.js');
const { instructions, tools } = agentContext({ face: 'orbit', avatar: null, orb: true });
const prompt = systemPrompt({ instructions, tools });
const SAID = ['What is the capital of France?', "what's Claude doing right now", 'Give me one quick tip for commit messages.'];

for (const model of models) {
  const warm = await new Promise((resolve) => {
    const t0 = Date.now();
    const p = new ClaudeProc({ exe, prompt, model, warm: true, onWarm: (ok) => resolve({ p, ok, ms: Date.now() - t0 }) });
  });
  if (!warm.ok) {
    console.log(`${model}: warm-up FAILED (${warm.p.stderr.trim().split('\n').pop() || 'no reason'})`);
    warm.p.kill();
    continue;
  }
  const firsts = [];
  let toolCalls = 0;
  for (let i = 0; i < turns; i++) {
    const r = await new Promise((resolve) => {
      const t0 = Date.now();
      let first = 0;
      let out = '';
      warm.p.ask(SAID[i % SAID.length], { onText: (d) => ((first ||= Date.now() - t0), (out += d)), onResult: (e) => resolve({ first, out, err: e?.is_error }), onFail: (w) => resolve({ first: 0, out: '', err: w }) });
    });
    if (r.err) console.log(`  ${model} turn ${i + 1}: error`);
    firsts.push(r.first);
    const m = r.out.match(/<tool>([\s\S]*?)<\/tool>/);
    if (m && parseToolCall(m[1])) toolCalls++;
  }
  warm.p.kill();
  const avg = firsts.reduce((a, b) => a + b, 0) / firsts.length;
  console.log(`${model}: answered, first word ${firsts.map((x) => `${(x / 1000).toFixed(2)}s`).join(', ')} (avg ${(avg / 1000).toFixed(2)}s), tool calls ${toolCalls}/${turns}, warm-up ${(warm.ms / 1000).toFixed(1)}s`);
}
setTimeout(() => process.exit(0), 300);
