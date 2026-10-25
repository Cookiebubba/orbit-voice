// Whether an avatar's window takes the mouse (electron/avatar-hover.js), from the real cursor and the
// avatar's rect, with no forwarded mouse moves at all. Regression: after Orbit went to sleep the
// on-screen Qubit could no longer be clicked or thrown, because hover rested only on forwarded mouse
// moves, and those stop for good once Windows drops Electron's low-level mouse hook.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LEAVE_MS, QUIET_LOG_MS, createHoverPoller, rateLimitedLog } from '../electron/avatar-hover.js';

function rig({ bounds = { x: -4200, y: 680, width: 1200, height: 240 } } = {}) {
  const calls = [];
  const cursors = [];
  let cursor = { x: 0, y: 0 };
  let live = true;
  let t = 1000;
  const ticks = [];
  const p = createHoverPoller({
    getCursor: () => cursor,
    getBounds: () => bounds,
    setIgnore: (ignore) => calls.push(ignore),
    isLive: () => live,
    onCursor: (c) => cursors.push(c),
    now: () => t,
    setTimer: (fn) => (ticks.push(fn), 1),
    clearTimer: () => ticks.splice(0),
  });
  const tick = () => ticks.forEach((fn) => fn());
  return {
    p,
    calls,
    cursors,
    /** The cursor moves there, and the poll runs for `ms` (default: long enough to let go). */
    move(x, y, ms = LEAVE_MS + 40) {
      cursor = { x, y };
      tick();
      for (let k = 0; k < ms; k += 33) {
        t += 33;
        tick();
      }
    },
    tick,
    wait(ms) {
      t += ms;
      tick();
    },
    set live(v) {
      live = v;
    },
    bounds,
  };
}

test('hover: the window takes the mouse when the real cursor is on him, with no forwarded moves at all', () => {
  const r = rig();
  r.p.start();
  r.p.setHit({ x: 900, y: 100, w: 44, h: 44 }); // his rect in the strip
  assert.equal(r.calls.at(-1), true, 'away from him: clicks go through');
  r.move(-4200 + 920, 680 + 120); // onto him (screen px)
  assert.equal(r.calls.at(-1), false, 'on him: the window takes the mouse (a click and a grab reach his page)');
  assert.equal(r.p.taking, true);
  r.move(-4200 + 300, 680 + 120);
  assert.equal(r.calls.at(-1), true, 'off him again: clicks go through to the app underneath');
  // He moves under a still cursor (asleep, dozing; or landing): it follows his rect.
  r.p.setHit({ x: 280, y: 100, w: 44, h: 44 });
  assert.equal(r.calls.at(-1), false);
  r.p.setHit(null);
  assert.equal(r.calls.at(-1), true, 'no rect: never takes the mouse');
});

test('hover: a press or drag keeps the mouse wherever the cursor goes; letting go gives it back', () => {
  const r = rig();
  r.p.start();
  r.p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  r.move(-4200 + 920, 680 + 120);
  r.p.setPageHover(true, { held: true });
  r.move(-4200 + 10, 680 + 5); // dragged far off him
  assert.equal(r.calls.at(-1), false, 'held: still takes the mouse');
  r.p.setPageHover(false, { held: false });
  assert.equal(r.calls.at(-1), false, 'just let go: a moment more (no flapping)');
  r.wait(LEAVE_MS + 10);
  assert.equal(r.calls.at(-1), true, 'let go away from him: clicks go through');
});

test('hover: hidden or stopped, the window never takes the mouse; the page hears the cursor only near it', () => {
  const r = rig();
  r.p.start();
  r.p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  r.move(-4200 + 920, 680 + 120);
  assert.equal(r.calls.at(-1), false);
  r.live = false; // hidden (Claude minimized) or leaving
  r.move(-4200 + 921, 680 + 120);
  assert.equal(r.calls.at(-1), true);
  r.live = true;
  r.move(-4200 + 920, 680 + 120);
  r.p.stop();
  assert.equal(r.calls.at(-1), true, 'stopped: lets everything through');
  const near = r.cursors.filter(Boolean);
  assert.ok(near.length >= 1 && near.every((c) => Number.isFinite(c.x)));
  r.p.start();
  r.move(5000, 5000); // nowhere near his window
  assert.equal(r.cursors.at(-1), null, 'far away: the page is told the cursor is away');
});

test('hover: only changes are sent to the window (no churn every poll)', () => {
  const r = rig();
  r.p.start();
  r.p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  const n = r.calls.length;
  for (let i = 0; i < 50; i++) r.move(-4200 + 100 + i, 680 + 120);
  assert.equal(r.calls.length, n, 'cursor moving about away from him: nothing sent');
  r.p.reset();
  assert.equal(r.calls.length, n + 1, 'after a reset the state is sent again');
});

