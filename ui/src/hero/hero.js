// Qubit as the launcher's hero: his real engine (vendor/avatars/qubit-engine.js), standing in the
// middle of the main page. He never walks or paths: no wander, none of the engine's own random
// flips or rolls. Instead he shows off his emotes every few seconds (his own moods and in-place
// moves, seeded so it never loops the same way), between his idle breathing, blinks and glances.
//
// While Orbit is live (listening, thinking, speaking...) he wears Orbit's state the way the avatar
// director maps it (director.js baseState and MODE_FOR) and his eye follows the voice levels; the
// demo emotes wait until Orbit goes back to sleep.
//
// No DOM here: the engine instance is passed in, so this runs in node for the tests.

import { MODE_FOR, baseState } from '../qubit/director.js';

/** His show: an emote every `everyS` [min, max] seconds, drawn from his seed. */
export const HERO_TIMING = Object.freeze({ firstS: 1.2, everyS: [1.8, 3.4] });

/**
 * What he shows off, all in place (none of them carries him across): a mood (`mode`, held `hold`
 * seconds) and/or one of his own moves (`act`). Weights: how often each comes up.
 */
export const HERO_EMOTES = Object.freeze([
  { name: 'happy', mode: 'happy', act: 'hopInPlace', hold: 1.6, weight: 3 },
  { name: 'celebrate', mode: 'happy', act: 'celebrate', hold: 1.9, weight: 1.4 },
  { name: 'curious', mode: 'curious', act: 'glance', params: { x: 0.8, y: -0.7, hold: 1.1 }, hold: 1.6, weight: 2 },
  { name: 'surprised', mode: 'surprised', act: 'wonder', hold: 1.1, weight: 1.4 },
  { name: 'nod', act: 'nod', hold: 0.7, weight: 1.6 },
  { name: 'shake', act: 'shake', hold: 0.8, weight: 0.8 },
  { name: 'stretch', act: 'stretch', hold: 1.1, weight: 1.2 },
  { name: 'lookAround', act: 'lookAround', hold: 1.7, weight: 1.4 },
  { name: 'eyeMorph', act: 'eyeMorph', hold: 1.9, weight: 1 },
  { name: 'eyeTurn', act: 'eyeTurn', hold: 1.9, weight: 0.9 },
  { name: 'blink', act: 'doubleBlink', hold: 0.6, weight: 0.8 },
  { name: 'jump', act: 'jump', params: { height: 1.1 }, hold: 1.1, weight: 1.2 },
  { name: 'flip', act: 'flip', params: { outcome: 'success', dir: -1 }, hold: 2.4, weight: 0.9 },
  { name: 'music', mode: 'music', hold: 3.6, weight: 0.7 },
  { name: 'sad', mode: 'sad', hold: 1.6, weight: 0.3 },
  { name: 'embarrassed', mode: 'embarrassed', hold: 1.4, weight: 0.35 },
]);

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Orbit's voice state as his hero mode: null while Orbit is off or asleep (his show runs then). */
export function heroMode(v = {}) {
  if (!v || !v.phase || v.phase === 'off' || v.asleep) return null;
  return MODE_FOR[baseState(v, 0)] || 'idle';
}

/**
 * The hero's director for one engine instance `q`, standing at stage x `home`.
 * tick(dt) after each engine update; setVoice(v) with Orbit's state; poke() on a click.
 */
export function createHero(q, { seed = 1, home = q.cx, timing = {} } = {}) {
  const T = { ...HERO_TIMING, ...timing };
  const R = rng(seed);
  const range = ([a, b]) => a + (b - a) * R();
  let t = 0;
  let nextAt = T.firstS;
  let hold = 0; // the current emote's mood ends then
  let last = '';
  let live = null; // Orbit's mode while it's live
  let v = { phase: 'off' };
  const shown = []; // emote names, in order (tests)

  // He stays put: no wander, and the engine's own brain only blinks and glances.
  q.setWander(false);
  q.brainT.play = q.brainT.stunt = Infinity;

  const settled = () => !q.air && !q.pivot && !q.busy && !q.task && !q.queue.length;

  function pick() {
    const pool = HERO_EMOTES.filter((e) => e.name !== last);
    let x = R() * pool.reduce((s, e) => s + e.weight, 0);
    for (const e of pool) if ((x -= e.weight) <= 0) return e;
    return pool[pool.length - 1];
  }

  function show(e) {
    last = e.name;
    shown.push(e.name);
    if (shown.length > 200) shown.shift();
    if (e.mode) q.setMode(e.mode);
    if (e.act) q.do(e.act, { ...(e.params || {}) });
    hold = t + e.hold;
    nextAt = t + e.hold + range(T.everyS);
  }

  /** Back to his spot if a landing left him a little off it (a small hop, never a slide). */
  function recentre() {
    const off = home - q.cx;
    if (Math.abs(off) < 2 || !settled()) return false;
    q.do('hop', { dir: Math.sign(off), dist: Math.min(0.75, Math.abs(off) / q.side) });
    return true;
  }

  return {
    tick(dt) {
      t += dt;
      q.setLevels(v.muted ? 0 : Number(v.input) || 0, Number(v.output) || 0);
      q.talking = live === 'speaking';
      if (live) return;
      if (hold && t >= hold && settled()) {
        hold = 0;
        if (q.mode !== 'idle') q.setMode('idle');
      }
      if (!hold && t >= nextAt && settled() && !recentre()) show(pick());
    },
    setVoice(next) {
      if (!next || typeof next !== 'object') return;
      v = next;
      const mode = heroMode(v);
      if (mode === live) return;
      live = mode;
      hold = 0;
      if (mode) {
        q.look = { x: 0, y: 0 };
        q.setMode(mode);
      } else {
        q.setMode('idle');
        nextAt = t + range(T.everyS) * 0.5;
      }
    },
    /** A click on him: a small, quick acknowledgement (a hop). */
    poke() {
      if (q.air || q.pivot) return;
      q.do('hopInPlace', {}, { interrupt: true });
      nextAt = Math.max(nextAt, t + 1.5);
    },
    /** Is (x, y) (stage px, y down) on him? */
    hit(x, y) {
      const cx = q._rx ?? q.cx;
      const cy = q._ry ?? q.ground - q.cy;
      return Math.abs(x - cx) < q.side * 0.62 && Math.abs(y - cy) < q.side * 0.62;
    },
    get shown() {
      return shown;
    },
    get live() {
      return live;
    },
    get home() {
      return home;
    },
    set home(x) {
      home = x;
    },
  };
}
