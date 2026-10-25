// The bridge with no xAI key, from a brand-new (empty) config folder:
//   - it starts on Claude voice and reports no key, and nothing on the Claude path asks for one
//   - only Grok refuses without a key, with the same plain words the main page shows
// Claude's window and `claude` are the fuzzer's fakes (test/fuzz/register.mjs). No speech models
// are downloaded: the config folder has none, and only a try to talk on the page starts that.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { GROK_NEEDS_KEY } from '../../ui/src/talk.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-no-key-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.XAI_API_KEY = ''; // a developer's own .env key mustn't count as a saved one
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };

const PORT = 4389;
const host = `127.0.0.1:${PORT}`;
const origin = `http://${host}`;

// A fake Grok that should never be reached: no key, no call.
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => fake.on('listening', r));
process.env.XAI_REALTIME_URL = `ws://127.0.0.1:${fake.address().port}`;
let grokConnections = 0;
fake.on('connection', () => grokConnections++);

const { updateSettings } = await import('../../src/config.js');
const server = await import('../../src/server.js');
const mem = (v) => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
const watcher = { on() {}, start() {}, working: () => [] };
const cfgDir = path.join(root, 'cfg');
await server.startServer({ port: PORT, configDir: cfgDir, secrets: mem(''), brainSecrets: mem(''), clipboard: () => {}, models: root, watcher });

const cookie = await new Promise((resolve) => {
  const u = new URL(server.authUrl());
  http.get({ host: '127.0.0.1', port: PORT, path: u.pathname + u.search, headers: { host } }, (res) => resolve(String(res.headers['set-cookie'][0]).split(';')[0]));
});
const getJson = (p) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p, headers: { host, cookie } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
      })
      .on('error', reject);
  });

/** Open the voice socket the way the page does; resolve with what came back before it closed. */
function call() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}/voice`, { headers: { origin, cookie } });
    const events = [];
    ws.on('message', (m) => events.push(JSON.parse(String(m))));
    ws.on('close', () => resolve(events));
    ws.on('error', () => {});
  });
}

test('a new install with no key: Claude voice, no key screen, nothing asks for a key', async () => {
  const { status, json } = await getJson('/api/config');
  assert.equal(status, 200);
  assert.equal(json.hasKey, false);
  assert.equal(json.settings.voiceEngine, 'claude');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8')).voiceEngine, 'claude');

  // Talking on Claude voice: not refused for a key (here only because the speech models aren't downloaded).
  const events = await call();
  const errors = events.filter((e) => e.type === 'bridge.error').map((e) => e.message);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /speech models/);
  assert.doesNotMatch(errors.join(' '), /xAI|key/i);
  assert.equal(grokConnections, 0);
});

test('Grok without a key: refused with the same plain words as the main page, never connected', async () => {
  updateSettings({ voiceEngine: 'grok' });
  const events = await call();
  const errors = events.filter((e) => e.type === 'bridge.error').map((e) => e.message);
  assert.deepEqual(errors, [GROK_NEEDS_KEY]);
  assert.equal(events.some((e) => e.type === 'bridge.ready'), false);
  assert.equal(grokConnections, 0);
  // The choice is saved as made.
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8')).voiceEngine, 'grok');
});

test.after(() => {
  fake.close();
  setTimeout(() => process.exit(0), 100).unref();
});
