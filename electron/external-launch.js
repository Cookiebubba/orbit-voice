// Resolve optional host launch policy before choosing a profile or taking its instance lock.
// Standalone defaults remain Orbit's; a selected host always gets the isolated companion profile.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { descriptorPath } from '../src/external-host.js';

export function externalLaunch({ argv = process.argv, env = process.env, packaged = false } = {}) {
  const descriptor = descriptorPath(argv, packaged ? {} : env);
  const managed = argv.includes('--bro-managed');
  const paired = managed || !!descriptor;
  return {
    descriptor, managed, paired,
    profile: paired ? 'OrbitBroPreview' : 'Orbit',
    appId: paired ? 'dev.justsuperhuman.orbit.bro-preview' : 'dev.orbit.voice',
    userDataOverride: packaged ? null : (paired ? env.ORBIT_BRO_PREVIEW_USER_DATA : env.ORBIT_USER_DATA) || null,
    importEnv: !paired,
    port: paired ? 0 : Number(env.PORT || 4317),
    updatesAllowed: !paired,
    registerHotkey: (settings) => !paired || settings.previewHotkeyEnabled === true,
  };
}

// Bro's preview verifies its payload independently and expects the manifest digest.
// Other protocol hosts can identify a source build by its package metadata instead.
export function managedBuildId(root) {
  let bytes;
  try { bytes = fs.readFileSync(path.join(root, 'orbit-bro-compatibility.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    bytes = fs.readFileSync(path.join(root, 'package.json'));
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
