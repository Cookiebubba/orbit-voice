// The pixel buddy's mind and body: physics (gravity, jumps, landing on the ground or on top of
// Claude's prompt box), getting places (walking, hopping up onto the box and off it), and little
// scripted routines for each state of Orbit and each thing that happens.
//
// Plain JS with no DOM: main.js feeds it the world and Orbit's state every frame and draws what it
// returns; the tests drive it the same way.
//
// Units are art pixels (the buddy is 16 tall) and seconds; y is the height above the ground.
//
// Routines are generator functions: each `yield` waits one frame (it receives the frame's dt), so a
// routine reads like a script ("hop, wait 0.3 s, stretch..."). A new mode or event replaces the
// running routine; being picked up interrupts everything.

export const PHYS = Object.freeze({ gravity: 260, walk: 24, run: 46, maxFall: 260 });

// Antenna colour per state (the ball on its head shows what Orbit is doing).
export const ANTENNA = Object.freeze({
  sleep: '#6b6b6b',
  connecting: '#fbbf24',
  listen: '#38bdf8',
  hear: '#4ade80',
  think: '#a78bfa',
  talk: '#f59e0b',
});

/** Orbit's voice state → the buddy's mode. */
export function modeFor(v = {}) {
  if (!v || v.phase === 'off' || !v.phase) return 'sleep';
  if (v.asleep) return 'sleep';
  if (v.phase === 'connecting') return 'connecting';
  if (v.phase === 'speaking') return 'talk';
  if (v.phase === 'thinking') return 'think';
  if (v.hearing) return 'hear';
  return 'listen';
}

const EVENT_NAMES = new Set(['finished', 'draft', 'sent', 'poke']);

