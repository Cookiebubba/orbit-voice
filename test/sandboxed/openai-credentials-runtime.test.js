// Actual authenticated HTTP/voice routes with fake environment, registry, store, host and provider.
// Run with --import ./test/fuzz/register.mjs. No real credentials, provider, audio or OS input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { WebSocket } from 'ws';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-credentials-http-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'Never automate any window' };
const { createOpenAICredentials } = await import('../../electron/openai-credentials.js');
const { createExternalHost, selectExternalHost } = await import('../../src/external-host.js');
const config = await import('../../src/config.js');
const server = await import('../../src/server.js');
const userKey = 'sk-fixture-runtime-user-credential-0000';
const savedKey = 'sk-fixture-runtime-saved-credential-000';
const machineKey = 'sk-fixture-runtime-machine-key-000000';
let startupRelease;
let registryCalls = 0, systemValue = userKey, savedValue = '', savedError = false, failSave = false, savedReads = 0;
let gate = { promise: new Promise((resolve) => { startupRelease = resolve; }) };
const native = createOpenAICredentials({ env: {}, platform: 'win32', timeoutMs: 1000, registry: async (scope) => {
  registryCalls++;
  if (gate) return gate.promise;
  return scope === 'user' ? systemValue : null;
} });
const mem = () => ({ kind: 'memory', get: () => '', set() {} });
const saved = { kind: 'memory', get: () => savedValue, readState: () => { savedReads++; return savedError ? { state: 'error', present: true } : savedValue ? { state: 'present', key: savedValue } : { state: 'absent' }; }, set: (v) => { if (failSave) throw new Error(savedKey); savedError = false; savedValue = v; } };
const host = createExternalHost({ descriptor: { protocol: 1, instanceId: 'credential-fixture', url: 'http://127.0.0.1:33333', token: 'fixture-host-token-not-a-real-secret' }, pollMs: 100000, fetchImpl: async (url, options) => {
  const route = new URL(url).pathname.replace('/orbit/v1', '');
  const body = options.body && JSON.parse(options.body);
  if (route === '/host') return new Response(JSON.stringify({ protocol: 1, instanceId: 'credential-fixture', capabilities: ['sessions.read', 'sessions.focus', 'requests.observe', 'orchestrator.submit'], focusedSessionId: 'a', sessions: [{ id: 'a', generation: 'one', title: 'Fixture' }], window: null }));
  if (route === '/utterances') return new Response(JSON.stringify({ id: body.id, instanceId: 'credential-fixture', target: { sessionId: 'a', generation: 'one' } }));
  throw new Error('Unexpected fake host route');
} });
await host.start(); selectExternalHost(host);
class Voice extends EventEmitter {
  readyState = 1;
  sent = [];
  send(json) { this.sent.push(JSON.parse(json)); }
  event(evt) { this.emit('message', Buffer.from(JSON.stringify(evt)), false); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000, Buffer.from(savedKey)); }
}
const providers = [], keySnapshots = [], broadcast = [], browserEvents = [], httpBodies = [];
let throwFactory = false;
const offTap = server.tapBroadcast((e) => broadcast.push(e));
const port = await new Promise((resolve) => { const p = net.createServer(); p.listen(0, '127.0.0.1', () => { const value = p.address().port; p.close(() => resolve(value)); }); });
const origin = `http://127.0.0.1:${port}`;
await server.startServer({ port, configDir: path.join(root, 'cfg'), secrets: mem(), brainSecrets: mem(), openaiSecrets: saved, openaiCredentials: native, pairedOpenAI: true, importEnv: false, realtimeFactory: ({ apiKey }) => {
  if (throwFactory) throw new Error(apiKey);
  keySnapshots.push(apiKey);
  const provider = new Voice(); providers.push(provider); setImmediate(() => provider.emit('open')); return provider;
} });
config.updateSettings({ voiceEngine: 'openai', brainEnabled: false, announce: 'off' });
const cookie = await new Promise((resolve) => { http.get(new URL(server.authUrl()), (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }); });
const request = async (route, body, overrides = {}) => {
  const r = await fetch(`${origin}${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { cookie, origin, 'content-type': 'application/json' }, ...overrides });
  const text = await r.text(); httpBodies.push(text);
  return { status: r.status, data: JSON.parse(text) };
};
const waitFor = async (predicate) => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 5)); } assert.fail('Fake credential runtime condition timed out'); };
const openVoice = async () => {
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/voice`, { headers: { origin, cookie } });
  const events = []; ws.on('message', (bytes) => { const event = JSON.parse(bytes); events.push(event); browserEvents.push(event); });
  const closed = new Promise((resolve) => ws.once('close', resolve));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, events, closed };
};

