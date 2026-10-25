// Picking Qubit up and throwing him. No DOM here (his engine instance is passed in), so the tests run
// it in node with the real engine.
//
//   - Held: the whole square follows the pointer as one rigid body (a stiff, critically damped
//     follow, so it's smooth at the display's full rate however the mouse reports). He swings a little
//     with the pointer's speed, back level as soon as it stops; nothing else about him changes.
//   - Thrown: the release velocity, and a spin from it. Then his engine's own physics take over:
//     gravity, its landing model (flat: a squash; on a corner: he rocks over onto a face, like a real
//     cube) and its solids (the prompt box, the strip's floor as a one-way ledge). Added here, as
//     velocity kicks only: the walls and ceiling of his stage (the work area) with his turned extents,
//     and bounces off whatever he lands on while he still comes down fast.
//   - Landed: reported once he's on a face, with how hard it was and how many bounces.
//
// Positions are stage px (y down); velocities px/s (y down for the pointer, as the screen).

import { nearestStripSpot, onStrip } from '../buddy/throw.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Tuning, in body sides (S) where it scales with him. */
export const THROW = Object.freeze({
  maxSpeedS: 60, // the fastest throw: 60 sides a second
  bounceMinS: 8.5, // landing faster than this (sides/s) bounces
  restitution: 0.4, // a bounce keeps this much of the speed into the surface
  friction: 0.78, // ...and this much of the speed along it
  wall: 0.45, // walls and ceiling keep this much
  spinPerSide: 14, // spin from horizontal speed: degrees/s per (side/s)
  maxSpin: 900, // degrees/s
  followHz: 16, // how stiffly he follows the pointer while held
  swingMax: 18, // degrees he swings with the pointer's speed while held
});

