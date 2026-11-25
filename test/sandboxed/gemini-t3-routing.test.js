// End-to-end sandboxed integration tests for:
//   1. T3 Code HTTP bridge routes & session listing via startServer({ t3Target })
//   2. Gemini Live WebSocket end-to-end through /voice (audio, vision gating, T3 toolCall)
//   3. SP3 Topic-Drift Guard + force:true override via createToolRunner + fake-t3
//   4. SP3 Busy-Turn Queue + Permission-Waiting Hard Guard (T3 mode:'queue' & Claude Desktop flushQueued)
//   5. T3 Lead Orchestrator tools (steer_thread, list_t3_projects, new_session worktree,
//      read_claude_prompt + answer_claude_prompt) + deterministic consent checks
//
// 100% offline, OS-independent, using throwaway temp config dirs & random free ports.
// Runs with: node --import ./test/fuzz/register.mjs --test test/sandboxed/gemini-t3-routing.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startFakeT3 } from '../e2e/fake-t3.mjs';
import { createFakeGeminiLive } from '../e2e/fake-gemini-live.mjs';
import { createT3Target } from '../../src/targets/t3-code.js';
import { createPromptQueue } from '../../src/router/queue.js';
import { GEMINI_LIVE_VOICES } from '../../src/gemini/auth.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-gemini-t3-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.XAI_API_KEY = '';
process.env.GEMINI_API_KEY = '';

globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'Build API' };

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, { timeoutMs = 4000, stepMs = 15, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = pred();
    if (val) return val;
    await wait(stepMs);
  }
  const finalVal = pred();
  if (finalVal) return finalVal;
  throw new Error(`Timed out waiting for ${label}`);
}

const memSecret = (initial = '') => {
  let value = initial;
  return { kind: 'memory', get: () => value, set: (v) => (value = String(v || '')) };
};

// Start fake T3 Code HTTP MCP server & fake Gemini Live WebSocket server on free loopback ports.
const fakeT3 = await startFakeT3({
  token: 'sandbox-t3-secret-token',
  projects: [
    { projectId: 'proj_launchpad', title: 'launchpad', workspaceRoot: '/workspace/launchpad' },
    { projectId: 'proj_orbit', title: 'orbit-voice', workspaceRoot: '/workspace/orbit-voice' },
  ],
  threads: [
    {
      threadId: 'thr_launchpad',
      title: 'Launchpad billing page',
      projectId: 'proj_launchpad',
      branch: 'main',
      status: 'idle',
      recentFiles: ['src/billing/checkout.tsx', 'src/billing/plans.ts'],
      messages: [
        { role: 'user', text: 'Update billing pricing tiers' },
        { role: 'assistant', text: 'Updated checkout.tsx with new pricing tiers.' },
      ],
    },
    {
      threadId: 'thr_orbit',
      title: 'Orbit voice Gemini routing',
      projectId: 'proj_orbit',
      branch: 'feat/gemini-t3-routing',
      status: 'running',
      recentFiles: ['src/gemini/live-voice.js', 'src/router/drift.js'],
      messages: [{ role: 'user', text: 'Wire Gemini Live and SP3 drift guard' }],
    },
    {
      threadId: 'thr_wait',
      title: 'Database migration check',
      projectId: 'proj_launchpad',
      branch: 'feat/db-migration',
      status: 'waiting',
      pendingRequests: [
        {
          requestId: 'req_db_1',
          kind: 'question',
          question: 'Which cache backend should we configure?',
          choices: [
            { n: 1, label: 'Redis', description: 'In-memory store' },
            { n: 2, label: 'Postgres', description: 'Existing primary DB' },
          ],
          multiSelect: false,
          canSkip: false,
        },
      ],
    },
  ],
});

const fakeGemini = createFakeGeminiLive();
await fakeGemini.ready;
const prevGeminiLiveUrl = process.env.GEMINI_LIVE_URL;
process.env.GEMINI_LIVE_URL = fakeGemini.url;

const bridgeT3Target = createT3Target({
  endpoint: fakeT3.url,
  token: fakeT3.token,
  pollMs: 60_000,
});

