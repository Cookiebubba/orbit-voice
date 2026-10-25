// Picking Qubit up and throwing him: the shared maths (ui/src/buddy/throw.js) and his throw
// controller (ui/src/qubit/throw.js) on his real engine, stepped frame by frame in node. Click vs drag,
// the release velocity from pointer samples, flight with bounces staying inside the work area and
// landing flat on a face (floor, the strip's floor ledge, or the prompt box), getting back to his strip
// from the screen's bottom edge, and his director carrying on from where he landed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESS, clampSpeed, liftedStage, nearestStripSpot, onStrip, pressKind, pushSample, throwVelocity } from '../ui/src/buddy/throw.js';
import { THROW, createThrow, headBack } from '../ui/src/qubit/throw.js';
import { FLOOR, createDirector, sideFor } from '../ui/src/qubit/director.js';
import { buddyBoundsFor, liftRectFor } from '../electron/buddy-geometry.js';

const fakeEl = () => ({ style: {}, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, remove() {} });
globalThis.document ??= { createElementNS: () => fakeEl() };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
await import('../ui/src/vendor/avatars/orbit-nav.js');
await import('../ui/src/vendor/avatars/qubit-engine.js');
const E = globalThis.QubitEngine;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const withRandom = async (seed, fn) => {
  const real = Math.random;
  Math.random = seeded(seed);
  try {
    return await fn();
  } finally {
    Math.random = real;
  }
};
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- press and velocity
test('press: a quick press-and-release is a click; moving a few px or holding still picks him up', () => {
  assert.equal(pressKind({ dx: 1, dy: 2, ms: 120, released: true }), 'click');
  assert.equal(pressKind({ dx: 0, dy: 0, ms: PRESS.clickMs - 1, released: true }), 'click');
  assert.equal(pressKind({ dx: 0, dy: 0, ms: PRESS.clickMs + 50, released: true }), 'hold', 'a long press is no click');
  assert.equal(pressKind({ dx: PRESS.slop + 1, dy: 0, ms: 40 }), 'drag');
  assert.equal(pressKind({ dx: 4, dy: 4, ms: 40 }), 'drag', 'diagonal distance counts');
  assert.equal(pressKind({ dx: 3, dy: 3, ms: 40 }), 'press');
  assert.equal(pressKind({ dx: 2, dy: 0, ms: PRESS.holdMs }), 'hold', 'held still: picked up');
  assert.equal(pressKind({ dx: 0, dy: 0, ms: 10, released: true, dragging: true }), 'drag', 'once dragging, always dragging');
  assert.equal(pressKind({ dx: 7, dy: 0, ms: 90, released: true }), 'drag', 'moved then let go fast: a throw, not a click');
});

test('press: a fast press-and-drag with no pause picks him up at once; press, hold, then drag does too', () => {
  // Fast: the first move already past the slop, 12 ms after the press.
  assert.equal(pressKind({ dx: -14, dy: -9, ms: 12 }), 'drag', 'no pause needed');
  assert.equal(pressKind({ dx: -3, dy: -2, ms: 8 }), 'press', 'not before the slop');
  // Held still: picked up at the hold, then dragged (the page is dragging from then on).
  assert.equal(pressKind({ dx: 0, dy: 0, ms: PRESS.holdMs + 5 }), 'hold');
  assert.equal(pressKind({ dx: -10, dy: -6, ms: PRESS.holdMs + 80, dragging: true }), 'drag');
  // A hold only starts after a click's time is up (a slow click is never a pickup and a put-down).
  assert.ok(PRESS.holdMs > PRESS.clickMs, `hold ${PRESS.holdMs} ms > click ${PRESS.clickMs} ms`);
  assert.equal(pressKind({ dx: 0, dy: 0, ms: PRESS.clickMs + 10 }), 'press', 'between a click and a hold: still a press');
  assert.equal(pressKind({ dx: 0, dy: 0, ms: PRESS.clickMs + 10, released: true }), 'hold', 'let go there: not a click (a poke)');
});

