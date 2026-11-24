// Tests that open real windows and drive them (UI Automation, focus, the keeper's pipe, Electron test
// apps) need an interactive desktop someone isn't using, and they load the machine. So they are
// opt-in: a plain `npm test` skips them, and ORBIT_E2E=1 runs them. They stay skipped in CI (no
// interactive desktop to rely on) and with ORBIT_SKIP_REAL_WINDOWS=1, whatever ORBIT_E2E says.
// Every such test uses `{ skip: realDesktopSkip || ... }`.

const on = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return !!s && s !== '0' && s !== 'false';
};

/** Why real-window tests can't run in this environment, or false when they can. */
export function realDesktopSkipFor(env = process.env) {
  if (on(env.CI)) return 'no interactive desktop in CI';
  if (env.ORBIT_SKIP_REAL_WINDOWS === '1') return 'real-window tests are off (ORBIT_SKIP_REAL_WINDOWS=1)';
  if (!on(env.ORBIT_E2E)) return 'opens real windows: set ORBIT_E2E=1 to run it';
  return false;
}

export const realDesktopSkip = realDesktopSkipFor();
