// Background helpers at the bridge ("Orbit anywhere", phase 8): the orbit-hands route's protections
// (POST only, a helper's own token, never from a browser), MCP over it, a held act reaching the
// voice as a notification, the user's yes through approve_task_action releasing it, and "Orbit,
// stop everything". Stand-ins: a fake Grok, a fake helper engine (no Claude Code), a fake window
// helper and UI Automation (no real windows). Claude's window is the fuzzer's fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-helpers-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { updateSettings } = await import('../../src/config.js');
const platform = await import('../../src/platform/index.js');
const anywhere = await import('../../src/anywhere/index.js');

// One app window, and UI Automation answers for it.
const WIN = { hwnd: 77, owner: 0, pid: 78, exe: 'Discord.exe', title: '#general - Discord', cls: 'Chrome_WidgetWin_1', kind: 'app', min: false, max: false, cloaked: false, elevated: false, x: 0, y: 0, w: 900, h: 700, dpi: 96 };
platform.setFocusBackend({ describe: async (h) => (h === 77 ? WIN : null), list: async () => [WIN], switchTo: async () => ({ switched: true, how: 'foreground' }) });
platform.focus.reset();
platform.focus.update(WIN);
const acts = [];
const NODES = [
  { i: 0, p: -1, t: 'Window', n: 'Discord', en: 1, r: [0, 0, 900, 700] },
  { i: 1, p: 0, t: 'Edit', n: 'Message', en: 1, pat: 'V', rid: 'r1', r: [10, 600, 500, 30] },
  { i: 2, p: 0, t: 'Button', n: 'Send', en: 1, pat: 'I', rid: 'r2', r: [520, 600, 60, 30] },
];
platform.setUiaHost({ request: async (op, args) => (op === 'scan' ? { ok: true, fw: 'Chrome', nodes: NODES } : op === 'act' ? (acts.push(args), { ok: true, verified: true }) : op === 'read' ? { ok: true, lines: ['hi'] } : { ok: false, error: 'x' }) });
// A helper engine stand-in: remembers how each helper was started.
const runs = [];
anywhere.useHelperEngine({ start: (opts) => (runs.push(opts), { send: () => true, stop: () => {}, pid: 1 }) });

// ---- the bridge, with a fake Grok ----
const PORT = 4397; // (each sandboxed test file has its own port)
const host = `127.0.0.1:${PORT}`;
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => fake.on('listening', r));
process.env.XAI_REALTIME_URL = `ws://127.0.0.1:${fake.address().port}`;
let up = null;
fake.on('connection', (sock) => {
  up = { sock, got: [] };
  const mine = up;
  sock.on('message', (m) => mine.got.push(JSON.parse(String(m))));
});
const grok = (e) => up.sock.readyState === WebSocket.OPEN && up.sock.send(JSON.stringify(e));
const watcher = { on() {}, start() {}, working: () => [] };
const server = await import('../../src/server.js');
const tools = await import('../../src/tools.js');
Object.assign(tools.TOOL_TIMING, { openSessionWaitMs: 0, newSessionWaitMs: 0 }); // the call's first look at Claude's session doesn't hold up the tools
const mem = (v) => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
await server.startServer({ port: PORT, configDir: path.join(root, 'cfg'), secrets: mem(`xai-${'k'.repeat(40)}`), brainSecrets: mem(''), clipboard: () => {}, models: root, watcher });
updateSettings({ avatar: 'none', announce: 'speak', wakeOnResults: true, brainEnabled: false, anywhere: true });
const cookie = await new Promise((resolve) => {
  const u = new URL(server.authUrl());
  http.get({ host: '127.0.0.1', port: PORT, path: u.pathname + u.search, headers: { host } }, (res) => resolve(String(res.headers['set-cookie'][0]).split(';')[0]));
});
async function page() {
  const ws = new WebSocket(`ws://${host}/voice`, { headers: { origin: `http://${host}`, cookie } });
  const events = [];
  ws.on('message', (m) => events.push(JSON.parse(String(m))));
  const closed = new Promise((r) => ws.on('close', r));
  for (let i = 0; i < 300 && !events.some((e) => e.type === 'bridge.ready'); i++) await wait(10);
  await wait(50);
  return { events, bye: async () => (ws.close(), await closed, await wait(60)) };
}
const say = async (id, text) => {
  grok({ type: 'input_audio_buffer.speech_started', item_id: id });
  await wait(10);
  grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
  await wait(80);
};
const callTool = async (name, args, callId) => {
  grok({ type: 'response.created', response: { id: `r-${callId}` } });
  grok({ type: 'response.function_call_arguments.done', response_id: `r-${callId}`, call_id: callId, name, arguments: JSON.stringify(args) });
  for (let i = 0; i < 250; i++) {
    const out = up.got.find((g) => g.item?.call_id === callId);
    if (out) return JSON.parse(out.item.output);
    await wait(20);
  }
  return null;
};
const post = (p, { headers = {}, body = {}, method = 'POST' } = {}) =>
  new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }));
    });
    req.end(data);
  });

