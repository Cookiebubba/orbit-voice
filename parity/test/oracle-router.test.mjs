// Cross-platform parity oracle verification for Gemini, T3 Code, and SP3 Routing settings & router fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FIXTURES, stale } from '../oracle/gen.mjs';
import { normalizeDriftResult, normalizeRankResult } from '../oracle/router.mjs';
import * as config from '../../src/config.js';
import * as ranker from '../../src/router/ranker.js';
import * as drift from '../../src/router/drift.js';
import * as queue from '../../src/router/queue.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

test('parity oracle fixtures are current (no stale fixtures)', async () => {
  assert.deepEqual(await stale(), [], 'run `node parity/oracle/gen.mjs` to regenerate stale oracle fixtures');
});

test('settings oracle covers Gemini, T3 Code, and SP3 Routing sanitization and engineFor rules', () => {
  const settings = readFixture('settings');
  const findCase = (input) => settings.cases.find((c) => JSON.stringify(c.input) === JSON.stringify(input));

  // voiceEngine: gemini-cli and gemini-live saved choices always win in engineFor
  for (const engine of ['gemini-cli', 'gemini-live']) {
    for (const hadFile of [false, true]) {
      for (const hasKey of [false, true]) {
        const entry = settings.engineFor.find((e) => e.saved === engine && e.hadFile === hadFile && e.hasKey === hasKey);
        assert.ok(entry, `missing engineFor case for ${engine} hadFile=${hadFile} hasKey=${hasKey}`);
        assert.equal(entry.output, engine);
        assert.equal(config.engineFor({ saved: engine, hadFile, hasKey }), engine);
      }
    }
    assert.ok(settings.loads.some((l) => l.file?.voiceEngine === engine && l.settings.voiceEngine === engine), `missing load case for ${engine}`);
  }

  // Gemini & brain settings
  assert.deepEqual(findCase({ voiceEngine: 'gemini-cli' })?.output, { voiceEngine: 'gemini-cli' });
  assert.deepEqual(findCase({ voiceEngine: 'gemini-live' })?.output, { voiceEngine: 'gemini-live' });
  assert.deepEqual(findCase({ geminiVoice: 'Aoede' })?.output, { geminiVoice: 'Aoede' });
  assert.deepEqual(findCase({ geminiVoice: 'aoede' })?.output, {});
  assert.deepEqual(findCase({ geminiVoiceModel: 'gemini-2.5-pro' })?.output, { geminiVoiceModel: 'gemini-2.5-pro' });
  assert.deepEqual(findCase({ geminiLiveModel: 'gemini-2.5-flash-native-audio-preview-12-2025' })?.output, {
    geminiLiveModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
  });
  assert.deepEqual(findCase({ geminiLiveModel: 'gemini-bad model' })?.output, {});
  assert.deepEqual(findCase({ brainProvider: 'gemini' })?.output, { brainProvider: 'gemini' });
  assert.deepEqual(findCase({ helperEngine: 'gemini' })?.output, { helperEngine: 'gemini' });

  // T3 Code settings: loopback allowed, remote URL rejected
  assert.deepEqual(findCase({ targetBackend: 't3-code' })?.output, { targetBackend: 't3-code' });
  assert.deepEqual(findCase({ targetBackend: 'claude-desktop' })?.output, { targetBackend: 'claude-desktop' });
  assert.deepEqual(findCase({ t3Endpoint: 'http://127.0.0.1:3773/' })?.output, { t3Endpoint: 'http://127.0.0.1:3773' });
  assert.deepEqual(findCase({ t3Endpoint: 'https://localhost:8443/t3/' })?.output, { t3Endpoint: 'https://localhost:8443/t3' });
  assert.deepEqual(findCase({ t3Endpoint: 'https://example.com' })?.output, {});
  assert.deepEqual(findCase({ t3Endpoint: 'http://192.168.1.5:3773' })?.output, {});
  assert.deepEqual(findCase({ t3Endpoint: 'http://127.0.0.1.evil.com:3773' })?.output, {});
  assert.deepEqual(findCase({ t3Endpoint: 'ftp://127.0.0.1:3773' })?.output, {});

  // SP3 routing settings: booleans + drift threshold clamped 0.5–0.98
  assert.deepEqual(findCase({ routingDriftGuard: true })?.output, { routingDriftGuard: true });
  assert.deepEqual(findCase({ routingDriftGuard: false })?.output, { routingDriftGuard: false });
  assert.deepEqual(findCase({ routingQueueBusy: true })?.output, { routingQueueBusy: true });
  assert.deepEqual(findCase({ routingQueueBusy: false })?.output, { routingQueueBusy: false });
  assert.deepEqual(findCase({ routingDriftThreshold: 0.49 })?.output, { routingDriftThreshold: 0.5 });
  assert.deepEqual(findCase({ routingDriftThreshold: 0.8 })?.output, { routingDriftThreshold: 0.8 });
  assert.deepEqual(findCase({ routingDriftThreshold: 0.99 })?.output, { routingDriftThreshold: 0.98 });
  assert.deepEqual(findCase({ routingDriftThreshold: '0.4' })?.output, { routingDriftThreshold: 0.5 });
  assert.deepEqual(findCase({ routingDriftThreshold: '0.75' })?.output, { routingDriftThreshold: 0.75 });
  assert.deepEqual(findCase({ routingDriftThreshold: '0.999' })?.output, { routingDriftThreshold: 0.98 });
});

