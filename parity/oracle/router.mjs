// The engine oracle's SP3 routing cases (parity/oracle/gen.mjs): deterministic fixtures for
// src/router/ranker.js (rankCandidates + heuristics), src/router/drift.js (checkTopicDrift), and
// src/router/queue.js (createPromptQueue, including the working/waiting hard block). OS-independent
// so Swift Router.swift and JS src/router/ can be verified against identical fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const pick = (r, list) => list[Math.floor(r() * list.length)];
const round4 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(4)) : n);

const T0 = 1_700_000_000_000;

function roundBreakdown(b) {
  if (!b || typeof b !== 'object') return {};
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, round4(v)]));
}

export function normalizeRankResult(res) {
  return plain({
    bestId: res.best?.id ?? null,
    runnerUpId: res.runnerUp?.id ?? null,
    score: res.score,
    margin: res.margin,
    confidence: res.confidence,
    ambiguous: res.ambiguous,
    suggestNew: res.suggestNew,
    reasons: res.reasons,
    candidates: (res.candidates || []).map((c) => ({
      id: c.id,
      isNone: Boolean(c.isNone),
      score: c.score,
      probability: c.probability,
      reasons: c.reasons,
      breakdown: roundBreakdown(c.breakdown),
    })),
  });
}

export function normalizeDriftResult(res) {
  return plain({
    drifted: Boolean(res.drifted),
    confidence: res.confidence,
    reason: res.reason ?? null,
    suggestedSessionId: res.suggestedSession?.id ?? null,
    suggestNew: Boolean(res.suggestNew),
    warning: res.warning ?? null,
  });
}

const HEURISTIC_TEXTS = [
  '',
  '   ',
  'yes',
  'yeah, go ahead',
  'go with option two',
  'allow it',
  'run the tests',
  'commit that',
  'sounds good',
  'fix the bug in billing.ts',
  'check src/router/ranker.js and test/router.test.js',
  'check server dot js and package dot json',
  'update Dockerfile and Makefile',
  'upgrade Node.js to v22.1.0 and read https://example.com/docs.html',
  'start a new project for an expense tracker',
  'open a fresh session to investigate latency',
  'let us build a brand new CLI tool from scratch',
  'unrelated topic: help me plan a database schema',
  'scaffold a new service for notifications',
  'add a new button to the login form',
  'write a new test for ranker.js',
  'refactor camelCaseParser and snake_case_helper in HTTPServer',
];

function buildBaseContexts(harvestSessionContext) {
  return {
    web: harvestSessionContext({
      id: 's_web',
      title: 'Fix login redirect',
      project: 'webapp',
      cwd: '/repo/webapp',
      branch: 'fix/login',
      status: 'idle',
      waiting: false,
      lastFocusedAt: T0 - 60_000,
      lastActivityAt: T0 - 60_000,
      recentFiles: ['src/auth/login.tsx', 'src/routes/callback.ts'],
      lastMessages: ['The OAuth redirect loses the returnTo query parameter'],
      recentCommits: ['fix: preserve returnTo query parameter'],
    }),
    pay: harvestSessionContext({
      id: 's_pay',
      title: 'Stripe webhook retries',
      project: 'payments-api',
      cwd: '/repo/payments-api',
      branch: 'feat/webhooks',
      status: 'idle',
      waiting: false,
      lastFocusedAt: T0 - 15 * 60_000,
      lastActivityAt: T0 - 10 * 60_000,
      recentFiles: ['src/billing.ts', 'src/webhooks/retry.ts'],
      lastMessages: ['Should I use option one Redis or option two Postgres for retry storage?'],
      recentCommits: ['feat: exponential backoff for webhook delivery'],
    }),
    cli: harvestSessionContext({
      id: 's_cli',
      title: 'CSV export formatter',
      project: 'data-cli',
      cwd: '/repo/data-cli',
      branch: 'feat/csv-quotes',
      status: 'idle',
      waiting: false,
      lastFocusedAt: T0 - 120 * 60_000,
      lastActivityAt: T0 - 120 * 60_000,
      recentFiles: ['cmd/export.go'],
      lastMessages: ['Escaping commas inside quoted CSV cells'],
      recentCommits: ['fix: quote escaping in CSV writer'],
    }),
    t3Docs: harvestSessionContext({
      threadId: 'thr_docs',
      title: 'API reference migration',
      project: 'developer-docs',
      worktreePath: '/repo/developer-docs',
      gitBranch: 'chore/openapi-v3',
      status: 'idle',
      waiting: false,
      updatedAt: new Date(T0 - 45 * 60_000).toISOString(),
      recentFiles: ['openapi/spec.yaml', 'docs/authentication.mdx'],
      lastMessages: ['Generated OpenAPI 3.1 examples for OAuth endpoints'],
    }),
  };
}