const PORT = await getFreePort();
const host = `127.0.0.1:${PORT}`;
const origin = `http://${host}`;

const { updateSettings } = await import('../../src/config.js');
const { createToolRunner } = await import('../../src/tools.js');
const server = await import('../../src/server.js');

const noopWatcher = { on() {}, start() {}, working: () => [] };
const cfgDir = path.join(root, 'cfg');

await server.startServer({
  port: PORT,
  configDir: cfgDir,
  secrets: memSecret(''),
  brainSecrets: memSecret(''),
  geminiSecrets: memSecret(''),
  t3Secrets: memSecret(fakeT3.token),
  clipboard: () => {},
  models: root,
  watcher: noopWatcher,
  t3Target: bridgeT3Target,
});

// Authenticate via /auth to obtain the HttpOnly session cookie.
const cookie = await new Promise((resolve, reject) => {
  const u = new URL(server.authUrl());
  http
    .get({ host: '127.0.0.1', port: PORT, path: u.pathname + u.search, headers: { host } }, (res) => {
      res.resume();
      const raw = res.headers['set-cookie']?.[0];
      if (!raw) return reject(new Error('Missing set-cookie from /auth'));
      resolve(String(raw).split(';')[0]);
    })
    .on('error', reject);
});

function apiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const headers = { host, cookie };
    if (method === 'POST') headers.origin = origin;
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const getJson = (p) => apiRequest('GET', p);
const postJson = (p, body) => apiRequest('POST', p, body);

/** Helper for testing createToolRunner with controlled user utterances. */
function makeToolHarness({ target = null, promptQueue = createPromptQueue() } = {}) {
  let utterance = null;
  const history = [];
  const events = [];
  const runner = createToolRunner({
    notify: (e) => events.push(e),
    utteranceSince: async (since) => (utterance && utterance.at > since ? utterance : null),
    recentUtterance: () => utterance,
    userWords: () => history.join(' '),
    heardSince: (ts) => (utterance?.at || 0) > ts,
    repliesSince: (ts) => (utterance && utterance.at > ts ? 1 : 0),
    target,
    promptQueue,
  });
  const say = async (text, at) => {
    await wait(5);
    utterance = { text, at: at ?? Date.now() };
    history.push(text);
    await wait(5);
  };
  const resetSpeech = () => {
    utterance = null;
    history.length = 0;
  };
  return { runner, say, resetSpeech, events, promptQueue };
}

// ============================================================================
// 1. T3 Code HTTP bridge routes & session listing
// ============================================================================

