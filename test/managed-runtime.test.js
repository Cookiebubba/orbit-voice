import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedRuntime, safeRendererStatus } from '../electron/managed-runtime.js';
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  let scheduled, now = 10000, commands = [], fail = false, quit = 0;
  const reports = [], sent = [], writes = [];
  const renderer = { rendererReady: true, phase: 'off', microphone: 'off', muted: false, credentialAvailable: true };
  const f = createManagedRuntime({
    host: { async heartbeat(status, acknowledgements, intentionalStop, runtimeStopped) {
      if (fail) throw new Error('fixture offline');
      reports.push({ status, acknowledgements, intentionalStop, runtimeStopped });
      commands = commands.filter((c) => !acknowledgements.includes(c.id));
      return { schema: 1, ownerEpoch: 'owner-a', leaseMs: 6000, intentionalStop, commands: structuredClone(commands) };
    } },
    identity: { runtimeId: 'runtime-a', pid: 42, buildId: 'a'.repeat(64) },
    getSettings: () => ({ voiceEngine: 'openai', openaiModel: 'gpt-realtime', openaiVoice: 'cedar', voiceVolume: 0.75, listenMode: 'always' }),
    getCredentials: () => ({ available: true, effectiveSource: 'process', key: 'sk-fixture-never-publish' }),
    send: (v) => sent.push(v), showSettings: () => writes.push('settings'), quit: () => quit++, setPreferences: (v) => writes.push(v),
    now: () => now, setTimer: (fn) => { scheduled = fn; return 1; }, clearTimer() {},
  });
  return { f, sent, reports, writes, renderer, quits: () => quit,
    queue(id, command) { commands.push({ id, runtimeId: 'runtime-a', ownerEpoch: 'owner-a', remainingMs: 10000, command }); },
    fail: (v) => { fail = v; },
    async start() { f.start(); await flush(); },
    async next(ms = 750) { now += ms; assert.ok(scheduled); const fn = scheduled; scheduled = null; await fn(); await flush(); },
  };
}
test('hidden startup reports readiness metadata without starting audio or exposing secrets', async () => {
  const x = fixture(); await x.start();
  assert.equal(x.reports[0].status.rendererReady, false);
  assert.equal(x.reports[0].status.microphone, 'off');
  assert.equal(x.sent.some((m) => m.command.kind === 'start'), false);
  assert.equal(JSON.stringify(x.reports).includes('sk-fixture'), false);
  assert.equal(x.f.update(x.renderer), true);
  await x.next(); assert.equal(x.reports.at(-1).status.rendererReady, true);
  assert.equal(safeRendererStatus({ ...x.renderer, token: 'fixture' }), null);
  x.f.stop();
});
test('start is consumed once, unknown/rejected outcomes are not replayed, and acknowledgements mean applied', async () => {
  const x = fixture(); await x.start(); x.f.update(x.renderer);
  x.queue('start-1', { kind: 'start' }); await x.next();
  const start = x.sent.find((m) => m.id === 'start-1');
  assert.ok(start.expiresAt > 10000);
  await x.next(); await x.next();
  assert.equal(x.sent.filter((m) => m.id === 'start-1').length, 1);
  assert.equal(x.reports.at(-1).acknowledgements.length, 0);
  assert.equal(x.f.acknowledge('start-1', false), true);
  await x.next(); assert.equal(x.sent.filter((m) => m.id === 'start-1').length, 1);
  x.queue('stop-1', { kind: 'stop' }); await x.next();
  x.f.acknowledge('stop-1', true); await x.next();
  assert.deepEqual(x.reports.at(-1).acknowledgements, ['stop-1']);
  assert.equal(x.f.acknowledge('not-issued', true), false);
  x.f.stop();
});
test('owner lease loss stops audio without any reconnect start', async () => {
  const x = fixture(); await x.start(); x.f.update({ ...x.renderer, phase: 'listening', microphone: 'active' });
  x.fail(true); await x.next(6001);
  assert.equal(x.sent.at(-1).command.kind, 'stop');
  assert.equal(x.sent.some((m) => m.command.kind === 'start'), false);
  x.fail(false); await x.next();
  assert.equal(x.sent.some((m) => m.command.kind === 'start'), false);
  x.f.stop();
});
test('graceful quit is recorded only after renderer audio is actually off', async () => {
  const x = fixture(); await x.start(); x.f.update({ ...x.renderer, phase: 'speaking', microphone: 'active' });
  x.queue('quit-1', { kind: 'quit' }); await x.next();
  assert.equal(x.quits(), 0); assert.equal(x.sent.at(-1).command.kind, 'stop');
  x.f.acknowledge('quit-1', true); await x.next();
  assert.equal(x.quits(), 0, 'receipt alone cannot prove device release');
  x.f.update(x.renderer); await x.next();
  assert.equal(x.quits(), 1);
  assert.equal(x.reports.at(-1).runtimeStopped, true);
  assert.equal(x.reports.at(-1).intentionalStop, true);
  x.f.stop();
});
test('control acknowledgement batches stay bounded across many native actions', async () => {
  const x = fixture(); await x.start(); x.f.update(x.renderer);
  for (let i = 0; i < 40; i++) {
    x.queue(`mute-${i}`, { kind: 'setMute', muted: true }); await x.next();
    x.f.acknowledge(`mute-${i}`, true);
  }
  await x.next();
  assert.ok(x.reports.every((r) => r.acknowledgements.length <= 16));
  x.f.stop();
});
