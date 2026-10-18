// Supervisor + ledger tests against a scripted ACP agent (test/fixtures/fake-acp-agent.js).
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor, ISOLATION_META, parseReport } from '../src/agents/supervisor.js';
import { Ledger, readEvents, replay, toCard } from '../src/agents/ledger.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.js', import.meta.url));

function setup(t, opts = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sup-'));
  const record = path.join(runsDir, 'record.jsonl');
  const base = { agentCommand: { command: process.execPath, args: [FAKE], env: { FAKE_RECORD: record } }, budgetCheckMs: 25 };
  const sup = Supervisor.create({ runsDir, goal: 'test run', ...base, ...opts });
  t.after(() => sup.shutdown());
  return { sup, base: { ...base, ...opts }, record };
}

function until(sup, pred, label = 'condition', ms = 10000) {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const on = () => { if (pred()) { clearTimeout(timer); sup.off('event', on); resolve(); } };
    const timer = setTimeout(() => {
      sup.off('event', on);
      reject(new Error(`timeout: ${label}\n${JSON.stringify(sup.cards().map((c) => [c.id, c.state, c.progress, c.reason]))}`));
    }, ms);
    sup.on('event', on);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eventsOf = (sup, id, type) => readEvents(sup.ledger.file).filter((e) => e.id === id && (!type || e.type === type));
const recorded = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

// ---- Ledger ---------------------------------------------------------------------

test('ledger: replay builds cards and skips a torn last line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ledger-'));
  const l = new Ledger(path.join(dir, 'ledger.jsonl'));
  l.append('run_started', { runId: 'r1', goal: 'g' });
  l.append('agent_spawned', { id: 'a', name: 'a', task: 't', budget: {} });
  l.append('agent_state', { id: 'a', state: 'running' });
  l.append('agent_progress', { id: 'a', done: 2, total: 5, step: 'three' });
  l.append('agent_usage', { id: 'a', used: 1000, size: 10000, cost: 0.5, model: 'm' });
  fs.appendFileSync(l.file, '{"seq":99,"type":"agent_state","id":"a","sta'); // Orbit died mid-write
  const s = replay(readEvents(l.file));
  assert.equal(s.run.goal, 'g');
  const c = toCard(s.agents.a);
  assert.equal(c.state, 'running');
  assert.deepEqual(c.progress, { done: 2, total: 5, step: 'three' });
  assert.equal(c.cost, 0.5);
  assert.equal(new Ledger(l.file).seq, 5, 'sequence continues after the torn line');
});

test('parseReport takes the last valid block and normalises it', () => {
  const r = parseReport('text ```json\n{"status":"nope"}\n``` more ```json\n{"status":"done","summary":"ok","changes":["a"]}\n```');
  assert.deepEqual(r, { status: 'done', summary: 'ok', changes: ['a'], branch: null, questions: [], next: null });
  assert.equal(parseReport('no json here'), null);
});

// ---- Supervisor -----------------------------------------------------------------

test('runs an agent to done: progress, activity, usage and report', async (t) => {
  const { sup } = setup(t);
  const id = sup.spawn({ name: 'Tests', task: '[fake steps=3 stepMs=10 costPerStep=0.01]', writes: true });
  assert.equal(id, 'tests');
  await sup.wait([id]);
  const c = sup.card(id);
  assert.equal(c.state, 'done');
  assert.deepEqual(c.progress, { done: 3, total: 3, step: 'finished' });
  assert.deepEqual(c.report.changes, ['step-1.txt', 'step-2.txt', 'step-3.txt']);
  assert.equal(c.model, 'fake-sonnet');
  assert.ok(Math.abs(c.cost - 0.03) < 1e-9);
  const progress = eventsOf(sup, id, 'agent_progress');
  assert.ok(progress.every((e) => typeof e.done === 'number' && typeof e.total === 'number' && typeof e.step === 'string'), 'no half-streamed progress');
  assert.deepEqual(progress.map((e) => e.done), [0, 1, 2, 3]);
  const acts = eventsOf(sup, id, 'agent_activity').map((e) => e.activity);
  assert.deepEqual(acts, ['Write step-1.txt', 'Write step-2.txt', 'Write step-3.txt'], 'placeholder titles are skipped');
});

