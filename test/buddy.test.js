// The pixel buddy: its drawing, its behaviour, and where its window goes. All in Node: the engine
// and sprite are plain JS with no DOM, and the window geometry is pure functions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ANTENNA, createBuddy, modeFor } from '../ui/src/buddy/engine.js';
import { BASE_POSE, GLYPH_NAMES, PALETTE, drawBuddy, glyph } from '../ui/src/buddy/sprite.js';
import { BOX_PADDING, BUDDY_HEIGHT, FREE_STRIP_MAX_WIDTH, boxInStrip, buddyBoundsFor, freeStripFor } from '../electron/buddy-geometry.js';

/** A seeded random number generator, so every run does the same things. */
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ---------- drawing ----------
const POSE_VALUES = {
  facing: [1, -1, 0],
  squash: [0, 1, 2],
  legs: ['stand', 'walk0', 'walk1', 'walk2', 'walk3', 'jump', 'sit', 'dangle0', 'dangle1', 'spread'],
  armL: ['down', 'up', 'out', 'ear', 'chin', 'wave0', 'wave1', 'hold', 'push', 'type0', 'type1', 'flail0', 'flail1'],
  eyes: ['open', 'closed', 'half', 'wide', 'happy', 'dizzy', 'look'],
  mouth: ['none', 'smile', 'open1', 'open2', 'yawn', 'o', 'flat', 'grin'],
  lie: [0, 1],
};

test('every pose draws a whole figure that stays in its 16-pixel box', () => {
  const rng = seeded(3);
  const any = (arr) => arr[Math.floor(rng() * arr.length)];
  for (let i = 0; i < 600; i++) {
    const pose = Object.fromEntries(Object.entries(POSE_VALUES).map(([k, v]) => [k, any(v)]));
    pose.armR = any(POSE_VALUES.armL);
    pose.bob = i % 2;
    pose.antennaGlow = rng();
    const px = drawBuddy(pose);
    assert.ok(px.length > 60, `${JSON.stringify(pose)}: only ${px.length} pixels`);
    for (const [x, y, c] of px) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), 'whole pixels');
      assert.ok(typeof c === 'string' && c.length > 0);
      if (pose.lie) assert.ok(x >= -10 && x <= 10 && y >= -2 && y <= 12, `lying pixel (${x},${y})`);
      else assert.ok(x >= -8 && x <= 7 && y >= -3 && y <= 17, `pixel (${x},${y}) out of its box in ${JSON.stringify(pose)}`);
    }
    const colors = new Set(px.map(([, , c]) => c));
    assert.ok(colors.has(PALETTE.line) && colors.has(PALETTE.body), 'outline and body are drawn');
  }
});

test('standing, the figure is 16 pixels tall from its feet to the top of its antenna', () => {
  const ys = drawBuddy(BASE_POSE).map(([, y]) => y);
  assert.equal(Math.min(...ys), 0, 'feet on the ground row');
  assert.equal(Math.max(...ys), 15, 'antenna top');
});

test('facing left is the mirror image of facing right', () => {
  const key = (px) => px.map(([x, y, c]) => `${x},${y},${c}`).sort().join('|');
  const right = drawBuddy({ facing: 1, armR: 'up', legs: 'walk1' });
  const left = drawBuddy({ facing: -1, armR: 'up', legs: 'walk1' });
  assert.equal(key(left), key(right.map(([x, y, c]) => [-1 - x, y, c])));
});

test('the antenna shows the state colour, and every effect glyph exists', () => {
  const px = drawBuddy({ antenna: '#123456' });
  assert.ok(px.some(([, , c]) => c === '#123456'));
  for (const name of GLYPH_NAMES) {
    const g = glyph(name, '#abcdef');
    assert.ok(g && g.length > 0, name);
  }
  assert.equal(glyph('nope'), null);
});

