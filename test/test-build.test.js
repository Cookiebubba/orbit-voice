// Orbit Test: a build that sits next to real Orbit. Its identity can't touch the real one, its first
// run only ever reads real Orbit's folder, and package.json keeps real Orbit's identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORBIT, ORBIT_TEST, identityFor } from '../electron/identity.js';
import { seedTestData, seededSettings } from '../electron/test-seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-build-'));

test('real Orbit stays real Orbit; only the packaged flag or the source-only switch changes it', () => {
  assert.equal(identityFor(pkg), ORBIT);
  assert.equal(identityFor({}), ORBIT);
  assert.equal(identityFor({ orbitTestBuild: 'true' }), ORBIT, 'only a real true');
  assert.equal(identityFor({ orbitTestBuild: true }), ORBIT_TEST);
  assert.equal(identityFor({}, { dev: true }), ORBIT_TEST);
  assert.equal(pkg.productName, 'Orbit');
  assert.equal(pkg.build.appId, 'dev.orbit.voice');
  assert.equal(pkg.orbitTestBuild, undefined);
});

test('the test identity differs from the real one wherever two apps could collide', () => {
  for (const k of ['name', 'appId', 'dataFolder', 'port', 'hotkey']) assert.notEqual(ORBIT_TEST[k], ORBIT[k], k);
  assert.notEqual(ORBIT_TEST.port, 4317);
  assert.equal(ORBIT_TEST.updates, false);
});

function realFolder({ models = true } = {}) {
  const from = tmp();
  fs.writeFileSync(path.join(from, 'settings.json'), JSON.stringify({ voiceEngine: 'claude', wakeHotkey: 'Control+G', anywhereUnderOrbit: ['discord.exe'], autoUpdate: true, avatar: 'qubit' }));
  for (const secret of ['xai-key.bin', 'anthropic-key.bin', 'Local State', 'keeper-tokens.json', 'mcp-tokens.bin']) fs.writeFileSync(path.join(from, secret), 'secret');
  if (models) {
    fs.mkdirSync(path.join(from, 'claude-voice-models', 'kitten'), { recursive: true });
    fs.writeFileSync(path.join(from, 'claude-voice-models', 'kitten', 'model.onnx'), 'model');
    fs.writeFileSync(path.join(from, 'claude-voice-models', 'verified.json'), '{}');
  }
  return from;
}
const snapshot = (dir) =>
  fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    return [f, st.mtimeMs, st.isFile() ? fs.readFileSync(p, 'utf8') : ''];
  });

test('first run: settings and speech models only, no key, real folder untouched', async () => {
  const from = realFolder();
  const before = snapshot(from);
  const to = path.join(tmp(), 'Orbit Test');
  const r = await seedTestData({ from, to, hotkey: ORBIT_TEST.hotkey });
  assert.deepEqual(r, { seeded: true, models: true });
  assert.deepEqual(fs.readdirSync(to).sort(), ['claude-voice-models', 'settings.json']);
  assert.equal(fs.readFileSync(path.join(to, 'claude-voice-models', 'kitten', 'model.onnx'), 'utf8'), 'model');
  const s = JSON.parse(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'));
  assert.equal(s.voiceEngine, 'claude');
  assert.equal(s.avatar, 'qubit');
  assert.equal(s.wakeHotkey, ORBIT_TEST.hotkey, 'its own hotkey');
  assert.equal(s.anywhereUnderOrbit, undefined, 'never leads to restarting an app real Orbit holds');
  assert.equal(s.autoUpdate, false);
  assert.deepEqual(snapshot(from), before, 'real folder unchanged');
});

test('it only seeds once, and a machine with no real Orbit is simply a new install', async () => {
  const from = realFolder({ models: false });
  const to = tmp();
  fs.writeFileSync(path.join(to, 'settings.json'), '{"avatar":"none"}');
  assert.deepEqual(await seedTestData({ from, to, hotkey: 'X' }), { seeded: false, why: 'already has settings' });
  assert.equal(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"avatar":"none"}');
  const fresh = path.join(tmp(), 'new');
  assert.equal((await seedTestData({ from: path.join(tmp(), 'nothing'), to: fresh, hotkey: 'X' })).seeded, false);
  assert.equal(fs.existsSync(fresh), false);
  assert.equal((await seedTestData({ from, to: fresh, hotkey: 'X' })).models, false);
  assert.deepEqual(seededSettings({ a: 1, anywhereUnderOrbit: [] }, { hotkey: 'H' }), { a: 1, wakeHotkey: 'H', autoUpdate: false });
});