test('a finished agent can be asked a follow-up as soon as it reports', async (t) => {
  const { sup } = setup(t);
  const id = sup.spawn({ name: 'a', task: '[fake steps=1 stepMs=5 codeword=KIWI]' });
  const answered = new Promise((resolve, reject) => {
    const on = (e) => {
      if (e.type !== 'agent_state' || e.id !== id || e.state !== 'done') return;
      sup.off('event', on);
      sup.message(id, "what's the codeword?").then(resolve, reject);
    };
    sup.on('event', on);
  });
  assert.match(await answered, /KIWI/);
  assert.equal(sup.card(id).state, 'done');
});

test('starts sessions isolated, in default mode, on the requested model', async (t) => {
  const { sup, record } = setup(t, { model: 'sonnet' });
  await sup.wait([sup.spawn({ name: 'a', task: '[fake steps=1 stepMs=5]' })]);
  const r = recorded(record);
  const ns = r.find((x) => x.kind === 'newSession');
  assert.deepEqual(ns.meta, ISOLATION_META);
  assert.deepEqual(ns.mcpServers, ['orbit']);
  assert.equal(r.find((x) => x.kind === 'setSessionMode').modeId, 'default');
  assert.equal(r.find((x) => x.kind === 'setSessionConfigOption').value, 'sonnet');

  const plain = setup(t, { isolate: false });
  await plain.sup.wait([plain.sup.spawn({ name: 'b', task: '[fake steps=1 stepMs=5]' })]);
  assert.equal(recorded(plain.record).find((x) => x.kind === 'newSession').meta, null);
});

test('respects maxConcurrent and starts queued agents as slots free up', async (t) => {
  const { sup } = setup(t, { maxConcurrent: 2 });
  let peak = 0;
  sup.on('event', () => { peak = Math.max(peak, sup.cards().filter((c) => ['starting', 'running', 'needs_you', 'paused'].includes(c.state)).length); });
  const ids = ['a', 'b', 'c'].map((n) => sup.spawn({ name: n, task: '[fake steps=2 stepMs=40]' }));
  assert.equal(sup.card('c').state, 'queued');
  await sup.wait(ids);
  assert.ok(ids.every((id) => sup.card(id).state === 'done'));
  assert.equal(peak, 2);
});

test('pause now cancels the turn but keeps the session and its memory; resume finishes', async (t) => {
  const { sup } = setup(t);
  const id = sup.spawn({ name: 'a', task: '[fake steps=6 stepMs=60 codeword=ORCHID]' });
  await until(sup, () => sup.card(id).progress.done >= 2, 'two steps');
  await sup.pause(id);
  assert.equal(sup.card(id).state, 'paused');
  const at = sup.card(id).progress.done;
  await sleep(250);
  assert.equal(sup.card(id).progress.done, at, 'no progress while paused');

  const answer = await sup.message(id, "Quick check: what's the codeword?");
  assert.match(answer, /ORCHID/);
  assert.match(answer, new RegExp(`finished ${at} of 6`));
  assert.equal(sup.card(id).state, 'paused', 'a question leaves the card paused');

  await sup.resume(id);
  await sup.wait([id]);
  assert.equal(sup.card(id).state, 'done');
  assert.equal(sup.card(id).report.changes.length, 6);
  const dones = eventsOf(sup, id, 'agent_progress').map((e) => e.done);
  assert.deepEqual(dones, [...dones].sort((x, y) => x - y), 'progress never goes backwards');
});