function buildQueueScenarios(createPromptQueue) {
  const runScenario = (name, { maxPerSession = 5, maxAgeMs = 30 * 60_000, t0 = T0 } = {}, ops = []) => {
    let clock = t0;
    const q = createPromptQueue({ maxPerSession, maxAgeMs, now: () => clock });
    const steps = [];
    for (const step of ops) {
      let output;
      switch (step.op) {
        case 'tick':
          clock += step.ms;
          output = { now: clock };
          break;
        case 'enqueue': {
          const r = q.enqueue(step.sessionId, step.prompt, step.meta ?? null);
          output = plain({
            ok: Boolean(r.ok),
            error: r.error ?? null,
            id: r.id ?? null,
            position: r.position ?? null,
            maxPerSession: r.maxPerSession ?? null,
            item: r.item ?? null,
          });
          break;
        }
        case 'takeNextIfReady':
          output = plain(q.takeNextIfReady(step.sessionId, { working: step.working, waiting: step.waiting }));
          break;
        case 'peek':
          output = plain(q.peek(step.sessionId));
          break;
        case 'list':
          output = plain(q.list(step.sessionId ?? null));
          break;
        case 'cancel': {
          const r = step.maybeItemId !== undefined ? q.cancel(step.idOrSessionId, step.maybeItemId) : q.cancel(step.idOrSessionId);
          output = plain({ ok: Boolean(r.ok), count: r.count, removed: r.removed });
          break;
        }
        case 'clearAll':
          output = plain(q.clearAll());
          break;
        default:
          throw new Error(`unknown queue op: ${step.op}`);
      }
      steps.push(plain({ ...step, output }));
    }
    return { name, config: { maxPerSession, maxAgeMs, t0 }, steps };
  };

  return [
    runScenario(
      'working_and_waiting_hard_block',
      { maxPerSession: 3, maxAgeMs: 60_000, t0: 1_000_000 },
      [
        { op: 'enqueue', sessionId: 's1', prompt: 'run unit tests', meta: { source: 'voice' } },
        { op: 'enqueue', sessionId: 's1', prompt: 'update changelog', meta: null },
        // Hard block matrix: ONLY working=false && waiting=false may dequeue.
        { op: 'takeNextIfReady', sessionId: 's1', working: true, waiting: false },
        { op: 'takeNextIfReady', sessionId: 's1', working: false, waiting: true },
        { op: 'takeNextIfReady', sessionId: 's1', working: true, waiting: true },
        { op: 'list', sessionId: 's1' },
        { op: 'peek', sessionId: 's1' },
        // Idle release (FIFO #1)
        { op: 'takeNextIfReady', sessionId: 's1', working: false, waiting: false },
        // Still hard blocked if waiting flips true before item #2
        { op: 'takeNextIfReady', sessionId: 's1', working: false, waiting: true },
        // Idle release (FIFO #2)
        { op: 'takeNextIfReady', sessionId: 's1', working: false, waiting: false },
        // Empty queue returns null
        { op: 'takeNextIfReady', sessionId: 's1', working: false, waiting: false },
      ],
    ),
    runScenario(
      'cap_and_invalid_inputs',
      { maxPerSession: 2, maxAgeMs: 60_000, t0: 2_000_000 },
      [
        { op: 'enqueue', sessionId: '', prompt: 'missing session' },
        { op: 'enqueue', sessionId: 's1', prompt: '   ' },
        { op: 'enqueue', sessionId: 's1', prompt: 'first prompt' },
        { op: 'enqueue', sessionId: 's1', prompt: 'second prompt' },
        { op: 'enqueue', sessionId: 's1', prompt: 'third rejected by cap' },
        { op: 'enqueue', sessionId: 's2', prompt: 'other session unaffected' },
        { op: 'list', sessionId: null },
      ],
    ),
    runScenario(
      'ttl_expiry',
      { maxPerSession: 2, maxAgeMs: 60_000, t0: 3_000_000 },
      [
        { op: 'enqueue', sessionId: 's1', prompt: 'expires at +60s' },
        { op: 'tick', ms: 30_000 },
        { op: 'enqueue', sessionId: 's1', prompt: 'expires at +90s' },
        { op: 'peek', sessionId: 's1' },
        { op: 'tick', ms: 30_000 },
        // First expired at exactly t0 + 60_000; second remains
        { op: 'peek', sessionId: 's1' },
        { op: 'takeNextIfReady', sessionId: 's1', working: false, waiting: false },
        { op: 'tick', ms: 30_000 },
        { op: 'list', sessionId: 's1' },
        { op: 'takeNextIfReady', sessionId: 's1', working: false, waiting: false },
      ],
    ),
    runScenario(
      'cancel_forms_and_clear_all',
      { maxPerSession: 5, maxAgeMs: 120_000, t0: 4_000_000 },
      [
        { op: 'enqueue', sessionId: 's1', prompt: 'prompt A' },
        { op: 'enqueue', sessionId: 's1', prompt: 'prompt B' },
        { op: 'enqueue', sessionId: 's2', prompt: 'prompt C' },
        { op: 'enqueue', sessionId: 's2', prompt: 'prompt D' },
        { op: 'cancel', idOrSessionId: 'q_1' },
        { op: 'cancel', idOrSessionId: 's1', maybeItemId: 'q_2' },
        { op: 'list', sessionId: 's1' },
        { op: 'cancel', idOrSessionId: 's2' },
        { op: 'list', sessionId: null },
        { op: 'enqueue', sessionId: 's3', prompt: 'prompt E' },
        { op: 'enqueue', sessionId: 's4', prompt: 'prompt F' },
        { op: 'clearAll' },
        { op: 'cancel', idOrSessionId: 'q_999' },
        { op: 'list', sessionId: null },
      ],
    ),
  ];
}

