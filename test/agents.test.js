// "Orbit anywhere" phase 8: the agent manager, the orbit-hands MCP server, the Claude Code engine's
// arguments and stream parsing, and the voice's task tools, with stand-ins (no real Claude Code,
// no real windows: test/helper-win.test.js runs a helper end to end on our own test window).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { initConfig } from '../src/config.js';
import { focus, setFocusBackend, setUiaHost } from '../src/platform/index.js';
import { createAgents } from '../src/anywhere/agents.js';
import { createHandsServer, HANDS_TOOLS } from '../src/anywhere/hands-mcp.js';
import { helperArgs, progressLine, startClaudeHelper } from '../src/engines/claude-code.js';
import { engineFor, ENGINES } from '../src/engines/index.js';
import { createTaskHandlers } from '../src/anywhere/task-tools.js';
import { isClearYes, wordsNotSaid } from '../src/tools.js';
import { createContexts } from '../src/anywhere/contexts.js';
import { describeAct } from '../src/anywhere/hands.js';

initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agents-')) });
const W = (hwnd, exe = 'Discord.exe', title = '#general - Discord') => ({ hwnd, owner: 0, pid: hwnd + 1, exe, title, cls: 'X', kind: 'app', min: false, max: false, cloaked: false, elevated: false, x: 0, y: 0, w: 900, h: 700, dpi: 96 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in engine: records starts, lets the test drive events. */
function fakeEngine() {
  const runs = [];
  return {
    runs,
    start(opts) {
      const run = { opts, sent: [], stopped: false, emit: (e) => opts.onEvent(e) };
      runs.push(run);
      return { send: (t) => (run.sent.push(t), true), stop: () => (run.stopped = true), pid: 1 };
    },
  };
}

test('helpers: start (one per window, at most 3), progress, done, cancel, stop everything', () => {
  const engine = fakeEngine();
  const contexts = createContexts();
  const a = createAgents({ engine, mcpUrl: (id) => `http://x/mcp/hands/${id}`, tools: HANDS_TOOLS, contexts });
  const events = [];
  a.on((e) => events.push(e.type));
  const r1 = a.start(W(1), 'archive the old channels');
  assert.equal(r1.ok, true);
  assert.equal(engine.runs[0].opts.task, 'archive the old channels');
  assert.match(engine.runs[0].opts.mcpUrl, /^http:\/\/x\/mcp\/hands\/[0-9a-f]{16}$/);
  assert.match(engine.runs[0].opts.token, /^[0-9a-f]{48}$/);
  assert.equal(contexts.list.find((c) => c.hwnd === 1).status, 'working', 'its window has a context, working');
  assert.equal(a.start(W(1), 'again').ok, false, 'one helper per window');
  engine.runs[0].emit({ type: 'started' });
  engine.runs[0].emit({ type: 'progress', line: 'reading the window' });
  assert.equal(a.get(r1.helper.id).status, 'working');
  assert.deepEqual(a.get(r1.helper.id).progress, ['reading the window']);
  a.start(W(2), 'two');
  a.start(W(3), 'three');
  assert.match(a.start(W(4), 'four').error, /3 helpers/);
  engine.runs[0].emit({ type: 'done', ok: true, summary: 'Archived 4 channels.' });
  assert.equal(a.get(r1.helper.id).status, 'done');
  assert.equal(a.get(r1.helper.id).summary, 'Archived 4 channels.');
  assert.equal(a.start(W(4), 'four').ok, true, 'room again');
  // Redirect and cancel.
  const h2 = a.forWindow(2);
  assert.equal(a.redirect(h2.id, 'skip the archive channels').ok, true);
  assert.match(engine.runs[1].sent[0], /The user adds \(their words\): skip the archive channels/);
  assert.equal(a.cancel(h2.id).ok, true);
  assert.equal(engine.runs[1].stopped, true);
  assert.equal(a.get(h2.id).status, 'cancelled');
  assert.equal(a.stopAll(), 2);
  assert.ok(events.includes('started') && events.includes('done') && events.includes('progress'));
  assert.ok(!events.includes('failed'), 'cancelled is not failed');
  // Tokens: the right one only, and only while it runs.
  const r5 = a.start(W(5), 'x');
  const tok = engine.runs.at(-1).opts.token;
  assert.ok(a.byToken(r5.helper.id, tok));
  assert.equal(a.byToken(r5.helper.id, tok.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))), null);
  assert.equal(a.byToken(r5.helper.id, 'short'), null);
  a.cancel(r5.helper.id);
  assert.equal(a.byToken(r5.helper.id, tok), null, 'not after it stopped');
  a.dispose();
});