// ---------- behaviour ----------
const WORLD = { w: 400, h: 120, platforms: [{ id: 'box', x0: 120, x1: 320, y: 45 }] };
function sim(bd, secs, { voice = { phase: 'listening' }, world = WORLD, events = [], cursor = null, each } = {}) {
  let f = null;
  for (let i = 0; i < Math.round(secs * 60); i++) {
    f = bd.step({ dt: 1 / 60, world, voice, events: i === 0 ? events : [], cursor });
    each?.(f);
  }
  return f;
}

test('modes follow Orbit: off or asleep sleeps; connecting, listening, hearing, thinking and talking each have their own', () => {
  assert.equal(modeFor({ phase: 'off' }), 'sleep');
  assert.equal(modeFor({ phase: 'listening', asleep: true }), 'sleep');
  assert.equal(modeFor({ phase: 'connecting' }), 'connecting');
  assert.equal(modeFor({ phase: 'listening' }), 'listen');
  assert.equal(modeFor({ phase: 'listening', hearing: true }), 'hear');
  assert.equal(modeFor({ phase: 'thinking' }), 'think');
  assert.equal(modeFor({ phase: 'speaking' }), 'talk');
  assert.equal(modeFor(undefined), 'sleep');
});

test('asleep it sits and snores Zs; waking, it hops up and stretches, then gets on with listening', () => {
  const bd = createBuddy({ rng: seeded(1) });
  let sawZ = false;
  let f = sim(bd, 4, { voice: { phase: 'off' }, each: (fr) => (sawZ ||= fr.fx.some((e) => e.g === 'z' || e.g === 'Z')) });
  assert.equal(f.mode, 'sleep');
  assert.equal(f.pose.legs, 'sit');
  assert.equal(f.pose.eyes, 'closed');
  assert.equal(f.pose.antenna, ANTENNA.sleep);
  assert.ok(sawZ, 'Zs float up');
  const tasks = new Set();
  sim(bd, 0.8, { voice: { phase: 'connecting' }, each: (fr) => tasks.add(fr.task) });
  f = sim(bd, 3, { voice: { phase: 'listening' }, each: (fr) => tasks.add(fr.task) });
  assert.ok(tasks.has('wake'), 'the wake-up routine ran');
  assert.equal(f.mode, 'listen');
  assert.equal(f.pose.antenna, ANTENNA.listen);
});

test('hearing: a hand to its ear and a green antenna that glows with your voice; talking: its mouth moves with Orbit\x27s voice', () => {
  const bd = createBuddy({ rng: seeded(2) });
  sim(bd, 3, { voice: { phase: 'listening' } });
  let f = sim(bd, 1, { voice: { phase: 'listening', hearing: true, input: 0.4 } });
  assert.equal(f.mode, 'hear');
  assert.ok(f.pose.armR === 'ear' || f.pose.armL === 'ear');
  assert.equal(f.pose.antenna, ANTENNA.hear);
  assert.ok(f.pose.antennaGlow > 0.5);
  const mouths = new Set();
  sim(bd, 2, { voice: { phase: 'speaking', output: 0.3 }, each: (fr) => mouths.add(fr.pose.mouth) });
  assert.ok(mouths.has('open2') || mouths.has('open1'), 'mouth opens while talking');
  const quiet = new Set();
  sim(bd, 1, { voice: { phase: 'speaking', output: 0 }, each: (fr) => quiet.add(fr.pose.mouth) });
  assert.ok(!quiet.has('open2'), 'and closes when there is no sound');
  f = sim(bd, 1, { voice: { phase: 'thinking' } });
  assert.equal(f.pose.antenna, ANTENNA.think);
  assert.ok(f.pose.armR === 'chin');
});

