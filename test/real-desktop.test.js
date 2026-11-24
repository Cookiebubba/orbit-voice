// The one switch every real-window test checks: opt-in with ORBIT_E2E=1, and still off in CI (no
// interactive desktop there) and with ORBIT_SKIP_REAL_WINDOWS=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realDesktopSkip, realDesktopSkipFor } from './e2e/real-desktop.mjs';

test('CI set means skip, with a reason, even with ORBIT_E2E=1', () => {
  for (const CI of ['true', '1', 'TRUE', 'yes']) {
    const r = realDesktopSkipFor({ CI, ORBIT_E2E: '1' });
    assert.equal(typeof r, 'string', `CI=${CI}`);
    assert.match(r, /CI/);
  }
});

test('ORBIT_SKIP_REAL_WINDOWS=1 means skip, even with ORBIT_E2E=1', () => {
  assert.match(realDesktopSkipFor({ ORBIT_SKIP_REAL_WINDOWS: '1', ORBIT_E2E: '1' }), /ORBIT_SKIP_REAL_WINDOWS/);
});

test('by default (no ORBIT_E2E) real-window tests are skipped, saying how to run them', () => {
  for (const env of [{}, { CI: '' }, { CI: 'false' }, { ORBIT_E2E: '0' }, { ORBIT_E2E: 'false' }]) assert.match(realDesktopSkipFor(env), /ORBIT_E2E=1/, JSON.stringify(env));
});

test('ORBIT_E2E=1 (CI unset or off) runs them', () => {
  assert.equal(realDesktopSkipFor({ ORBIT_E2E: '1' }), false);
  assert.equal(realDesktopSkipFor({ ORBIT_E2E: '1', CI: 'false' }), false);
  assert.equal(realDesktopSkipFor({ ORBIT_E2E: '1', CI: '0' }), false);
  assert.equal(realDesktopSkipFor({ ORBIT_E2E: '1', ORBIT_SKIP_REAL_WINDOWS: '0' }), false);
});

test('the exported value follows this process', () => {
  assert.equal(realDesktopSkip, realDesktopSkipFor(process.env));
});