test('orbit-hands at the bridge: POST only, never from a browser, only with the helper\x27s own token', async () => {
  const r = anywhere.agents.start(WIN, 'post the notes');
  assert.equal(r.ok, true);
  const { mcpUrl, token } = runs.at(-1);
  assert.equal(mcpUrl, `http://${host}/mcp/hands/${r.helper.id}`);
  const p = new URL(mcpUrl).pathname;
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  assert.equal((await post(p, { method: 'GET' })).status, 405);
  assert.equal((await post(p, { body: init })).status, 401, 'no token');
  assert.equal((await post(p, { body: init, headers: { authorization: 'Bearer ' + 'f'.repeat(48) } })).status, 401, 'wrong token');
  assert.equal((await post(p, { body: init, headers: { authorization: `Bearer ${token}`, origin: 'http://evil.example' } })).status, 403, 'a browser page');
  assert.equal((await post(p, { body: init, headers: { authorization: `Bearer ${token}`, host: 'evil.example' } })).status, 421, 'DNS rebinding');
  const ok = await post(p, { body: init, headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result.serverInfo.name, 'orbit-hands');
  assert.equal((await post(p, { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: { authorization: `Bearer ${token}` } })).status, 202);
  assert.equal(anywhere.agents.cancel(r.helper.id).ok, true);
  assert.equal((await post(p, { body: init, headers: { authorization: `Bearer ${token}` } })).status, 401, 'a stopped helper\x27s token is dead');
});

test('a held act reaches the voice; the user\x27s yes releases it; "stop everything" stops the rest', async () => {
  const pg = await page();
  const r = anywhere.agents.start(WIN, 'send the notes');
  const { mcpUrl, token } = runs.at(-1);
  const p = new URL(mcpUrl).pathname;
  const auth = { authorization: `Bearer ${token}` };
  const call = async (name, args, id) => JSON.parse((await post(p, { body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, headers: auth })).json.result.content[0].text);
  assert.equal((await call('act', { control: 'Message', action: 'set_text', text: 'the notes' }, 2)).ok, true);
  const held = await call('act', { control: 'Send', action: 'press' }, 3);
  assert.equal(held.held, true);
  // The voice is told (a call is on), naming the act and what's in the box.
  let notice = null;
  for (let i = 0; i < 100 && !notice; i++) {
    notice = up.got.find((g) => g.type === 'conversation.item.create' && /A background helper needs the user's OK/.test(g.item?.content?.[0]?.text || ''));
    await wait(20);
  }
  assert.ok(notice, 'notification sent');
  const text = notice.item.content[0].text;
  assert.match(text, /^\[App notification\]/);
  assert.match(text, /press Send in Discord/);
  assert.match(text, /the notes/);
  assert.equal(acts.filter((a) => a.action === 'press').length, 0, 'not pressed yet');
  // The model tries to approve before the user answered: refused.
  const early = await callTool('approve_task_action', { approve: true }, 'c1');
  assert.equal(early.ok, false);
  // The user says yes; the model approves; the helper's wait returns approved and Send is pressed.
  await say('u1', 'yes go ahead');
  const yes = await callTool('approve_task_action', { approve: true }, 'c2');
  assert.equal(yes.approved, true, JSON.stringify(yes));
  const res = await call('wait_for_approval', { approval_id: held.approval_id }, 4);
  assert.equal(res.state, 'approved');
  assert.equal(acts.filter((a) => a.action === 'press').length, 1);
  // "Take me there" right after a helper's question would switch to it (offered); a status check:
  const st = await callTool('task_status', { window: 'discord' }, 'c3');
  assert.equal(st.status, 'working');
  // "Orbit, stop everything": the fast path stops every helper, no model turn needed.
  anywhere.agents.start({ ...WIN, hwnd: 88, title: 'Other' }, 'x');
  const before = up.got.length;
  await say('u2', 'Orbit, stop everything');
  await wait(100);
  const note = up.got.slice(before).find((g) => /\[Orbit note: the user said to stop everything/.test(g.item?.content?.[0]?.text || ''));
  assert.ok(note, 'the note');
  assert.match(note.item.content[0].text, /all 2 helpers/);
  assert.equal(anywhere.agents.list().filter((h) => ['working', 'starting', 'waiting'].includes(h.status)).length, 0);
  await pg.bye();
});

test.after(() => {
  fake.close();
  setTimeout(() => process.exit(0), 100).unref();
});