test('throw velocity: a least-squares fit over the last 80 ms of samples, clamped', () => {
  // Steady 1200 px/s right and 600 px/s up, sampled every 8 ms.
  const s = [];
  for (let t = 0; t <= 200; t += 8) s.push({ x: 100 + 1.2 * t, y: 500 - 0.6 * t, t });
  let v = throwVelocity(s, 200);
  assert.ok(Math.abs(v.x - 1200) < 1 && Math.abs(v.y + 600) < 1, JSON.stringify(v));
  // Only the last 80 ms count: a fast start then a slow finish reads as the finish.
  const slow = [];
  for (let t = 0; t <= 100; t += 8) slow.push({ x: 4 * t, y: 0, t });
  for (let t = 104; t <= 300; t += 8) slow.push({ x: 400 + 0.2 * (t - 100), y: 0, t });
  v = throwVelocity(slow, 300);
  assert.ok(Math.abs(v.x - 200) < 5, `the last 80 ms: ${v.x.toFixed(1)}`);
  // One jittery sample doesn't fling him.
  const jit = s.map((p, i) => (i === s.length - 3 ? { ...p, x: p.x + 25 } : p));
  v = throwVelocity(jit, 200);
  assert.ok(Math.abs(v.x - 1200) < 260, `robust to one jumpy sample: ${v.x.toFixed(0)}`);
  // Stopped before letting go: a drop.
  assert.deepEqual(throwVelocity(s, 400), { x: 0, y: 0 });
  assert.deepEqual(throwVelocity([{ x: 1, y: 1, t: 10 }], 10), { x: 0, y: 0 });
  assert.deepEqual(throwVelocity([], 10), { x: 0, y: 0 });
  assert.deepEqual(throwVelocity([{ x: 0, y: 0, t: 5 }, { x: 50, y: 0, t: 5 }], 5), { x: 0, y: 0 }, 'no time between them: no speed');
  // Garbage samples are ignored.
  v = throwVelocity([...s, { x: NaN, y: 0, t: 199 }, null, { x: 1, y: 1, t: Infinity }], 200);
  assert.ok(Math.abs(v.x - 1200) < 1);
  // Clamped, keeping its direction.
  v = throwVelocity(s, 200, { max: 500 });
  assert.ok(Math.abs(Math.hypot(v.x, v.y) - 500) < 1e-6 && Math.abs(v.y / v.x + 0.5) < 1e-6, JSON.stringify(v));
  assert.deepEqual(clampSpeed({ x: 3, y: 4 }, 10), { x: 3, y: 4 });
  assert.deepEqual(clampSpeed({ x: NaN, y: 4 }, 10), { x: 0, y: 0 });
  // Samples are kept to a short window.
  const keep = [];
  for (let t = 0; t < 1000; t += 10) pushSample(keep, { x: t, y: 0, t }, 200);
  assert.ok(keep.length <= 22 && keep[0].t >= 790);
});

// ---------------------------------------------------------------- the lifted stage
const AREA = { x: 0, y: 0, width: 1600, height: 860 }; // a work area (the taskbar is below it)
const STRIP_HIGH = { x: 300, y: 380, width: 1000, height: 240 }; // a Claude window whose bottom is mid-screen
const STRIP_LOW = { x: 200, y: 620, width: 1200, height: 240 }; // a maximised one: its floor is the screen's
const BOX = { x: 260, y: 140, w: 480, h: 100 }; // strip px