test('it climbs onto the prompt box to deliver a draft, and stomps Send with a paper plane flying off', () => {
  const bd = createBuddy({ rng: seeded(4), x: 30 });
  sim(bd, 3, { voice: { phase: 'listening' } });
  let carried = false;
  let dropped = false;
  let onBox = false;
  sim(bd, 7, {
    events: ['draft'],
    each: (fr) => {
      carried ||= fr.prop?.g === 'letter';
      dropped ||= fr.fx.some((e) => e.g === 'letter');
      onBox ||= fr.on === 'box';
    },
  });
  assert.ok(carried, 'carries a letter');
  assert.ok(onBox, 'gets up onto the box');
  assert.ok(dropped, 'drops it in');
  let plane = false;
  sim(bd, 6, { events: ['sent'], each: (fr) => (plane ||= fr.fx.some((e) => e.g === 'plane')) });
  assert.ok(plane, 'a paper plane flies off');
});

test('Claude finishing: awake, it celebrates with sparkles; asleep, it jolts, then sleeps on and still reacts later', () => {
  const awake = createBuddy({ rng: seeded(5) });
  sim(awake, 3);
  let sparkles = false;
  sim(awake, 3, { events: ['finished'], each: (fr) => (sparkles ||= fr.fx.some((e) => e.g === 'sparkle')) });
  assert.ok(sparkles);

  const asleep = createBuddy({ rng: seeded(6) });
  sim(asleep, 2, { voice: { phase: 'off' } });
  let bang = false;
  const f = sim(asleep, 4, { voice: { phase: 'off' }, events: ['finished'], each: (fr) => (bang ||= fr.fx.some((e) => e.g === '!')) });
  assert.ok(bang, 'a startled "!"');
  assert.equal(f.mode, 'sleep');
  assert.equal(f.pose.eyes, 'closed', 'back asleep');
  // Events after that still get through (the startle doesn't leave it stuck).
  let bang2 = false;
  sim(asleep, 3, { voice: { phase: 'off' }, events: ['finished'], each: (fr) => (bang2 ||= fr.task === 'finished') });
  assert.ok(bang2);
});

test('a click gets a reaction; picked up it dangles, and dropped from high it lands dizzy', () => {
  const bd = createBuddy({ rng: seeded(7), x: 60 });
  sim(bd, 3);
  bd.poke();
  let reacted = false;
  sim(bd, 1, { each: (fr) => (reacted ||= fr.task === 'poke') });
  assert.ok(reacted);
  sim(bd, 3);
  const s = bd.state;
  assert.ok(bd.hit(s.x, s.y + 8), 'clicking its middle hits it');
  assert.ok(!bd.hit(s.x + 30, s.y + 8));
  bd.grab(s.x, 125); // as high as its window allows
  let f = sim(bd, 1);
  assert.ok(f.y > 60, 'lifted up');
  assert.ok(f.pose.legs.startsWith('dangle'), 'legs kicking');
  bd.release();
  const seen = new Set();
  f = sim(bd, 3, { each: (fr) => seen.add(fr.pose.eyes) });
  assert.ok(seen.has('dizzy'), 'a hard landing leaves it seeing stars');
  assert.ok(f.y === 0 || f.on === 'box', 'it ends up standing on something');
});

test('it looks at a nearby cursor, and hops out of the way when the cursor comes right at it', () => {
  const bd = createBuddy({ rng: seeded(8), x: 200 });
  sim(bd, 4);
  const s = bd.state;
  let looked = false;
  sim(bd, 0.5, { cursor: { x: s.x + 30, y: s.y + 10 }, each: (fr) => (looked ||= fr.pose.lookX === 1) });
  assert.ok(looked);
  const x0 = bd.state.x;
  let dodged = false;
  sim(bd, 1.5, { cursor: { x: bd.state.x + 2, y: bd.state.y + 8 }, each: (fr) => (dodged ||= fr.task === 'dodge') });
  assert.ok(dodged);
  assert.ok(Math.abs(bd.state.x - x0) > 4, 'it moved away');
});

test('standing on the box when the box goes away (or moves), it falls to the floor', () => {
  const bd = createBuddy({ rng: seeded(9), x: 30 });
  sim(bd, 3);
  sim(bd, 7, { events: ['draft'] });
  assert.equal(bd.state.on, 'box');
  sim(bd, 1.5, { world: { w: 400, h: 120, platforms: [] } });
  assert.equal(bd.state.on, 'floor');
  assert.equal(bd.state.y, 0);
});

