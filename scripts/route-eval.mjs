// Offline evaluation harness for src/router/ against labeled routing & drift fixtures.
// Usage: node scripts/route-eval.mjs [path/to/cases.json]
// Exits 0 if overall accuracy >= 85%, non-zero otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  harvestSessionContext,
  rankCandidates,
  checkTopicDrift,
} from '../src/router/index.js';

const MIN_ACCURACY = 0.85;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../test/fixtures/routing-cases.json');

const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const baseNow = Number(data.now) || Date.now();
const sessionTemplates = data.sessions || {};
const cases = Array.isArray(data.cases) ? data.cases : [];

if (cases.length < 20) {
  console.error(`Expected at least 20 eval cases, found ${cases.length}`);
  process.exit(1);
}

function materializeSession(key, overrides = {}) {
  const tpl = sessionTemplates[key];
  if (!tpl) throw new Error(`Unknown fixture session key: ${key}`);
  return harvestSessionContext({ ...tpl, ...(overrides[key] || {}) });
}

function checkRouteExpectation(res, expect) {
  const issues = [];
  if ('bestId' in expect) {
    const actualId = res.best ? res.best.id : null;
    if (actualId !== expect.bestId) issues.push(`bestId=${actualId} (want ${expect.bestId})`);
  }
  if ('suggestNew' in expect && res.suggestNew !== expect.suggestNew) {
    issues.push(`suggestNew=${res.suggestNew} (want ${expect.suggestNew})`);
  }
  if ('ambiguous' in expect && res.ambiguous !== expect.ambiguous) {
    issues.push(`ambiguous=${res.ambiguous} (want ${expect.ambiguous})`);
  }
  return issues;
}

function checkDriftExpectation(res, expect) {
  const issues = [];
  if ('drifted' in expect && res.drifted !== expect.drifted) {
    issues.push(`drifted=${res.drifted} (want ${expect.drifted})`);
  }
  if ('suggestedId' in expect) {
    const actualId = res.suggestedSession ? res.suggestedSession.id : null;
    if (actualId !== expect.suggestedId) issues.push(`suggestedId=${actualId} (want ${expect.suggestedId})`);
  }
  if ('suggestNew' in expect && res.suggestNew !== expect.suggestNew) {
    issues.push(`suggestNew=${res.suggestNew} (want ${expect.suggestNew})`);
  }
  return issues;
}

let passed = 0;
let routePassed = 0;
let routeTotal = 0;
let driftPassed = 0;
let driftTotal = 0;

for (const c of cases) {
  if (c.kind === 'route') {
    routeTotal += 1;
    const contexts = Array.isArray(c.customSessions)
      ? c.customSessions.map((s) => harvestSessionContext(s))
      : (c.sessions || []).map((k) => materializeSession(k, c.overrides));

    const res = rankCandidates(c.query, contexts, {
      activeId: c.activeId ?? null,
      lastSpokenId: c.lastSpokenId ?? null,
      lastSpokenAt: c.lastSpokenAt ?? 0,
      recentInteractedIds: c.recentInteractedIds ?? null,
      now: baseNow + (Number(c.nowOffsetMs) || 0),
    });

    const issues = checkRouteExpectation(res, c.expect || {});
    const ok = issues.length === 0;
    if (ok) {
      passed += 1;
      routePassed += 1;
    }
    const target = res.best ? res.best.id : 'none';
    console.log(
      `${ok ? 'PASS' : 'FAIL'} [${c.id}] -> ${target} (conf=${res.confidence.toFixed(2)}, margin=${res.margin.toFixed(2)}, ambig=${res.ambiguous})${ok ? '' : ` | ${issues.join('; ')}`}`,
    );
  } else if (c.kind === 'drift') {
    driftTotal += 1;
    const activeContext = materializeSession(c.active, c.overrides);
    const otherContexts = (c.others || []).map((k) => materializeSession(k, c.overrides));
    const extractSubject = typeof c.extractedSubject === 'string'
      ? async () => c.extractedSubject
      : null;

    const res = await checkTopicDrift({
      prompt: c.prompt,
      activeContext,
      otherContexts,
      extractSubject,
    });

    const issues = checkDriftExpectation(res, c.expect || {});
    const ok = issues.length === 0;
    if (ok) {
      passed += 1;
      driftPassed += 1;
    }
    console.log(
      `${ok ? 'PASS' : 'FAIL'} [${c.id}] -> drifted=${res.drifted} (conf=${res.confidence.toFixed(2)}, suggested=${res.suggestedSession?.id ?? 'none'}, new=${res.suggestNew})${ok ? '' : ` | ${issues.join('; ')}`}`,
    );
  } else {
    console.log(`FAIL [${c.id}] unknown case kind: ${c.kind}`);
  }
}

const accuracy = cases.length ? passed / cases.length : 0;
const pct = (accuracy * 100).toFixed(1);
console.log(
  `\nSummary: ${passed}/${cases.length} (${pct}%) | routing ${routePassed}/${routeTotal} | drift ${driftPassed}/${driftTotal}`,
);

if (accuracy < MIN_ACCURACY) {
  console.error(`Accuracy ${pct}% is below threshold ${(MIN_ACCURACY * 100).toFixed(0)}%`);
  process.exit(1);
}