test('lifted stage: the strip, its floor and the prompt box in the work area\'s coordinates', () => {
  const a = liftedStage({ area: AREA, strip: STRIP_HIGH, box: BOX, floor: FLOOR });
  assert.equal(a.W, 1600);
  assert.equal(a.ground, 857);
  assert.deepEqual(a.ledge, { x1: 300, x2: 1300, y: 380 + 240 - FLOOR });
  assert.deepEqual(a.box, { x: 560, y: 520, w: 480, h: 100 });
  assert.equal(a.solids.find((s) => s.id === 'ledge').oneWay, true, 'the strip floor is a ledge he can jump up through');
  const box = a.solids.find((s) => s.id === 'box');
  assert.equal(box.y + box.h, a.ledge.y, 'the box is solid down to the strip floor');
  const b = liftedStage({ area: AREA, strip: STRIP_LOW, box: null, floor: FLOOR });
  assert.equal(b.ledge, null, "a maximised window's floor is the screen's own: no ledge");
  assert.equal(b.stripGround, b.ground);
  // Another display (negative coordinates) and odd input.
  const c = liftedStage({ area: { x: -1920, y: 0, width: 1920, height: 1040 }, strip: { x: -1500, y: 600, width: 900, height: 240 }, box: BOX, floor: FLOOR });
  assert.equal(c.ledge.x1, 420);
  assert.equal(liftedStage({ area: null, strip: STRIP_LOW }), null);
  assert.equal(onStrip(a, { x: 900, y: a.box.y, half: 18 }), 'box');
  assert.equal(onStrip(a, { x: 400, y: a.ledge.y, half: 18 }), 'floor');
  assert.equal(onStrip(a, { x: 100, y: a.ground, half: 18 }), null, 'beside the window, on the screen edge: away');
  assert.equal(onStrip(a, { x: 400, y: a.ground, half: 18 }), null, 'below the window: away');
  const spot = nearestStripSpot(a, 50, 18);
  assert.ok(spot.x >= 300 + 18 && spot.y === a.ledge.y);
  const onBox = nearestStripSpot(a, 800, 18);
  assert.equal(onBox.y, a.box.y, 'never under the box: on top of it');
});

// ---------------------------------------------------------------- flight
function areaScene({ seed = 3, strip = STRIP_HIGH, box = BOX, size = 2 } = {}) {
  const st = liftedStage({ area: AREA, strip, box, floor: FLOOR });
  const q = E.create({ mount: null, width: st.W, height: st.H, size: sideFor(size), floor: FLOOR, x: 800, mode: 'idle', keepAlive: true });
  q.brainT.play = q.brainT.stunt = Infinity;
  q.bounds = [0, st.W];
  q.abilityOverrides = { jumpUp: st.ground - Math.min(st.stripGround, st.box ? st.box.y : Infinity) + q.S, dropDown: st.H };
  q.nav = null;
  const th = createThrow(q);
  th.setSolids(st.solids);
  return { q, th, st };
}

/** Every frame: the whole turned square inside the work area (never under its bottom edge: the taskbar). */
function inside(q, st, problems, label) {
  const a = (q.angle + q._tilt()) * DEG;
  const [hw, hh] = q._halfExtents();
  const ex = hw * Math.abs(Math.cos(a)) + hh * Math.abs(Math.sin(a));
  const ey = hh * Math.abs(Math.cos(a)) + hw * Math.abs(Math.sin(a));
  const x = q._rx ?? q.cx;
  const y = q._ry ?? q.ground - q.cy;
  if (x - ex < -1.5 || x + ex > st.W + 1.5) problems.push(`${label}: out sideways at x ${x.toFixed(1)}`);
  if (y - ey < -1.5) problems.push(`${label}: above the top at y ${y.toFixed(1)}`);
  if (y + ey > st.ground + 1.5) problems.push(`${label}: below the floor (y ${(y + ey).toFixed(1)} > ${st.ground})`);
}

async function fly(q, th, st, secs, problems, label) {
  let landed = null;
  const off = th.on('land', (d) => (landed = landed || d));
  const bounces = [];
  const offB = th.on('bounce', (b) => bounces.push(b.impact));
  for (let i = 0; i < secs * 60; i++) {
    q.update(1 / 60);
    inside(q, st, problems, label);
    await null;
    if (landed && !q.air && !q.pivot && !q.task && Math.abs(q.angleSettle.v) < 0.5 && Math.abs(q.angleSettle.vel) < 2) break;
  }
  off();
  offB();
  return { landed, bounces };
}