test('pause after this step parks the agent on a step boundary', async (t) => {
  const { sup } = setup(t);
  const id = sup.spawn({ name: 'a', task: '[fake steps=5 stepMs=40]' });
  await until(sup, () => sup.card(id).progress.done >= 1, 'one step');
  await sup.pause(id, { when: 'step' });
  await sup.pause(id, { when: 'step' }); // a second click is a no-op
  await until(sup, () => sup.card(id).state === 'paused', 'parked');
  await sup.pause(id); // so is pausing a paused agent
  assert.equal(sup.card(id).reason, 'paused by you after a step');
  assert.equal(eventsOf(sup, id, 'control').length, 1, 'only one pause recorded');
  const before = readEvents(sup.ledger.file).length;
  await sleep(300);
  const during = readEvents(sup.ledger.file).slice(before).filter((e) => ['agent_activity', 'agent_progress'].includes(e.type));
  assert.equal(during.length, 0, 'nothing happens while parked');
  await sup.resume(id);
  await sup.wait([id]);
  assert.equal(sup.card(id).state, 'done');
});

test('redirect mid-run changes direction in the same session', async (t) => {
  const { sup, record } = setup(t);
  const id = sup.spawn({ name: 'a', task: '[fake steps=5 stepMs=50]' });
  await until(sup, () => sup.card(id).progress.done >= 2, 'two steps');
  await sup.redirect(id, 'UPPERCASE ONLY');
  await sup.wait([id]);
  const acts = eventsOf(sup, id, 'agent_activity').map((e) => e.activity);
  const firstRedirected = acts.findIndex((a) => a.includes('redirected: UPPERCASE ONLY'));
  assert.ok(firstRedirected >= 2, `earlier steps kept their direction: ${acts}`);
  assert.ok(acts.slice(firstRedirected).every((a) => a.includes('redirected')));
  assert.match(sup.card(id).report.summary, /redirected/);
  assert.equal(recorded(record).filter((x) => x.kind === 'newSession').length, 1, 'no new session');
});

test('redirect works while parked after a step', async (t) => {
  const { sup } = setup(t);
  const id = sup.spawn({ name: 'a', task: '[fake steps=4 stepMs=30]' });
  await until(sup, () => sup.card(id).progress.done >= 1, 'one step');
  await sup.pause(id, { when: 'step' });
  await until(sup, () => sup.card(id).state === 'paused', 'parked');
  await sup.redirect(id, 'NEW PLAN');
  await sup.wait([id]);
  assert.equal(sup.card(id).state, 'done');
  assert.match(sup.card(id).report.summary, /NEW PLAN/);
});

test('stop ends one agent and leaves the others running', async (t) => {
  const { sup } = setup(t);
  const a = sup.spawn({ name: 'a', task: '[fake steps=50 stepMs=30]' });
  const b = sup.spawn({ name: 'b', task: '[fake steps=4 stepMs=40]' });
  await until(sup, () => sup.card(a).progress.done >= 1, 'a started');
  await sup.stop(a);
  assert.equal(sup.card(a).state, 'stopped');
  await sup.wait([b]);
  assert.equal(sup.card(b).state, 'done');
  const child = sup.rt.get(a).child;
  if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "a's process is gone");
});

test('needs you: write permissions wait for an answer; a denial ends as blocked', async (t) => {
  const { sup } = setup(t);
  const id = sup.spawn({ name: 'a', task: '[fake steps=2 stepMs=10 write=ask]', writes: true });
  await until(sup, () => sup.card(id).state === 'needs_you', 'first request');
  assert.equal(sup.card(id).needs.title, 'Write step-1.txt');
  assert.equal(sup.card(id).needs.path, '/work/step-1.txt');
  await sleep(150);
  assert.equal(sup.card(id).state, 'needs_you', 'still waiting');
  sup.answer(id, true);
  await until(sup, () => sup.card(id).state === 'needs_you' && sup.card(id).needs.title === 'Write step-2.txt', 'second request');
  sup.answer(id, false);
  await sup.wait([id]);
  const c = sup.card(id);
  assert.equal(c.state, 'blocked');
  assert.match(c.reason, /denied for step-2\.txt/);
  assert.deepEqual(c.report.changes, ['step-1.txt']);
});

test('an autoApprove policy skips the card', async (t) => {
  const { sup } = setup(t, { autoApprove: (card, req) => req.toolCall.title.startsWith('Write') });
  const id = sup.spawn({ name: 'a', task: '[fake steps=2 stepMs=10 write=ask]' });
  await sup.wait([id]);
  assert.equal(sup.card(id).state, 'done');
  assert.equal(eventsOf(sup, id, 'agent_needs').length, 0);
});

