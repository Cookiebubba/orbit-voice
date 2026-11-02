// Resolve optional host launch policy before choosing a profile or taking its instance lock.
// Standalone defaults remain Orbit's; a selected host always gets the isolated companion profile.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { descriptorPath } from '../src/external-host.js';

export function externalLaunch({ argv = process.argv, env = process.env, packaged = false } = {}) {
  const descriptor = descriptorPath(argv, packaged ? {} : env);
  const managed = argv.includes('--host-managed');
  const paired = managed || !!descriptor;
  return {
    descriptor, managed, paired,
    profile: paired ? 'OrbitCompanion' : 'Orbit',
    appId: paired ? 'dev.orbit.voice.companion' : 'dev.orbit.voice',
    userDataOverride: packaged ? null : (paired ? env.ORBIT_COMPANION_USER_DATA : env.ORBIT_USER_DATA) || null,
    importEnv: !paired,
    port: paired ? 0 : Number(env.PORT || 4317),
    updatesAllowed: !paired,
    registerHotkey: (settings) => !paired || settings.previewHotkeyEnabled === true,
  };
}

// A host that verifies a companion payload expects its compatibility-manifest digest.
// Without that optional file, a source build is identified by its package metadata.
export function managedBuildId(root) {
  let bytes;
  try { bytes = fs.readFileSync(path.join(root, 'orbit-host-compatibility.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    bytes = fs.readFileSync(path.join(root, 'package.json'));
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