test('voice oracle includes Gemini voice engines, Gemini brainProvider, and T3 Code lead contexts', () => {
  const voice = readFixture('voice');
  assert.ok(voice.contexts.some((c) => c.settings.voiceEngine === 'gemini-cli'));
  assert.ok(voice.contexts.some((c) => c.settings.voiceEngine === 'gemini-live'));
  assert.ok(voice.contexts.some((c) => c.settings.brainProvider === 'gemini'));
  assert.ok(voice.contexts.some((c) => c.settings.targetBackend === 't3-code'));
});

test('router oracle fixture matches src/router/ rankCandidates, checkTopicDrift, heuristics, and createPromptQueue', async () => {
  const fixture = readFixture('router');
  assert.deepEqual(fixture.defaultWeights, ranker.DEFAULT_WEIGHTS);
  assert.equal(fixture.defaultDriftThreshold, drift.DEFAULT_DRIFT_THRESHOLD);
  assert.ok(fixture.heuristics.length >= 40);
  assert.ok(fixture.rankCases.length >= 40);
  assert.ok(fixture.driftCases.length >= 15);
  assert.ok(fixture.queueScenarios.length >= 4);

  for (const h of fixture.heuristics) {
    const got = ranker[h.fn](h.input);
    assert.deepEqual(got, h.output, `heuristic ${h.fn}(${JSON.stringify(h.input)})`);
  }

  for (const c of fixture.rankCases) {
    const got = normalizeRankResult(ranker.rankCandidates(c.input.query, c.input.contexts, c.input.options));
    assert.deepEqual(got, c.output, `rankCandidates case ${c.name}`);
  }

  for (const c of fixture.driftCases) {
    const got = normalizeDriftResult(
      await drift.checkTopicDrift({
        prompt: c.input.prompt,
        activeContext: c.input.activeContext,
        otherContexts: c.input.otherContexts,
        threshold: c.input.threshold,
        extractSubject: c.input.extractedSubject !== null ? async () => c.input.extractedSubject : null,
      }),
    );
    assert.deepEqual(got, c.output, `checkTopicDrift case ${c.name}`);
  }

  // Verify every queue scenario replays identically, including the working/waiting hard block.
  let sawWaitingHardBlock = false;
  let sawWorkingHardBlock = false;
  for (const sc of fixture.queueScenarios) {
    let clock = sc.config.t0;
    const q = queue.createPromptQueue({
      maxPerSession: sc.config.maxPerSession,
      maxAgeMs: sc.config.maxAgeMs,
      now: () => clock,
    });
    for (const [idx, step] of sc.steps.entries()) {
      let got;
      if (step.op === 'tick') {
        clock += step.ms;
        got = { now: clock };
      } else if (step.op === 'enqueue') {
        const r = q.enqueue(step.sessionId, step.prompt, step.meta ?? null);
        got = {
          ok: Boolean(r.ok),
          error: r.error ?? null,
          id: r.id ?? null,
          position: r.position ?? null,
          maxPerSession: r.maxPerSession ?? null,
          item: r.item ?? null,
        };
      } else if (step.op === 'takeNextIfReady') {
        got = q.takeNextIfReady(step.sessionId, { working: step.working, waiting: step.waiting });
        if (step.waiting) {
          assert.equal(got, null, `${sc.name}[${idx}]: waiting MUST hard-block dequeue`);
          sawWaitingHardBlock = true;
        }
        if (step.working) {
          assert.equal(got, null, `${sc.name}[${idx}]: working MUST hard-block dequeue`);
          sawWorkingHardBlock = true;
        }
      } else if (step.op === 'peek') {
        got = q.peek(step.sessionId);
      } else if (step.op === 'list') {
        got = q.list(step.sessionId ?? null);
      } else if (step.op === 'cancel') {
        const r = step.maybeItemId !== undefined ? q.cancel(step.idOrSessionId, step.maybeItemId) : q.cancel(step.idOrSessionId);
        got = { ok: Boolean(r.ok), count: r.count, removed: r.removed };
      } else if (step.op === 'clearAll') {
        got = q.clearAll();
      } else {
        assert.fail(`unexpected op ${step.op}`);
      }
      assert.deepEqual(got, step.output, `queue scenario ${sc.name} step ${idx} (${step.op})`);
    }
  }
  assert.ok(sawWaitingHardBlock, 'expected queue scenarios to test waiting hard block');
  assert.ok(sawWorkingHardBlock, 'expected queue scenarios to test working hard block');
});

// Keep HERE referenced cleanly if needed for relative path sanity.
test('oracle fixtures directory lives under parity/oracle/fixtures', () => {
  assert.equal(path.resolve(HERE, '..', 'oracle', 'fixtures'), path.resolve(FIXTURES));
});
