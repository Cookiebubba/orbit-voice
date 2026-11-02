// Real hidden Electron/React/server, a protected loopback host and fake audio/provider.
// This driver never pairs with a running host, touches a real microphone or uses a real API key.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'public/index.html'))) throw new Error('Run npm run build:ui first.');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-managed-acceptance-'));
const evidence = path.join(scratch, 'evidence');
const descriptor = path.join(scratch, 'connection.json');
const token = crypto.randomBytes(32).toString('hex');
const lineage = crypto.randomUUID();
let epoch = crypto.randomUUID(), status = null, statusEpoch = null, child = null, exit = null;
let intentionalStop = false, stopped = false;
const commands = new Map();
const capabilities = ['sessions.read', 'orchestrator.submit', 'requests.observe', 'voice.lifecycle.v1', 'tools.v1'];
const catalog = { schema: 1, revision: 'fixture-v1', tools: ['read_session', 'read_chat', 'coordination_snapshot', 'coordination_task'].map((name) => ({
  name, effect: 'read',
  description: 'Read only fixture data.', scope: 'pinned', inputSchema: { type: 'object', additionalProperties: false, properties: {} },
})) };
const server = http.createServer(async (request, response) => {
  const json = (code, body) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'fixture authentication required' });
  const route = new URL(request.url, 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && route === '/orbit/v1/host') return json(200, { protocol: 1, instanceId: epoch, name: 'Fixture host',
    lineage, ownerEpoch: epoch, mode: 'attached', window: null, focusedSessionId: null, sessions: [], capabilities, toolCatalogRevision: catalog.revision });
  if (request.method === 'GET' && route === '/orbit/v1/tools/catalog') return json(200, catalog);
  if (request.method === 'GET' && route === '/orbit/v1/events') return json(200, { events: [], cursor: 0, gap: false });
  if (request.method === 'POST' && route === '/orbit/v1/runtime/heartbeat') {
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 64 * 1024) throw new Error('large fixture request'); }
      const heartbeat = JSON.parse(body);
      if (heartbeat.lineage !== lineage || heartbeat.ownerEpoch !== epoch) return json(409, { error: 'owner changed' });
      assert.equal(heartbeat.status.pid, child.pid);
      assert.match(heartbeat.status.buildId, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(heartbeat).includes('sk-managed-fixture'), false);
      status = heartbeat.status; statusEpoch = epoch;
      intentionalStop = heartbeat.intentionalStop; stopped = heartbeat.runtimeStopped;
      for (const id of heartbeat.acknowledgements) commands.delete(id);
      return json(200, { schema: 1, ownerEpoch: epoch, leaseMs: 6000, intentionalStop: false,
        commands: [...commands].map(([id, command]) => ({ id, runtimeId: status.runtimeId, ownerEpoch: epoch, remainingMs: 8000, command })) });
    } catch { return json(400, { error: 'invalid fixture heartbeat' }); }
  }
  return json(404, { error: 'unsupported fixture route' });
});
const waitFor = async (condition, label, timeout = 18000) => {
  const until = Date.now() + timeout;
  while (!condition()) {
    if (exit || Date.now() > until) throw new Error(`Managed acceptance failed: ${label}. Evidence: ${evidence}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const report = () => { try { return JSON.parse(fs.readFileSync(path.join(evidence, 'report.json'), 'utf8')); } catch { return {}; } };
const queue = (command) => commands.set(crypto.randomUUID(), command);
let avatarSequence = 0;
const avatarAction = async (action) => {
  const sequence = ++avatarSequence;
  const file = path.join(evidence, 'avatar-action.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ sequence, action })); fs.renameSync(`${file}.tmp`, file);
  await waitFor(() => report().avatarActionSequence === sequence, `avatar ${action} dispatch`);
};
const protect = (file) => {
  if (process.platform !== 'win32') return fs.chmodSync(file, 0o600);
  const windows = process.env.SystemRoot || 'C:/Windows';
  const principal = execFileSync(path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!/^S-1-5-[0-9-]+$/.test(principal)) throw new Error('Could not identify the fixture owner.');
  execFileSync(path.join(windows, 'System32/icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${principal}:(F)`], { windowsHide: true, stdio: 'ignore' });
};
const publishDescriptor = (url) => {
  const temporary = `${descriptor}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ protocol: 1, instanceId: epoch, lineage, ownerEpoch: epoch, url, token }), { mode: 0o600 });
  protect(temporary);
  fs.renameSync(temporary, descriptor);
};
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  publishDescriptor(url);
  fs.mkdirSync(evidence);
  const stdout = fs.openSync(path.join(evidence, 'stdout.log'), 'w'), stderr = fs.openSync(path.join(evidence, 'stderr.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [path.join(root, 'scripts/managed-runtime-e2e.mjs'), '--host-managed', '--external-host-file', descriptor,
    '--acceptance-dir', evidence], { cwd: root, env, windowsHide: true, stdio: ['ignore', stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr);
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  child.on('error', () => { exit = { code: -1 }; });
  await waitFor(() => status?.rendererReady && report().startup, 'hidden startup');
  assert.equal(status.phase, 'off'); assert.equal(status.microphone, 'off');
  assert.equal(report().startup.microphoneOpens, 0);
  assert.equal(report().startup.providerStarts, 0);
  assert.equal(report().startup.visible, false);
  queue({ kind: 'start' });
  await waitFor(() => status?.phase === 'listening' && status.microphone === 'active', 'explicit start');
  queue({ kind: 'setMute', muted: true }); await waitFor(() => status?.muted === true, 'mute');
  await avatarAction('start'); await waitFor(() => status?.muted === false, 'avatar unmute');
  await avatarAction('sleep'); await waitFor(() => report().avatarVoice?.asleep === true && report().avatarVoice?.listening === false, 'original orb sleep');
  await avatarAction('start'); await waitFor(() => report().avatarVoice?.asleep === false && report().avatarVoice?.listening === true, 'avatar wake');
  await avatarAction('start'); // idempotent: never creates another voice socket or audio context
  queue({ kind: 'showSettings' }); await waitFor(() => report().settingsHidden, 'settings close preserves voice');
  assert.equal(status.phase, 'listening');
  const runtimeId = status.runtimeId;
  epoch = crypto.randomUUID(); commands.clear(); publishDescriptor(url);
  await waitFor(() => statusEpoch === epoch && status?.runtimeId === runtimeId && status.phase === 'listening', 'owner handover');
  assert.equal(report().providerStarts, 1); assert.equal(report().rendererIds.length, 1);
  assert.equal(report().renderer.contexts, 1); assert.equal(report().renderer.tracksStopped, 0);
  await waitFor(() => catalog.tools.every((tool) => report().tools?.includes(tool.name)), 'catalog recovery on the same provider socket');
  await avatarAction('stop');
  await waitFor(() => status?.phase === 'off' && status.microphone === 'off' && report().providerCloses === 1, 'stop releases fake devices');
  queue({ kind: 'quit' });
  await waitFor(() => exit !== null, 'clean quit');
  assert.equal(exit.code, 0); assert.equal(intentionalStop, true); assert.equal(stopped, true);
  const final = report();
  assert.deepEqual(final.errors, []);
  assert.equal(final.blockedChildren, 0); assert.equal(final.clipboardWrites, 0); assert.equal(final.desktopCalls, 0);
  assert.equal(final.renderer.contextsClosed, 1); assert.equal(final.renderer.tracksStopped, 1);
  console.log(`PASS managed startup, avatar unmute/wake/stop, settings, owner handover and device release: ${evidence}`);
} finally {
  if (child && !exit) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
  await new Promise((resolve) => server.close(resolve));
  // Preserve only this isolated fixture's evidence, never a reusable pairing credential.
  for (const file of [descriptor, `${descriptor}.tmp`]) { try { fs.unlinkSync(file); } catch {} }
}