test('thrown: real physics inside the work area, bounces, and he lands flat on a face of a real surface', async () => {
  const problems = [];
  const surfaces = new Set();
  let bouncy = 0;
  await withRandom(21, async () => {
    const R = seeded(77);
    for (let n = 0; n < 40; n++) {
      const { q, th, st } = areaScene({ seed: n });
      // Held somewhere on the screen, dragged a little, then thrown in a random direction and speed.
      const start = { x: 80 + R() * (st.W - 160), y: 60 + R() * (st.ground - 160) };
      th.hold({ x: q.cx, y: q.ground - q.cy });
      th.move(start);
      for (let i = 0; i < 40; i++) {
        q.update(1 / 60);
        inside(q, st, problems, `held ${n}`);
        await null;
      }
      const ang = R() * Math.PI * 2;
      const speed = R() * THROW.maxSpeedS * q.S * 1.4; // some faster than the clamp
      th.release({ x: Math.cos(ang) * speed, y: Math.sin(ang) * speed });
      assert.ok(Math.hypot(q.vx, q.vy) <= THROW.maxSpeedS * q.S + 1e-6, 'clamped');
      const { landed, bounces } = await fly(q, th, st, 14, problems, `throw ${n}`);
      assert.ok(landed, `throw ${n} landed`);
      if (bounces.length) bouncy++;
      // Settled: on a face (no held lean or tilt), resting on the floor, the ledge or the box top.
      assert.ok(Math.abs(wrap(q.angle)) < 1, `throw ${n} flat on a face (angle ${q.angle.toFixed(2)})`);
      assert.ok(!q.air && !q.pivot);
      const surfaceY = Math.round(q.ground - q.sy);
      const named = surfaceY === Math.round(st.ground) ? 'floor' : surfaceY === Math.round(st.ledge.y) ? 'ledge' : surfaceY === Math.round(st.box.y) ? 'box' : `y ${surfaceY}`;
      assert.ok(['floor', 'ledge', 'box'].includes(named), `throw ${n} rests on a known surface (${named})`);
      surfaces.add(named);
      q.destroy();
    }
  });
  assert.deepEqual(problems.slice(0, 5), []);
  assert.ok(bouncy >= 10, `hard throws bounce (${bouncy} of 40)`);
  assert.ok(surfaces.has('floor'), `landed on the floor at least once (${[...surfaces]})`);
});

test('thrown straight up: he hits the work area\'s top, comes back down, and never leaves the screen', async () => {
  await withRandom(4, async () => {
    const { q, th, st } = areaScene();
    th.hold({ x: q.cx, y: q.ground - q.cy });
    th.move({ x: 100, y: 300 });
    for (let i = 0; i < 30; i++) q.update(1 / 60);
    let walls = 0;
    th.on('wall', () => walls++);
    th.release({ x: -900, y: -5000 }); // up and into the left edge
    const problems = [];
    const { landed } = await fly(q, th, st, 14, problems, 'up');
    assert.deepEqual(problems, []);
    assert.ok(walls > 0, 'touched the top or the side');
    assert.ok(landed);
    q.destroy();
  });
});

test('a slow release is a drop: he falls straight down and lands', async () => {
  await withRandom(5, async () => {
    const { q, th, st } = areaScene();
    th.hold({ x: q.cx, y: q.ground - q.cy });
    th.move({ x: 1450, y: 200 });
    for (let i = 0; i < 40; i++) q.update(1 / 60);
    const x0 = q.cx;
    th.release({ x: 0, y: 0 });
    const problems = [];
    const { landed } = await fly(q, th, st, 6, problems, 'drop');
    assert.deepEqual(problems, []);
    assert.ok(landed && Math.abs(q.cx - x0) < q.side * 0.8, `lands under where he was let go (${x0.toFixed(0)} -> ${q.cx.toFixed(0)})`);
    q.destroy();
  });
});