export async function routerFixtures(root, rng) {
  const load = (...rel) => import(pathToFileURL(path.join(root, ...rel)).href);
  const ranker = await load('src', 'router', 'ranker.js');
  const drift = await load('src', 'router', 'drift.js');
  const queue = await load('src', 'router', 'queue.js');
  const ctxMod = await load('src', 'router', 'context.js');

  const heuristics = [];
  for (const text of HEURISTIC_TEXTS) {
    heuristics.push({ fn: 'isBareFollowUp', input: text, output: ranker.isBareFollowUp(text) });
    heuristics.push({ fn: 'looksLikeNewWork', input: text, output: ranker.looksLikeNewWork(text) });
    heuristics.push({ fn: 'extractMentionedFiles', input: text, output: ranker.extractMentionedFiles(text) });
    heuristics.push({ fn: 'tokenize', input: text, output: ranker.tokenize(text) });
  }

  const base = buildBaseContexts(ctxMod.harvestSessionContext);
  const allBase = [base.web, base.pay, base.cli, base.t3Docs];
  const rankCases = [];
  const driftCases = [];

  const addRank = (name, query, contexts, options = {}) => {
    const opts = {
      activeId: options.activeId ?? null,
      lastSpokenId: options.lastSpokenId ?? null,
      lastSpokenAt: options.lastSpokenAt ?? 0,
      recentInteractedIds: options.recentInteractedIds ?? null,
      now: options.now ?? T0,
      weights: options.weights ?? null,
    };
    const res = ranker.rankCandidates(query, contexts, opts);
    rankCases.push({
      name,
      input: plain({ query, contexts, options: opts }),
      output: normalizeRankResult(res),
    });
  };

  const addDrift = async (name, { prompt, activeContext, otherContexts = [], threshold = drift.DEFAULT_DRIFT_THRESHOLD, extractedSubject = null }) => {
    const res = await drift.checkTopicDrift({
      prompt,
      activeContext,
      otherContexts,
      threshold,
      extractSubject: extractedSubject !== null ? async () => extractedSubject : null,
    });
    driftCases.push({
      name,
      input: plain({ prompt, activeContext, otherContexts, threshold, extractedSubject }),
      output: normalizeDriftResult(res),
    });
  };

  // Core hand-picked rankCandidates cases
  addRank('empty_query_with_active', '   ', allBase, { activeId: 's_web' });
  addRank('empty_query_no_active', '', allBase, {});
  addRank('empty_contexts', 'fix login redirect', [], {});
  addRank('explicit_file_beats_active', 'fix the null check in billing.ts', [base.web, base.pay, base.cli], { activeId: 's_web' });
  addRank('explicit_project_beats_active', 'in data-cli add a flag for tab-delimited output', [base.web, base.pay, base.cli], { activeId: 's_web' });
  addRank(
    'bare_followup_waiting_spoken',
    'go with option two',
    [base.web, { ...base.pay, waiting: true, status: 'waiting' }, base.cli],
    { activeId: 's_web', lastSpokenId: 's_pay', lastSpokenAt: T0 - 20_000 },
  );
  addRank('bare_followup_active', 'yes, go ahead', [base.web, base.pay, base.cli], {
    activeId: 's_web',
    recentInteractedIds: ['s_web', 's_pay', 's_cli'],
  });
  addRank('explicit_new_work_suggests_none', 'start a new project from scratch for an invoice generator app', [base.web, base.pay, base.cli], {
    activeId: 's_web',
  });
  addRank('stale_sessions_decay_to_none', 'write a kubernetes helm chart for a redis sentinel cluster', [base.web, base.pay, base.cli], {
    activeId: 's_web',
    now: T0 + 5 * 60 * 60_000,
  });
  addRank(
    'ambiguous_tied_sessions',
    'fix the tests',
    [
      ctxMod.harvestSessionContext({ id: 'a1', title: 'Fix API tests', project: 'backend', lastFocusedAt: T0 - 60_000 }),
      ctxMod.harvestSessionContext({ id: 'a2', title: 'Fix UI tests', project: 'frontend', lastFocusedAt: T0 - 60_000 }),
    ],
    { recentInteractedIds: [] },
  );
  addRank('t3_thread_file_match', 'update openapi/spec.yaml with the error schema', allBase, { activeId: 's_web' });
  addRank('custom_weights_override', 'in data-cli fix csv', [base.web, base.pay, base.cli], {
    activeId: 's_web',
    weights: { projectMatch: 5.0, typed0: 0.5 },
  });

  // Core hand-picked checkTopicDrift cases
  await addDrift('drift_bare_followup_silent', {
    prompt: 'go ahead and run the tests',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
  });
  await addDrift('drift_other_file_mention', {
    prompt: 'update the retry delay inside billing.ts',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
  });
  await addDrift('drift_other_project_mention', {
    prompt: 'in payments-api add idempotency key validation',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
  });
  await addDrift('drift_new_work_shift', {
    prompt: 'start a brand new project from scratch for a podcast RSS downloader',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
  });
  await addDrift('drift_foreign_repo_mention', {
    prompt: 'in the analytics-pipeline repo add a parquet export job',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
  });
  await addDrift('drift_untracked_file_below_default_threshold', {
    prompt: 'inspect migrations/0042_init.sql for lock contention',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
    threshold: 0.8,
  });
  await addDrift('drift_untracked_file_above_low_threshold', {
    prompt: 'inspect migrations/0042_init.sql for lock contention',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
    threshold: 0.5,
  });
  await addDrift('drift_high_threshold_blocks_warning', {
    prompt: 'in payments-api add idempotency key validation',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
    threshold: 0.98,
  });
  await addDrift('drift_long_incidental_cross_ref_silent', {
    prompt:
      'Update the login redirect logic in webapp so OAuth callbacks preserve returnTo cleanly. ' +
      'Remember last week in payments-api we noticed strict query sanitization prevented subtle loops, so let us apply a similar safeguard here and add tests.',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
    extractedSubject: 'Update webapp OAuth login redirect logic to preserve returnTo with tests',
  });
  await addDrift('drift_long_true_drift_warns', {
    prompt:
      'Before we wrap up today I remembered something urgent we need to ship right away because customers are seeing duplicate charges when webhooks retry twice in payments-api billing.ts and we must patch it now.',
    activeContext: base.web,
    otherContexts: [base.pay, base.cli],
    extractedSubject: 'Patch duplicate webhook charge bug in payments-api billing.ts',
  });

  // Include benchmark fixtures from test/fixtures/routing-cases.json if present so the
  // cross-platform oracle covers the exact evaluation suite too.
  const benchPath = path.join(root, 'test', 'fixtures', 'routing-cases.json');
  if (fs.existsSync(benchPath)) {
    const bench = JSON.parse(fs.readFileSync(benchPath, 'utf8'));
    const benchNow = bench.now || T0;
    const resolveBenchSession = (key, overrides) => {
      const raw = { ...bench.sessions[key], ...(overrides?.[key] || {}) };
      return ctxMod.harvestSessionContext(raw, { includeGit: false });
    };
    for (const c of bench.cases || []) {
      if (c.kind === 'route') {
        const ctxs = Array.isArray(c.customSessions)
          ? c.customSessions.map((s) => ctxMod.harvestSessionContext(s, { includeGit: false }))
          : (c.sessions || []).map((k) => resolveBenchSession(k, c.overrides));
        addRank(`bench_${c.id}`, c.query, ctxs, {
          activeId: c.activeId ?? null,
          lastSpokenId: c.lastSpokenId ?? null,
          lastSpokenAt: c.lastSpokenAt ?? 0,
          recentInteractedIds: c.recentInteractedIds ?? null,
          now: benchNow + (c.nowOffsetMs || 0),
        });
      } else if (c.kind === 'drift') {
        await addDrift(`bench_${c.id}`, {
          prompt: c.prompt,
          activeContext: resolveBenchSession(c.active, c.overrides),
          otherContexts: (c.others || []).map((k) => resolveBenchSession(k, c.overrides)),
          threshold: c.threshold ?? drift.DEFAULT_DRIFT_THRESHOLD,
          extractedSubject: c.extractedSubject ?? null,
        });
      }
    }
  }

  // Seeded random combinations to catch subtle score/tie/decay edge cases between JS and Swift.
  const r = rng(20261125);
  const queries = [
    'fix login.tsx',
    'retry webhook backoff in billing.ts',
    'yes',
    'run the tests',
    'in webapp update callback',
    'escape commas in export.go',
    'start a fresh session for rust',
    'update openapi/spec.yaml',
    'commit that',
    'add metrics to the worker pool',
  ];
  const ageOffsets = [0, 60_000, 10 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
  for (let i = 0; i < 20; i++) {
    const q = pick(r, queries);
    const ctxs = allBase.map((c) => ({
      ...c,
      waiting: r() < 0.25,
      status: r() < 0.25 ? 'waiting' : 'idle',
    }));
    const activeId = r() < 0.8 ? pick(r, ctxs).id : null;
    const lastSpokenId = r() < 0.4 ? pick(r, ctxs).id : null;
    addRank(`seeded_${i}`, q, ctxs, {
      activeId,
      lastSpokenId,
      lastSpokenAt: lastSpokenId ? T0 - pick(r, [5_000, 30_000, 300_000]) : 0,
      now: T0 + pick(r, ageOffsets),
    });
  }

  return {
    defaultWeights: plain(ranker.DEFAULT_WEIGHTS),
    defaultDriftThreshold: drift.DEFAULT_DRIFT_THRESHOLD,
    heuristics,
    rankCases,
    driftCases,
    queueScenarios: buildQueueScenarios(queue.createPromptQueue),
  };
}