test('1. T3 Code HTTP bridge routes, config, session listing, and switching', async () => {
  const cfg = await getJson('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.activeTarget, 't3-code');
  assert.equal(cfg.json.hasT3Token, true);

  const st = await getJson('/api/t3/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.active, true);
  assert.equal(st.json.hasToken, true);

  const threadsRes = await getJson('/api/t3/threads');
  assert.equal(threadsRes.status, 200);
  assert.equal(threadsRes.json.active, true);
  assert.equal(threadsRes.json.threads.length, 3);
  const ids = new Set(threadsRes.json.threads.map((t) => t.id));
  assert.ok(ids.has('thr_launchpad'));
  assert.ok(ids.has('thr_orbit'));
  assert.ok(ids.has('thr_wait'));

  const sessionsRes = await getJson('/api/sessions');
  assert.equal(sessionsRes.status, 200);
  assert.equal(sessionsRes.json.backend, 't3-code');
  assert.equal(sessionsRes.json.canSwitch, true);
  assert.equal(sessionsRes.json.sessions.length, 3);
  assert.equal(sessionsRes.json.sessions.find((s) => s.id === 'thr_orbit')?.working, true);
  assert.equal(sessionsRes.json.sessions.find((s) => s.id === 'thr_wait')?.waiting, true);

  // Switch active thread via POST /api/t3/switch
  const sw1 = await postJson('/api/t3/switch', { threadId: 'thr_orbit' });
  assert.equal(sw1.status, 200);
  assert.equal(sw1.json.ok, true);
  assert.equal(sw1.json.threadId, 'thr_orbit');

  const afterSw1 = await getJson('/api/t3/threads');
  assert.equal(afterSw1.json.activeThreadId, 'thr_orbit');

  // Switch active thread via POST /api/switch (by title)
  const sw2 = await postJson('/api/switch', { title: 'Launchpad billing page' });
  assert.equal(sw2.status, 200);
  assert.equal(sw2.json.ok, true);
  assert.equal(sw2.json.threadId, 'thr_launchpad');

  const sessionsAfterSw2 = await getJson('/api/sessions');
  assert.equal(sessionsAfterSw2.json.openInApp, 'Launchpad billing page');
  assert.equal(sessionsAfterSw2.json.sessions.find((s) => s.id === 'thr_launchpad')?.open, true);
});

// ============================================================================
// 2. Gemini Live WebSocket end-to-end through /voice
// ============================================================================

test('2. Gemini Live WebSocket end-to-end through /voice (audio, vision gating, T3 toolCall)', async () => {
  const geminiKey = 'AIzaSyFakeSandboxKey1234567890abcd';
  const keyRes = await postJson('/api/gemini/key', { key: geminiKey });
  assert.equal(keyRes.status, 200);
  assert.equal(keyRes.json.hasKey, true);

  const settingsRes = await postJson('/api/settings', {
    voiceEngine: 'gemini-live',
    targetBackend: 't3-code',
    geminiVoice: 'Kore',
    anywhereVision: false,
  });
  assert.equal(settingsRes.status, 200);
  assert.equal(settingsRes.json.voiceEngine, 'gemini-live');
  assert.equal(settingsRes.json.anywhereVision, false);

  const voiceRes = await getJson('/api/voice?engine=gemini-live');
  assert.equal(voiceRes.status, 200);
  assert.equal(voiceRes.json.engine, 'gemini-live');
  assert.equal(voiceRes.json.voice, 'Kore');
  assert.deepEqual(
    voiceRes.json.voices.map((v) => v.id),
    [...GEMINI_LIVE_VOICES],
  );

  // Open browser WebSocket to /voice
  const ws = new WebSocket(`ws://${host}/voice`, { headers: { origin, cookie } });
  const browserEvents = [];
  ws.on('message', (d) => browserEvents.push(JSON.parse(String(d))));

  try {
    const readyEvt = await waitFor(
      () => browserEvents.find((e) => e.type === 'bridge.ready'),
      { label: 'bridge.ready' },
    );
    assert.equal(readyEvt.engine, 'gemini-live');
    assert.equal(readyEvt.voice, 'Kore');

    // Wait for Gemini setup handshake + setupComplete -> session.updated
    await waitFor(
      () => browserEvents.find((e) => e.type === 'session.updated'),
      { label: 'session.updated' },
    );

    const conn = fakeGemini.current();
    assert.ok(conn, 'expected active fake Gemini Live connection');
    assert.equal(conn.headers['x-goog-api-key'], geminiKey);
    assert.ok(conn.setup, 'expected setup payload');
    assert.equal(conn.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');

    const decls = conn.setup.tools?.flatMap((t) => t.functionDeclarations || []) || [];
    assert.ok(
      decls.some((d) => d.name === 't3_thread_status'),
      'Gemini Live setup should declare t3_thread_status when T3 target is active',
    );

    // Stream 24 kHz PCM audio from browser -> resampled to 16 kHz PCM at Gemini Live
    const pcm24 = Buffer.alloc(960); // 20 ms at 24 kHz PCM16
    for (let i = 0; i < 480; i++) pcm24.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm24.toString('base64') }));

    const audioChunk = await waitFor(
      () => conn.received.find((m) => m.realtimeInput?.mediaChunks?.[0]?.mimeType === 'audio/pcm;rate=16000'),
      { label: '16kHz PCM audio chunk at Gemini Live' },
    );
    const pcm16 = Buffer.from(audioChunk.realtimeInput.mediaChunks[0].data, 'base64');
    assert.ok(pcm16.length > 0 && pcm16.length < pcm24.length, '24kHz audio should be resampled down to 16kHz');

    // Vision frame blocked while anywhereVision is false
    const tinyJpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');
    ws.send(JSON.stringify({
      type: 'orbit.vision_frame',
      data: tinyJpegB64,
      mimeType: 'image/jpeg',
      window: { hwnd: 101, exe: 'code.exe', title: 'server.js - orbit-voice' },
    }));
    await wait(80);
    const visionWhileOff = conn.received.filter((m) => m.realtimeInput?.mediaChunks?.[0]?.mimeType === 'image/jpeg');
    assert.equal(visionWhileOff.length, 0, 'vision frame must be blocked when anywhereVision is false');

    // Enable anywhereVision and verify JPEG vision frame is forwarded
    const enableVis = await postJson('/api/settings', { anywhereVision: true });
    assert.equal(enableVis.status, 200);
    assert.equal(enableVis.json.anywhereVision, true);

    ws.send(JSON.stringify({
      type: 'orbit.vision_frame',
      data: tinyJpegB64,
      mimeType: 'image/jpeg',
      window: { hwnd: 101, exe: 'code.exe', title: 'server.js - orbit-voice' },
    }));
    const forwardedVision = await waitFor(
      () => conn.received.find((m) => m.realtimeInput?.mediaChunks?.[0]?.mimeType === 'image/jpeg'),
      { label: 'forwarded JPEG vision frame at Gemini Live' },
    );
    assert.equal(forwardedVision.realtimeInput.mediaChunks[0].data, tinyJpegB64);

    // Even with anywhereVision: true, an offLimits or password-manager vision frame is still refused
    ws.send(JSON.stringify({
      type: 'orbit.vision_frame',
      data: tinyJpegB64,
      mimeType: 'image/jpeg',
      offLimits: true,
    }));
    ws.send(JSON.stringify({
      type: 'orbit.vision_frame',
      data: tinyJpegB64,
      mimeType: 'image/jpeg',
      window: { hwnd: 102, exe: '1password.exe', title: '1Password Vault' },
    }));
    await wait(80);
    const visionAfterBlocked = conn.received.filter((m) => m.realtimeInput?.mediaChunks?.[0]?.mimeType === 'image/jpeg');
    assert.equal(visionAfterBlocked.length, 1, 'offLimits and password-manager vision frames must not be forwarded');

    // Trigger a Gemini Live toolCall (t3_thread_status) and verify real T3 statuses in toolResponse
    fakeGemini.sendToolCall({ id: 'gcall_status_1', name: 't3_thread_status', args: { limit: 10 } }, conn);

    const toolRespMsg = await waitFor(
      () => conn.received.find((m) => m.toolResponse?.functionResponses?.some((r) => r.id === 'gcall_status_1')),
      { label: 'toolResponse for t3_thread_status' },
    );
    const fnResp = toolRespMsg.toolResponse.functionResponses.find((r) => r.id === 'gcall_status_1');
    assert.equal(fnResp.name, 't3_thread_status');
    assert.equal(fnResp.response.backend, 't3-code');
    assert.equal(fnResp.response.total, 3);
    assert.equal(fnResp.response.running.length, 1);
    assert.equal(fnResp.response.running[0].id, 'thr_orbit');
    assert.equal(fnResp.response.waiting.length, 1);
    assert.equal(fnResp.response.waiting[0].id, 'thr_wait');
    assert.equal(fnResp.response.idle.length, 1);
    assert.equal(fnResp.response.idle[0].id, 'thr_launchpad');

    const browserToolResult = await waitFor(
      () => browserEvents.find((e) => e.type === 'bridge.tool_result' && e.name === 't3_thread_status'),
      { label: 'bridge.tool_result' },
    );
    assert.equal(browserToolResult.result.total, 3);
  } finally {
    const closed = new Promise((r) => {
      if (ws.readyState === WebSocket.CLOSED) return r();
      ws.once('close', r);
      ws.close();
    });
    await closed;
    await waitFor(() => !fakeGemini.current(), { label: 'upstream Gemini Live socket close' });
  }
});