test('hover: the last rect stands however long the page is quiet (a throttled or stalled page)', () => {
  // The live bug (0edbf9b): a rect not heard for 3 s was dropped, so whenever the page's timers were
  // slowed (Chromium throttles pages; a busy renderer misses beats) a press on him went to the app
  // underneath. He hasn't moved because his page went quiet: the rect stands until the page says
  // otherwise or the window goes.
  let t = 1000;
  const calls = [];
  const modes = [];
  const quiet = [];
  let cursor = { x: -4200 + 100, y: 680 + 10 }; // off him
  const ticks = [];
  const p = createHoverPoller({
    getCursor: () => cursor,
    getBounds: () => ({ x: -4200, y: 680, width: 1200, height: 240 }),
    setIgnore: (i) => calls.push(i),
    onMode: (m) => modes.push(m),
    onQuiet: (ms) => quiet.push(ms),
    now: () => t,
    setTimer: (fn) => (ticks.push(fn), 1),
    clearTimer: () => ticks.splice(0),
  });
  const tick = () => ticks.forEach((fn) => fn());
  p.start();
  p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  assert.equal(calls.at(-1), true);
  // Ten minutes without a word from the page (intensive throttling: a beat a minute, or none).
  for (let i = 0; i < 600 * 30; i++) {
    t += 33;
    tick();
  }
  assert.equal(p.state.hit, true, 'the rect is kept');
  assert.equal(quiet.length, 1, 'the quiet spell is logged once');
  assert.ok(quiet[0] > QUIET_LOG_MS);
  cursor = { x: -4200 + 920, y: 680 + 120 }; // onto him
  tick();
  assert.equal(calls.at(-1), false, 'a press on him still reaches his page');
  assert.deepEqual(modes, [false, true], 'no flapping meanwhile');
  // The page speaks again: a new quiet spell can be logged later.
  p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  assert.equal(p.state.quiet, false);
  // Only the page or the window going ends it: no rect from the page, or a reset (the window made
  // again, its page reloaded or gone).
  p.setHit(null);
  assert.equal(calls.at(-1), true, 'no rect: clicks go through at once');
  p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  assert.equal(calls.at(-1), false);
  p.reset();
  assert.equal(p.state.hit, false, 'a reset forgets him');
  assert.equal(calls.at(-1), true);
  // A press the page stopped mentioning (its pointerup lost) doesn't hold the mouse for ever.
  p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  cursor = { x: -4200 + 100, y: 680 + 10 };
  p.setHeld(true);
  assert.equal(calls.at(-1), false);
  for (let i = 0; i < 20 * 30; i++) {
    t += 33;
    tick();
  }
  assert.equal(calls.at(-1), true, 'a press not mentioned for a long while lets go');
  // The page's own hover guess never holds the window (a stale one could block the app underneath).
  p.setPageHover(true, { held: false });
  assert.equal(calls.at(-1), true);
});

test('hover: the mode never flaps faster than LEAVE_MS while the cursor is on him or at his edge', () => {
  let t = 1000;
  const changes = [];
  let cursor = { x: 0, y: 0 };
  const ticks = [];
  const p = createHoverPoller({
    getCursor: () => cursor,
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 240 }),
    setIgnore: (i) => changes.push([t, i]),
    now: () => t,
    setTimer: (fn) => (ticks.push(fn), 1),
    clearTimer: () => ticks.splice(0),
  });
  const tick = () => ticks.forEach((fn) => fn());
  p.start();
  // Tiny Qubit (a 36 px box) walking under a hand trying to catch him: the cursor wobbles across his
  // edge every 40 ms, and he moves a px a frame.
  let x = 500;
  for (let i = 0; i < 300; i++) {
    t += 16;
    x += 1;
    if (i % 2 === 0) p.setHit({ x, y: 100, w: 36, h: 36 });
    cursor = { x: x + 36 + (Math.floor(i / 2.5) % 2 ? 4 : -3), y: 118 }; // just inside, then just out
    tick();
  }
  const flips = changes.slice(1);
  let fast = 0;
  for (let i = 1; i < flips.length; i++) if (flips[i][1] !== flips[i - 1][1] && flips[i][0] - flips[i - 1][0] < LEAVE_MS) fast++;
  assert.equal(fast, 0, `no change within ${LEAVE_MS} ms of the last (${flips.length} changes)`);
  assert.ok(flips.length <= 3, `it held on at his edge (${flips.length} changes)`);
  // Right onto him: takes the mouse at once (a quick click still lands); leaves only after LEAVE_MS off.
  cursor = { x: 2000, y: 2000 };
  for (let k = 0; k < 10; k++) {
    t += 33;
    tick();
  }
  assert.equal(changes.at(-1)[1], true);
  p.setHit({ x: 600, y: 100, w: 36, h: 36 });
  cursor = { x: 618, y: 118 };
  tick();
  assert.equal(changes.at(-1)[1], false, 'onto him: at once');
  const at = t;
  cursor = { x: 700, y: 118 };
  tick();
  t += LEAVE_MS - 40;
  tick();
  assert.equal(changes.at(-1)[1], false, 'just off him: still takes the mouse for a moment');
  t += 60;
  tick();
  assert.equal(changes.at(-1)[1], true, 'off him for LEAVE_MS: clicks go through');
  assert.ok(changes.at(-1)[0] - at >= LEAVE_MS);
});

test('hover: the log lines are rate-limited and carry no text', () => {
  let t = 0;
  const lines = [];
  const log = rateLimitedLog((m) => lines.push(m), { everyMs: 10_000, now: () => t });
  assert.equal(log('mode', 'qubit: its window lets clicks through'), true);
  for (let i = 0; i < 20; i++) {
    t += 100;
    log('mode', 'qubit: its window takes the mouse');
  }
  log('poll', 'qubit: hover polling started');
  t += 10_000;
  log('mode', 'qubit: its window lets clicks through');
  assert.deepEqual(lines, ['qubit: its window lets clicks through', 'qubit: hover polling started', 'qubit: its window lets clicks through (and 20 more like it before)']);
});

