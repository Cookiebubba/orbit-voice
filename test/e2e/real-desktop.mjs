// Tests that open real windows and drive them (UI Automation, focus, the keeper's pipe) need an
// interactive desktop someone isn't using. A CI runner has none it can rely on, so there they are
// skipped, as they are anywhere ORBIT_SKIP_REAL_WINDOWS=1 is set. Every such test uses
// `{ skip: realDesktopSkip || ... }`; with neither set, nothing changes.

/** Why real-window tests can't run in this environment, or false when they can. */
export function realDesktopSkipFor(env = process.env) {
  const ci = String(env.CI ?? '').trim().toLowerCase();
  if (ci && ci !== '0' && ci !== 'false') return 'no interactive desktop in CI';
  if (env.ORBIT_SKIP_REAL_WINDOWS === '1') return 'real-window tests are off (ORBIT_SKIP_REAL_WINDOWS=1)';
  return false;
}

export const realDesktopSkip = realDesktopSkipFor();