// ============================================================================
// 3. SP3 Topic-Drift Guard + force:true override via createToolRunner + fake-t3
// ============================================================================

test('3. SP3 Topic-Drift Guard warns on cross-project/file drift, honors force:true, and drafts cleanly after switch', async (t) => {
  updateSettings({ routingDriftGuard: true, routingDriftThreshold: 0.8 });

  const localFakeT3 = await startFakeT3({
    token: 'drift-test-token',
    projects: [
      { projectId: 'proj_launchpad', title: 'launchpad', workspaceRoot: '/workspace/launchpad' },
      { projectId: 'proj_orbit', title: 'orbit-voice', workspaceRoot: '/workspace/orbit-voice' },
    ],
    threads: [
      {
        threadId: 'thr_launchpad',
        title: 'Launchpad billing checkout',
        projectId: 'proj_launchpad',
        branch: 'main',
        status: 'idle',
        recentFiles: ['src/billing/checkout.tsx', 'src/billing/stripe.ts'],
      },
      {
        threadId: 'thr_orbit',
        title: 'Orbit voice Gemini live audio',
        projectId: 'proj_orbit',
        branch: 'feat/gemini-t3-routing',
        status: 'idle',
        recentFiles: ['src/gemini/live-voice.js', 'src/router/drift.js'],
      },
    ],
  });
  t.after(() => localFakeT3.close());

  const target = createT3Target({ endpoint: localFakeT3.url, token: localFakeT3.token });
  const swInit = await target.switchSession('thr_launchpad');
  assert.equal(swInit.ok, true);
  assert.equal(target.activeThreadId, 'thr_launchpad');

  const { runner, say } = makeToolHarness({ target });

  // Dictate prompt explicitly referencing orbit-voice and a file only in orbit-voice thread
  await say('tell claude to fix resamplePcm16 in src/gemini/live-voice.js for orbit-voice');
  const drifted = await runner.run(
    'draft_prompt',
    JSON.stringify({ text: 'Fix resamplePcm16 in src/gemini/live-voice.js for orbit-voice' }),
  );
  assert.equal(drifted.drafted, false);
  assert.equal(drifted.drift_warning, true);
  assert.equal(drifted.active_session, 'Launchpad billing checkout');
  assert.equal(drifted.suggested_session?.id, 'thr_orbit');
  assert.equal(runner.getDraft(), null, 'drifted prompt must not be stored as active draft');

  // Calling again with force:true overrides the advisory drift warning
  const forced = await runner.run(
    'draft_prompt',
    JSON.stringify({ text: 'Fix resamplePcm16 in src/gemini/live-voice.js for orbit-voice', force: true }),
  );
  assert.equal(forced.drafted, true);
  assert.equal(forced.drift_warning, undefined);
  assert.equal(forced.thread_id, 'thr_launchpad');
  assert.equal(forced.target_session, 'Launchpad billing checkout');

  // Switch to orbit-voice on the user's explicit words, then draft cleanly without force
  await say('switch to orbit-voice');
  const switched = await runner.run('switch_session', JSON.stringify({ session: 'orbit-voice' }));
  assert.equal(switched.ok, true);
  assert.equal(switched.threadId, 'thr_orbit');

  await say('tell claude to fix resamplePcm16 in src/gemini/live-voice.js for orbit-voice');
  const cleanDraft = await runner.run(
    'draft_prompt',
    JSON.stringify({ text: 'Fix resamplePcm16 in src/gemini/live-voice.js for orbit-voice' }),
  );
  assert.equal(cleanDraft.drafted, true);
  assert.equal(cleanDraft.drift_warning, undefined);
  assert.equal(cleanDraft.thread_id, 'thr_orbit');
  assert.equal(cleanDraft.target_session, 'Orbit voice Gemini live audio');
});