test('let go over the prompt box (inside it): it never traps him; he falls clear and lands', async () => {
  await withRandom(6, async () => {
    const { q, th, st } = areaScene();
    th.hold({ x: q.cx, y: q.ground - q.cy });
    th.move({ x: st.box.x + st.box.w / 2, y: st.box.y + 40 });
    for (let i = 0; i < 60; i++) q.update(1 / 60);
    th.release({ x: 0, y: 0 });
    const problems = [];
    const { landed } = await fly(q, th, st, 8, problems, 'in box');
    assert.ok(landed, 'landed');
    assert.deepEqual(problems, []);
    q.destroy();
  });
});

test('landed away from his strip (the screen edge beside it): he gets back onto it by his own route', async () => {
  for (const [label, strip] of [['high window', STRIP_HIGH], ['maximised window', STRIP_LOW]]) {
    await withRandom(8, async () => {
      const { q, th, st } = areaScene({ strip, box: label === 'high window' ? BOX : null });
      th.hold({ x: q.cx, y: q.ground - q.cy });
      th.move({ x: 60, y: st.ground - 120 }); // off to the left of the window
      for (let i = 0; i < 40; i++) q.update(1 / 60);
      th.release({ x: -200, y: 0 });
      const problems = [];
      await fly(q, th, st, 6, problems, label);
      assert.equal(onStrip(st, { x: q.cx, y: q.ground - q.sy, half: q.side / 2 }), null, `${label}: landed away`);
      const landX = q.cx;
      let done = null;
      headBack(q, st).then((ok) => (done = ok));
      let maxStep = 0;
      let prev = q._rx ?? q.cx;
      for (let i = 0; i < 60 * 20 && done === null; i++) {
        q.update(1 / 60);
        inside(q, st, problems, `${label} back`);
        const x = q._rx ?? q.cx;
        maxStep = Math.max(maxStep, Math.abs(x - prev));
        prev = x;
        await null;
      }
      assert.equal(done, true, `${label}: made it back (from x ${landX.toFixed(0)} to ${q.cx.toFixed(0)})`);
      assert.ok(onStrip(st, { x: q.cx, y: q.ground - q.sy, half: q.side / 2 }));
      assert.ok(maxStep < q.side * 0.6, `${label}: no jumps on the way (largest step ${maxStep.toFixed(1)} px)`);
      assert.deepEqual(problems, []);
      q.destroy();
    });
  }
});

// ---------------------------------------------------------------- inside the window he lives on
// While held or thrown his window covers the window he lives on (the Claude window, or the app's for
// Orbit anywhere), clipped to the work area: he stays inside it, never over another window.
test('the lifted rect: the host window clipped to the work area; no host, the work area', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(liftRectFor({ x: 300, y: 100, width: 1000, height: 700 }, area), { x: 300, y: 100, width: 1000, height: 700 });
  // Maximised (its invisible borders hang over the edges and under the taskbar): clipped.
  assert.deepEqual(liftRectFor({ x: -8, y: -8, width: 1936, height: 1056 }, area), { x: 0, y: 0, width: 1920, height: 1040 });
  // Half off the screen: only the part on it.
  assert.deepEqual(liftRectFor({ x: 1500, y: 600, width: 1000, height: 700 }, area), { x: 1500, y: 600, width: 420, height: 440 });
  assert.deepEqual(liftRectFor(null, area), area, 'no window to live on: the work area');
  assert.equal(liftRectFor({ x: 5000, y: 0, width: 800, height: 600 }, area), null, 'not on this screen at all');
  assert.equal(liftRectFor({ x: 0, y: 0, width: 800, height: 600 }, null), null);
});

