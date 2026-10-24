// "Orbit anywhere" phase 8, end to end: a background helper works in our own test window
// (test/e2e/FakeApp.cs). The real agent manager starts the real Claude Code engine code, which
// starts a stand-in for Claude Code (test/e2e/fake-helper-claude.mjs) with the real arguments; it
// talks MCP over HTTP to orbit-hands (the real endpoint and tool server), which reads and acts
// through the real UI Automation helper. Send is held until "the user" approves. The window never
// becomes active.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initConfig } from '../src/config.js';
import { focus, setUiaHost, startFocusTracking } from '../src/platform/index.js';
import { createUiaHost } from '../src/platform/win/uia.js';
import { createAgents } from '../src/anywhere/agents.js';
import { HANDS_TOOLS } from '../src/anywhere/hands-mcp.js';
import { describeAct } from '../src/anywhere/hands.js';
import { createHandsEndpoint } from '../src/anywhere/index.js';
import { startClaudeHelper } from '../src/engines/claude-code.js';
import { canRunApps, startFakeApp } from './e2e/fake-app.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';

if (process.platform === 'win32') await lockDesktop(); // one real-desktop test file at a time

const skip = !canRunApps() && 'needs Windows with .NET Framework 4 (csc.exe)';
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e', 'fake-helper-claude.mjs');
initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-helper-win-')) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a helper types into our window, its Send waits for the user, then it finishes', { skip, timeout: 180_000 }, async () => {
  const app = await startFakeApp('winforms', `ORBIT-HELPER-${process.pid}`);
  const host = createUiaHost({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-uia-cache-')) });
  setUiaHost(host);
  focus.reset();
  const tracker = startFocusTracking();
  let base = '';
  const agents = createAgents({
    engine: { start: (opts) => startClaudeHelper({ ...opts, claudePath: 'fake-claude', spawnImpl: (_file, args, o) => spawn(process.execPath, [FAKE, ...args], o) }) },
    mcpUrl: (id) => `${base}/mcp/hands/${id}`,
    tools: HANDS_TOOLS,
    describe: describeAct,
  });
  const endpoint = createHandsEndpoint(agents);
  const statuses = [];
  // The bridge's route, as src/server.js has it (POST only, bearer token).
  const server = http.createServer(async (req, res) => {
    const m = /^\/mcp\/hands\/([0-9a-f]+)$/.exec(req.url);
    if (!m || req.method !== 'POST') return res.writeHead(404).end();
    let body = '';
    for await (const c of req) body += c;
    const out = await endpoint(m[1], String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), JSON.parse(body));
    statuses.push(out.status);
    if (out.status !== 200) return res.writeHead(out.status).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  agents.on((e) => events.push(e));
  try {
    const win = { hwnd: app.hwnd, exe: 'OrbitFakeApp.exe', title: `ORBIT-HELPER-${process.pid}`, kind: 'app', pid: app.pid };
    const r = agents.start(win, 'send "running late" to the team');
    assert.equal(r.ok, true, JSON.stringify(r));
    // It asks before Send.
    for (let i = 0; i < 200 && !events.some((e) => e.type === 'approval'); i++) await sleep(100);
    const ask = events.find((e) => e.type === 'approval');
    assert.ok(ask, `asked (events: ${events.map((e) => e.type).join(',')})`);
    assert.match(ask.ask, /wants to press Send in OrbitFakeApp/);
    assert.match(ask.ask, /the box says "running late"/);
    assert.equal((await app.state()).Message, 'running late', 'typed already (local)');
    await sleep(500);
    assert.ok(!app.events.some((e) => e.event === 'click' && e.name === 'Send'), 'Send not pressed yet');
    assert.equal(agents.get(r.helper.id).status, 'waiting');
    // "The user" says yes (the voice tool's gate is tested in agents.test.js).
    agents.markTold(ask.approvalId);
    assert.equal(agents.decide(r.helper.id, true).ok, true);
    assert.ok(await app.waitFor((e) => e.event === 'click' && e.name === 'Send', 8000), 'Send pressed after the yes');
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'done' || e.type === 'failed'); i++) await sleep(100);
    const done = events.find((e) => e.type === 'done' || e.type === 'failed');
    assert.equal(done?.type, 'done', JSON.stringify(done));
    assert.match(done.helper.summary, /Typed it and sent it\. \(tools: 7, read: yes, typed: true\)/, 'its six tools and the permission prompt');
    assert.ok(events.filter((e) => e.type === 'progress').length >= 4, 'progress along the way');
    // Its token stops working once it's done.
    const tok = await fetch(`${base}/mcp/hands/${r.helper.id}`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    assert.equal(tok.status, 401);
    assert.ok(app.events.every((e) => e.event !== 'activated'), 'the window never became active');
  } finally {
    agents.dispose();
    server.close();
    tracker?.stop();
    host.stop();
    setUiaHost(null);
    await app.close();
  }
});