export function createBuddy({ rng = Math.random, x = 40 } = {}) {
  const b = {
    x,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 1,
    on: 'floor', // 'floor', a platform id, or null while in the air
    t: 0,
    mode: null,
    task: null,
    taskName: '',
    over: {}, // pose fields the routine wants right now
    prop: null, // { g, dx, dy, color, color2 } carried or used (laptop, letter)
    fx: [], // effects: { g, x, y, vx, vy, age, life, color, color2, grav, fade, follow }
    events: [],
    grab: null, // { x, y } while the user holds it
    fallFrom: 0, // the height a fall started at (for dizzy landings)
    squashT: 0, // landing squash time left
    blinkAt: 2,
    walkDist: 0,
    lastCursor: null,
    dodgeAt: -10,
    idleSince: 0,
    world: { w: 200, h: 60, platforms: [] },
    voice: {},
    lastLand: 0,
    walls: 0, // times it walked into a wall (for the occasional bonk)
  };
  const R = (a, z) => a + rng() * (z - a);
  const chance = (p) => rng() < p;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  // ---------- helpers ----------
  const platform = (id) => b.world.platforms.find((p) => p.id === id) || null;
  const box = () => platform('box');
  const levelY = (on) => (on === 'floor' ? 0 : platform(on)?.y ?? 0);
  /** Too low to walk under (Claude's prompt box sits just above the bottom): a block to go over. */
  const solid = (p) => p && Number.isFinite(p.bottom) && p.bottom < 17;
  /** A solid platform between here and x, on the floor. */
  const blockerBetween = (x) => b.world.platforms.find((p) => solid(p) && Math.min(b.x, x) < p.x0 && Math.max(b.x, x) > p.x1);
  const edgeMargin = 5;

  function addFx(g, x, y, o = {}) {
    b.fx.push({ g, x, y, vx: 0, vy: 0, age: 0, life: 1, color: '#ffffff', color2: '#1b1210', grav: 0, fade: true, ...o });
    if (b.fx.length > 80) b.fx.shift();
  }
  const head = () => ({ x: b.x, y: b.y + 17 });
  function say(g, color = '#ffffff', life = 0.9) {
    const h = head();
    addFx(g, h.x + 3 * (b.facing || 1), h.y, { vy: 6, life, color, follow: true });
  }
  function burst(g, n, color, speed = 30) {
    for (let i = 0; i < n; i++) {
      const a = R(0.2, Math.PI - 0.2);
      addFx(g, b.x + R(-2, 2), b.y + R(6, 12), { vx: Math.cos(a) * speed * R(0.5, 1), vy: Math.sin(a) * speed * R(0.6, 1.2), grav: 60, life: R(0.6, 1.1), color });
    }
  }
  function dust() {
    addFx('dust', b.x - 5, b.y, { vx: -10, vy: 3, life: 0.35, color: '#9ca3af' });
    addFx('dust', b.x + 3, b.y, { vx: 10, vy: 3, life: 0.35, color: '#9ca3af' });
  }

  // ---------- routine building blocks (generators) ----------
  function* wait(s) {
    let t = 0;
    while (t < s) t += yield;
  }
  function* hold(s, pose) {
    b.over = { ...pose };
    yield* wait(s);
  }
  /** Get onto the floor or a platform at x, walking, hopping up and stepping off as needed. */
  function* walkTo(tx, level = b.on || 'floor', speed = PHYS.walk, maxS = 8) {
    let spent = 0;
    const W = b.world.w;
    tx = Math.max(edgeMargin, Math.min(W - edgeMargin, tx));
    while (spent < maxS) {
      const dt = yield;
      spent += dt;
      if (b.on === null) continue; // in the air: let it land
      const target = level === 'floor' || platform(level) ? level : 'floor';
      const P = target === 'floor' ? null : platform(target);
      if (P) tx = Math.max(P.x0 + 3, Math.min(P.x1 - 3, tx));
      // On the floor with a solid box in the way: over it (up, across, down the far side).
      if (b.on === 'floor' && target === 'floor') {
        const wall = blockerBetween(tx);
        if (wall) {
          const ok = yield* walkTo((wall.x0 + wall.x1) / 2, wall.id, speed, maxS - spent);
          if (!ok) break;
          continue;
        }
      }
      if (b.on === target) {
        const d = tx - b.x;
        if (Math.abs(d) < 1.2) {
          b.vx = 0;
          return true;
        }
        b.vx = Math.sign(d) * speed;
        b.facing = Math.sign(d);
        continue;
      }
      if (b.on !== 'floor') {
        // On a platform, going down: walk off the nearer edge (or the one toward the target).
        const Q = platform(b.on);
        if (!Q) continue;
        const goRight = tx > (Q.x0 + Q.x1) / 2;
        const edge = goRight ? Q.x1 + 3 : Q.x0 - 3;
        b.vx = Math.sign(edge - b.x) * speed;
        b.facing = Math.sign(edge - b.x) || b.facing;
        continue;
      }
      // On the floor, going up onto P: run to a take-off spot beside it, then jump.
      // From beside it, the near side; from under it, the side nearer where it's going.
      const side = b.x <= P.x0 + 2 ? 'left' : b.x >= P.x1 - 2 ? 'right' : tx >= (P.x0 + P.x1) / 2 ? 'right' : 'left';
      const takeoff = side === 'left' ? P.x0 - 6 : P.x1 + 6;
      if (Math.abs(takeoff - b.x) > 1.5) {
        b.vx = Math.sign(takeoff - b.x) * speed;
        b.facing = Math.sign(takeoff - b.x);
        continue;
      }
      // Crouch a moment, then spring up and over the edge.
      b.vx = 0;
      b.facing = side === 'left' ? 1 : -1;
      yield* hold(0.12, { squash: 1, legs: 'spread' });
      b.over = {};
      // Straight up until its feet clear the top, then over the edge (no clipping the corner).
      jump(P.y + 8, 0);
      let up = 0;
      yield;
      while (b.on === null && up < 3) {
        if (b.y > P.y + 1) b.vx = b.facing * 30;
        up += yield;
      }
    }
    b.vx = 0;
    return false;
  }
  function jump(height, vx = 0) {
    b.vy = Math.sqrt(2 * PHYS.gravity * Math.max(4, height));
    b.vx = vx;
    b.on = null;
    b.fallFrom = b.y;
  }
  function* untilLanded(maxS = 3) {
    let t = 0;
    yield;
    while (b.on === null && t < maxS) t += yield;
  }
  function* hop(height = 8, vx = 0) {
    yield* hold(0.08, { squash: 1 });
    b.over = {};
    jump(height, vx);
    yield* untilLanded();
  }
  function* frontFace(s, pose = {}) {
    b.vx = 0;
    yield* hold(s, { facing: 0, ...pose });
  }

  // ---------- routines ----------
  function* sleepLoop({ settle = true } = {}) {
    b.vx = 0;
    b.prop = null;
    if (settle) {
      // A big yawn and stretch, a sleepy walk to its nap spot, then sit down and nod off.
      yield* hold(0.25, { facing: 0, eyes: 'half' });
      yield* hold(0.7, { facing: 0, armL: 'up', armR: 'up', mouth: 'yawn', eyes: 'closed' });
      const h = home();
      if (Math.abs(h.x - b.x) > 3 || (b.on || 'floor') !== h.level) {
        b.over = { eyes: 'half' };
        yield* walkTo(h.x, h.level, PHYS.walk * 0.7, 10);
      }
      yield* hold(0.4, { facing: 0, eyes: 'half', legs: 'sit' });
    }
    let zAt = 0;
    let dreamAt = R(6, 12);
    for (;;) {
      const dt = yield;
      const breath = Math.sin(b.t * 1.6) > 0.3;
      b.over = { legs: 'sit', eyes: 'closed', bob: breath ? 0 : 1, mouth: b.t % 9 < 0.6 ? 'o' : 'none', facing: b.facing || 1, squash: 0 };
      zAt -= dt;
      if (zAt <= 0) {
        zAt = 1.3;
        addFx(chance(0.5) ? 'z' : 'Z', b.x + 4 * (b.facing || 1), b.y + 15, { vx: R(3, 7) * (b.facing || 1), vy: 7, life: 2.2, color: '#c7d2fe', wobble: true });
      }
      dreamAt -= dt;
      if (dreamAt <= 0) {
        dreamAt = R(10, 18);
        // Dreams of what Claude is doing (a gear while it works), or of a little heart.
        addFx(b.voice.claudeWorking ? 'gear' : 'heart', b.x - 9 * (b.facing || 1), b.y + 20, { vy: 2, life: 2.4, color: b.voice.claudeWorking ? '#e07b53' : '#fda4af' });
      }
    }
  }

  /** Asleep, but not at its nap spot (the box turned up late): it sleepwalks there, eyes shut. */
  function* sleepwalkHome() {
    const h = home();
    yield* hold(0.4, { legs: 'sit', eyes: 'closed' });
    b.over = { eyes: 'closed', armL: 'push', armR: 'push', mouth: 'o' };
    yield* walkTo(h.x, h.level, PHYS.walk * 0.75, 18);
    yield* hold(0.3, { facing: 0, eyes: 'closed', legs: 'sit' });
  }

  function* wakeUp() {
    b.prop = null;
    say('!', '#fde68a', 0.6);
    yield* hold(0.25, { legs: 'sit', eyes: 'wide', facing: 0 });
    yield* hop(6);
    yield* hold(0.55, { facing: 0, armL: 'up', armR: 'up', mouth: 'yawn', eyes: 'closed' });
    // A quick shake awake.
    for (let i = 0; i < 4; i++) yield* hold(0.07, { facing: i % 2 ? 1 : -1, eyes: 'closed' });
    yield* hold(0.35, { facing: 0, eyes: 'happy', mouth: 'smile' });
    b.taskName = b.mode;
    yield* loopFor(b.mode);
  }

  /** Its nap spot: on top of the prompt box near its right end (out of the way), else mid-window. */
  function home() {
    const P = box();
    if (P) return { x: Math.max(P.x0 + 4, P.x1 - 14), level: P.id };
    return { x: b.world.w * 0.5, level: 'floor' };
  }

  /** Awake and quiet: little things to do, picked at random. */
  function* listenLoop() {
    for (;;) {
      b.over = {};
      const quiet = b.t - b.idleSince;
      const P = box();
      const opts = [
        [6, wander],
        [4, lookAround],
        [P ? 3 : 0, climbAbout],
        [3, sitAndKick],
        [b.lastCursor ? 2 : 0, waveAtCursor],
        [2, waveHello],
        [1.4, littleHop],
        [0.8, dance],
        [0.5, trip],
        [0.8, kickBall],
        [quiet > 50 ? 2 : 0, yawnStretch],
        [b.voice.claudeWorking ? 6 : 0, typeAlong],
        [3, standBy],
      ].filter(([w]) => w > 0);
      let total = opts.reduce((n, [w]) => n + w, 0);
      let r = rng() * total;
      let chosen = opts[0][1];
      for (const [w, fn] of opts) {
        if ((r -= w) <= 0) {
          chosen = fn;
          break;
        }
      }
      yield* chosen();
    }
  }

  function* standBy() {
    b.vx = 0;
    yield* hold(R(1.2, 3), { facing: 0, mouth: chance(0.4) ? 'smile' : 'none' });
  }
  function* wander() {
    const level = b.on && b.on !== 'floor' && chance(0.6) ? b.on : 'floor';
    const P = platform(level);
    const tx = P ? R(P.x0 + 4, P.x1 - 4) : R(edgeMargin + 4, b.world.w - edgeMargin - 4);
    yield* walkTo(tx, level, chance(0.15) ? PHYS.run : PHYS.walk);
    yield* hold(R(0.4, 1.2), { facing: chance(0.5) ? 0 : b.facing });
  }
  function* lookAround() {
    b.vx = 0;
    yield* hold(0.6, { lookX: -1, facing: 0 });
    yield* hold(0.6, { lookX: 1, facing: 0 });
    yield* hold(0.4, { lookY: -1, facing: 0, eyes: 'half' });
    if (chance(0.3)) say('?', '#e5e7eb', 0.8);
    yield* hold(0.5, { facing: 0 });
  }
  function* climbAbout() {
    const P = box();
    if (!P) return;
    if (b.on === 'box') {
      // Walk to the edge, peek over, hop down.
      const right = chance(0.5);
      yield* walkTo(right ? P.x1 - 4 : P.x0 + 4, 'box');
      b.facing = right ? 1 : -1;
      yield* hold(0.7, { lookY: 1, eyes: 'wide' });
      yield* walkTo(right ? P.x1 + 14 : P.x0 - 14, 'floor', PHYS.walk);
    } else {
      yield* walkTo(R(P.x0 + 6, P.x1 - 6), 'box');
      yield* hold(0.5, { facing: 0, eyes: 'happy', mouth: 'smile', armL: 'up', armR: 'up' });
    }
  }
  function* sitAndKick() {
    const P = box();
    if (P && b.on === 'box' && chance(0.7)) {
      // Sit on the edge of the prompt box, legs dangling and swinging.
      const right = b.x > (P.x0 + P.x1) / 2;
      yield* walkTo(right ? P.x1 - 3 : P.x0 + 3, 'box');
      b.facing = right ? 1 : -1;
      b.vx = 0;
      const until = b.t + R(3, 6);
      while (b.t < until) {
        yield* hold(0.25, { legs: 'dangle0', mouth: 'smile' });
        yield* hold(0.25, { legs: 'dangle1', mouth: 'smile' });
      }
      return;
    }
    b.vx = 0;
    yield* hold(R(2.5, 5), { legs: 'sit', facing: b.facing, eyes: chance(0.5) ? 'half' : 'open' });
  }
  function* waveAtCursor() {
    const c = b.lastCursor;
    if (!c) return;
    b.vx = 0;
    b.facing = c.x > b.x ? 1 : -1;
    for (let i = 0; i < 3; i++) {
      yield* hold(0.18, { armR: 'wave0', armL: 'wave0', eyes: 'happy', mouth: 'smile', blush: true });
      yield* hold(0.18, { armR: 'wave1', armL: 'wave1', eyes: 'happy', mouth: 'smile', blush: true });
    }
  }
  function* waveHello() {
    b.vx = 0;
    for (let i = 0; i < 3; i++) {
      yield* hold(0.2, { facing: 0, armR: 'wave0', mouth: 'smile' });
      yield* hold(0.2, { facing: 0, armR: 'wave1', mouth: 'smile' });
    }
  }
  function* littleHop() {
    yield* hop(R(5, 9));
    yield* hold(0.3, { facing: 0, eyes: 'happy' });
  }
  function* dance() {
    b.vx = 0;
    const until = b.t + R(2.5, 4);
    let noteAt = 0;
    let k = 0;
    while (b.t < until) {
      k++;
      yield* hold(0.18, { facing: k % 2 ? 1 : -1, armL: k % 2 ? 'up' : 'out', armR: k % 2 ? 'out' : 'up', squash: k % 2, mouth: 'grin', eyes: 'happy' });
      noteAt -= 0.18;
      if (noteAt <= 0) {
        noteAt = 0.6;
        addFx('note', b.x + R(-6, 6), b.y + 18, { vy: 10, vx: R(-6, 6), life: 1.2, color: pick(['#fde68a', '#a5f3fc', '#fbcfe8']) });
      }
    }
  }
  function* trip() {
    // Walks, catches a foot, falls flat on its face, sees stars, gets back up.
    const dir = chance(0.5) ? 1 : -1;
    yield* walkTo(b.x + dir * R(14, 24), b.on || 'floor', PHYS.run);
    say('!', '#fde68a', 0.4);
    b.vx = dir * 20;
    yield* hold(0.18, { armL: 'up', armR: 'up', eyes: 'wide', mouth: 'o', legs: 'spread' });
    b.vx = 0;
    dust();
    yield* dizzy(1.4);
  }
  function* dizzy(s = 1.2) {
    b.vx = 0;
    const until = b.t + s;
    while (b.t < until) {
      const a = b.t * 7;
      b.fx = b.fx.filter((f) => f.g !== 'star' || !f.orbit);
      for (let i = 0; i < 3; i++) {
        const ang = a + (i * Math.PI * 2) / 3;
        addFx('star', b.x + Math.cos(ang) * 7 - 1, b.y + 9 + Math.sin(ang) * 2, { life: 0.05, fade: false, color: '#fde68a', orbit: true });
      }
      b.over = { lie: 1, eyes: 'dizzy', mouth: 'flat' };
      yield;
    }
    b.over = {};
    yield* hop(4);
    for (let i = 0; i < 4; i++) yield* hold(0.08, { facing: i % 2 ? 1 : -1, eyes: 'closed' });
  }
  function* kickBall() {
    // Finds a little ball, kicks it, watches it bounce away.
    b.vx = 0;
    const dir = b.x < b.world.w / 2 ? 1 : -1;
    b.facing = dir;
    addFx('ball', b.x + dir * 8, b.y, { life: 4, fade: true, color: '#f472b6', ball: true, vx: 0, vy: 0 });
    yield* hold(0.4, { lookY: 1, eyes: 'wide' });
    yield* hold(0.12, { squash: 1, legs: 'spread' });
    const ball = b.fx.findLast((f) => f.ball);
    if (ball) {
      ball.vx = dir * R(45, 70);
      ball.vy = R(40, 70);
      ball.grav = PHYS.gravity;
      ball.bounce = 0.55;
      ball.floorY = levelY(b.on || 'floor');
    }
    yield* hold(0.8, { facing: dir, eyes: 'happy', mouth: 'grin', armL: 'up', armR: 'up' });
  }
  function* yawnStretch() {
    b.vx = 0;
    yield* hold(0.8, { facing: 0, armL: 'up', armR: 'up', mouth: 'yawn', eyes: 'closed' });
    b.idleSince = b.t;
  }
  function* typeAlong() {
    // While Claude works: sit on top of the prompt box with a tiny laptop, typing along.
    const P = box();
    if (P) yield* walkTo(R(P.x0 + 8, P.x1 - 8), 'box');
    b.vx = 0;
    b.facing = 1;
    b.prop = { g: 'laptop', dx: 5, dy: 0, color: '#7dd3fc', color2: '#d1d5db' };
    const until = b.t + R(4, 8);
    let k = 0;
    while (b.t < until && b.voice.claudeWorking) {
      k++;
      yield* hold(0.12, { legs: 'sit', armR: k % 2 ? 'type0' : 'type1', armL: k % 2 ? 'type1' : 'type0', lookY: 1 });
    }
    b.prop = null;
  }

  function* hearLoop() {
    b.vx = 0;
    b.prop = null;
    for (;;) {
      const v = b.voice;
      b.over = { facing: 0, armR: 'ear', lookY: -1, bob: (v.input || 0) > 0.08 && Math.sin(b.t * 18) > 0 ? 1 : 0, eyes: (v.input || 0) > 0.25 ? 'wide' : 'open' };
      yield;
    }
  }
  function* thinkLoop() {
    b.vx = 0;
    b.prop = null;
    let dotAt = 0;
    let n = 0;
    for (let i = 0; ; i++) {
      // Hand on chin, pacing two steps each way, thought dots rising.
      const dir = i % 2 ? 1 : -1;
      const start = b.t;
      while (b.t - start < 0.9) {
        const dt = yield;
        b.vx = dir * 10;
        b.facing = dir;
        b.over = { armR: 'chin', armL: 'down', eyes: 'half', lookY: -1 };
        dotAt -= dt;
        if (dotAt <= 0) {
          dotAt = 0.35;
          n++;
          addFx(n % 4 === 0 ? '?' : 'dot', b.x - 2 + (n % 4) * 3, b.y + 19 + (n % 4), { life: 0.7, color: '#c4b5fd', follow: true });
        }
      }
      b.vx = 0;
      yield* hold(0.4, { armR: 'chin', facing: 0, eyes: 'half', lookY: -1 });
    }
  }
  function* talkLoop() {
    b.vx = 0;
    b.prop = null;
    let gest = 0;
    for (;;) {
      const dt = yield;
      const lvl = b.voice.output || 0;
      gest -= dt;
      if (gest <= 0) {
        gest = R(0.4, 0.9);
        b.gesture = pick(['down', 'out', 'down', 'wave0', 'out', 'chin']);
      }
      const mouth = lvl > 0.22 ? 'open2' : lvl > 0.06 ? 'open1' : Math.sin(b.t * 14) > 0.6 && lvl > 0.02 ? 'open1' : 'smile';
      b.over = { facing: 0, mouth, armR: b.gesture || 'down', armL: b.gesture === 'out' ? 'out' : 'down', bob: lvl > 0.1 && Math.sin(b.t * 16) > 0 ? 1 : 0 };
    }
  }
  function* connectingLoop() {
    b.vx = 0;
    for (;;) {
      yield* hold(0.4, { facing: 0, lookX: -1 });
      yield* hold(0.4, { facing: 0, lookX: 1 });
    }
  }

  // ---------- event routines ----------
  function* celebrate() {
    b.prop = null;
    say('!', '#fde68a', 0.5);
    for (let i = 0; i < 2; i++) {
      yield* hop(10);
      burst('sparkle', 5, pick(['#fde68a', '#86efac', '#93c5fd', '#f9a8d4']), 32);
    }
    yield* hold(0.7, { facing: 0, armL: 'up', armR: 'up', eyes: 'happy', mouth: 'grin' });
  }
  function* startledAsleep() {
    // Claude finished while Orbit sleeps: jolts, looks around, nods off again.
    yield* hold(0.12, { legs: 'sit', eyes: 'wide' });
    say('!', '#fde68a', 0.5);
    yield* hold(0.4, { legs: 'sit', eyes: 'wide', lookX: -1 });
    yield* hold(0.4, { legs: 'sit', eyes: 'wide', lookX: 1 });
    yield* hold(0.5, { legs: 'sit', eyes: 'half' }); // ...then back to sleep (the mode's own routine)
  }
  function* deliverDraft() {
    // A prompt was typed into Claude's box: carry a letter over and drop it in.
    const P = box();
    b.prop = { g: 'letter', dx: -3, dy: 17, color: '#fef3c7', color2: '#1b1210' };
    yield* hold(0.25, { armL: 'hold', armR: 'hold', eyes: 'happy' });
    if (P) {
      b.over = { armL: 'hold', armR: 'hold' };
      yield* walkTo((P.x0 + P.x1) / 2, 'box', PHYS.run);
      b.prop = null;
      addFx('letter', b.x - 3, b.y + 17, { vy: -30, grav: 80, life: 0.6, color: '#fef3c7' });
      yield* hold(0.25, { squash: 1, armL: 'push', armR: 'push' });
      burst('sparkle', 3, '#fde68a', 18);
    } else {
      yield* hold(0.8, { facing: 0, armL: 'hold', armR: 'hold', eyes: 'happy' });
      b.prop = null;
    }
    yield* hold(0.6, { facing: 0, eyes: 'happy', mouth: 'smile' });
  }
  function* pressSend() {
    // The prompt was sent: a big stomp on Send, and a paper plane flies off.
    const P = box();
    if (P) yield* walkTo(P.x1 - 4, 'box', PHYS.run);
    b.facing = 1;
    yield* hop(12);
    yield* hold(0.15, { squash: 2, legs: 'spread', armL: 'up', armR: 'up' });
    dust();
    addFx('plane', b.x + 2, b.y + 10, { vx: 60, vy: 38, life: 1.8, color: '#e0f2fe', trail: true });
    yield* hold(0.8, { facing: 1, armR: 'up', eyes: 'happy', mouth: 'grin', lookY: -1 });
  }
  function* pokeReaction() {
    const kind = pick(['giggle', 'spin', 'flop', 'blush', 'giggle']);
    b.vx = 0;
    if (kind === 'giggle') {
      say('heart', '#fb7185', 0.9);
      yield* hop(7);
      yield* hold(0.4, { facing: 0, eyes: 'happy', mouth: 'grin', blush: true });
    } else if (kind === 'spin') {
      say('!', '#fde68a', 0.5);
      for (let i = 0; i < 6; i++) yield* hold(0.06, { facing: [1, 0, -1, 0][i % 4], eyes: 'wide', mouth: 'o' });
    } else if (kind === 'flop') {
      yield* hold(0.15, { eyes: 'wide', mouth: 'o' });
      yield* dizzy(1);
    } else {
      yield* hold(0.9, { facing: 0, eyes: 'happy', blush: true, armL: 'chin', armR: 'chin', mouth: 'smile' });
    }
  }
  function* dodge(dir) {
    say('drop', '#7dd3fc', 0.5);
    b.facing = dir;
    yield* hop(9, dir * 40);
    yield* hold(0.3, { facing: -dir, eyes: 'wide' });
  }
  function* landedHard() {
    yield* dizzy(1.1);
  }

  // ---------- task control ----------
  function start(gen, name, kind = '') {
    b.task = gen;
    b.taskName = name;
    b.taskKind = kind;
    b.over = {};
  }
  /** The ongoing routine for a mode. */
  function loopFor(mode) {
    if (mode === 'sleep') return sleepLoop({ settle: false });
    if (mode === 'connecting') return connectingLoop();
    if (mode === 'hear') return hearLoop();
    if (mode === 'think') return thinkLoop();
    if (mode === 'talk') return talkLoop();
    return listenLoop();
  }
  /** What to run on entering a mode: waking up first when coming out of sleep. */
  function modeRoutine(mode, from) {
    if (mode === 'sleep') return [sleepLoop({ settle: from !== null && from !== 'sleep' }), 'sleep'];
    if (from === null || from === 'sleep') return [wakeUp(), 'wake'];
    return [loopFor(mode), mode];
  }
  /** Run a routine, then carry on with whatever Orbit is doing by then. */
  function then(routine) {
    return (function* () {
      yield* routine;
      b.taskKind = '';
      b.taskName = b.mode;
      yield* loopFor(b.mode);
    })();
  }

  // ---------- one frame ----------
  function step({ dt = 1 / 60, world, voice, cursor = null, events = [] } = {}) {
    dt = Math.min(0.1, Math.max(0, dt));
    b.t += dt;
    if (world && !b.placed && (world.platforms?.length || b.t > 1.5)) {
      b.placed = true;
      b.world = { ...b.world, w: Math.max(30, world.w || 200), h: Math.max(20, world.h || 60), platforms: world.platforms || [] };
      const h = home();
      const P = platform(h.level);
      if (!b.grab && b.taskKind !== 'event' && (!P || (P.x1 - P.x0 >= 16 && P.y > 4))) {
        b.x = h.x;
        b.y = P ? P.y : 0;
        b.on = P ? P.id : 'floor';
      }
    }
    if (world) b.world = { w: Math.max(30, world.w || 200), h: Math.max(20, world.h || 60), platforms: (world.platforms || []).filter((p) => p && p.x1 - p.x0 >= 16 && p.y > 4 && p.y < (world.h || 60) - 18) };
    b.voice = voice || {};
    for (const e of events) if (EVENT_NAMES.has(e)) b.events.push(e);
    b.lastCursor = cursor && cursor.x > -20 && cursor.x < b.world.w + 20 && cursor.y > -10 && cursor.y < b.world.h + 30 ? cursor : null;

    // Mode from Orbit's state (a change replaces the routine; hearing / talking take over at once).
    const mode = modeFor(b.voice);
    if (mode !== b.mode && !b.grab) {
      const from = b.mode;
      b.mode = mode;
      // Connecting then listening is one wake-up: don't cut it short.
      const keepWaking = b.taskName === 'wake' && (mode === 'connecting' || mode === 'listen');
      if (!keepWaking) start(...modeRoutine(mode, from));
      if (mode === 'listen') b.idleSince = b.t;
    }

    // The box turned up while it was asleep somewhere else: off to its nap spot (once).
    if (!b.homed && box() && b.mode === 'sleep' && b.taskName === 'sleep' && !b.grab && b.on !== null) {
      b.homed = true;
      const h = home();
      if (Math.abs(h.x - b.x) > 4 || b.on !== h.level) start(then(sleepwalkHome()), 'sleepwalk');
    }
    if (b.mode !== 'sleep') b.homed = true; // awake, it goes where it likes

    // Events (one at a time, in order), unless it's being held.
    if (!b.grab && b.events.length && !['event', 'grabbed'].includes(b.taskKind)) {
      const e = b.events.shift();
      const asleep = b.mode === 'sleep';
      const routine =
        e === 'finished' ? (asleep ? startledAsleep() : celebrate()) : e === 'draft' ? (asleep ? null : deliverDraft()) : e === 'sent' ? (asleep ? null : pressSend()) : e === 'poke' ? pokeReaction() : null;
      if (routine) start(then(routine), e, 'event');
    }

    // Held by the user: dangles where the cursor is, legs kicking.
    if (b.grab) {
      b.x += (b.grab.x - b.x) * Math.min(1, dt * 18);
      b.y += (Math.max(0, b.grab.y - 16) - b.y) * Math.min(1, dt * 18);
      // Held, it still stays inside the window (which can shrink while it's held).
      b.x = Math.max(edgeMargin, Math.min(b.world.w - edgeMargin, b.x));
      b.y = Math.max(0, Math.min(b.world.h - 17, b.y));
      b.vx = 0;
      b.vy = 0;
      b.on = null;
      b.fallFrom = Math.max(b.fallFrom, b.y);
      b.over = { legs: Math.sin(b.t * 20) > 0 ? 'dangle0' : 'dangle1', armL: Math.sin(b.t * 20) > 0 ? 'flail0' : 'flail1', armR: Math.sin(b.t * 20) > 0 ? 'flail1' : 'flail0', eyes: 'wide', mouth: 'o', facing: 0 };
      if (Math.floor(b.t * 2) !== Math.floor((b.t - dt) * 2)) addFx('drop', b.x + 6, b.y + 15, { vy: -8, life: 0.5, color: '#7dd3fc' });
    } else if (b.task) {
      try {
        const r = b.task.next(dt);
        if (r.done) {
          b.task = null;
          b.taskKind = '';
        }
      } catch {
        b.task = null;
      }
      if (!b.task) start(loopFor(b.mode), b.mode);
    }

    // The cursor: it looks at it when near, and hops out of the way if it comes right at it.
    let look = null;
    if (b.lastCursor && !b.grab) {
      const dx = b.lastCursor.x - b.x;
      const dy = b.lastCursor.y - (b.y + 10);
      const dist = Math.hypot(dx, dy);
      if (dist < 60) look = { x: Math.sign(dx) * (Math.abs(dx) > 4 ? 1 : 0), y: dy > 8 ? -1 : dy < -8 ? 1 : 0 };
      if (dist < 9 && b.on !== null && b.t - b.dodgeAt > 2.5 && ['listen', 'connecting'].includes(b.mode) && b.taskKind !== 'event') {
        b.dodgeAt = b.t;
        const dir = dx > 0 ? -1 : 1;
        start(then(dodge(dir)), 'dodge');
      }
    }

    physics(dt);
    updateFx(dt);
    return frame(look);
  }

  function physics(dt) {
    if (b.grab) return;
    const W = b.world.w;
    const wasOn = b.on;
    if (b.on !== null) {
      // Standing: still on something? (a platform can end under it, or move away)
      const P = b.on === 'floor' ? null : platform(b.on);
      if (b.on !== 'floor' && (!P || b.x < P.x0 - 1 || b.x > P.x1 + 1)) {
        b.on = null;
        b.vy = 0;
        b.fallFrom = b.y;
      } else {
        b.y = P ? P.y : 0;
        b.vy = 0;
      }
    }
    if (b.on === null) b.vy = Math.max(-PHYS.maxFall, b.vy - PHYS.gravity * dt);
    const prevY = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.on === null && b.vy <= 0) {
      // Landing: on a platform it was above, else on the floor.
      const P = b.world.platforms.find((p) => b.x >= p.x0 && b.x <= p.x1 && prevY >= p.y - 0.01 && b.y <= p.y);
      if (P || b.y <= 0) {
        const impact = b.fallFrom - (P ? P.y : 0);
        b.y = P ? P.y : 0;
        b.on = P ? P.id : 'floor';
        b.vy = 0;
        b.squashT = impact > 6 ? 0.14 : 0.07;
        if (impact > 14) dust();
        if (impact > 40 && b.taskName === 'dropped') start(then(landedHard()), 'dizzy');
        b.lastLand = b.t;
        b.fallFrom = b.y;
      }
    }
    if (wasOn !== null && b.on !== null && Math.abs(b.vx) > 0) b.walkDist += Math.abs(b.vx * dt);
    // Solid platforms are walls to anything below their top: stop at their sides, and if one grew
    // around it (the box got taller as you typed), pop out of the nearer side.
    for (const p of b.world.platforms) {
      if (!solid(p) || b.y >= p.y - 0.5) continue;
      if (b.x > p.x0 - 3 && b.x < p.x1 + 3) {
        const left = b.x - (p.x0 - 3);
        const right = p.x1 + 3 - b.x;
        if (left < right) (b.x = p.x0 - 3), (b.vx = Math.min(0, b.vx));
        else (b.x = p.x1 + 3), (b.vx = Math.max(0, b.vx));
      }
    }
    // Walls: the window's sides.
    if (b.x < edgeMargin) (b.x = edgeMargin), (b.vx = Math.max(0, b.vx));
    if (b.x > W - edgeMargin) (b.x = W - edgeMargin), (b.vx = Math.min(0, b.vx));
    if (b.y > b.world.h - 17) (b.y = b.world.h - 17), (b.vy = Math.min(0, b.vy));
    b.squashT = Math.max(0, b.squashT - dt);
  }

  function updateFx(dt) {
    for (const f of b.fx) {
      f.age += dt;
      if (f.follow) f.x += (b.x + 4 * (b.facing || 1) - f.x) * Math.min(1, dt * 4);
      f.vy -= (f.grav || 0) * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.wobble) f.x += Math.sin(f.age * 5) * 0.15;
      if (f.ball && f.y < (f.floorY ?? 0)) {
        f.y = f.floorY ?? 0;
        f.vy = Math.abs(f.vy) * (f.bounce || 0.5);
        f.vx *= 0.8;
        if (f.vy < 8) f.vy = 0;
      }
      if (f.ball && (f.x < 2 || f.x > b.world.w - 4)) f.vx = -f.vx * 0.7;
      if (f.trail && Math.floor(f.age * 20) !== Math.floor((f.age - dt) * 20)) b.fx.push({ g: 'dot', x: f.x, y: f.y + 1, vx: 0, vy: 0, age: 0, life: 0.35, color: '#bae6fd', fade: true });
    }
    b.fx = b.fx.filter((f) => f.age < f.life && f.y < b.world.h + 10 && f.x > -20 && f.x < b.world.w + 20);
  }

  function frame(look) {
    const o = b.over || {};
    const moving = b.on !== null && Math.abs(b.vx) > 0.5;
    const pose = {
      facing: b.facing || 1,
      antenna: ANTENNA[b.mode] || ANTENNA.listen,
      antennaGlow: b.mode === 'hear' ? Math.min(1, (b.voice.input || 0) * 4) : b.mode === 'talk' ? Math.min(1, (b.voice.output || 0) * 4) : b.mode === 'think' ? 0.4 + 0.4 * Math.sin(b.t * 5) : 0,
    };
    if (b.on === null && !b.grab) {
      pose.legs = 'jump';
      pose.armL = b.vy > 0 ? 'up' : 'out';
      pose.armR = b.vy > 0 ? 'up' : 'out';
    } else if (moving) {
      pose.legs = `walk${Math.floor(b.walkDist / 2.5) % 4}`;
      pose.bob = Math.floor(b.walkDist / 2.5) % 2;
    }
    if (b.squashT > 0) pose.squash = b.squashT > 0.07 ? 2 : 1;
    if (b.mode === 'connecting') pose.antenna = Math.sin(b.t * 10) > 0 ? ANTENNA.connecting : '#78350f';
    Object.assign(pose, o);
    if (moving && o.facing === 0) pose.facing = b.facing || 1; // walking is always side-on
    if (moving && !o.legs) pose.legs = `walk${Math.floor(b.walkDist / 2.5) % 4}`;
    // Eyes: blink now and then; look toward the cursor when it's near.
    if (b.t > b.blinkAt) {
      if (b.t > b.blinkAt + 0.12) b.blinkAt = b.t + R(2, 5);
      else if (!o.eyes || o.eyes === 'open') pose.eyes = 'closed';
    }
    if (look && (!o.eyes || o.eyes === 'open') && !o.lie) {
      if (pose.facing !== 0 && look.x) pose.facing = look.x;
      pose.lookX = look.x;
      pose.lookY = look.y;
    }
    return {
      x: b.x,
      y: b.y,
      pose,
      prop: b.prop,
      fx: b.fx.map((f) => ({ g: f.g, x: f.x, y: f.y, color: f.color, color2: f.color2, alpha: f.fade ? Math.max(0, 1 - f.age / f.life) : 1 })),
      mode: b.mode,
      task: b.taskName,
      on: b.on,
    };
  }

  return {
    step,
    /** A click on it. */
    poke() {
      b.events.push('poke');
    },
    /** Picked up: it follows (x, y), the cursor, until released. */
    grab(x, y) {
      if (!b.grab) {
        start(null, 'grabbed', 'grabbed');
        b.fallFrom = b.y;
        b.prop = null;
      }
      b.grab = { x, y };
    },
    release() {
      if (!b.grab) return;
      b.grab = null;
      b.on = null;
      b.vy = 0;
      start(then(untilLanded(4)), 'dropped');
    },
    /** Is (x, y) on it? (for clicks and grabbing; a forgiving box around the figure) */
    hit(x, y) {
      return Math.abs(x - b.x) <= 8 && y >= b.y - 2 && y <= b.y + 19;
    },
    get state() {
      return b;
    },
  };
}