function windowScene({ host, workArea = AREA, box = BOX, seed = 3 } = {}) {
  const lifted = liftRectFor(host, workArea);
  const strip = buddyBoundsFor(host);
  const st = liftedStage({ area: lifted, strip, box, floor: FLOOR });
  const q = E.create({ mount: null, width: st.W, height: st.H, size: 36, floor: FLOOR, x: st.W / 2, mode: 'idle', keepAlive: true });
  q.brainT.play = q.brainT.stunt = Infinity;
  q.bounds = [0, st.W];
  const th = createThrow(q);
  th.setSolids(st.solids);
  return { q, th, st, lifted, strip };
}

test('thrown inside his window: random throws bounce off its edges and land on its floor or the prompt box', async () => {
  const problems = [];
  const where = new Set();
  await withRandom(31, async () => {
    const R = seeded(91);
    for (let n = 0; n < 40; n++) {
      // Windows of different sizes and places, some hanging off the screen.
      const host = { x: Math.round(-200 + R() * 1200), y: Math.round(R() * 400), width: Math.round(700 + R() * 900), height: Math.round(450 + R() * 600) };
      const { q, th, st, lifted } = windowScene({ host, box: R() < 0.7 ? BOX : null });
      assert.equal(st.W, lifted.width, 'his stage is that window (clipped), not the screen');
      th.hold({ x: q.cx, y: q.ground - q.cy });
      th.move({ x: R() * st.W, y: R() * st.ground });
      for (let i = 0; i < 30; i++) {
        q.update(1 / 60);
        inside(q, st, problems, `held ${n}`);
        await null;
      }
      const ang = R() * Math.PI * 2;
      const speed = R() * THROW.maxSpeedS * q.S;
      th.release({ x: Math.cos(ang) * speed, y: Math.sin(ang) * speed });
      const { landed } = await fly(q, th, st, 14, problems, `throw ${n}`);
      assert.ok(landed, `throw ${n} landed`);
      assert.ok(Math.abs(wrap(q.angle)) < 1, `throw ${n} flat on a face`);
      const on = onStrip(st, { x: q.cx, y: q.ground - q.sy, half: q.side / 2 });
      assert.ok(on === 'floor' || on === 'box', `throw ${n}: on his window's floor or the prompt box (${on}, x ${Math.round(q.cx)} y ${Math.round(q.ground - q.sy)}, stage ${JSON.stringify({ W: st.W, ground: st.ground, sg: st.stripGround, box: st.box, ledge: st.ledge, sx: st.stripX })})`);
      where.add(on);
      q.destroy();
    }
  });
  assert.deepEqual(problems.slice(0, 5), [], 'never outside his window (so never over another one)');
  assert.ok(where.has('floor'));
});

test("held: dragged past his window's edge, he stops at the edge", async () => {
  await withRandom(32, async () => {
    const { q, th, st } = windowScene({ host: { x: 300, y: 100, width: 1000, height: 700 } });
    th.hold({ x: q.cx, y: q.ground - q.cy });
    const problems = [];
    for (const target of [{ x: -900, y: 300 }, { x: st.W + 900, y: 300 }, { x: 400, y: -800 }, { x: 400, y: st.H + 800 }]) {
      th.move(target);
      for (let i = 0; i < 40; i++) {
        q.update(1 / 60);
        inside(q, st, problems, 'held');
      }
      const x = q._rx ?? q.cx;
      const y = q.ground - q.cy;
      const half = q.side / 2;
      assert.ok(x >= half - 1 && x <= st.W - half + 1 && y >= half - 1 && y <= st.ground - half + 1, `clamped at the edge for ${JSON.stringify(target)}: ${x.toFixed(0)},${y.toFixed(0)}`);
    }
    assert.deepEqual(problems, []);
    q.destroy();
  });
});