// ============================================================================
// 4. SP3 Busy-Turn Queue + Permission-Waiting Hard Guard
// ============================================================================

test('4. SP3 Busy-Turn Queue (T3 mode:queue) and Claude Desktop flushQueued permission-waiting hard guard', async (t) => {
  updateSettings({ routingQueueBusy: true, routingDriftGuard: false });

  await t.test('4a. busy T3 thread queues confirmed draft via mode:queue', async (st) => {
    const busyFakeT3 = await startFakeT3({
      token: 'queue-test-token',
      projects: [{ projectId: 'proj_orbit', title: 'orbit-voice', workspaceRoot: '/workspace/orbit-voice' }],
      threads: [
        {
          threadId: 'thr_busy',
          title: 'Busy refactor thread',
          projectId: 'proj_orbit',
          branch: 'feat/busy',
          status: 'running',
          messages: [{ role: 'user', text: 'Refactor router module' }],
        },
      ],
    });
    st.after(() => busyFakeT3.close());

    const t3Target = createT3Target({ endpoint: busyFakeT3.url, token: busyFakeT3.token });
    await t3Target.switchSession('thr_busy');

    const { runner: t3Runner, say: t3Say } = makeToolHarness({ target: t3Target });
    await t3Say('tell claude to add unit tests for queue expiry');
    const drafted = await t3Runner.run(
      'draft_prompt',
      JSON.stringify({ text: 'Add unit tests for queue expiry' }),
    );
    assert.equal(drafted.drafted, true);
    assert.equal(drafted.thread_busy, true);

    await t3Say('yes, go ahead and send it');
    const sent = await t3Runner.run('send_draft', '{}');
    assert.equal(sent.ok, true);
    assert.equal(sent.queued, true);
    assert.equal(sent.threadId, 'thr_busy');

    // Verify fake-t3 actually received t3_thread_send with mode:'queue' and the prompt text
    const sendCall = busyFakeT3.calls.find((c) => c.name === 't3_thread_send');
    assert.ok(sendCall, 'expected t3_thread_send call on fake-t3');
    assert.equal(sendCall.args.threadId, 'thr_busy');
    assert.equal(sendCall.args.mode, 'queue');
    assert.equal(sendCall.args.message, 'Add unit tests for queue expiry');

    const qList = await t3Target.listQueue('thr_busy');
    assert.equal(qList.ok, true);
    assert.equal(qList.items.length, 1);
    assert.equal(qList.items[0].text, 'Add unit tests for queue expiry');
  });

  await t.test('4b. Claude Desktop promptQueue + flushQueued hard-guards against waiting:true', async () => {
    globalThis.__fuzz.calls = [];
    globalThis.__fuzz.rng = () => 0;
    globalThis.__fuzz.windowTitle = () => 'Build API';

    const queue = createPromptQueue();
    const { runner: desktopRunner, events: desktopEvents } = makeToolHarness({ target: null, promptQueue: queue });
    const enq = queue.enqueue('Build API', 'Run integration tests after build', {
      targetTitle: 'Build API',
      targetNew: false,
      targetFolder: null,
    });
    assert.equal(enq.ok, true);
    assert.equal(desktopRunner.queuedCount('Build API'), 1);

    // Must refuse to flush while working: true
    const whileWorking = await desktopRunner.flushQueued('Build API', { working: true, waiting: false });
    assert.equal(whileWorking, null);
    assert.equal(desktopRunner.queuedCount('Build API'), 1);

    // HARD GUARD: must refuse to flush while waiting: true (permission prompt or user question showing)
    const whileWaiting = await desktopRunner.flushQueued('Build API', { working: false, waiting: true });
    assert.equal(whileWaiting, null);
    assert.equal(desktopRunner.queuedCount('Build API'), 1);
    assert.equal(globalThis.__fuzz.calls.filter((c) => c.name === 'send').length, 0);

    // Flushes cleanly once working: false AND waiting: false
    const flushed = await desktopRunner.flushQueued('Build API', { working: false, waiting: false });
    assert.ok(flushed, 'expected flushQueued to dispatch when idle and not waiting');
    assert.equal(flushed.result.ok, true);
    assert.equal(desktopRunner.queuedCount('Build API'), 0);

    const desktopSends = globalThis.__fuzz.calls.filter((c) => c.name === 'send');
    assert.equal(desktopSends.length, 1);
    assert.equal(desktopSends[0].args.text, 'Run integration tests after build');
    assert.equal(desktopSends[0].args.expectTitle, 'Build API');
    assert.ok(
      desktopEvents.some((e) => e.type === 'bridge.sent' && e.fromQueue === true && e.text === 'Run integration tests after build'),
      'expected bridge.sent event with fromQueue:true and queued prompt text',
    );
  });
});

