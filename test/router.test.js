// OS-independent test suite for src/router/ (context, ranker, drift, queue, barrel index).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as router from '../src/router/index.js';
import {
  extractRecentFiles,
  readRecentCommits,
  harvestSessionContext,
} from '../src/router/context.js';
import {
  DEFAULT_WEIGHTS,
  isBareFollowUp,
  looksLikeNewWork,
  extractMentionedFiles,
  rankCandidates,
} from '../src/router/ranker.js';
import {
  DEFAULT_DRIFT_THRESHOLD,
  checkTopicDrift,
} from '../src/router/drift.js';
import { createPromptQueue } from '../src/router/queue.js';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-router-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Barrel exports
// ---------------------------------------------------------------------------

test('src/router/index.js exports all public APIs', () => {
  const expected = [
    'extractRecentFiles',
    'readRecentCommits',
    'harvestSessionContext',
    'DEFAULT_WEIGHTS',
    'isBareFollowUp',
    'looksLikeNewWork',
    'extractMentionedFiles',
    'rankCandidates',
    'DEFAULT_DRIFT_THRESHOLD',
    'checkTopicDrift',
    'createPromptQueue',
  ];
  for (const name of expected) {
    assert.ok(name in router, `missing export ${name}`);
  }
});

// ---------------------------------------------------------------------------
// context.js
// ---------------------------------------------------------------------------

test('extractRecentFiles reads tool_use inputs newest-first, deduplicates, and ignores noise', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/old.js' } },
            { type: 'tool_use', name: 'Grep', input: { path: 'src\\router\\ranker.js', pattern: '**/*' } },
          ],
        },
      }),
      // Sidechain must be ignored.
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/sidechain-only.js' } }],
        },
      }),
      'not valid json {{{',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { target_file: 'src/auth/login.ts' } },
            { type: 'tool_use', name: 'Glob', input: { pattern: 'test/**/router.test.js' } },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'node --test test/queue.test.js && curl https://example.com/index.html -o /dev/null' },
            },
            // Re-touch old.js so it becomes newest.
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/old.js' } },
          ],
        },
      }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const files = extractRecentFiles(file, { maxFiles: 8 });
    assert.equal(files[0], '/repo/src/old.js');
    assert.ok(files.includes('test/queue.test.js'));
    assert.ok(files.includes('test/router.test.js'));
    assert.ok(files.includes('src/auth/login.ts'));
    assert.ok(files.includes('src/router/ranker.js'));
    assert.ok(!files.includes('src/sidechain-only.js'));
    assert.ok(!files.some((f) => f.includes('example.com')));
    // Deduplicated: /repo/src/old.js appears only once.
    assert.equal(files.filter((f) => f === '/repo/src/old.js').length, 1);

    // Respects maxFiles.
    assert.equal(extractRecentFiles(file, { maxFiles: 2 }).length, 2);
    assert.deepEqual(extractRecentFiles(file, { maxFiles: 0 }), []);
  });
});

test('extractRecentFiles reads only tail when file exceeds maxBytes and handles missing files', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'big.jsonl');
    const filler = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/early.js' } }] },
    });
    const padding = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2048) } });
    const latest = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/latest.ts' } }] },
    });
    fs.writeFileSync(file, [filler, padding, padding, latest].join('\n') + '\n', 'utf8');

    const tailFiles = extractRecentFiles(file, { maxBytes: 1024 });
    assert.deepEqual(tailFiles, ['src/latest.ts']);
  });

  assert.deepEqual(extractRecentFiles('/nonexistent/path/transcript.jsonl'), []);
  assert.deepEqual(extractRecentFiles(null), []);
  assert.deepEqual(extractRecentFiles(''), []);
});