// One server per test worker; subtests deliberately sequence account/source changes through it.
test('authenticated credential HTTP and cached voice runtime', async (t) => {
  await t.test('registry-only first startup publishes pending then effective availability without another helper per read', async () => {
    const before = await request('/api/config');
    assert.equal(before.data.hasKey, false);
    assert.equal(before.data.openai.pending, true);
    const chunks = [];
    const stream = http.get(`${origin}/api/events`, { headers: { cookie } }, (res) => res.on('data', (bytes) => chunks.push(bytes.toString())));
    stream.on('error', () => {});
    try {
      await waitFor(() => chunks.join('').includes('"pending":true'));
      const count = providers.length;
      const early = await openVoice(); await early.closed;
      assert.equal(providers.length, count);
      const calls = registryCalls;
      gate = null; startupRelease(userKey);
      await waitFor(() => chunks.join('').includes('"pending":false') && config.getOpenAIStatus().available);
      const ready = await request('/api/config');
      assert.equal(ready.data.openai.effectiveSource, 'user');
      assert.equal(ready.data.hasKey, true);
      assert.equal(registryCalls, calls);
      assert.equal(chunks.join('').includes(userKey), false);
    } finally { stream.destroy(); }
  });
  await t.test('host reflection exposes only validated optional Auto metadata and legacy fixed mode', async () => {
    const snapshot = host.snapshot(), capabilities = snapshot.capabilities;
    snapshot.mode = 'desktop';
    snapshot.avatarRoam = { schema: 1, policy: 'auto', geometry: 'never-show-geometry' };
    try {
      assert.equal((await request('/api/external-host')).data.avatarRoam, null);
      snapshot.capabilities = [...capabilities, 'avatar.roam.v1'];
      const supported = await request('/api/external-host');
      assert.deepEqual(supported.data.avatarRoam, { schema: 1, policy: 'auto' });
      assert.equal(supported.data.mode, 'desktop');
      assert.equal(JSON.stringify(supported.data).includes('never-show-geometry'), false);
      snapshot.avatarRoam.schema = '1';
      assert.equal((await request('/api/external-host')).data.avatarRoam, null);
      snapshot.avatarRoam = { schema: 1, policy: 'desktop' };
      assert.equal((await request('/api/external-host')).data.avatarRoam, null);
    } finally { snapshot.capabilities = capabilities; delete snapshot.mode; delete snapshot.avatarRoam; }
  });
  await t.test('refresh endpoint requires session, same origin and non-cross-site request', async () => {
    const calls = registryCalls;
    for (const headers of [{ origin }, { cookie, origin: 'https://other.invalid' }, { cookie, origin, 'sec-fetch-site': 'cross-site' }]) {
      const r = await request('/api/openai/refresh', {}, { headers });
      assert.ok([401, 403].includes(r.status));
    }
    assert.equal(registryCalls, calls);
    assert.equal((await request('/api/openai/key', { key: 'sk-short' })).status, 400);
  });
  await t.test('config reports system availability separately from saved presence, with no helper/store per read', async () => {
    const before = { calls: registryCalls, reads: savedReads };
    for (let n = 0; n < 10; n++) {
      const r = await request('/api/config');
      assert.equal(r.data.hasKey, true);
      assert.equal(r.data.hasOpenAIKey, false);
      assert.equal(r.data.openai.effectiveSource, 'user');
      assert.equal(r.data.settings.openaiKeySource, 'saved-or-system');
    }
    assert.deepEqual({ calls: registryCalls, reads: savedReads }, before);
  });
  await t.test('source changes leave active call on its snapshot and clear continuity only for the next call', async () => {
    const a = await openVoice();
    await waitFor(() => a.events.some((e) => e.type === 'bridge.ready'));
    assert.equal(keySnapshots[0], userKey);
    a.ws.send(JSON.stringify({ type: 'ui.text', text: 'Private previous-account resume marker' }));
    await waitFor(() => providers[0].sent.some((e) => e.item?.content?.some((c) => c.text?.includes('resume marker'))));
    const savedResult = await request('/api/openai/key', { key: savedKey });
    assert.equal(savedResult.data.hasOpenAIKey, true);
    assert.equal(savedResult.data.openai.effectiveSource, 'saved');
    await request('/api/settings', { openaiKeySource: 'saved' });
    assert.equal(providers.length, 1);
    assert.equal(keySnapshots[0], userKey);
    assert.equal(providers[0].readyState, 1);
    a.ws.close(); await a.closed;
    await waitFor(() => providers[0].readyState === 3);
    const b = await openVoice();
    await waitFor(() => b.events.some((e) => e.type === 'bridge.ready'));
    assert.equal(keySnapshots[1], savedKey);
    assert.equal(JSON.stringify(providers[1].sent).includes('previous-account'), false);
    const before = providers.length;
    providers[1].emit('error', new Error(savedKey));
    providers[1].event({ type: 'error', error: { code: savedKey, message: savedKey } });
    providers[1].event({ type: 'session.created', secret: savedKey });
    await waitFor(() => b.events.some((e) => e.type === 'bridge.error'));
    assert.equal(providers.length, before, 'authentication failure never switches provider or key');
    assert.equal(config.getSetting('openaiKeySource'), 'saved');
    b.ws.close(); await b.closed;
  });
  await t.test('saving and removing an Orbit key do not change the system credential, including corrupt-store failure', async () => {
    await request('/api/settings', { openaiKeySource: 'system' });
    const removed = await request('/api/openai/key', { key: '' });
    assert.equal(removed.data.hasOpenAIKey, false);
    assert.equal(removed.data.hasKey, true);
    assert.equal(native.get().key, userKey);
    assert.equal(savedValue, '');
    savedError = true;
    await request('/api/settings', { openaiKeySource: 'saved-or-system' });
    await request('/api/openai/refresh', {});
    const broken = await request('/api/config');
    assert.equal(broken.data.hasOpenAIKey, true);
    assert.equal(broken.data.hasKey, false);
    assert.equal(broken.data.openai.error, 'saved-unreadable');
    const count = providers.length;
    const blocked = await openVoice(); await blocked.closed;
    assert.equal(providers.length, count);
    assert.match(blocked.events.find((e) => e.type === 'bridge.error').message, /not switched/);
    failSave = true;
    assert.equal((await request('/api/openai/key', { key: savedKey })).status, 503);
    failSave = false;
    await request('/api/openai/key', { key: '' });
    assert.equal(native.get().key, userKey);
  });
  await t.test('disconnect while refresh is pending cannot create a late provider; HTTP refresh is deduplicated', async () => {
    await request('/api/settings', { openaiKeySource: 'system' });
    systemValue = null;
    await request('/api/openai/refresh', {});
    assert.equal(config.getOpenAIStatus().available, false);
    let release;
    gate = { promise: new Promise((r) => { release = r; }) };
    const calls = registryCalls, count = providers.length;
    const a = request('/api/openai/refresh', {}), b = request('/api/openai/refresh', {});
    await waitFor(() => native.status().pending);
    const early = await openVoice(); await early.closed;
    assert.match(early.events.find((e) => e.type === 'bridge.error').message, /being checked/);
    assert.equal(providers.length, count);
    release(machineKey); gate = null;
    await Promise.all([a, b]);
    assert.equal(registryCalls, calls + 1);
    assert.equal(config.getOpenAIStatus().available, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(providers.length, count, 'late credential completion cannot reopen a disconnected voice');
    throwFactory = true;
    const failed = await openVoice(); await failed.closed;
    assert.match(failed.events.find((e) => e.type === 'bridge.error').message, /could not connect/);
    throwFactory = false;
  });
  await t.test('serialized HTTP, events, errors, logs and settings never contain native credentials or account digests', async () => {
    const logs = await request('/api/logs');
    const serialized = JSON.stringify({ httpBodies, browserEvents, broadcast, logs }) + fs.readFileSync(path.join(root, 'cfg', 'settings.json'), 'utf8');
    for (const key of [userKey, savedKey, machineKey]) assert.equal(serialized.includes(key), false);
    assert.equal(/fingerprint|digest|keyHash/.test(serialized), false);
    assert.equal(globalThis.__fuzz.calls.some((c) => /desktop|sendToDesktop|fillDesktop|answerPrompt/i.test(String(c.name))), false);
  });
});

test.after(async () => {
  offTap(); host.stop(); selectExternalHost(null); await server.closeServer();
  fs.rmSync(root, { recursive: true, force: true });
});