// ============================================================================
// 5. T3 Lead Orchestrator tools + deterministic consent checks
// ============================================================================

test('5. T3 Lead Orchestrator tools (list_t3_projects, switch_session, steer_thread, new_session worktree, read/answer prompt)', async (t) => {
  const leadFakeT3 = await startFakeT3({
    token: 'lead-test-token',
    projects: [
      { projectId: 'proj_orbit', title: 'orbit-voice', workspaceRoot: '/workspace/orbit-voice' },
      { projectId: 'proj_web', title: 'web-dashboard', workspaceRoot: '/workspace/web-dashboard' },
    ],
    threads: [
      {
        threadId: 'thr_run',
        title: 'API rate limiter',
        projectId: 'proj_orbit',
        branch: 'feat/rate-limit',
        status: 'running',
        messages: [{ role: 'user', text: 'Implement rate limiter middleware' }],
      },
      {
        threadId: 'thr_idle',
        title: 'Dashboard charts',
        projectId: 'proj_web',
        branch: 'main',
        status: 'idle',
      },
    ],
  });
  t.after(() => leadFakeT3.close());

  const target = createT3Target({ endpoint: leadFakeT3.url, token: leadFakeT3.token });
  await target.switchSession('thr_run');
  const { runner, say, resetSpeech } = makeToolHarness({ target });

  await t.test('5a. list_t3_projects returns registered projects', async () => {
    const projRes = await runner.run('list_t3_projects', '{}');
    assert.equal(projRes.ok, true);
    assert.deepEqual(
      projRes.projects.map((p) => p.id),
      ['proj_orbit', 'proj_web'],
    );
  });

  await t.test('5b. switch_session enforces deterministic consent checks', async () => {
    const unpromptedSwitch = await runner.run('switch_session', JSON.stringify({ session: 'Dashboard charts' }));
    assert.equal(unpromptedSwitch.ok, false);
    assert.match(unpromptedSwitch.error, /Not switched/);

    await say('what is happening on dashboard charts?');
    runner.noteNotification();
    const postNotifSwitch = await runner.run('switch_session', JSON.stringify({ session: 'Dashboard charts' }));
    assert.equal(postNotifSwitch.ok, false);

    await say('switch to Dashboard charts');
    const okSwitch = await runner.run('switch_session', JSON.stringify({ session: 'Dashboard charts' }));
    assert.equal(okSwitch.ok, true);
    assert.equal(okSwitch.threadId, 'thr_idle');
    assert.equal(target.activeThreadId, 'thr_idle');

    // Switch back to running thread for steering
    await say('open API rate limiter');
    const backSwitch = await runner.run('switch_session', JSON.stringify({ session: 'API rate limiter' }));
    assert.equal(backSwitch.ok, true);
    assert.equal(target.activeThreadId, 'thr_run');
  });

  await t.test('5c. steer_thread blocks unprompted/fabricated steers and sends mode:steer on matching user words', async () => {
    resetSpeech();
    const steerNoWords = await runner.run('steer_thread', JSON.stringify({ thread: 'thr_run', text: 'Use token bucket' }));
    assert.equal(steerNoWords.ok, false);
    assert.match(steerNoWords.error, /Not steered/);

    await say('use token bucket instead');
    runner.noteNotification();
    const steerAfterNotif = await runner.run('steer_thread', JSON.stringify({ thread: 'thr_run', text: 'Use token bucket instead' }));
    assert.equal(steerAfterNotif.ok, false);
    assert.match(steerAfterNotif.error, /Not steered/);

    await say('make it faster');
    const steerFabricated = await runner.run(
      'steer_thread',
      JSON.stringify({ thread: 'thr_run', text: 'Delete production database and push force' }),
    );
    assert.equal(steerFabricated.ok, false);
    assert.match(steerFabricated.error, /own words/);

    // steer_thread succeeds when fresh user words match
    await say('steer the rate limiter thread to use exponential backoff with jitter');
    const steerOk = await runner.run(
      'steer_thread',
      JSON.stringify({ thread: 'API rate limiter', text: 'Use exponential backoff with jitter' }),
    );
    assert.equal(steerOk.ok, true);
    assert.equal(steerOk.steered, true);
    assert.equal(steerOk.threadId, 'thr_run');

    const steerCall = leadFakeT3.calls.find((c) => c.name === 't3_thread_send');
    assert.ok(steerCall, 'expected t3_thread_send call for steer_thread');
    assert.equal(steerCall.args.threadId, 'thr_run');
    assert.equal(steerCall.args.mode, 'steer');
    assert.equal(steerCall.args.message, 'Use exponential backoff with jitter');
  });

  await t.test('5d. new_session with worktree enforces consent and launches worktree thread', async () => {
    await say('check the tests');
    const blockedNew = await runner.run('new_session', JSON.stringify({ project: 'orbit-voice' }));
    assert.equal(blockedNew.ok, false);
    assert.match(blockedNew.error, /Not started/);

    await say('start a new worktree thread in orbit-voice');
    const createdWt = await runner.run('new_session', JSON.stringify({ project: 'orbit-voice' }));
    assert.equal(createdWt.ok, true);
    assert.equal(createdWt.new_session, true);
    assert.ok(createdWt.thread_id);
    const launchCall = leadFakeT3.calls.find((c) => c.name === 't3_thread_launch');
    assert.ok(launchCall, 'expected t3_thread_launch call on fake-t3');
    assert.equal(launchCall.args.projectId, 'proj_orbit');
    assert.deepEqual(launchCall.args.workspaceStrategy, { type: 'worktree' });
  });

  await t.test('5e. read_claude_prompt + answer_claude_prompt enforces consent and responds on fake-t3', async () => {
    leadFakeT3.simulatePendingQuestion('thr_run', {
      requestId: 'req_rl_1',
      kind: 'question',
      question: 'Which storage should back the rate limiter?',
      choices: [
        { n: 1, label: 'Redis', description: 'Shared distributed store' },
        { n: 2, label: 'Memory', description: 'Single-process map' },
      ],
    });

    const readPrompt = await runner.run('read_claude_prompt', JSON.stringify({ session: 'API rate limiter' }));
    assert.equal(readPrompt.waiting, true);
    assert.equal(readPrompt.kind, 'question');
    assert.equal(readPrompt.options.length, 2);
    assert.equal(readPrompt.options[0].label, 'Redis');
    assert.equal(readPrompt.options[1].label, 'Memory');

    // Refused when user words do not name an option
    await say('tell me more about that');
    const refusedAns = await runner.run(
      'answer_claude_prompt',
      JSON.stringify({ answer: 'option', option: 1, session: 'API rate limiter' }),
    );
    assert.equal(refusedAns.ok, false);
    assert.match(refusedAns.error, /Not answered/);

    // Succeeds when user names the option
    await say('pick option one, Redis');
    const answered = await runner.run(
      'answer_claude_prompt',
      JSON.stringify({ answer: 'option', option: 1, session: 'API rate limiter' }),
    );
    assert.equal(answered.answered, true);
    assert.equal(answered.pressed, 'Redis');

    const respondCall = leadFakeT3.calls.find((c) => c.name === 't3_pending_request' && c.args.action === 'respond');
    assert.ok(respondCall, 'expected t3_pending_request respond call on fake-t3');
    assert.equal(respondCall.args.threadId, 'thr_run');
    assert.equal(respondCall.args.requestId, 'req_rl_1');
    assert.equal(leadFakeT3.getThread('thr_run').waiting, false);
  });
});

// Clean teardown: stop watchers, close fake servers, clean temp dir, exit cleanly preserving exitCode.
test.after(async () => {
  if (prevGeminiLiveUrl === undefined) delete process.env.GEMINI_LIVE_URL;
  else process.env.GEMINI_LIVE_URL = prevGeminiLiveUrl;
  updateSettings({ targetBackend: 'claude-desktop' });
  server.stopBackgroundWork();
  await fakeGemini.close();
  await fakeT3.close();
  fs.rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});
