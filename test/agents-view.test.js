// The read side of Orbit Agents: the ledger hub and the bridge's /api/agents endpoints.
// The bridge runs in a child process (it has no stop()), with a temp config and runs folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentsHub, feedEntry } from '../src/agents/hub.js';
import { Ledger } from '../src/agents/ledger.js';
import { Supervisor } from '../src/agents/supervisor.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.js', import.meta.url));
const SERVER = new URL('../src/server.js', import.meta.url).href;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeRun(runsDir, id, goal, t0) {
  const l = new Ledger(path.join(runsDir, id, 'ledger.jsonl'));
  l.append('run_started', { runId: id, goal });
  l.append('agent_spawned', { id: 'a', name: 'a', task: 'Do the thing\nsecond line', budget: {} });
  l.append('agent_state', { id: 'a', state: 'starting' });
  l.append('agent_state', { id: 'a', state: 'running' });
  l.append('agent_progress', { id: 'a', done: 1, total: 3, step: 'two' });
  if (t0) { // make start times deterministic for sorting
    const f = l.file;
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((line) => JSON.stringify({ ...JSON.parse(line), t: t0 })).join('\n') + '\n');
  }
  return l;
}

// ---- Hub ------------------------------------------------------------------------

test('hub lists runs newest first and rejects bad run ids', () => {
  const runsDir = tmp('orbit-hub-');
  writeRun(runsDir, 'old', 'Old run', 1000);
  writeRun(runsDir, 'new', 'New run', 2000);
  fs.mkdirSync(path.join(runsDir, 'empty-dir'));
  const hub = createAgentsHub({ runsDir });
  const runs = hub.listRuns();
  assert.deepEqual(runs.map((r) => r.id), ['new', 'old']);
  assert.equal(runs[0].active, 1);
  for (const bad of ['../new', 'new/../old', '..', 'a b', '', null]) assert.equal(hub.snapshot(bad), null, String(bad));
  const snap = hub.snapshot('new');
  assert.equal(snap.cards[0].progress.step, 'two');
  assert.deepEqual(snap.feed.map((f) => f.text), ['Run started: New run', 'Spawned a: Do the thing']);
});

test('hub streams appended events, holding back a half-written line', async () => {
  const runsDir = tmp('orbit-hub-');
  const l = writeRun(runsDir, 'r', 'Run');
  const hub = createAgentsHub({ runsDir, pollMs: 20 });
  const msgs = [];
  const unsubscribe = hub.subscribe('r', (m) => msgs.push(m));
  assert.equal(msgs[0].type, 'snapshot');

  l.append('agent_progress', { id: 'a', done: 2, total: 3, step: 'three' });
  const torn = JSON.stringify({ seq: 99, t: Date.now(), type: 'agent_state', id: 'a', state: 'needs_you', reason: 'Write x' });
  fs.appendFileSync(l.file, torn.slice(0, 20));
  await sleep(80);
  const u1 = msgs.filter((m) => m.type === 'update');
  assert.equal(u1.length, 1);
  assert.deepEqual(u1[0].cards[0].progress, { done: 2, total: 3, step: 'three' });

  fs.appendFileSync(l.file, torn.slice(20) + '\n');
  await sleep(80);
  const u2 = msgs.filter((m) => m.type === 'update');
  assert.equal(u2.length, 2);
  assert.equal(u2[1].cards[0].state, 'needs_you');
  assert.equal(u2[1].feed[0].text, 'a needs you: Write x');
  unsubscribe();
  hub.close();
});

test('feed lines skip noise and speak plainly', () => {
  assert.equal(feedEntry({ type: 'agent_state', id: 'a', state: 'running' }, 'starting'), null);
  assert.equal(feedEntry({ type: 'agent_usage', id: 'a' }), null);
  assert.equal(feedEntry({ type: 'agent_state', id: 'a', state: 'paused', reason: 'paused by you' }, 'running').text, 'a paused: paused by you');
  assert.equal(feedEntry({ type: 'control', id: 'a', action: 'redirect', text: 'skip e2e' }).text, 'You redirected a: “skip e2e”');
  assert.equal(feedEntry({ type: 'control', id: 'a', action: 'redirect', text: 'one more' }, 'done').text, 'You followed up with a: “one more”');
});

// ---- Bridge endpoints -----------------------------------------------------------