test('readRecentCommits invokes git safely with 1500ms timeout and returns [] on failure', () => {
  const calls = [];
  const fakeExec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return 'feat: add smart router\nfix: debounce watcher\nchore: bump deps\n';
  };

  const commits = readRecentCommits('/fake/repo', { limit: 2, execImpl: fakeExec });
  assert.deepEqual(commits, ['feat: add smart router', 'fix: debounce watcher']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, ['log', '-n', '2', '--pretty=%s']);
  assert.equal(calls[0].opts.timeout, 1500);
  assert.equal(calls[0].opts.cwd, '/fake/repo');
  assert.equal(calls[0].opts.shell, undefined);

  const failingExec = () => {
    throw new Error('not a git repo');
  };
  assert.deepEqual(readRecentCommits('/not/a/repo', { execImpl: failingExec }), []);
  assert.deepEqual(readRecentCommits('', { execImpl: fakeExec }), []);
  assert.deepEqual(readRecentCommits('/fake/repo', { limit: 0, execImpl: fakeExec }), []);
});

test('harvestSessionContext normalizes Claude Desktop sessions and T3 Code threads', () => {
  withTempDir((dir) => {
    const tf = path.join(dir, 'cli.jsonl');
    fs.writeFileSync(
      tf,
      [
        JSON.stringify({ type: 'user', message: { content: '<system-reminder>noise</system-reminder>Fix the OAuth callback bug' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth/oauth.js' } },
              { type: 'text', text: 'Updated OAuth callback validation.' },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const claudeSession = {
      id: 'local_123',
      cliSessionId: 'cli_abc',
      title: 'OAuth callback fix',
      cwd: '/Users/dev/repos/webapp',
      project: 'webapp',
      branch: 'fix/oauth',
      lastFocusedAt: 1700000002000,
      lastActivityAt: 1700000005000,
    };

    const normClaude = harvestSessionContext(claudeSession, {
      includeGit: true,
      transcriptFile: tf,
      execImpl: () => 'fix: oauth redirect\n',
    });

    assert.equal(normClaude.id, 'local_123');
    assert.equal(normClaude.title, 'OAuth callback fix');
    assert.equal(normClaude.project, 'webapp');
    assert.equal(normClaude.cwd, '/Users/dev/repos/webapp');
    assert.equal(normClaude.branch, 'fix/oauth');
    assert.equal(normClaude.status, 'idle');
    assert.equal(normClaude.waiting, false);
    assert.equal(normClaude.lastFocusedAt, 1700000002000);
    assert.equal(normClaude.lastActivityAt, 1700000005000);
    assert.deepEqual(normClaude.recentFiles, ['src/auth/oauth.js']);
    assert.deepEqual(normClaude.lastMessages, ['Fix the OAuth callback bug', 'Updated OAuth callback validation.']);
    assert.deepEqual(normClaude.recentCommits, ['fix: oauth redirect']);

    // T3 Code thread shape with Windows path, ISO timestamp, and pending request.
    const t3Thread = {
      threadId: 'thr_999',
      title: 'Stripe webhook retries',
      worktreePath: 'C:\\code\\payments-api',
      gitBranch: 'feat/webhooks',
      status: 'running',
      hasPendingRequest: true,
      updatedAt: '2026-11-24T12:00:00.000Z',
      messages: [
        { role: 'user', content: 'Add exponential backoff for webhook delivery' },
        { role: 'assistant', text: 'Should I use Redis or Postgres for the retry queue?' },
      ],
      files: ['src/webhooks/retry.ts'],
    };

    const normT3 = harvestSessionContext(t3Thread, { includeGit: false });
    assert.equal(normT3.id, 'thr_999');
    assert.equal(normT3.title, 'Stripe webhook retries');
    assert.equal(normT3.project, 'payments-api');
    assert.equal(normT3.cwd, 'C:\\code\\payments-api');
    assert.equal(normT3.branch, 'feat/webhooks');
    assert.equal(normT3.status, 'waiting');
    assert.equal(normT3.waiting, true);
    assert.equal(normT3.lastActivityAt, Date.parse('2026-11-24T12:00:00.000Z'));
    assert.equal(normT3.lastFocusedAt, 0);
    assert.deepEqual(normT3.recentFiles, ['src/webhooks/retry.ts']);
    assert.equal(normT3.lastMessages.length, 2);
    assert.deepEqual(normT3.recentCommits, []);

    // Defensive null handling.
    const empty = harvestSessionContext(null);
    assert.equal(empty.title, '(untitled)');
    assert.deepEqual(empty.recentFiles, []);
    assert.deepEqual(empty.lastMessages, []);
    assert.deepEqual(empty.recentCommits, []);
  });
});

// ---------------------------------------------------------------------------
// ranker.js
// ---------------------------------------------------------------------------

test('DEFAULT_WEIGHTS defines all SP3 attention weight keys', () => {
  const keys = [
    'titleMatch',
    'projectMatch',
    'fileMatch',
    'messageOverlap',
    'typed0',
    'typed1',
    'typed2',
    'typedAgeDecay',
    'spokeRecent',
    'waitingBonus',
    'noneBias',
    'noneNewish',
    'noneWords',
  ];
  for (const k of keys) {
    assert.equal(typeof DEFAULT_WEIGHTS[k], 'number', `weight ${k} should be a number`);
    assert.ok(Number.isFinite(DEFAULT_WEIGHTS[k]) && DEFAULT_WEIGHTS[k] > 0, `weight ${k} should be positive`);
  }
});

test('isBareFollowUp, looksLikeNewWork, and extractMentionedFiles heuristics', () => {
  for (const q of ['yes', 'go ahead', 'option two', 'allow it', 'run the tests', 'commit that', 'try again', 'sounds good']) {
    assert.equal(isBareFollowUp(q), true, `expected bare follow-up: ${q}`);
  }
  for (const q of [
    '',
    'fix the bug in billing.ts',
    'start a new project for billing',
    'refactor the payments webhook handler to support idempotency keys and backoff retries',
  ]) {
    assert.equal(isBareFollowUp(q), false, `expected NOT bare follow-up: ${q}`);
  }

  for (const q of [
    'start a new project for an expense tracker',
    'open a fresh session to investigate latency',
    'let us build a brand new CLI tool from scratch',
    'unrelated topic: help me plan a database schema',
    'scaffold a new service for notifications',
  ]) {
    assert.equal(looksLikeNewWork(q), true, `expected looksLikeNewWork: ${q}`);
  }
  for (const q of ['add a new button to the login form', 'write a new test for ranker.js', 'fix the CSS alignment']) {
    assert.equal(looksLikeNewWork(q), false, `expected NOT looksLikeNewWork: ${q}`);
  }

  assert.deepEqual(extractMentionedFiles('fix the crash in src/router/ranker.js and test/router.test.js'), [
    'src/router/ranker.js',
    'test/router.test.js',
  ]);
  assert.ok(extractMentionedFiles('check server dot js and package dot json').includes('server.js'));
  assert.ok(extractMentionedFiles('check server dot js and package dot json').includes('package.json'));
  assert.deepEqual(extractMentionedFiles('upgrade Node.js to v22.1.0 and read https://example.com/docs.html'), []);
});

test('rankCandidates routes by file, project, recency, spoken, waiting, new-work, and detects ambiguity', () => {
  const now = 1_700_000_000_000;
  const ctxWeb = harvestSessionContext({
    id: 's_web',
    title: 'Fix login redirect',
    project: 'webapp',
    branch: 'fix/login',
    lastFocusedAt: now - 60_000,
    lastActivityAt: now - 60_000,
    recentFiles: ['src/auth/login.tsx', 'src/routes/callback.ts'],
    lastMessages: ['The OAuth redirect loses the returnTo query parameter'],
  });
  const ctxPay = harvestSessionContext({
    id: 's_pay',
    title: 'Stripe webhook retries',
    project: 'payments-api',
    branch: 'feat/webhooks',
    waiting: true,
    lastFocusedAt: now - 15 * 60_000,
    lastActivityAt: now - 10 * 60_000,
    recentFiles: ['src/billing.ts', 'src/webhooks/retry.ts'],
    lastMessages: ['Should I use option one Redis or option two Postgres for retry storage?'],
  });
  const ctxCli = harvestSessionContext({
    id: 's_cli',
    title: 'CSV export formatter',
    project: 'data-cli',
    lastFocusedAt: now - 120 * 60_000,
    lastActivityAt: now - 120 * 60_000,
    recentFiles: ['cmd/export.go'],
    lastMessages: ['Escaping commas inside quoted CSV cells'],
  });
  const contexts = [ctxWeb, ctxPay, ctxCli];

  // 1. Explicit file mention beats active session.
  const byFile = rankCandidates('fix the null check in billing.ts', contexts, {
    activeId: 's_web',
    now,
  });
  assert.equal(byFile.best?.id, 's_pay');
  assert.equal(byFile.suggestNew, false);
  assert.ok(byFile.reasons.includes('fileMatch'));

  // 2. Explicit project mention beats active session.
  const byProj = rankCandidates('in data-cli add a flag for tab-delimited output', contexts, {
    activeId: 's_web',
    now,
  });
  assert.equal(byProj.best?.id, 's_cli');
  assert.ok(byProj.reasons.includes('projectMatch'));

  // 3. Bare follow-up with waiting + recently spoken routes to waiting spoken session.
  const byWaiting = rankCandidates('go with option two', contexts, {
    activeId: 's_web',
    lastSpokenId: 's_pay',
    lastSpokenAt: now - 20_000,
    now,
  });
  assert.equal(byWaiting.best?.id, 's_pay');
  assert.equal(byWaiting.suggestNew, false);
  assert.ok(byWaiting.reasons.includes('waitingForInput'));
  assert.ok(byWaiting.reasons.includes('recentlySpoken'));

  // 4. Bare follow-up with no waiting/spoken routes to active session.
  const idleContexts = contexts.map((c) => ({ ...c, waiting: false, status: 'idle' }));
  const byActive = rankCandidates('yes, go ahead', idleContexts, {
    activeId: 's_web',
    recentInteractedIds: ['s_web', 's_pay', 's_cli'],
    now,
  });
  assert.equal(byActive.best?.id, 's_web');
  assert.equal(byActive.suggestNew, false);

  // 5. Explicit new work routes to synthetic `none` (`suggestNew: true`).
  const newWork = rankCandidates('start a new project from scratch for an invoice generator app', idleContexts, {
    activeId: 's_web',
    now,
  });
  assert.equal(newWork.best, null);
  assert.equal(newWork.suggestNew, true);
  assert.ok(newWork.reasons.includes('newWorkSignal'));

  // 6. Stale sessions decay over time so unrelated work suggests new session.
  const staleNow = now + 5 * 60 * 60_000;
  const staleRes = rankCandidates('write a kubernetes helm chart for a redis sentinel cluster', idleContexts, {
    activeId: 's_web',
    now: staleNow,
  });
  assert.equal(staleRes.suggestNew, true);
  assert.equal(staleRes.best, null);

  // 7. Ambiguous tie between two nearly identical sessions.
  const a1 = harvestSessionContext({ id: 'a1', title: 'Fix API tests', project: 'backend', lastFocusedAt: now - 60_000 });
  const a2 = harvestSessionContext({ id: 'a2', title: 'Fix UI tests', project: 'frontend', lastFocusedAt: now - 60_000 });
  const ambig = rankCandidates('fix the tests', [a1, a2], { recentInteractedIds: [], now });
  assert.equal(ambig.ambiguous, true);
  assert.ok(ambig.margin < 0.65);

  // 8. Empty contexts and empty query edge cases.
  const noCtx = rankCandidates('fix login', [], { now });
  assert.equal(noCtx.best, null);
  assert.equal(noCtx.suggestNew, true);

  const emptyQ = rankCandidates('   ', idleContexts, { activeId: 's_web', now });
  assert.equal(emptyQ.best?.id, 's_web');
});

// ---------------------------------------------------------------------------
// drift.js
// ---------------------------------------------------------------------------

test('checkTopicDrift detects explicit drift, stays silent on follow-ups, and uses extractSubject on >=25 words', async () => {
  assert.equal(DEFAULT_DRIFT_THRESHOLD, 0.8);

  const active = harvestSessionContext({
    id: 's_orbit',
    title: 'Voice watcher debounce',
    project: 'orbit-voice',
    recentFiles: ['src/watcher.js', 'src/router/ranker.js'],
    lastMessages: ['Debounce Claude status transitions by 400ms'],
  });
  const other = harvestSessionContext({
    id: 's_pay',
    title: 'Stripe webhook retries',
    project: 'payments-api',
    recentFiles: ['src/billing.ts', 'src/webhooks/retry.ts'],
    lastMessages: ['Retry failed Stripe webhooks with backoff'],
  });

  // Bare follow-up never drifts.
  const followUp = await checkTopicDrift({
    prompt: 'go ahead and run the tests',
    activeContext: active,
    otherContexts: [other],
  });
  assert.equal(followUp.drifted, false);
  assert.equal(followUp.warning, null);

  // Explicit other-session file mention triggers drift.
  const fileDrift = await checkTopicDrift({
    prompt: 'update the retry delay inside billing.ts',
    activeContext: active,
    otherContexts: [other],
  });
  assert.equal(fileDrift.drifted, true);
  assert.ok(fileDrift.confidence >= DEFAULT_DRIFT_THRESHOLD);
  assert.equal(fileDrift.suggestedSession?.id, 's_pay');
  assert.equal(fileDrift.suggestNew, false);
  assert.ok(typeof fileDrift.warning === 'string' && fileDrift.warning.length > 0);

  // Explicit other-project mention triggers drift.
  const projDrift = await checkTopicDrift({
    prompt: 'in payments-api add idempotency key validation',
    activeContext: active,
    otherContexts: [other],
  });
  assert.equal(projDrift.drifted, true);
  assert.equal(projDrift.suggestedSession?.id, 's_pay');

  // Explicit new work triggers drift with suggestNew: true.
  const newDrift = await checkTopicDrift({
    prompt: 'start a brand new project from scratch for a podcast RSS downloader',
    activeContext: active,
    otherContexts: [other],
  });
  assert.equal(newDrift.drifted, true);
  assert.equal(newDrift.suggestNew, true);
  assert.equal(newDrift.suggestedSession, null);

  // Short prompt (< 25 words) does NOT call extractSubject.
  let calledShort = false;
  await checkTopicDrift({
    prompt: 'tweak the debounce window in watcher.js',
    activeContext: active,
    otherContexts: [other],
    extractSubject: async () => {
      calledShort = true;
      return 'payments-api';
    },
  });
  assert.equal(calledShort, false);

  // Long prompt (>= 25 words) with incidental mention of payments-api calls extractSubject and does NOT drift.
  const longIncidental =
    'Update the debounce logic in orbit-voice watcher so rapid status flickers do not interrupt speech. ' +
    'Remember last week in payments-api we noticed a 400ms cooldown felt much smoother, so let us apply a similar cooldown window here and add unit tests.';
  assert.ok(longIncidental.split(/\s+/).length >= 25);

  let calledLong = false;
  const noIncidentalDrift = await checkTopicDrift({
    prompt: longIncidental,
    activeContext: active,
    otherContexts: [other],
    extractSubject: async () => {
      calledLong = true;
      return 'Update debounce logic in orbit-voice watcher with a 400ms cooldown and unit tests';
    },
  });
  assert.equal(calledLong, true);
  assert.equal(noIncidentalDrift.drifted, false);

  // Long prompt whose extracted subject IS the other project DOES drift.
  const longTrueDrift = await checkTopicDrift({
    prompt:
      'Before we wrap up today I remembered something urgent we need to ship right away because customers are seeing duplicate charges when webhooks retry twice in payments-api billing.ts and we must patch it now.',
    activeContext: active,
    otherContexts: [other],
    extractSubject: async () => 'Patch duplicate webhook charge bug in payments-api billing.ts',
  });
  assert.equal(longTrueDrift.drifted, true);
  assert.equal(longTrueDrift.suggestedSession?.id, 's_pay');

  // Timeout & error resilience in extractSubject.
  const timedOut = await checkTopicDrift({
    prompt: longIncidental,
    activeContext: active,
    otherContexts: [other],
    subjectTimeoutMs: 20,
    extractSubject: () => new Promise((resolve) => setTimeout(() => resolve('payments-api'), 500)),
  });
  assert.equal(timedOut.drifted, false);

  const errored = await checkTopicDrift({
    prompt: longIncidental,
    activeContext: active,
    otherContexts: [other],
    extractSubject: async () => {
      throw new Error('model unavailable');
    },
  });
  assert.equal(errored.drifted, false);
});

// ---------------------------------------------------------------------------
// queue.js
// ---------------------------------------------------------------------------

test('createPromptQueue enforces FIFO, cap, TTL expiry, and NEVER releases when working or waiting', () => {
  let t = 1_000_000;
  const q = createPromptQueue({ maxPerSession: 2, maxAgeMs: 60_000, now: () => t });

  const e1 = q.enqueue('s1', 'run unit tests', { source: 'voice' });
  const e2 = q.enqueue('s1', 'update changelog');
  const e3 = q.enqueue('s1', 'third should be rejected');
  assert.equal(e1.ok, true);
  assert.equal(e1.position, 1);
  assert.equal(e2.ok, true);
  assert.equal(e2.position, 2);
  assert.equal(e3.ok, false);
  assert.equal(e3.error, 'queue_full');

  // Invalid inputs rejected cleanly.
  assert.equal(q.enqueue('', 'hello').ok, false);
  assert.equal(q.enqueue('s1', '   ').ok, false);

  // CRITICAL: Never release while working === true OR waiting === true.
  assert.equal(q.takeNextIfReady('s1', { working: true, waiting: false }), null);
  assert.equal(q.takeNextIfReady('s1', { working: false, waiting: true }), null);
  assert.equal(q.takeNextIfReady('s1', { working: true, waiting: true }), null);
  assert.equal(q.list('s1').length, 2);
  assert.equal(q.peek('s1')?.prompt, 'run unit tests');

  // Releases FIFO only when both working === false AND waiting === false.
  const first = q.takeNextIfReady('s1', { working: false, waiting: false });
  assert.equal(first?.id, e1.id);
  assert.equal(first?.prompt, 'run unit tests');
  assert.deepEqual(first?.meta, { source: 'voice' });
  assert.equal(q.list('s1').length, 1);

  // Expiry after maxAgeMs.
  t += 60_000;
  assert.equal(q.peek('s1'), null);
  assert.equal(q.takeNextIfReady('s1', { working: false, waiting: false }), null);
  assert.deepEqual(q.list('s1'), []);

  // Cancel by item id, by (sessionId, itemId), by sessionId, and clearAll.
  const a = q.enqueue('s1', 'prompt A');
  const b = q.enqueue('s1', 'prompt B');
  const c = q.enqueue('s2', 'prompt C');
  assert.equal(q.list().length, 3);

  const c1 = q.cancel(a.id);
  assert.equal(c1.ok, true);
  assert.equal(c1.count, 1);
  assert.equal(q.peek('s1')?.id, b.id);

  const c2 = q.cancel('s1', b.id);
  assert.equal(c2.ok, true);
  assert.equal(q.list('s1').length, 0);

  q.enqueue('s2', 'prompt D');
  const cleared = q.clearAll();
  assert.equal(cleared.cleared, 2);
  assert.deepEqual(q.list(), []);
  assert.equal(q.cancel(c.id).ok, false);
});