test('a cost budget pauses the agent after the current step', async (t) => {
  const { sup } = setup(t);
  const id = sup.spawn({ name: 'a', task: '[fake steps=6 stepMs=20 costPerStep=0.1]', budget: { costUsd: 0.25 } });
  await until(sup, () => sup.card(id).state === 'paused', 'paused by budget');
  const c = sup.card(id);
  assert.ok(c.overBudget);
  assert.match(c.reason, /over budget: \$0\.30 of \$0\.25/);
  assert.equal(c.progress.done, 3);
  await sup.resume(id);
  await sup.wait([id]);
  assert.equal(sup.card(id).state, 'done', 'resuming means the user accepted the overrun');
});

test('a time budget pauses the agent too', async (t) => {
  const { sup } = setup(t);
  const id = sup.spawn({ name: 'a', task: '[fake steps=20 stepMs=60]', budget: { ms: 200 } });
  await until(sup, () => sup.card(id).state === 'paused', 'paused by time');
  assert.match(sup.card(id).reason, /over time budget/);
});

test('a missing report gets one reminder; a second miss fails the agent', async (t) => {
  const { sup } = setup(t);
  const ok = sup.spawn({ name: 'once', task: '[fake steps=1 stepMs=5 report=badOnce]' });
  const bad = sup.spawn({ name: 'never', task: '[fake steps=1 stepMs=5 report=bad]' });
  await sup.wait([ok, bad]);
  assert.equal(sup.card(ok).state, 'done');
  assert.ok(eventsOf(sup, ok, 'agent_activity').some((e) => e.activity === 'Asked for the missing report'));
  assert.equal(sup.card(bad).state, 'failed');
  assert.equal(sup.card(bad).reason, 'no valid report after one reminder');
  assert.equal(sup.card(bad).report.malformed, true);
});

test('a crashed agent fails on its own card without touching the others', async (t) => {
  const { sup } = setup(t);
  const crash = sup.spawn({ name: 'crash', task: '[fake steps=4 stepMs=20 crashAt=2]' });
  const fine = sup.spawn({ name: 'fine', task: '[fake steps=3 stepMs=30]' });
  await sup.wait([crash, fine]);
  assert.equal(sup.card(crash).state, 'failed');
  assert.match(sup.card(crash).reason, /agent process exited \(3\)/);
  assert.equal(sup.card(fine).state, 'done');
});

test('after Orbit dies, open() rebuilds the run from the ledger and restart() continues', async (t) => {
  const { sup, base, record } = setup(t, { maxConcurrent: 2 });
  const a = sup.spawn({ name: 'a', task: '[fake steps=4 stepMs=250]' });
  const b = sup.spawn({ name: 'b', task: '[fake steps=1 stepMs=5]' });
  const c = sup.spawn({ name: 'c', task: '[fake steps=1 stepMs=5]' });
  await sup.wait([b]);
  await until(sup, () => sup.card(a).progress.done >= 2, 'a halfway');
  const cBefore = sup.card(c).state;
  await sup.shutdown(); // simulated crash: processes die, nothing is recorded

  const sup2 = Supervisor.open(sup.runDir, base);
  t.after(() => sup2.shutdown());
  assert.equal(sup2.runId, sup.runId);
  assert.equal(sup2.card(a).state, 'interrupted');
  assert.deepEqual(sup2.card(a).progress.done >= 2, true);
  assert.deepEqual(sup2.card(b), { ...sup.card(b), elapsedMs: sup2.card(b).elapsedMs });
  if (cBefore === 'queued') {
    await sleep(200);
    assert.equal(sup2.card(c).state, 'queued', 'queued agents wait for resumeQueue()');
  }

  sup2.restart(a);
  sup2.resumeQueue();
  await sup2.wait([a, c]);
  assert.equal(sup2.card(a).state, 'done');
  assert.equal(sup2.card(c).state, 'done');
  assert.ok(recorded(record).filter((x) => x.kind === 'newSession').length >= 4, 'a got a fresh session');
});

// ---- Control inbox (build step 4) --------------------------------------------------