test('long random runs: it never leaves its window, never breaks, and keeps its effects bounded', () => {
  for (const seed of [11, 12, 13, 14, 15]) {
    const rng = seeded(seed);
    const bd = createBuddy({ rng, x: 50 });
    const phases = ['off', 'connecting', 'listening', 'listening', 'thinking', 'speaking'];
    let voice = { phase: 'off' };
    let world = WORLD;
    for (let sec = 0; sec < 240; sec++) {
      if (rng() < 0.15) voice = { phase: phases[Math.floor(rng() * phases.length)], hearing: rng() < 0.3, input: rng(), output: rng(), claudeWorking: rng() < 0.4, asleep: rng() < 0.1 };
      if (rng() < 0.05) world = rng() < 0.5 ? WORLD : { w: 200 + rng() * 600, h: 80 + rng() * 80, platforms: rng() < 0.6 ? [{ id: 'box', x0: 40 + rng() * 60, x1: 160 + rng() * 300, y: 20 + rng() * 40 }] : [] };
      const events = rng() < 0.1 ? [['finished', 'draft', 'sent', 'poke'][Math.floor(rng() * 4)]] : [];
      if (rng() < 0.03) bd.grab(rng() * world.w, rng() * world.h);
      if (rng() < 0.05) bd.release();
      const cursor = rng() < 0.3 ? { x: rng() * world.w, y: rng() * world.h } : null;
      sim(bd, 1, {
        voice,
        world,
        events,
        cursor,
        each: (f) => {
          assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y), 'a real position');
          assert.ok(f.x >= 4.9 && f.x <= world.w - 4.9 + 1e-6, `x ${f.x} inside 0..${world.w}`);
          assert.ok(f.y >= 0 && f.y <= world.h, `y ${f.y}`);
          assert.ok(f.fx.length <= 80, 'effects bounded');
          drawBuddy(f.pose);
        },
      });
    }
    bd.release();
  }
});

// ---------- its window ----------
test('the strip is the bottom of the Claude window, full width, and never taller than 60% of it', () => {
  assert.deepEqual(buddyBoundsFor({ x: 100, y: 50, width: 1200, height: 800 }), { x: 100, y: 850 - BUDDY_HEIGHT, width: 1200, height: BUDDY_HEIGHT });
  const small = buddyBoundsFor({ x: 0, y: 0, width: 500, height: 200 });
  assert.equal(small.height, 120);
  assert.equal(small.y, 80);
});

test('the prompt box lands in the right place in the strip at any display scaling', () => {
  // UI Automation saw the window at 1500×1000 (150% scaling, say) with the box near its bottom.
  const uiaWin = { x: 300, y: 150, w: 1500, h: 1000 };
  const uiaBox = { x: 300 + 450, y: 150 + 820, w: 600, h: 150 };
  const claudeDip = { x: 200, y: 100, width: 1000, height: 666.67 };
  const strip = buddyBoundsFor(claudeDip);
  const r = boxInStrip(uiaBox, uiaWin, claudeDip, strip);
  // The text field's rect, padded out to the visible box.
  assert.equal(r.x, 300 - BOX_PADDING.padX);
  assert.equal(r.w, 400 + 2 * BOX_PADDING.padX);
  assert.equal(r.y, Math.round(100 + 0.82 * 666.67 - strip.y - BOX_PADDING.padTop));
  assert.equal(r.h, 100 + BOX_PADDING.padTop);
  assert.equal(boxInStrip(null, uiaWin, claudeDip, strip), null);
  assert.equal(boxInStrip({ x: 5000, y: 0, w: 10, h: 10 }, uiaWin, claudeDip, strip), null, 'a box off the window is ignored');
  assert.equal(boxInStrip(uiaBox, { x: 0, y: 0, w: 0, h: 0 }, claudeDip, strip), null);
});

