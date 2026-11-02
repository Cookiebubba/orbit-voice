// Real loopback bind failures with isolated settings and fake desktop/provider hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-port-conflict-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
globalThis.__fuzz = { rng: () => 0, str: () => 'fixture', calls: [], windowTitle: () => 'Never automate' };
const server = await import('../../src/server.js');
const mem = () => ({ kind: 'memory', get: () => '', set() {} });

test('an occupied requested port rejects startup without an uncaught WebSocket error', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(server.startServer({ port: blocker.address().port, configDir: path.join(root, 'cfg'),
      importEnv: false, secrets: mem(), brainSecrets: mem(), openaiSecrets: mem(),
      watcher: { start() {}, stop() {}, on() {}, working: () => [] },
      realtimeFactory: () => { throw new Error('A bind failure cannot start a provider'); },
    }), { code: 'EADDRINUSE' });
    assert.equal(blocker.listening, true);
  } finally {
    await server.closeServer();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