async function startBridge(t, runsDir) {
  const port = 4390 + Math.floor(Math.random() * 50);
  const configDir = tmp('orbit-cfg-');
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(SERVER)}); await m.startServer({ port: ${port}, configDir: ${JSON.stringify(configDir)}, agentsRuns: ${JSON.stringify(runsDir)} }); console.log('AUTH ' + m.authUrl('agents'));`],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XAI_API_KEY: '' } });
  t.after(() => child.kill());
  const auth = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /AUTH (\S+)/.exec(out); if (m) resolve(m[1]); });
    child.on('exit', (code) => reject(new Error(`bridge exited ${code}`)));
    setTimeout(() => reject(new Error(`bridge did not start: ${out}`)), 15000);
  });
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(auth, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/agents.html', 'sign-in link opens the Agents page');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { base, cookie };
}

/** Reads SSE messages from a fetch response until `until(msgs)` is true. */
async function readSse(res, until, ms = 10000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const msgs = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => ({ done: true }))]);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
      if (data) msgs.push(JSON.parse(data));
    }
    if (until(msgs)) break;
  }
  reader.cancel().catch(() => {});
  return msgs;
}

test('bridge: agents endpoints need the session cookie and serve runs, snapshots and a live stream', async (t) => {
  const runsDir = tmp('orbit-runs-');
  const { base, cookie } = await startBridge(t, runsDir);
  const get = (p, headers = {}) => fetch(base + p, { headers: { cookie, ...headers } });

  assert.equal((await fetch(`${base}/api/agents/runs`)).status, 401, 'no cookie');
  assert.equal((await get('/api/agents/runs', { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site');
  assert.deepEqual(await (await get('/api/agents/runs')).json(), { runs: [] });

  const page = await get('/agents.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);

  // A real run: the Supervisor drives two fake agents and writes the ledger the bridge tails.
  const sup = Supervisor.create({ runsDir, goal: 'Bridge test', agentCommand: { command: process.execPath, args: [FAKE] } });
  t.after(() => sup.shutdown());
  const runs = (await (await get('/api/agents/runs')).json()).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].goal, 'Bridge test');

  assert.equal((await get('/api/agents/run?id=..%2F..%2Fetc')).status, 404);
  assert.equal((await get('/api/agents/stream?id=nope')).status, 404);

  const res = await get(`/api/agents/stream?id=${sup.runId}`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const a = sup.spawn({ name: 'writer', task: '[fake steps=3 stepMs=400]' }); // slower than the 250 ms poll
  const b = sup.spawn({ name: 'reader', task: '[fake steps=2 stepMs=60]' });
  const msgs = await readSse(res, (m) => {
    const cards = {};
    for (const x of m) for (const c of x.cards) cards[c.id] = c;
    return cards[a]?.state === 'done' && cards[b]?.state === 'done';
  });
  assert.equal(msgs[0].type, 'snapshot');
  const seen = {};
  for (const m of msgs) for (const c of m.cards) (seen[c.id] ??= []).push(c);
  assert.deepEqual(seen[a].at(-1).progress, { done: 3, total: 3, step: 'finished' });
  assert.equal(seen[a].at(-1).report.status, 'done');
  assert.ok(seen[a].some((c) => c.state === 'running' && c.ticking), 'running cards tick');
  assert.ok(seen[a].map((c) => c.progress.done).includes(1), 'intermediate progress streamed');
  const feed = msgs.flatMap((m) => m.feed).map((f) => f.text);
  assert.ok(feed.includes('Spawned writer: [fake steps=3 stepMs=400]'));
  assert.ok(feed.some((f) => f.startsWith('writer reported done')));

  const snap = await (await get(`/api/agents/run?id=${sup.runId}`)).json();
  assert.deepEqual(snap.cards.map((c) => c.state), ['done', 'done']);
});

test('bridge: control requests are checked, queued for the run owner, and answered on the stream', async (t) => {
  const runsDir = tmp('orbit-runs-');
  const { base, cookie } = await startBridge(t, runsDir);
  const origin = base;
  const post = (body, headers = {}) => fetch(`${base}/api/agents/control`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const sup = Supervisor.create({ runsDir, goal: 'Controls', agentCommand: { command: process.execPath, args: [FAKE] }, inboxPollMs: 50 });
  t.after(() => sup.shutdown());
  const id = sup.spawn({ name: 'a', task: '[fake steps=8 stepMs=150]' });

  assert.equal((await fetch(`${base}/api/agents/control`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 401, 'no cookie');
  assert.equal((await post({ run: sup.runId, agent: id, action: 'stop' }, { origin: 'http://evil.example' })).status, 403, 'foreign origin');
  assert.equal((await post({ run: 'nope', agent: id, action: 'stop' })).status, 404);
  assert.equal((await post({ run: sup.runId, agent: id, action: 'format_disk' })).status, 400);
  assert.equal((await post({ run: sup.runId, agent: '../x', action: 'stop' })).status, 400);
  assert.equal((await post({ run: sup.runId, agent: id, action: 'redirect', text: '   ' })).status, 400);
  assert.equal((await post({ run: sup.runId, agent: id, action: 'redirect', text: 'x'.repeat(4001) })).status, 400);

  const snap = await (await fetch(`${base}/api/agents/run?id=${sup.runId}`, { headers: { cookie } })).json();
  assert.equal(snap.run.live, true);

  const stream = await fetch(`${base}/api/agents/stream?id=${sup.runId}`, { headers: { cookie } });
  const sse = readSse(stream, (m) => m.some((x) => x.cards?.some((c) => c.state === 'done')), 20000);
  await sleep(500);
  const pauseRes = await post({ run: sup.runId, agent: id, action: 'pause_step' });
  assert.equal(pauseRes.status, 202);
  const { rid: pauseRid } = await pauseRes.json();
  while (sup.card(id).state !== 'paused') await sleep(50);
  await sleep(400); // longer than the hub's 250 ms poll, so the paused card is streamed
  const { rid: badRid } = await (await post({ run: sup.runId, agent: id, action: 'approve' })).json(); // nothing to approve
  const { rid: resumeRid } = await (await post({ run: sup.runId, agent: id, action: 'resume' })).json();
  const msgs = await sse;
  const results = Object.fromEntries(msgs.flatMap((m) => m.results ?? []).map((r) => [r.rid, r]));
  assert.equal(results[pauseRid]?.ok, true);
  assert.equal(results[resumeRid]?.ok, true);
  assert.equal(results[badRid]?.ok, false);
  assert.ok(msgs.some((m) => m.cards?.some((c) => c.state === 'paused')), 'card showed paused');
  assert.ok(msgs.flatMap((m) => m.feed ?? []).some((f) => f.failed && /Couldn't approve the request from a/.test(f.text)), 'the failure is in the feed');

  // Once the owner is gone, controls are refused and the view says so.
  await sup.shutdown();
  assert.equal((await post({ run: sup.runId, agent: id, action: 'stop' })).status, 409);
  const after = await (await fetch(`${base}/api/agents/run?id=${sup.runId}`, { headers: { cookie } })).json();
  assert.equal(after.run.live, false);
});
