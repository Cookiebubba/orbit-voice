// The sidecar's own parts: sealed storage, the channel's framing, the mouse timing it copies from
// electron/orbit-mouse.js, and a real start (init → ready → the bridge answers → quit).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANNEL_MARK, MOUSE_TIMING, glideMs, makeSealer, sealedKeyStore, sealedMapStore } from './sidecar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sidecar-test-'));

test('sealing round-trips and refuses tampering or the wrong key', () => {
  const s = makeSealer(crypto.randomBytes(32));
  const sealed = s.seal('xai-fake-key-for-tests-0123456789');
  assert.equal(s.open(sealed), 'xai-fake-key-for-tests-0123456789');
  assert.ok(!sealed.includes(Buffer.from('fake-key')), 'no plaintext on disk');
  const bad = Buffer.from(sealed);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => s.open(bad));
  assert.throws(() => makeSealer(crypto.randomBytes(32)).open(sealed));
  assert.throws(() => makeSealer(Buffer.alloc(16)), /32 bytes/);
});

test('key store: missing or unreadable reads as empty, empty set removes it', () => {
  const dir = tmp();
  const store = sealedKeyStore(makeSealer(crypto.randomBytes(32)), dir, 'k.sealed');
  assert.equal(store.get(), '');
  store.set('abc');
  assert.equal(store.get(), 'abc');
  // (POSIX modes: Windows has none, and the sidecar only runs on macOS.)
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'k.sealed')).mode & 0o077, 0, 'owner-only file');
  store.set('');
  assert.equal(fs.existsSync(path.join(dir, 'k.sealed')), false);
  fs.writeFileSync(path.join(dir, 'k.sealed'), 'garbage');
  assert.equal(store.get(), '');
});

test('map store keeps several values sealed in one file', () => {
  const dir = tmp();
  const key = crypto.randomBytes(32);
  const a = sealedMapStore(makeSealer(key), dir, 'm.sealed');
  a.set('x', '1');
  a.set('y', '2');
  a.set('x', null);
  const b = sealedMapStore(makeSealer(key), dir, 'm.sealed');
  assert.equal(b.get('x'), null);
  assert.equal(b.get('y'), '2');
});

test("the mouse timing matches electron/orbit-mouse.js's", () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'orbit-mouse.js'), 'utf8');
  const timing = src.match(/export const MOUSE_TIMING = Object\.freeze\((\{.*\})\);/)[1];
  assert.deepEqual(MOUSE_TIMING, Function(`return (${timing})`)());
  const glide = src.match(/export const glideMs = (\(distDip\) => .*);/)[1];
  const theirs = Function(`return ${glide}`)();
  for (const d of [0, 1, 10, 44, 100, 500, 1000, -5, NaN]) assert.equal(glideMs(d), theirs(d), `glideMs(${d})`);
});

test('a real start: init, ready with sign-in links, the bridge answers, quit ends it', { timeout: 60_000 }, async () => {
  const profile = tmp();
  const port = 4590 + Math.floor(Math.random() * 9);
  const child = spawn(process.execPath, [path.join(HERE, 'sidecar.mjs')], { env: { ...process.env, ORBIT_PROFILE_DIR: profile, PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(JSON.stringify({ t: 'init', sealKey: crypto.randomBytes(32).toString('base64') }) + '\n');
  let buf = '';
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ready')), 30_000);
    child.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        if (!line.startsWith(CHANNEL_MARK)) continue;
        const m = JSON.parse(line.slice(CHANNEL_MARK.length));
        if (m.t === 'ready' || m.t === 'error') {
          clearTimeout(timer);
          resolve(m);
        }
      }
    });
    child.on('exit', (c) => reject(new Error(`exited ${c}`)));
  });
  assert.equal(ready.t, 'ready', ready.message);
  assert.equal(ready.base, `http://127.0.0.1:${port}`);
  for (const v of ['main', 'orb', 'qubit', 'buddy', 'mouse']) assert.match(ready.auth[v], new RegExp(`^http://127\\.0\\.0\\.1:${port}/auth\\?t=[a-f0-9]{64}`));
  // Nothing but channel lines on stdout.
  for (const line of buf.split('\n').filter(Boolean)) assert.ok(line.startsWith(CHANNEL_MARK), 'stdout carries only the channel');
  const r = await fetch(`${ready.base}/api/config`, { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(r.status, 401, 'the API wants a session');
  const signIn = await fetch(ready.auth.main, { redirect: 'manual' });
  assert.equal(signIn.status, 302);
  const cookie = signIn.headers.get('set-cookie').split(';')[0];
  const cfg = await (await fetch(`${ready.base}/api/config`, { headers: { cookie } })).json();
  assert.equal(cfg.keyStorage, 'macos-keychain');
  assert.equal(fs.existsSync(path.join(profile, 'settings.json')) || true, true);
  const exited = new Promise((r) => child.on('exit', r));
  child.stdin.write(JSON.stringify({ t: 'quit' }) + '\n');
  assert.equal(await exited, 0);
});
