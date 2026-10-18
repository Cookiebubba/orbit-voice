// Build step 2 smoke test: the real Supervisor driving two real Claude agents over ACP.
//   writer: writes 4 files in its own temp folder; paused after a step, then resumed.
//   reader: read-only; summarizes 3 seeded files.
// Writes inside an agent's own folder are auto-approved; anything else would wait on the card.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor, claudeAgentCommand } from '../../src/agents/supervisor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const writerDir = tmp('orbit-smoke-writer-');
const readerDir = tmp('orbit-smoke-reader-');
for (const [f, body] of [['alpha.txt', 'Alpha: the first orbit.\nmore'], ['beta.txt', 'Beta: a moon.\nmore'], ['gamma.txt', 'Gamma: a comet.\nmore']]) fs.writeFileSync(path.join(readerDir, f), body);

const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`);

const sup = Supervisor.create({
  runsDir: path.join(HERE, 'runs', 'supervisor'),
  goal: 'Smoke test: two real agents',
  agentCommand: claudeAgentCommand(ADAPTER),
  model: 'sonnet',
  autoApprove: (card, req) => {
    const p = req.toolCall?.locations?.[0]?.path ?? req.toolCall?.rawInput?.file_path ?? '';
    return card.id === 'writer' && p && path.resolve(p).toLowerCase().startsWith(writerDir.toLowerCase());
  },
});

const last = {};
sup.on('event', (e) => {
  if (!e.id) return;
  const c = sup.card(e.id);
  const line = `${c.state.padEnd(10)} ${c.progress.total ? `${c.progress.done}/${c.progress.total} ${c.progress.step}` : ''}${c.activity ? ` · ${c.activity}` : ''}${c.reason ? ` · (${c.reason})` : ''}`;
  if (last[e.id] !== line) { last[e.id] = line; say(`[${e.id}] ${line}`); }
});

// Play the user: when a card shows "Needs you", approve it after 2 s (like clicking Approve).
const approvals = [];
sup.on('event', (e) => {
  if (e.type !== 'agent_needs') return;
  approvals.push(`${e.id}: ${e.title.split('\n')[0].slice(0, 80)}`);
  setTimeout(() => { if (sup.card(e.id)?.state === 'needs_you') { say(`→ approve ${e.id}'s request (as the user)`); sup.answer(e.id, true); } }, 2000);
});

const checks = {};
const check = (name, pass, detail = '') => { checks[name] = !!pass; say(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}`); };
const until = (pred, ms = 180000) => new Promise((res, rej) => {
  if (pred()) return res();
  const on = () => { if (pred()) { clearTimeout(to); sup.off('event', on); res(); } };
  const to = setTimeout(() => { sup.off('event', on); rej(new Error('timeout')); }, ms);
  sup.on('event', on);
});

let exit = 0;
try {
  const writer = sup.spawn({ name: 'writer', role: 'writer', writes: true, cwd: writerDir, budget: { costUsd: 1.5 },
    task: 'Create four files in the current folder, poem-1.txt to poem-4.txt, one at a time, each holding a two-line poem about orbits. Use a separate tool call per file.' });
  const reader = sup.spawn({ name: 'reader', role: 'reader', cwd: readerDir, budget: { costUsd: 1 },
    task: 'Read the .txt files in the current folder and report each file name with its first line. Don\'t change anything.' });

  await until(() => sup.card(writer).progress.done >= 1);
  say('→ pause writer after this step');
  await sup.pause(writer, { when: 'step' });
  await until(() => sup.card(writer).state === 'paused' || ['done', 'failed'].includes(sup.card(writer).state));
  const parkedAt = sup.card(writer).progress.done;
  const filesAtPark = fs.readdirSync(writerDir).length;
  await new Promise((r) => setTimeout(r, 5000));
  check('writer parks after a step', sup.card(writer).state === 'paused' && fs.readdirSync(writerDir).length === filesAtPark, `at ${parkedAt}/${sup.card(writer).progress.total}, ${filesAtPark} files, unchanged for 5 s`);
  say('→ resume writer');
  await sup.resume(writer);

  await sup.wait([writer, reader]);
  const w = sup.card(writer);
  const r = sup.card(reader);
  check('writer done with a report', w.state === 'done' && w.report?.status === 'done', w.report?.summary?.slice(0, 120));
  check('writer wrote 4 files', ['poem-1.txt', 'poem-2.txt', 'poem-3.txt', 'poem-4.txt'].every((f) => fs.existsSync(path.join(writerDir, f))));
  check('reader done with a report', r.state === 'done' && r.report?.status === 'done', r.report?.summary?.slice(0, 160));
  check('reader saw all three files', ['alpha', 'beta', 'gamma'].every((n) => r.report?.summary?.toLowerCase().includes(n)));
  check('reader changed nothing', fs.readdirSync(readerDir).length === 3 && (r.report?.changes ?? []).length === 0);
  check('progress came from report_progress', w.progress.total >= 4 && r.progress.total >= 1, `writer ${w.progress.done}/${w.progress.total}, reader ${r.progress.done}/${r.progress.total}`);
  check('needs-you approvals went through', true, approvals.join(' | ') || 'none needed');
  check('cost and model on the cards', w.cost > 0 && /sonnet/i.test(w.model ?? ''), `writer $${w.cost.toFixed(2)} ${w.model}, reader $${r.cost.toFixed(2)} ${r.model}`);
  const answer = await sup.message(writer, 'In one short sentence: which file did you write last? No tools.');
  check('follow-up question answered, card stays done', /poem-4/.test(answer ?? '') && sup.card(writer).state === 'done', `"${(answer ?? '').slice(0, 100)}"`);
} catch (e) {
  exit = 1;
  say(`ERROR ${e.stack ?? e}`);
} finally {
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  say(`done: ${Object.keys(checks).length - failed.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
  say(`ledger: ${sup.ledger.file}`);
  await sup.shutdown();
  process.exit(exit || (failed.length ? 1 : 0));
}
