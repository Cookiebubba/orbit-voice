// Whether an avatar's window takes the mouse (electron/avatar-hover.js), from the real cursor and the
// avatar's rect, with no forwarded mouse moves at all. Regression: after Orbit went to sleep the
// on-screen Qubit could no longer be clicked or thrown, because hover rested only on forwarded mouse
// moves, and those stop for good once Windows drops Electron's low-level mouse hook.
import test from 'node:test';
import assert from 'node:assert/strict';

import { HIT_STALE_MS, createHoverPoller, rateLimitedLog } from '../electron/avatar-hover.js';

function rig({ bounds = { x: -4200, y: 680, width: 1200, height: 240 } } = {}) {
  const calls = [];
  const cursors = [];
  let cursor = { x: 0, y: 0 };
  let live = true;
  const ticks = [];
  const p = createHoverPoller({
    getCursor: () => cursor,
    getBounds: () => bounds,
    setIgnore: (ignore) => calls.push(ignore),
    isLive: () => live,
    onCursor: (c) => cursors.push(c),
    setTimer: (fn) => (ticks.push(fn), 1),
    clearTimer: () => ticks.splice(0),
  });
  return {
    p,
    calls,
    cursors,
    move(x, y) {
      cursor = { x, y };
      ticks.forEach((fn) => fn());
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

test('hover: a rect not heard again is forgotten, and the heartbeat puts it right (the stuck-after-a-while bug)', () => {
  // The live bug (after 3f3d55a): a lift and drop the page didn't follow wiped the rect, and a Qubit
  // standing still never sent it again, so he couldn't be clicked or picked up. Now the page sends it
  // every half second and Orbit forgets one it hasn't heard for a while.
  let t = 1000;
  const calls = [];
  const modes = [];
  let cursor = { x: -4200 + 920, y: 680 + 120 }; // on him
  const ticks = [];
  const p = createHoverPoller({
    getCursor: () => cursor,
    getBounds: () => ({ x: -4200, y: 680, width: 1200, height: 240 }),
    setIgnore: (i) => calls.push(i),
    onMode: (m) => modes.push(m),
    now: () => t,
    setTimer: (fn) => (ticks.push(fn), 1),
    clearTimer: () => ticks.splice(0),
  });
  const tick = () => ticks.forEach((fn) => fn());
  p.start();
  p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  assert.equal(calls.at(-1), false, 'on him: takes the mouse');
  // The page goes quiet (a page that stopped, or a rect wiped): forgotten after HIT_STALE_MS.
  t += HIT_STALE_MS + 1;
  tick();
  assert.equal(calls.at(-1), true, 'an old rect is never trusted: clicks go through');
  assert.equal(p.state.hit, false);
  // The next heartbeat (the same rect, unchanged) and he's clickable again at once.
  p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  assert.equal(calls.at(-1), false, 'the heartbeat restores it');
  // A long run of heartbeats keeps it, however long he stands still.
  for (let i = 0; i < 200; i++) {
    t += 500;
    p.setHit({ x: 900, y: 100, w: 44, h: 44 });
    tick();
  }
  assert.equal(calls.at(-1), false);
  assert.deepEqual(modes, [false, true, false, true], 'the first mode and each change reported once (for the log)');
  // A press the page stopped mentioning doesn't hold the mouse for ever either.
  cursor = { x: -4200 + 100, y: 680 + 10 }; // off him
  p.setHeld(true);
  assert.equal(calls.at(-1), false);
  t += 6000;
  p.setHit({ x: 900, y: 100, w: 44, h: 44 });
  assert.equal(calls.at(-1), true, 'a stale press lets go');
  // The page's own hover guess never holds the window (a stale one could block the app underneath).
  p.setPageHover(true, { held: false });
  assert.equal(calls.at(-1), true);
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

