// Which copy of Orbit this is. Real Orbit by default. A test build (scripts/build-test.mjs) says
// "orbitTestBuild": true in its packaged package.json and becomes a separate app that can sit next to
// the real one: its own name, app id, data folder, single-instance lock and port, a wake hotkey of its
// own, and no updates at all, so it can never update itself into real Orbit.
//
// No Electron here, so the tests can read it.

export const ORBIT = Object.freeze({
  name: 'Orbit',
  appId: 'dev.orbit.voice',
  dataFolder: 'Orbit',
  port: 0, // 0: the bridge's own default (4317)
  hotkey: '', // '': the default in src/config.js
  updates: true,
  testBuild: false,
});

export const ORBIT_TEST = Object.freeze({
  name: 'Orbit Test',
  appId: 'dev.orbit.voice.test',
  dataFolder: 'Orbit Test',
  port: 4327,
  hotkey: 'Control+Alt+Shift+G',
  updates: false,
  testBuild: true,
});

/** `dev`: developer testing from source only (ORBIT_TEST_IDENTITY=1, never in an installed app). */
export const identityFor = (pkg, { dev = false } = {}) => (pkg?.orbitTestBuild === true || dev ? ORBIT_TEST : ORBIT);
