// The one switch every real-window test checks: off in CI (no interactive desktop there) and when
// ORBIT_SKIP_REAL_WINDOWS=1; on otherwise, so local runs behave as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realDesktopSkip, realDesktopSkipFor } from './e2e/real-desktop.mjs';

test('CI set means skip, with a reason', () => {
  for (const CI of ['true', '1', 'TRUE', 'yes']) {
    const r = realDesktopSkipFor({ CI });
    assert.equal(typeof r, 'string', `CI=${CI}`);
    assert.match(r, /CI/);
  }
});

test('ORBIT_SKIP_REAL_WINDOWS=1 means skip', () => {
  assert.match(realDesktopSkipFor({ ORBIT_SKIP_REAL_WINDOWS: '1' }), /ORBIT_SKIP_REAL_WINDOWS/);
});

test('neither set (or CI explicitly off): real-window tests run as before', () => {
  assert.equal(realDesktopSkipFor({}), false);
  assert.equal(realDesktopSkipFor({ CI: '' }), false);
  assert.equal(realDesktopSkipFor({ CI: 'false' }), false);
  assert.equal(realDesktopSkipFor({ CI: '0' }), false);
  assert.equal(realDesktopSkipFor({ ORBIT_SKIP_REAL_WINDOWS: '0' }), false);
});

test('the exported value follows this process', () => {
  assert.equal(realDesktopSkip, realDesktopSkipFor(process.env));
});
