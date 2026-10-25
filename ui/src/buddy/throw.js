// Picking an avatar up and throwing it: the parts every avatar shares (Qubit uses them; any other
// avatar on the shared host can). Pure functions, no DOM, so the tests run them in node.
//
//   - Press: a short click (press and release without dragging) versus picking him up (a drag past a
//     few px, or holding still a moment).
//   - Throw velocity: from the last ~80 ms of pointer samples (a least-squares fit, so one jittery
//     sample can't fling him), clamped.
//   - The lifted stage: while he's held or flying, his window covers the work area of the display he's
//     on (never the taskbar). His usual strip, the floor along its bottom and Claude's prompt box are
//     carried into that bigger stage's coordinates, so he can land back on them.

/**
 * Press thresholds: px of movement before it's a drag, ms a click may last, ms of holding still that
 * picks him up. Holding starts after a click ends, never before: a slow click (330 ms, say) used to
 * pick him up and set him straight down.
 */
export const PRESS = Object.freeze({ slop: 5, clickMs: 350, holdMs: 420 });

/**
 * What a press is so far: 'drag' once it moved more than `slop` px from where it went down, 'hold'
 * once it has been held still for `holdMs`, else 'press'. On release (`released`), a press that never
 * became either and lasted under `clickMs` is a 'click'.
 */
export function pressKind({ dx = 0, dy = 0, ms = 0, released = false, dragging = false }, P = PRESS) {
  if (dragging) return 'drag';
  if (Math.hypot(dx, dy) > P.slop) return 'drag';
  if (released) return ms < P.clickMs ? 'click' : 'hold';
  return ms >= P.holdMs ? 'hold' : 'press';
}

/** The throw sound: only for a real throw, at least this fast (body sides a second), not a put-down. */
export const THROW_SOUND = Object.freeze({ minSpeedS: 12 });

/** Does letting go at velocity `v` (px/s) with a body `side` px make the throw sound (Settings `prefs`)? */
export function throwSoundFor(v, side, prefs = {}) {
  if (prefs.throw === false || prefs.throwSound === false) return false;
  const s = Math.hypot(Number(v?.x) || 0, Number(v?.y) || 0);
  return Number.isFinite(s) && side > 0 && s >= THROW_SOUND.minSpeedS * side;
}

/** Keep a velocity's direction, at most `max` long. */
export function clampSpeed(v, max = Infinity) {
  const s = Math.hypot(v.x, v.y);
  if (!(s > max) || !Number.isFinite(s)) return Number.isFinite(s) ? { x: v.x, y: v.y } : { x: 0, y: 0 };
  return { x: (v.x / s) * max, y: (v.y / s) * max };
}

/**
 * The release velocity (px/s, screen axes: y down) from pointer samples [{ x, y, t }] (t in ms),
 * released at `now` (ms): a least-squares slope over the samples in the last `windowMs`. Fewer than two
 * samples there (the pointer had stopped before letting go) is a drop: { x: 0, y: 0 }.
 */
export function throwVelocity(samples, now, { windowMs = 80, max = Infinity } = {}) {
  const end = Number.isFinite(now) ? now : samples.length ? samples[samples.length - 1].t : 0;
  const pts = (samples || []).filter((s) => s && Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.t) && s.t >= end - windowMs && s.t <= end + 1);
  if (pts.length < 2) return { x: 0, y: 0 };
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let tt = 0;
  let tx = 0;
  let ty = 0;
  for (const p of pts) {
    const d = p.t - mt;
    tt += d * d;
    tx += d * (p.x - mx);
    ty += d * (p.y - my);
  }
  if (tt < 1) return { x: 0, y: 0 }; // all at the same moment: no way to tell a speed
  return clampSpeed({ x: (tx / tt) * 1000, y: (ty / tt) * 1000 }, max);
}

/** Keep pointer samples to the last `keepMs` (ms). */
export function pushSample(samples, s, keepMs = 200) {
  samples.push(s);
  while (samples.length > 2 && samples[0].t < s.t - keepMs) samples.shift();
  return samples;
}