import { appendControl, ownerLive } from '../src/agents/inbox.js';

const resultFor = (sup, rid) => readEvents(sup.ledger.file).find((e) => e.type === 'control_result' && e.rid === rid);
const untilResult = (sup, rid) => until(sup, () => !!resultFor(sup, rid), `result ${rid}`).then(() => resultFor(sup, rid));

test('the owner keeps a heartbeat while running and clears it on shutdown', async (t) => {
  const { sup } = setup(t);
  assert.equal(ownerLive(sup.runDir), true);
  await sup.shutdown();
  assert.equal(ownerLive(sup.runDir), false);
});

test('inbox requests drive the agent and each gets a result', async (t) => {
  const { sup } = setup(t, { inboxPollMs: 20 });
  const id = sup.spawn({ name: 'a', task: '[fake steps=6 stepMs=60 write=ask]', writes: true });

  await until(sup, () => sup.card(id).state === 'needs_you', 'first write request');
  let r = await untilResult(sup, appendControl(sup.runDir, { agent: id, action: 'approve' }));
  assert.equal(r.ok, true);

  await until(sup, () => sup.card(id).state === 'needs_you' && sup.card(id).needs.title === 'Write step-2.txt', 'second request');
  r = await untilResult(sup, appendControl(sup.runDir, { agent: id, action: 'approve' }));
  r = await untilResult(sup, appendControl(sup.runDir, { agent: id, action: 'approve' }));
  assert.equal(r.ok, false, 'approving twice fails cleanly');
  assert.match(r.error, /isn't waiting/);

  r = await untilResult(sup, appendControl(sup.runDir, { agent: id, action: 'pause_step' }));
  assert.equal(r.ok, true);
  await until(sup, () => sup.card(id).state === 'paused' || sup.card(id).state === 'needs_you', 'parked or asking');
  if (sup.card(id).state === 'needs_you') await untilResult(sup, appendControl(sup.runDir, { agent: id, action: 'approve' }));
  await until(sup, () => sup.card(id).state === 'paused', 'parked');

  r = await untilResult(sup, appendControl(sup.runDir, { agent: id, action: 'redirect', text: 'SHORTER FILES' }));
  assert.equal(r.ok, true);
  await until(sup, () => sup.card(id).state === 'needs_you', 'asks again after redirect');
  assert.match(sup.card(id).needs.title, /redirected: SHORTER FILES/);

  r = await untilResult(sup, appendControl(sup.runDir, { agent: id, action: 'stop' }));
  assert.equal(r.ok, true);
  assert.equal(sup.card(id).state, 'stopped');
  r = await untilResult(sup, appendControl(sup.runDir, { agent: id, action: 'restart' }));
  assert.equal(r.ok, true);
  await until(sup, () => sup.card(id).state === 'needs_you', 'restarted and asking');
});

test('bad inbox requests get an error result, and old requests are ignored', async (t) => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sup-'));
  const base = { agentCommand: { command: process.execPath, args: [FAKE] }, inboxPollMs: 20 };
  const first = Supervisor.create({ runsDir, goal: 'g', ...base });
  const id = first.spawn({ name: 'a', task: '[fake steps=1 stepMs=5]' });
  await first.wait([id]);
  await first.shutdown();
  const stale = appendControl(first.runDir, { agent: id, action: 'stop' }); // written while nobody owns the run

  const sup = Supervisor.open(first.runDir, base);
  t.after(() => sup.shutdown());
  const unknown = await untilResult(sup, appendControl(sup.runDir, { agent: 'ghost', action: 'pause' }));
  assert.deepEqual([unknown.ok, unknown.error], [false, 'no agent ghost']);
  fs.appendFileSync(path.join(sup.runDir, 'inbox.jsonl'), JSON.stringify({ rid: 'x1', agent: id, action: 'format_disk' }) + '\n');
  const bogus = await untilResult(sup, 'x1');
  assert.deepEqual([bogus.ok, bogus.error], [false, 'unknown action']);
  assert.equal(resultFor(sup, stale), undefined, 'a request from before this owner is never run');
  assert.equal(sup.card(id).state, 'done');
});