// ---------------------------------------------------------------- the strip again, and the director
test('reframe: carried between the strip and the work area, his place on screen stays put', async () => {
  await withRandom(9, async () => {
    const strip = STRIP_HIGH;
    const q = E.create({ mount: null, width: strip.width, height: strip.height, size: 36, floor: FLOOR, x: 400, mode: 'idle', keepAlive: true });
    const th = createThrow(q);
    for (let i = 0; i < 10; i++) q.update(1 / 60);
    const screen = () => ({ x: (q._rx ?? q.cx) + origin.x, y: q.ground - q.cy + origin.y });
    let origin = { x: strip.x, y: strip.y };
    const before = screen();
    th.reframe({ shift: { x: strip.x - AREA.x, y: strip.y - AREA.y }, W: AREA.width, H: AREA.height, floor: FLOOR });
    origin = { x: AREA.x, y: AREA.y };
    q.update(1 / 60);
    const lifted = screen();
    assert.ok(Math.abs(lifted.x - before.x) < 0.5 && Math.abs(lifted.y - before.y) < 0.5, `${JSON.stringify(before)} vs ${JSON.stringify(lifted)}`);
    assert.equal(Math.round(q.ground - q.sy), strip.y + strip.height - FLOOR, 'still standing on the strip floor line');
    th.reframe({ shift: { x: AREA.x - strip.x, y: AREA.y - strip.y }, W: strip.width, H: strip.height, floor: FLOOR });
    origin = { x: strip.x, y: strip.y };
    q.update(1 / 60);
    const back = screen();
    assert.ok(Math.abs(back.x - before.x) < 0.5 && Math.abs(back.y - before.y) < 0.5);
    assert.ok(Math.abs(q.sy) < 0.5, 'on the strip floor again');
    q.destroy();
  });
});

test('director: picked up, thrown and landed, he carries on from where he landed (never back where he started)', async () => {
  const W = 1200;
  const H = 240;
  const box = { x: 300, y: 142, w: 624, h: 98 };
  const send = { x: 872, y: 196, w: 32, h: 32 };
  for (const voice of [{ phase: 'listening', draft: true }, { phase: 'off' }]) {
    await withRandom(12, async () => {
      const q = E.create({ mount: null, width: W, height: H, size: sideFor(2), floor: FLOOR, mode: 'asleep', keepAlive: true });
      q.brainT.play = q.brainT.stunt = Infinity;
      const dir = createDirector(q, { seed: 12, life: { dozeS: [600, 600] } });
      const th = createThrow(q);
      dir.setVoice(voice);
      dir.setGeometry({ W, H, box, send, side: sideFor(2) });
      dir.place();
      const step = async (n, each) => {
        for (let i = 0; i < n; i++) {
          q.update(1 / 60);
          dir.tick(1 / 60);
          each?.();
          await null;
        }
      };
      await step(120);
      const startX = q.cx;
      th.hold({ x: q.cx, y: q.ground - q.cy });
      dir.grabbed();
      assert.equal(q.mode, 'surprised');
      th.move({ x: 120, y: 120 }); // over the floor, left of the box
      await step(50);
      assert.equal(dir.reaction, 'held');
      th.release({ x: -150, y: 0 });
      dir.thrown();
      let land = null;
      th.on('land', (d) => {
        land = d;
        dir.landed({ impact: d.impact, bounces: d.bounces });
      });
      const paths = [];
      q.on('path', (p) => paths.push(p.path ? p.path[0]?.from?.x : null));
      await step(240, () => {});
      assert.ok(land, 'landed');
      assert.ok(Math.abs(land.x - startX) > 100, 'landed well away from where he was picked up');
      // The reaction ran and ended; his state took over again.
      assert.equal(dir.reaction, null, `the reaction ended (${dir.reaction})`);
      let maxStep = 0;
      let prev = q._rx ?? q.cx;
      await step(60 * 6, () => {
        const x = q._rx ?? q.cx;
        maxStep = Math.max(maxStep, Math.abs(x - prev));
        prev = x;
      });
      assert.ok(maxStep < q.side * 0.6, `no snap back to where he started (largest step ${maxStep.toFixed(1)} px)`);
      if (voice.draft) {
        // "Send it?": he heads for his spot by Send, starting from where he landed.
        assert.ok(paths.length > 0 && Math.abs(paths[0] - land.x) < q.side, `his route starts where he landed (${paths[0]?.toFixed?.(0)} vs ${land.x.toFixed(0)})`);
      } else {
        // Orbit off: he dozes off right where he landed.
        assert.ok(Math.abs(q.cx - land.x) < q.side * 0.8, `dozes where he landed (${q.cx.toFixed(0)} vs ${land.x.toFixed(0)})`);
        assert.ok(['sleepy', 'asleep'].includes(q.mode), q.mode);
      }
      assert.ok(Math.abs(wrap(q.angle)) < 1, 'level: no held lean');
      q.destroy();
    });
  }
});

