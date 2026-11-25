// OS-independent tests for the TargetBackend abstraction, Claude Desktop wrapper, and T3 Code
// Lead backend (both HTTP JSON transport and direct callTool injection).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGET_BACKENDS,
  REQUIRED_BACKEND_METHODS,
  normalizeSession,
  assertTargetBackend,
  createTargetRegistry,
  createClaudeDesktopTarget,
  createT3Target,
} from '../src/targets/index.js';
import { startFakeT3 } from './e2e/fake-t3.mjs';

const waitFor = async (pred, { timeoutMs = 3000, stepMs = 15 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = pred();
    if (val) return val;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
};

// ---------------- interface.js & registry ----------------

test('interface: TARGET_BACKENDS, normalizeSession, assertTargetBackend, createTargetRegistry', () => {
  assert.deepEqual(TARGET_BACKENDS, ['auto', 'claude-desktop', 't3-code']);
  assert.ok(Object.isFrozen(TARGET_BACKENDS));

  const normalized = normalizeSession(
    {
      threadId: 'thr_42',
      title: '  Fix auth race  ',
      cwd: '/repo/orbit-voice/',
      branch: 'feat/auth',
      status: 'running',
      updatedAt: '2026-11-25T10:00:00.000Z',
      createdAt: 1700000000000,
      recentFiles: ['src/a.js', { path: 'src/b.js' }, '', null],
    },
    { backend: 't3-code' },
  );
  assert.deepEqual(Object.keys(normalized).sort(), [
    'backend',
    'branch',
    'createdAt',
    'cwd',
    'id',
    'lastActivityAt',
    'lastFocusedAt',
    'project',
    'recentFiles',
    'status',
    'title',
    'waiting',
    'working',
  ]);
  assert.equal(normalized.id, 'thr_42');
  assert.equal(normalized.title, 'Fix auth race');
  assert.equal(normalized.project, 'orbit-voice');
  assert.equal(normalized.branch, 'feat/auth');
  assert.equal(normalized.status, 'running');
  assert.equal(normalized.working, true);
  assert.equal(normalized.waiting, false);
  assert.equal(normalized.lastActivityAt, Date.parse('2026-11-25T10:00:00.000Z'));
  assert.equal(normalized.lastFocusedAt, normalized.lastActivityAt);
  assert.equal(normalized.createdAt, 1700000000000);
  assert.deepEqual(normalized.recentFiles, ['src/a.js', 'src/b.js']);
  assert.equal(normalized.backend, 't3-code');

  // Defensive defaults on empty/malformed input
  const fallback = normalizeSession(null);
  assert.equal(fallback.title, '(untitled)');
  assert.equal(fallback.status, 'idle');
  assert.equal(fallback.working, false);
  assert.equal(fallback.waiting, false);
  assert.equal(fallback.branch, null);
  assert.deepEqual(fallback.recentFiles, []);

  // assertTargetBackend rejects missing fields or methods
  assert.throws(() => assertTargetBackend(null), TypeError);
  assert.throws(() => assertTargetBackend({ id: 'x', label: 'X', capabilities: {} }), TypeError);
  const stub = { id: 'stub', label: 'Stub', capabilities: {} };
  for (const m of REQUIRED_BACKEND_METHODS) stub[m] = () => {};
  assert.equal(assertTargetBackend(stub), stub);

  // Registry registration & selection
  const reg = createTargetRegistry();
  const desktop = createClaudeDesktopTarget({ listDesktopSessions: () => [] });
  const t3 = createT3Target({ callTool: async () => ({}) });
  reg.register(desktop);
  reg.register(t3);

  assert.equal(reg.select('auto'), t3, 'auto prefers t3-code when available');
  assert.equal(reg.select('claude-desktop'), desktop);
  assert.equal(reg.select('t3-code'), t3);
  assert.equal(reg.select('unknown'), null);
  assert.equal(
    reg.select('auto', { isAvailable: (b) => b.id !== 't3-code' }),
    desktop,
    'auto falls back to next available backend',
  );
  assert.equal(reg.unregister('t3-code'), true);
  assert.equal(reg.select('auto'), desktop);
});

// ---------------- T3 Code over real HTTP transport ----------------

test('t3-code (HTTP): multi-thread switching, MRU/spoken tracking, worktree launch, queue/steer, pending requests', async (t) => {
  const fake = await startFakeT3({
    token: 'secret-token-123',
    threads: [
      {
        threadId: 'thr_alpha',
        title: 'Alpha refactor',
        projectId: 'proj_orbit',
        branch: 'feat/alpha',
        status: 'idle',
        messages: [
          { role: 'user', text: 'Check alpha tests' },
          { role: 'assistant', text: 'All 12 alpha tests pass.' },
        ],
      },
      {
        threadId: 'thr_beta',
        title: 'Beta dashboard',
        projectId: 'proj_web',
        branch: 'feat/beta',
        status: 'running',
        messages: [{ role: 'user', text: 'Build chart component' }],
      },
    ],
  });
  t.after(() => fake.close());

  let fakeNow = 1_700_000_000_000;
  const target = createT3Target({
    endpoint: fake.url,
    token: fake.token,
    pollMs: 30,
    now: () => ++fakeNow,
  });

  assert.equal(target.id, 't3-code');
  assert.deepEqual(target.capabilities, {
    multiThread: true,
    nativeQueue: true,
    steer: true,
    worktrees: true,
    draftInBox: false,
  });

  // List projects & sessions
  const projs = await target.listProjects();
  assert.equal(projs.ok, true);
  assert.equal(projs.projects.length, 2);

  const listed = await target.listSessions();
  assert.equal(listed.ok, true);
  assert.equal(listed.sessions.length, 2);
  assert.ok(listed.sessions.every((s) => s.backend === 't3-code'));

  // Search sessions
  const found = await target.searchSessions('alpha');
  assert.equal(found.ok, true);
  assert.equal(found.sessions.length, 1);
  assert.equal(found.sessions[0].id, 'thr_alpha');

  // Switch between threads and verify activeThreadId + MRU
  const sw1 = await target.switchSession('Beta dashboard');
  assert.equal(sw1.ok, true);
  assert.equal(sw1.threadId, 'thr_beta');
  assert.equal(target.activeThreadId, 'thr_beta');

  const sw2 = await target.switchSession('thr_alpha');
  assert.equal(sw2.ok, true);
  assert.equal(target.activeThreadId, 'thr_alpha');
  assert.deepEqual(target.recentInteractedIds.slice(0, 2), ['thr_alpha', 'thr_beta']);

  // noteSpoken updates lastSpokenThreadId, lastSpokenAt, and MRU
  const spoken = target.noteSpoken('thr_beta');
  assert.equal(spoken.threadId, 'thr_beta');
  assert.equal(target.lastSpokenThreadId, 'thr_beta');
  assert.equal(target.lastSpokenAt, spoken.at);
  assert.equal(target.recentInteractedIds[0], 'thr_beta');

  // Read session messages
  const read = await target.readSession('thr_alpha');
  assert.equal(read.ok, true);
  assert.equal(read.messages.length, 2);
  assert.equal(read.messages[1].text, 'All 12 alpha tests pass.');

  // Launch new thread with project name resolution + worktree + baseRef
  const launched = await target.newSession({
    title: 'Routing engine',
    project: 'orbit-voice',
    worktree: true,
    branch: 'feat/routing-engine',
    baseRef: 'origin/main',
    message: 'Implement routing rules',
  });
  assert.equal(launched.ok, true);
  assert.equal(launched.projectId, 'proj_orbit');
  assert.equal(launched.branch, 'feat/routing-engine');
  assert.ok(launched.worktreePath.includes('.worktrees'));
  assert.equal(target.activeThreadId, launched.threadId);

  const launchCall = fake.calls.find((c) => c.name === 't3_thread_launch');
  assert.deepEqual(launchCall.args.workspaceStrategy, {
    type: 'worktree',
    branch: 'feat/routing-engine',
    baseRef: 'origin/main',
    startFromOrigin: true,
  });

  // Unknown project fails cleanly without launching
  const badProj = await target.newSession({ title: 'Oops', project: 'does-not-exist' });
  assert.equal(badProj.ok, false);
  assert.equal(badProj.error, 'project_not_found');

  // Draft, clear, re-draft, send from draft
  const d1 = await target.draftPrompt('Temporary draft');
  assert.equal(d1.ok, true);
  assert.equal(d1.draftedInBox, false);
  const clr = await target.clearDraft();
  assert.deepEqual(clr, { ok: true, cleared: true });

  await target.draftPrompt('Queue this follow-up');
  const q1 = await target.sendPrompt('', { mode: 'queue' });
  assert.equal(q1.ok, true);
  assert.equal(q1.queued, true);
  assert.ok(q1.queuedRunId);

  const q2 = await target.sendPrompt('Second queued item', { mode: 'queue' });
  assert.equal(q2.ok, true);

  const queueBefore = await target.listQueue();
  assert.equal(queueBefore.ok, true);
  assert.equal(queueBefore.items.length, 2);

  // Cancel first queued item and promote second to steer
  const cancelled = await target.cancelQueued({ queuedRunId: q1.queuedRunId });
  assert.equal(cancelled.ok, true);
  const promoted = await target.promoteQueued({ queuedRunId: q2.queuedRunId });
  assert.equal(promoted.ok, true);

  const queueAfter = await target.listQueue();
  assert.equal(queueAfter.items.length, 0);

  // Direct steer & restart modes + invalid mode check
  const steered = await target.sendPrompt('Actually use strict mode', { mode: 'steer' });
  assert.equal(steered.ok, true);
  assert.equal(steered.mode, 'steer');

  const restarted = await target.sendPrompt('Start over cleanly', { mode: 'restart' });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.mode, 'restart');

  const invalidMode = await target.sendPrompt('Nope', { mode: 'bogus' });
  assert.equal(invalidMode.ok, false);
  assert.equal(invalidMode.error, 'invalid_mode');

  // Pending question flow
  const qReq = fake.simulatePendingQuestion(launched.threadId, {
    question: 'Choose a database engine',
    choices: ['SQLite', 'Postgres'],
  });
  const pending = await target.getPendingRequest({ threadId: launched.threadId });
  assert.equal(pending.ok, true);
  assert.equal(pending.pending.id, qReq.requestId);
  assert.equal(pending.pending.question, 'Choose a database engine');
  assert.equal(pending.pending.choices.length, 2);

  const answered = await target.answerPendingRequest({
    threadId: launched.threadId,
    answers: { choice: 'SQLite' },
  });
  assert.equal(answered.ok, true);
  assert.equal(answered.requestId, qReq.requestId);

  const afterAnswer = await target.getPendingRequest({ threadId: launched.threadId });
  assert.equal(afterAnswer.pending, null);

  // Interrupt active run
  const stopped = await target.interruptSession({ threadId: launched.threadId, reason: 'user asked' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
  assert.equal(fake.getThread(launched.threadId).status, 'interrupted');

  // Confirm all calls went over HTTP
  assert.ok(fake.calls.every((c) => c.via === 'http'));
});

// ---------------- Watcher events (HTTP) ----------------

test('t3-code watcher emits claude.status, claude.waiting, claude.finished, and t3.failed', async (t) => {
  const fake = await startFakeT3({
    token: 'watch-token',
    threads: [
      { threadId: 'thr_work', title: 'Worker thread', projectId: 'proj_orbit', status: 'running' },
      { threadId: 'thr_boom', title: 'Fragile thread', projectId: 'proj_orbit', status: 'running' },
    ],
  });
  t.after(() => fake.close());

  const target = createT3Target({ endpoint: fake.url, token: fake.token, pollMs: 25 });
  const watcher = target.createWatcher();
  const events = [];
  watcher.on((evt) => events.push(evt));
  watcher.start();
  t.after(() => watcher.stop());

  // Initial working status
  const status1 = await waitFor(() => events.find((e) => e.type === 'claude.status' && e.working.length === 2));
  assert.ok(status1, 'should emit initial claude.status with 2 working threads');
  assert.equal(watcher.working().length, 2);

  // Pending question -> claude.waiting
  const req = fake.simulatePendingQuestion('thr_work', { question: 'Deploy to staging?' });
  const waitingEvt = await waitFor(() => events.find((e) => e.type === 'claude.waiting' && e.id === 'thr_work'));
  assert.ok(waitingEvt, 'should emit claude.waiting');
  assert.equal(waitingEvt.kind, 'question');
  assert.equal(waitingEvt.requestId, req.requestId);
  assert.equal(waitingEvt.toolId, req.requestId);

  // Answer then finish -> claude.finished with summary
  await target.answerPendingRequest({ threadId: 'thr_work', requestId: req.requestId, answers: { choice: 'yes' } });
  fake.simulateFinish('thr_work', { text: 'Deployed cleanly to staging.' });
  const finishedEvt = await waitFor(() => events.find((e) => e.type === 'claude.finished' && e.id === 'thr_work'));
  assert.ok(finishedEvt, 'should emit claude.finished');
  assert.equal(finishedEvt.title, 'Worker thread');
  assert.equal(finishedEvt.summary, 'Deployed cleanly to staging.');

  // Fail second thread -> t3.failed + claude.status drops to 0 working
  fake.simulateFail('thr_boom', { error: 'Provider connection dropped' });
  const failedEvt = await waitFor(() => events.find((e) => e.type === 't3.failed' && e.id === 'thr_boom'));
  assert.ok(failedEvt, 'should emit t3.failed');
  assert.equal(failedEvt.error, 'Provider connection dropped');

  const idleStatus = await waitFor(() => events.find((e) => e.type === 'claude.status' && e.working.length === 0));
  assert.ok(idleStatus, 'should emit empty working status when all threads settle');
  assert.equal(watcher.working().length, 0);

  // Verify waiting / finished / failed were not emitted multiple times across subsequent polls
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(events.filter((e) => e.type === 'claude.waiting' && e.id === 'thr_work').length, 1);
  assert.equal(events.filter((e) => e.type === 'claude.finished' && e.id === 'thr_work').length, 1);
  assert.equal(events.filter((e) => e.type === 't3.failed' && e.id === 'thr_boom').length, 1);
});

// ---------------- Auth rejection, loopback guard, timeout ----------------

test('t3-code HTTP security: Bearer auth rejection, loopback enforcement, and timeout', async (t) => {
  const fake = await startFakeT3({ token: 'expected-bearer-token' });
  t.after(() => fake.close());

  // Wrong token -> 401 unauthorized
  const wrongToken = createT3Target({ endpoint: fake.url, token: 'wrong-token' });
  const r1 = await wrongToken.listSessions();
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'unauthorized');
  assert.equal(r1.status, 401);

  // Missing token -> 401 unauthorized
  const noToken = createT3Target({ endpoint: fake.url, token: '' });
  const r2 = await noToken.listProjects();
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'unauthorized');

  // Remote endpoint refused by default without invoking fetch
  let fetchCalled = false;
  const remoteBlocked = createT3Target({
    endpoint: 'https://t3.example.com',
    token: 'tok',
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('should not be called');
    },
  });
  const r3 = await remoteBlocked.listSessions();
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'remote_endpoint_disallowed');
  assert.equal(fetchCalled, false);

  // Remote endpoint allowed when allowRemote: true
  const remoteAllowed = createT3Target({
    endpoint: 'https://t3.example.com',
    token: 'tok',
    allowRemote: true,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://t3.example.com/mcp/call');
      assert.equal(init.headers.authorization, 'Bearer tok');
      return new Response(JSON.stringify({ ok: true, result: { projects: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const r4 = await remoteAllowed.listProjects();
  assert.equal(r4.ok, true);
  assert.deepEqual(r4.projects, []);

  // Request timeout surfaces error: 'timeout'
  const slowTarget = createT3Target({
    endpoint: 'http://127.0.0.1:9999',
    timeoutMs: 500,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  });
  const r5 = await slowTarget.listSessions();
  assert.equal(r5.ok, false);
  assert.equal(r5.error, 'timeout');
});

// ---------------- Direct callTool transport ----------------

test('t3-code (direct callTool): works without HTTP and handles exceptions cleanly', async (t) => {
  const fake = await startFakeT3({
    threads: [{ threadId: 'thr_direct', title: 'Direct thread', projectId: 'proj_orbit', status: 'idle' }],
  });
  t.after(() => fake.close());

  const target = createT3Target({ callTool: fake.callTool });
  const active = await target.getActiveSession();
  assert.equal(active.ok, true);
  assert.equal(active.session.id, 'thr_direct');

  const sent = await target.sendPrompt('Run unit tests', { threadId: 'thr_direct' });
  assert.equal(sent.ok, true);
  assert.equal(fake.getThread('thr_direct').status, 'running');
  assert.ok(fake.calls.every((c) => c.via === 'direct'));

  // Exception in direct callTool is caught cleanly
  const throwing = createT3Target({
    callTool: async () => {
      throw new Error('boom');
    },
  });
  const res = await throwing.listSessions();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'tool_exception');
});

// ---------------- Claude Desktop TargetBackend contract compliance ----------------

test('claude-desktop: TargetBackend contract compliance and DI delegation', async () => {
  const sampleSession = {
    id: 'local_abc123',
    cliSessionId: 'cli-abc123',
    title: 'Fix login bug',
    cwd: '/Users/dev/orbit-voice',
    project: 'orbit-voice',
    branch: 'main',
    createdAt: 1700000000000,
    lastActivityAt: 1700000500000,
    lastFocusedAt: 1700000600000,
  };

  const calls = [];
  const fakeWatcher = {
    start() {},
    stop() {},
    on() {
      return () => {};
    },
    working: () => [],
  };

  const desktop = createClaudeDesktopTarget({
    listDesktopSessions: () => [sampleSession],
    findSessionByTitle: (title) => (title === sampleSession.title ? sampleSession : null),
    resolveSession: () => sampleSession,
    findTranscript: () => '/fake/transcript.jsonl',
    readTranscriptTail: () => ({
      state: 'idle (finished its last reply)',
      turns: [
        { role: 'user', text: 'Check login', at: '2026-11-25T10:00:00Z' },
        { role: 'claude', text: 'Fixed the token check.', at: '2026-11-25T10:00:05Z' },
      ],
      lastKind: 'assistant_text',
      lastTool: null,
    }),
    getDesktopInfo: async () => ({ ok: true, sessionTitle: 'Fix login bug', promptText: '' }),
    switchSession: async (title) => {
      calls.push(['switch', title]);
      return { ok: true, sessionTitle: title };
    },
    newSession: async ({ project }) => {
      calls.push(['new', project]);
      return { ok: true, folder: project || 'orbit-voice' };
    },
    fillDesktop: async (text, opts) => {
      calls.push(['fill', text, opts]);
      return { ok: true, sessionTitle: 'Fix login bug' };
    },
    sendToDesktop: async (text, opts) => {
      calls.push(['send', text, opts]);
      return { ok: true, sessionTitle: 'Fix login bug' };
    },
    clearDesktop: async (text, opts) => {
      calls.push(['clear', text, opts]);
      return { ok: true };
    },
    stopClaude: async (opts) => {
      calls.push(['stop', opts]);
      return { ok: true, stopped: true, confirmed: true };
    },
    getPendingPrompt: async () => ({
      ok: true,
      sessionTitle: 'Fix login bug',
      pending: { kind: 'permission', key: 'perm_1', title: 'Run tests?', options: [{ id: 'allow_once', label: 'Allow' }] },
    }),
    answerPrompt: async (args) => {
      calls.push(['answer', args]);
      return { ok: true };
    },
    claudeApp: async () => ({ ok: true, folders: ['orbit-voice', 'other-app'] }),
    createSessionWatcher: () => fakeWatcher,
  });

  assertTargetBackend(desktop);
  assert.equal(desktop.id, 'claude-desktop');
  assert.deepEqual(desktop.capabilities, {
    multiThread: false,
    nativeQueue: false,
    steer: false,
    worktrees: false,
    draftInBox: true,
  });

  const listed = await desktop.listSessions();
  assert.equal(listed.ok, true);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].backend, 'claude-desktop');

  const active = await desktop.getActiveSession();
  assert.equal(active.ok, true);
  assert.equal(active.session.id, 'local_abc123');

  const read = await desktop.readSession('local_abc123');
  assert.equal(read.ok, true);
  assert.equal(read.messages.length, 2);
  assert.equal(read.messages[1].text, 'Fixed the token check.');

  const sw = await desktop.switchSession('local_abc123');
  assert.equal(sw.ok, true);
  assert.equal(sw.sessionTitle, 'Fix login bug');

  const nw = await desktop.newSession({ project: 'orbit-voice' });
  assert.equal(nw.ok, true);
  assert.equal(nw.newSession, true);

  const dr = await desktop.draftPrompt('Run npm test');
  assert.equal(dr.ok, true);
  assert.equal(dr.draftedInBox, true);

  const clr = await desktop.clearDraft();
  assert.deepEqual(clr, { ok: true, cleared: true });

  await desktop.draftPrompt('Run npm test now');
  const sent = await desktop.sendPrompt('');
  assert.equal(sent.ok, true);
  assert.equal(sent.sent, true);

  const stopped = await desktop.interruptSession();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);

  const pending = await desktop.getPendingRequest();
  assert.equal(pending.ok, true);
  assert.equal(pending.pending.key, 'perm_1');

  const ans = await desktop.answerPendingRequest({ key: 'perm_1', choice: 'allow_once' });
  assert.equal(ans.ok, true);

  const projects = await desktop.listProjects();
  assert.equal(projects.ok, true);
  assert.ok(projects.projects.some((p) => p.name === 'orbit-voice'));

  assert.equal(desktop.createWatcher(), fakeWatcher);
  assert.ok(calls.some((c) => c[0] === 'send' && c[2].filled === true));
});