test('Claude\x27s prompt box sits too low to walk under: it goes over the top to get past, never through', () => {
  const world = { w: 400, h: 120, platforms: [{ id: 'box', x0: 120, x1: 320, y: 45, bottom: 6 }] };
  const bd = createBuddy({ rng: seeded(21), x: 40 });
  sim(bd, 3, { world });
  // Let it roam (wandering, climbing, kicking a ball...) and watch where it goes.
  let wentOver = false;
  let inside = false;
  for (let i = 0; i < 40 && !wentOver; i++) {
    sim(bd, 1, {
      world,
      each: (f) => {
        if (f.on === 'box') wentOver = true;
        if (f.y < 44 && f.x > 121 && f.x < 319) inside = true;
      },
    });
  }
  assert.ok(wentOver, 'it got up onto the box at some point');
  assert.ok(!inside, 'never inside the box below its top');
});

test('a box that grows around it (you typed more lines) pushes it out to the nearer side', () => {
  const bd = createBuddy({ rng: seeded(22), x: 130 });
  sim(bd, 2, { world: { w: 400, h: 120, platforms: [] } });
  const f = sim(bd, 0.2, { world: { w: 400, h: 120, platforms: [{ id: 'box', x0: 120, x1: 320, y: 45, bottom: 6 }] } });
  assert.ok(f.x <= 117.01 || f.x >= 322.99 || f.on === 'box', `out of the box (x ${f.x})`);
});

test('its nap spot is on the prompt box near its right end: it starts there, and walks back to it to sleep', () => {
  const bd = createBuddy({ rng: seeded(31) });
  let f = sim(bd, 0.5, { voice: { phase: 'off' } });
  assert.equal(f.on, 'box', 'starts on the box, not in a corner of the window');
  assert.ok(Math.abs(f.x - (320 - 14)) < 1);
  // Awake, it wanders off; when Orbit goes to sleep it heads home before nodding off.
  sim(bd, 30, { voice: { phase: 'listening' } });
  f = sim(bd, 12, { voice: { phase: 'off' } });
  assert.equal(f.on, 'box');
  assert.ok(Math.abs(f.x - (320 - 14)) < 2, `asleep at its spot (x ${f.x})`);
  assert.equal(f.pose.eyes, 'closed');
  // No box (another Claude page): it starts mid-window.
  const lone = createBuddy({ rng: seeded(32) });
  f = sim(lone, 2, { voice: { phase: 'off' }, world: { w: 400, h: 120, platforms: [] } });
  assert.ok(Math.abs(f.x - 200) < 1);
});

test('asleep in the middle when the box turns up late, it sleepwalks to its spot on the box', () => {
  const bd = createBuddy({ rng: seeded(33) });
  sim(bd, 2, { voice: { phase: 'off' }, world: { w: 400, h: 120, platforms: [] } }); // no box yet: mid-window
  assert.equal(bd.state.on, 'floor');
  let walked = false;
  const f = sim(bd, 14, { voice: { phase: 'off' }, each: (fr) => (walked ||= fr.task === 'sleepwalk' && fr.pose.eyes === 'closed') });
  assert.ok(walked, 'sleepwalking, eyes shut');
  assert.equal(f.on, 'box');
  assert.ok(Math.abs(f.x - 306) < 2);
  assert.equal(f.mode, 'sleep');
});

test('free-floating avatar: a strip along the bottom of the work area (above the Dock), centred, capped', () => {
  const mac = { x: 0, y: 25, width: 1512, height: 870 }; // under the menu bar, above the Dock
  const s = freeStripFor(mac);
  assert.equal(s.width, FREE_STRIP_MAX_WIDTH);
  assert.equal(s.y + s.height, mac.y + mac.height, 'stands on the top of the Dock');
  assert.equal(s.x, Math.round((1512 - FREE_STRIP_MAX_WIDTH) / 2));
  const small = freeStripFor({ x: 100, y: 0, width: 600, height: 300 });
  assert.equal(small.width, 552, '24 px margin each side');
  assert.equal(small.height, 180, 'at most 60% of a short screen');
  assert.equal(small.x, 124);
});