test('director: thrown while asleep (Orbit off, low power): a start in the air, then he dozes off again where he landed', async () => {
  await withRandom(14, async () => {
    const q = E.create({ mount: null, width: 1200, height: 240, size: 36, floor: FLOOR, mode: 'asleep', keepAlive: true });
    q.brainT.play = q.brainT.stunt = Infinity;
    const dir = createDirector(q, { seed: 14, life: { dozeS: [600, 600] } });
    const th = createThrow(q);
    dir.setVoice({ phase: 'off' });
    dir.setGeometry({ W: 1200, H: 240, box: null, send: null, side: 36 });
    dir.place();
    const step = async (n) => {
      for (let i = 0; i < n; i++) {
        q.update(1 / 60);
        dir.tick(1 / 60);
        await null;
      }
    };
    await step(90);
    assert.equal(q.mode, 'asleep');
    assert.equal(dir.lowPower(), true, 'asleep and still: low power');
    th.hold({ x: q.cx, y: q.ground - q.cy });
    dir.grabbed();
    assert.equal(dir.lowPower(), false, 'held: full rate');
    assert.equal(q.mode, 'surprised', 'he wakes with a start when picked up');
    th.move({ x: 300, y: 60 });
    await step(40);
    th.release({ x: 400, y: -300 });
    dir.thrown();
    let land = null;
    th.on('land', (d) => {
      land = d;
      dir.landed(d);
    });
    await step(60 * 10);
    assert.ok(land, 'landed');
    assert.equal(dir.reaction, null);
    assert.ok(['sleepy', 'asleep'].includes(q.mode), `back to sleep (${q.mode})`);
    assert.ok(Math.abs(q.cx - land.x) < q.side, `where he landed (${q.cx.toFixed(0)} vs ${land.x.toFixed(0)})`);
    await step(60 * 4);
    assert.equal(q.mode, 'asleep');
    assert.equal(dir.lowPower(), true, 'asleep and still again: low power');
    q.destroy();
  });
});

test('director: a click that starts talking is only a tiny acknowledgement; a held or flying Qubit ignores it', async () => {
  await withRandom(13, async () => {
    const q = E.create({ mount: null, width: 1200, height: 240, size: 36, floor: FLOOR, mode: 'asleep', keepAlive: true });
    const dir = createDirector(q, { seed: 13, life: { dozeS: [600, 600] } });
    dir.setVoice({ phase: 'listening' });
    dir.setGeometry({ W: 1200, H: 240, box: null, send: null, side: 36 });
    dir.place();
    for (let i = 0; i < 60; i++) (q.update(1 / 60), dir.tick(1 / 60));
    const acts = [];
    q.on('action', (a) => acts.push(a.name));
    dir.ack();
    for (let i = 0; i < 30; i++) (q.update(1 / 60), dir.tick(1 / 60));
    assert.deepEqual(acts, ['nod']);
    dir.grabbed();
    acts.length = 0;
    dir.ack();
    q.update(1 / 60);
    assert.deepEqual(acts, []);
    q.destroy();
  });
});