/** A ±180 wrap, for angles. */
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export function createThrow(q, { tune = {} } = {}) {
  const T = { ...THROW, ...tune };
  let held = null; // { x, y, vx, vy, tx, ty, wv }  his centre (stage px) and its velocity, the target
  let flying = null; // { bounces, impact, since }
  let solids = []; // the stage's solids (setSolids), some of them ghosts until he's clear of them
  let ghosts = new Set();
  const listeners = { land: [], bounce: [], wall: [] };
  const emit = (k, d) => listeners[k].forEach((fn) => fn(d));

  const physics = q._physics.bind(q);
  const ext = () => {
    const a = (q.angle + q._tilt()) * DEG;
    const [hw, hh] = q._halfExtents();
    return { x: hw * Math.abs(Math.cos(a)) + hh * Math.abs(Math.sin(a)), y: hh * Math.abs(Math.cos(a)) + hw * Math.abs(Math.sin(a)) };
  };
  const stageY = () => q.ground - q.cy; // his centre's stage y

  function applySolids() {
    q.setEnvironment({ solids: solids.filter((s) => !ghosts.has(s.id)) });
  }
  /** Solids his body overlaps now (held over the prompt box, say): they don't count until he's clear. */
  function overlapping() {
    const e = ext();
    const x1 = q.cx - e.x;
    const x2 = q.cx + e.x;
    const y1 = stageY() - e.y;
    const y2 = stageY() + e.y;
    return solids.filter((s) => !s.oneWay && x2 > s.x && x1 < s.x + s.w && y2 > s.y && y1 < s.y + s.h).map((s) => s.id);
  }

  q._physics = (dt) => {
    if (held) return holdStep(dt);
    if (!flying) return physics(dt);
    const before = { air: q.air, vx: q.vx, vy: q.vy, av: q.av };
    physics(dt);
    if (ghosts.size && !overlapping().length) {
      ghosts = new Set();
      applySolids();
    }
    // Contact this frame: still coming down fast, so he bounces (a velocity kick), keeping his turn.
    if (before.air && (!q.air || q.pivot)) {
      const impact = Math.max(0, -before.vy);
      flying.impact = Math.max(flying.impact, impact);
      if (impact > T.bounceMinS * q.S) {
        q.pivot = null;
        q.air = true;
        q.leftFrom = q.sy;
        q.vy = impact * T.restitution;
        q.vx = before.vx * T.friction;
        q.av = clamp(before.av * 0.5 - (before.vx / q.side) * T.spinPerSide * 0.6, -T.maxSpin, T.maxSpin);
        q.cy = q.sy + ext().y + 0.5;
        flying.bounces++;
        emit('bounce', { impact, n: flying.bounces });
      }
    }
    if (q.air) walls();
    if (!q.air && !q.pivot) {
      const done = { impact: flying.impact, bounces: flying.bounces, x: q.cx, y: q.ground - q.sy, secs: q.t - flying.since };
      flying = null;
      if (ghosts.size) {
        ghosts = new Set();
        applySolids();
      }
      emit('land', done);
    }
  };

  /** The stage's walls and ceiling, with his turned extents (the engine's own walls use a flat half). */
  function walls() {
    const e = ext();
    const [minX, maxX] = [0, q.W];
    let hit = false;
    if (q.cx - e.x < minX) {
      q.cx = minX + e.x;
      if (q.vx < 0) (q.vx = -q.vx * T.wall), (q.av = clamp(q.av * -0.6, -T.maxSpin, T.maxSpin));
      hit = true;
    } else if (q.cx + e.x > maxX) {
      q.cx = maxX - e.x;
      if (q.vx > 0) (q.vx = -q.vx * T.wall), (q.av = clamp(q.av * -0.6, -T.maxSpin, T.maxSpin));
      hit = true;
    }
    if (q.cy + e.y > q.ground) {
      q.cy = q.ground - e.y; // the top of his stage (the work area's top edge)
      if (q.vy > 0) q.vy = -q.vy * T.wall;
      hit = true;
    }
    if (hit) emit('wall', { x: q.cx });
  }

  /** One held frame: the whole body follows the target; he swings a little with its speed. */
  function holdStep(dt) {
    const h = held;
    const w = 2 * Math.PI * T.followHz;
    for (const k of ['x', 'y']) {
      const v = k === 'x' ? 'vx' : 'vy';
      const tk = k === 'x' ? 'tx' : 'ty';
      // Critically damped (no overshoot, no wobble), substepped so a slow frame stays stable.
      const n = Math.max(1, Math.ceil(dt / (1 / 240)));
      const s = dt / n;
      for (let i = 0; i < n; i++) {
        h[v] += (w * w * (h[tk] - h[k]) - 2 * w * h[v]) * s;
        h[k] += h[v] * s;
      }
    }
    // The swing: toward a lean that follows the sideways speed, back level when it stops.
    const want = clamp((h.vx / q.side) * 1.2, -T.swingMax, T.swingMax);
    const k = (2 * Math.PI * 3) ** 2;
    const c = 2 * 0.55 * 2 * Math.PI * 3;
    h.wv += (k * (want - wrap(q.angle)) - c * h.wv) * dt;
    q.angle += h.wv * dt;
    // Inside his stage (the window he lives on), by his turned extents: dragged past its edge, he
    // stops at it, and no corner pokes over another window. And never inside a solid (the prompt
    // box): he slides along its top or side instead, so he's never let go inside one.
    const e = ext();
    h.x = clamp(h.x, e.x, q.W - e.x);
    h.y = clamp(h.y, e.y, q.ground - e.y);
    for (const sd of solids.length ? solids : (q.envSrc && q.envSrc.solids) || []) {
      if (sd.oneWay || !(h.x + e.x > sd.x && h.x - e.x < sd.x + sd.w && h.y + e.y > sd.y && h.y - e.y < sd.y + sd.h)) continue;
      const outs = [{ x: h.x, y: sd.y - e.y }];
      if (sd.x - e.x >= e.x) outs.push({ x: sd.x - e.x, y: h.y });
      if (sd.x + sd.w + e.x <= q.W - e.x) outs.push({ x: sd.x + sd.w + e.x, y: h.y });
      const best = outs.reduce((a, b) => (Math.hypot(b.x - h.x, b.y - h.y) < Math.hypot(a.x - h.x, a.y - h.y) ? b : a));
      h.x = best.x;
      h.y = Math.max(e.y, best.y);
    }
    q.cx = h.x;
    q.cy = q.ground - h.y;
    q.air = true;
    q.pivot = null;
    q.vx = h.vx;
    q.vy = -h.vy;
  }

  return {
    /** Pick him up at his own centre; `target` (stage px) is where the pointer wants his centre. */
    hold(target) {
      for (const j of q.queue) j.resolve(false);
      q.queue = [];
      if (q.task) q.task.cancelled = true;
      flying = null;
      // Leave from exactly where he's drawn (a squash or a lean tipped onto a corner included).
      const x = q._rx ?? q.cx;
      const y = q._ry ?? stageY();
      q.pivot = null;
      held = { x, y, vx: 0, vy: 0, tx: target?.x ?? x, ty: target?.y ?? y, wv: q.av || 0 };
      q.air = true;
      q.av = 0;
      q.cx = x;
      q.cy = q.ground - y;
      q.sp.stretch.to(1);
    },
    /** Where the pointer wants his centre now (stage px). */
    move(target) {
      if (!held || !target) return;
      held.tx = target.x;
      held.ty = target.y;
    },
    /** Let go with the pointer's velocity (px/s, y down). A slow release is a drop. */
    release(v = { x: 0, y: 0 }) {
      if (!held) return;
      const h = held;
      held = null;
      const max = T.maxSpeedS * q.S;
      const s = Math.hypot(v.x, v.y);
      const k = s > max ? max / s : 1;
      q.air = true;
      q.pivot = null;
      q.vx = v.x * k;
      q.vy = -v.y * k;
      q.av = clamp(h.wv + (q.vx / q.side) * T.spinPerSide, -T.maxSpin, T.maxSpin);
      q.leftFrom = null;
      flying = { bounces: 0, impact: 0, since: q.t };
      ghosts = new Set(overlapping());
      if (ghosts.size) applySolids();
    },
    /** The stage's solids (stage px), with the ones he's inside left out until he's clear. */
    setSolids(list) {
      solids = (list || []).slice();
      applySolids();
    },
    /**
     * His stage moved under him (the window grew to the work area or shrank back to the strip): his
     * place on screen stays. `shift` is the old origin minus the new (screen px); W, H, floor the new stage.
     */
    reframe({ shift, W, H, floor = q.floor }) {
      const oldGround = q.ground;
      const cyStage = oldGround - q.cy + shift.y;
      const syStage = oldGround - q.sy + shift.y;
      q.cx += shift.x;
      if (q._rx != null) q._rx += shift.x;
      if (q._ry != null) q._ry += shift.y;
      if (q.pivot) q.pivot.px += shift.x;
      q.resize(W, H, floor);
      q.cy = q.ground - cyStage;
      q.sy = Math.max(0, q.ground - syStage);
      if (held) {
        held.x += shift.x;
        held.y += shift.y;
        held.tx += shift.x;
        held.ty += shift.y;
      }
    },
    on(type, fn) {
      listeners[type]?.push(fn);
      return () => (listeners[type] = listeners[type].filter((f) => f !== fn));
    },
    get held() {
      return !!held;
    },
    get flying() {
      return !!flying;
    },
    /** Held or still in the air from a throw. */
    get active() {
      return !!held || !!flying;
    },
    destroy() {
      q._physics = physics;
    },
  };
}

/**
 * Landed away from his strip (the screen's bottom edge beside or below the Claude window): back to
 * it by his own route (orbit-nav: hops, and a jump up through the strip's floor, which is a one-way
 * ledge), from right where he is. If there's no route, one big leap of his own straight there.
 * Everything waits on his engine's clock. Resolves true once he stands on his strip.
 */
export async function headBack(q, stage, { stillOk = () => true } = {}) {
  const half = () => q.side / 2;
  const here = () => onStrip(stage, { x: q.cx, y: q.ground - q.sy, half: half() });
  const settle = async () => {
    while (q.air || q.pivot) await q.do('pause', { secs: 0.05 });
  };
  if (here()) return true;
  const spot = nearestStripSpot(stage, q.cx, half());
  await q.goTo(spot.x, spot.y - 1, { style: 'bold', interrupt: true });
  await settle();
  if (here() || !stillOk()) return !!here();
  const s = nearestStripSpot(stage, q.cx, half());
  const level = q.ground - s.y;
  await q.do('pause', { secs: 0.2 }, { interrupt: true });
  if (!stillOk()) return false;
  q.launchTo(s.x, level, Math.max(level, q.sy) + q.side * 1.4, 0);
  await settle();
  return !!here();
}