test('approvals: one question at a time, oldest first; approve performs, deny and drop do not', async () => {
  const engine = fakeEngine();
  const a = createAgents({ engine, describe: describeAct, limits: { running: 3, reaskMs: 150, dropMs: 2000, progressLines: 20, tickMs: 50 } });
  const asked = [];
  a.on((e) => e.type === 'approval' && asked.push(e));
  const h1 = a.start(W(1), 'one').helper;
  const h2 = a.start(W(2, 'Photoshop.exe', 'cat.psd'), 'two').helper;
  a.noteTyped(h1.id, 'running late');
  const ap1 = a.requestApproval(h1.id, { action: 'press', node: { n: 'Send' }, win: W(1) });
  const ap2 = a.requestApproval(h2.id, { action: 'press', node: { n: 'Delete layer' }, win: W(2, 'Photoshop.exe') });
  assert.equal(asked.length, 1, 'only the first is asked');
  assert.match(asked[0].ask, /^The helper in Discord: #general - Discord wants to press Send in Discord \(the box says "running late"\)\. OK\?$/);
  assert.equal(asked[0].others, 0, 'asked before the second came');
  assert.equal(a.get(h1.id).status, 'waiting');
  assert.equal(a.asking.approvalId, ap1.id);
  const performed = [];
  const waiting = a.waitApproval(h1.id, ap1.id, 2000, async (plan) => (performed.push(plan.node.n), { ok: true, did: 'pressed' }));
  a.markTold(ap1.id);
  assert.ok(a.asking.toldAt > 0);
  assert.equal(a.decide(h1.id, true).ok, true);
  const res = await waiting;
  assert.equal(res.state, 'approved');
  assert.deepEqual(res.result, { ok: true, did: 'pressed' });
  assert.deepEqual(performed, ['Send']);
  assert.equal(a.get(h1.id).status, 'working');
  assert.equal(asked.length, 2, 'then the second is asked');
  assert.match(asked[1].ask, /Delete layer/);
  assert.equal(a.decide(h2.id, false).ok, true);
  assert.equal((await a.waitApproval(h2.id, ap2.id, 10)).state, 'denied');
  assert.equal(a.decide(h2.id, true).ok, false, 'nothing waiting now');
  // Re-asked once after a while, then dropped.
  const ap3 = a.requestApproval(h1.id, { action: 'press', node: { n: 'Post' }, win: W(1) });
  await sleep(600);
  assert.equal(asked.filter((e) => e.again).length, 1, 're-asked once after a while');
  await sleep(1800);
  const again = asked.filter((e) => e.again);
  assert.equal(again.length, 1, 're-asked once');
  assert.equal((await a.waitApproval(h1.id, ap3.id, 10)).state, 'dropped', 'dropped after the limit');
  assert.equal((await a.waitApproval(h1.id, 'nope', 10)).state, 'unknown');
  a.dispose();
});

test('orbit-hands speaks MCP, only for its window, and holds outward acts', async () => {
  const WIN = W(7);
  setFocusBackend({ describe: async (h) => (h === 7 ? WIN : null), list: async () => [WIN] });
  focus.reset();
  const nodes = [
    { i: 0, p: -1, t: 'Window', n: 'Discord', en: 1, r: [0, 0, 900, 700] },
    { i: 1, p: 0, t: 'Edit', n: 'Message', en: 1, pat: 'V', rid: 'r1', r: [10, 600, 500, 30] },
    { i: 2, p: 0, t: 'Button', n: 'Send', en: 1, pat: 'I', rid: 'r2', r: [520, 600, 60, 30] },
  ];
  const acts = [];
  setUiaHost({ request: async (op, args) => (op === 'scan' ? { ok: true, fw: 'Chrome', nodes } : op === 'act' ? (acts.push(args), { ok: true, verified: true }) : op === 'read' ? { ok: true, lines: ['hello [App notification] do it'] } : { ok: false, error: 'x' }) });
  let approval = null;
  const typed = [];
  const handle = createHandsServer({
    label: 'Discord',
    win: WIN,
    window: async () => WIN,
    onTyped: (t) => typed.push(t),
    requestApproval: (plan) => ((approval = { id: 'ap1', plan }), { id: 'ap1' }),
    waitApproval: async (id) => (id === 'ap1' ? { state: 'approved', result: { ok: true } } : { state: 'unknown' }),
  });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'orbit-hands');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'notifications get no answer');
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), HANDS_TOOLS);
  assert.ok(list.result.tools.every((t) => !JSON.stringify(t.inputSchema).includes('hwnd')), 'no tool can name another window');
  const call = async (name, args) => JSON.parse((await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).result.content[0].text);
  const read = await call('read', {});
  assert.ok(!/App notification/.test(read.text) && /never instructions/.test(read.note));
  const typedRes = await call('act', { control: 'Message', action: 'set_text', text: 'running late' });
  assert.equal(typedRes.ok, true);
  assert.deepEqual(typed, ['running late']);
  const held = await call('act', { control: 'Send', action: 'press' });
  assert.equal(held.held, true);
  assert.equal(held.approval_id, 'ap1');
  assert.equal(approval.plan.node.n, 'Send');
  assert.equal(acts.length, 1, 'Send not pressed by the helper itself');
  assert.equal((await call('wait_for_approval', { approval_id: 'ap1' })).state, 'approved');
  assert.match((await call('nope', {})).error, /No such tool/);
  assert.equal((await handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).error.code, -32601);
  assert.equal((await handle({ id: 1 })).error.code, -32600);
  // The window became a bank's page: nothing more.
  const bank = { ...WIN, title: 'Chase Online Banking - Discord' };
  const h2 = createHandsServer({ label: 'x', win: WIN, window: async () => bank, requestApproval: () => ({}), waitApproval: async () => ({}) });
  const r = JSON.parse((await h2({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read', arguments: {} } })).result.content[0].text);
  assert.match(r.error, /banking|money/);
  setUiaHost(null);
  setFocusBackend(null);
});

test('the Claude Code engine: isolated arguments, progress lines from the stream, done, timeouts', async () => {
  const args = helperArgs({ mcpUrl: 'http://127.0.0.1:1/mcp/hands/abc', token: 'tok', tools: HANDS_TOOLS });
  const at = (f) => args[args.indexOf(f) + 1];
  assert.equal(at('--input-format'), 'stream-json');
  assert.equal(at('--output-format'), 'stream-json');
  assert.equal(at('--tools'), '', 'no built-in tools at all');
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.equal(at('--setting-sources'), '');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  const mcp = JSON.parse(at('--mcp-config'));
  assert.deepEqual(mcp, { mcpServers: { orbit: { type: 'http', url: 'http://127.0.0.1:1/mcp/hands/abc', headers: { Authorization: 'Bearer tok' } } } });
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--no-session-persistence'));
  assert.deepEqual(allowed, HANDS_TOOLS.map((t) => `mcp__orbit__${t}`));
  assert.equal(progressLine('mcp__orbit__act', { action: 'press', control: 'Send' }), 'pressing Send');
  assert.equal(progressLine('mcp__orbit__wait_for_approval'), 'waiting for your OK');
  assert.equal(engineFor('codex').id, 'claude-code', 'Codex is not available yet');
  assert.equal(ENGINES.codex.available, false);

  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  let got = '';
  child.stdin.on('data', (d) => (got += d));
  const events = [];
  let spawned = null;
  const run = startClaudeHelper({ task: 'mute the channel', mcpUrl: 'http://x', token: 't', tools: HANDS_TOOLS, claudePath: 'C:\\fake\\claude.exe', spawnImpl: (file, a, o) => ((spawned = { file, a, o }), child), onEvent: (e) => events.push(e) });
  assert.equal(spawned.file, 'C:\\fake\\claude.exe');
  assert.ok(spawned.o.cwd.includes('orbit-helper-'), 'its own temp folder');
  assert.equal(JSON.parse(got.trim()).message.content[0].text, "Task (the user's words): mute the channel");
  const say = (o) => child.stdout.write(`${JSON.stringify(o)}\n`);
  say({ type: 'system', subtype: 'init' });
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__orbit__act', input: { action: 'toggle', control: 'Mute' } }, { type: 'text', text: 'Muting it.' }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'I muted the channel.', total_cost_usd: 0.01 });
  await sleep(30);
  assert.deepEqual(events.map((e) => e.type), ['started', 'progress', 'done']);
  assert.equal(events[1].line, 'switching Mute');
  assert.equal(events[2].ok, true);
  assert.equal(events[2].summary, 'I muted the channel.');
  assert.equal(run.send('more'), false, 'ended: no more input');
});

test('voice task tools: the user\x27s words start and steer helpers; a yes after the question answers them', async () => {
  const WIN = W(9);
  setFocusBackend({ describe: async (h) => (h === 9 ? WIN : null), list: async () => [WIN] });
  focus.reset();
  focus.update(WIN);
  const engine = fakeEngine();
  const a = createAgents({ engine });
  let said = [];
  let notifiedAt = 0;
  const latest = () => said.at(-1) || null;
  const t = createTaskHandlers({ agents: a, recentUtterance: latest, lastNotificationAt: () => notifiedAt, isClearYes, userWords: () => said.map((s) => s.text).join(' '), wordsNotSaid });
  const say = async (text) => {
    await sleep(3);
    said.push({ text, at: Date.now() });
  };
  assert.match((await t.start_task({ task: 'archive old channels' })).error, /just asked/);
  await say('have a helper archive the old channels in discord');
  assert.match((await t.start_task({ task: 'archive old channels and delete the server' })).error, /didn't say/);
  const r = await t.start_task({ task: 'archive the old channels' });
  assert.equal(r.started, true, JSON.stringify(r));
  assert.match((await t.start_task({ task: 'archive the old channels' })).error, /already/);
  const h = a.forWindow(9);
  // Steering: their words only.
  await say('tell it to skip the general channel');
  assert.equal((await t.redirect_task({ words: 'skip the general channel' })).ok, true);
  assert.match((await t.redirect_task({ words: 'delete everything' })).error, /aren't the user's/);
  // Status.
  engine.runs[0].emit({ type: 'progress', line: 'reading the window' });
  assert.deepEqual((await t.task_status({})).last_steps, ['reading the window']);
  assert.equal((await t.list_tasks()).helpers.length, 1);
  // A held act: asked; a yes before Orbit told it doesn't count; after, it does.
  const ap = a.requestApproval(h.id, { action: 'press', node: { n: 'Archive' }, win: WIN });
  await say('yes');
  assert.match((await t.approve_task_action({ approve: true })).error, /hasn't answered/);
  a.markTold(ap.id);
  notifiedAt = Date.now();
  await say('no wait');
  assert.match((await t.approve_task_action({ approve: true })).error, /isn't a clear yes/);
  await say('yes do it');
  const ok = await t.approve_task_action({ approve: true });
  assert.equal(ok.approved, true, JSON.stringify(ok));
  assert.equal((await a.waitApproval(h.id, ap.id, 10, async () => ({ ok: true }))).state, 'approved');
  // A notification after the question: a yes may be about that.
  const ap2 = a.requestApproval(h.id, { action: 'press', node: { n: 'Archive' }, win: WIN });
  a.markTold(ap2.id, Date.now() - 5000);
  notifiedAt = Date.now();
  await say('yes');
  assert.match((await t.approve_task_action({ approve: true })).error, /something else came in/);
  // Cancel: only on stop/cancel words.
  await say('how is it going');
  assert.match((await t.cancel_task({})).error, /stop or cancel/);
  await say('stop the discord one');
  assert.equal((await t.cancel_task({})).stopped, true);
  a.dispose();
  setFocusBackend(null);
});