const rectOk = (r) => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;

/**
 * The lifted stage: his window covers `area` (the display's work area, DIPs); his usual `strip`
 * (DIPs) has its floor `floor` px above its bottom edge, and Claude's prompt box `box` (strip px, or
 * null). Returns everything in the area stage's px (y down):
 *   { W, H, ground, dx, dy, ledge, box, solids }
 * `ledge` is the strip's floor line { x1, x2, y } (null when it is the area's own floor, as with a
 * maximised Claude window); `solids` is what he can land on there: the ledge as a one-way platform
 * and the prompt box (solid down to the strip's floor).
 */
export function liftedStage({ area, strip, box = null, floor = 3 }) {
  if (!rectOk(area) || !rectOk(strip)) return null;
  const W = Math.round(area.width);
  const H = Math.round(area.height);
  const ground = H - floor;
  const dx = strip.x - area.x;
  const dy = strip.y - area.y;
  const stripGround = dy + strip.height - floor;
  const x1 = Math.max(0, dx);
  const x2 = Math.min(W, dx + strip.width);
  const solids = [];
  let ledge = null;
  if (x2 - x1 > 8 && stripGround < ground - 4 && stripGround > 0) {
    ledge = { x1, x2, y: stripGround };
    solids.push({ id: 'ledge', x: x1, y: stripGround, w: x2 - x1, h: 2, oneWay: true });
  }
  let b = null;
  if (box && [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0) {
    // (Only the part inside his stage: a box running past its edge would push him out through it.)
    const x1b = Math.max(0, box.x + dx);
    const x2b = Math.min(W, box.x + dx + box.w);
    b = { x: x1b, y: box.y + dy, w: x2b - x1b, h: box.h };
    const bottom = Math.min(ground, stripGround);
    if (bottom - b.y > 2 && b.w > 8) solids.push({ id: 'box', x: b.x, y: b.y, w: b.w, h: bottom - b.y });
    else b = null;
  }
  return { W, H, ground, dx, dy, ledge, box: b, solids, stripGround: Math.min(ground, stripGround), stripX: [dx, dx + strip.width] };
}

/**
 * Where a point (stage px) sits on his usual strip: 'box' (on the prompt box's top), 'floor' (on the
 * strip's floor), or null (somewhere else on the screen). `x` is his centre, `y` the surface he stands
 * on (stage y), `half` his half side.
 */
export function onStrip(stage, { x, y, half = 0 }) {
  if (!stage) return null;
  const [sx1, sx2] = stage.stripX;
  if (x - half < sx1 - 1 || x + half > sx2 + 1) return null;
  // (On the box: any of his base over it, as his engine lets him rest on it.)
  if (stage.box && Math.abs(y - stage.box.y) < 2.5 && x + half > stage.box.x && x - half < stage.box.x + stage.box.w) return 'box';
  if (Math.abs(y - stage.stripGround) < 2.5) return 'floor';
  return null;
}

/** A point on the strip's floor (stage px) nearest to x, for him to go back to. */
export function nearestStripSpot(stage, x, half = 0) {
  const [sx1, sx2] = stage.stripX;
  const lo = Math.max(sx1 + half + 8, 0);
  const hi = Math.min(sx2 - half - 8, stage.W);
  let tx = Math.min(hi, Math.max(lo, x));
  // Not under the prompt box: it's solid down to the floor. Its top is a fine spot instead.
  if (stage.box && tx > stage.box.x - half && tx < stage.box.x + stage.box.w + half) return { x: Math.min(stage.box.x + stage.box.w - half - 2, Math.max(stage.box.x + half + 2, tx)), y: stage.box.y };
  return { x: tx, y: stage.stripGround };
}

/** Convert a point between frames whose origins (screen DIPs) are `from` and `to`. */
export const reframe = (p, from, to) => ({ x: p.x + from.x - to.x, y: p.y + from.y - to.y });
