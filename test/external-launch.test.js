import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { externalLaunch, managedBuildId } from '../electron/external-launch.js';

test('ordinary Orbit preserves its profile, identity, default port, updates and wake shortcut', () => {
  const launch = externalLaunch({ argv: ['electron', '.'], env: {} });
  assert.equal(launch.paired, false);
  assert.equal(launch.managed, false);
  assert.equal(launch.descriptor, null);
  assert.equal(launch.profile, 'Orbit');
  assert.equal(launch.appId, 'dev.orbit.voice');
  assert.equal(launch.port, 4317);
  assert.equal(launch.importEnv, true);
  assert.equal(launch.updatesAllowed, true);
  assert.equal(launch.registerHotkey({ previewHotkeyEnabled: false }), true);
});

test('standalone development keeps PORT and ORBIT_USER_DATA without importing the companion override', () => {
  const launch = externalLaunch({ argv: [], env: { PORT: '48123', ORBIT_USER_DATA: 'standalone-fixture', ORBIT_BRO_PREVIEW_USER_DATA: 'companion-fixture' } });
  assert.equal(launch.port, 48123);
  assert.equal(launch.userDataOverride, 'standalone-fixture');
});

test('an explicit host gets an isolated profile, dynamic port and opt-in shortcut', () => {
  for (const managed of [false, true]) {
    const launch = externalLaunch({ argv: ['--external-host-file', 'fixture.json', ...(managed ? ['--bro-managed'] : [])], env: { PORT: '48123', ORBIT_USER_DATA: 'standalone-fixture', ORBIT_BRO_PREVIEW_USER_DATA: 'companion-fixture' } });
    assert.equal(launch.paired, true);
    assert.equal(launch.managed, managed);
    assert.equal(launch.descriptor, 'fixture.json');
    assert.equal(launch.profile, 'OrbitBroPreview');
    assert.notEqual(launch.appId, 'dev.orbit.voice');
    assert.equal(launch.userDataOverride, 'companion-fixture');
    assert.equal(launch.port, 0);
    assert.equal(launch.importEnv, false);
    assert.equal(launch.updatesAllowed, false);
    assert.equal(launch.registerHotkey({}), false);
    assert.equal(launch.registerHotkey({ previewHotkeyEnabled: true }), true);
  }
});

test('packaged launches ignore development pairing and profile overrides', () => {
  const env = { ORBIT_EXTERNAL_HOST_FILE: 'untrusted-env.json', ORBIT_USER_DATA: 'standalone-fixture', ORBIT_BRO_PREVIEW_USER_DATA: 'companion-fixture' };
  const standalone = externalLaunch({ argv: [], env, packaged: true });
  assert.equal(standalone.paired, false);
  assert.equal(standalone.userDataOverride, null);
  const explicit = externalLaunch({ argv: ['--external-host-file', 'explicit.json'], env, packaged: true });
  assert.equal(explicit.descriptor, 'explicit.json');
  assert.equal(explicit.userDataOverride, null);
});

test('development environment pairing is explicit and an empty CLI argument fails', () => {
  assert.equal(externalLaunch({ argv: [], env: { ORBIT_EXTERNAL_HOST_FILE: 'fixture.json' } }).paired, true);
  assert.throws(() => externalLaunch({ argv: ['--external-host-file'], env: {} }), /descriptor path/);
  assert.equal(externalLaunch({ argv: ['--bro-managed'], env: {} }).profile, 'OrbitBroPreview');
});

test('managed build identity supports source checkouts and retains preview manifest compatibility', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-build-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.3.0-beta.4"}');
  assert.equal(managedBuildId(root), hash('{"version":"1.3.0-beta.4"}'));
  fs.writeFileSync(path.join(root, 'orbit-bro-compatibility.json'), '{"schema":1}');
  assert.equal(managedBuildId(root), hash('{"schema":1}'));
});
