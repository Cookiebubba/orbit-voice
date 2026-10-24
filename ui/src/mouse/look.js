// Orbit's mouse: how it looks (plain JS, no DOM, so the tests run it in node). The page that draws it
// is main.js; the window it lives in is electron/orbit-mouse.js.
//
// The shape is a plain arrow pointer, the size of Windows' own at the display's scaling (the page
// draws in CSS pixels, which Electron scales for the display). Qubit's art rules: the arrow's vector
// fill is the only visual, one solid, fully opaque colour: Qubit's colour for the same moment (his
// engine's PALETTE through his MODES, mapped from Orbit's voice state exactly as his director does:
// listening cyan, thinking violet, speaking amber...). No stroke, outline, ring, gradient, glow,
// blur or shadow. Where it points is shown by the arrow alone: its glide, where it rests, its press.

import { MODE_FOR, baseState } from '../qubit/director.js';

export { ARROW_PATH, ARROW_SIZE, PREVIEW, css } from './shape.js';

/**
 * Qubit's mode for Orbit's voice state `v` (as the avatars get it): the same mapping as his director
 * (baseState, MODE_FOR), except that with Orbit off (a helper acting while no call is on) the mouse
 * wears Qubit's own indigo, not his sleeping night blue.
 */
export function mouseMode(v = {}) {
  if (!v || typeof v !== 'object' || !v.phase || v.phase === 'off') return 'idle';
  return MODE_FOR[baseState(v, 0)] || 'idle';
}

/** OKLCH [l, c, h] for a mode, from the engine's MODES (Qubit's palette, unchanged). */
export function lchFor(mode, MODES) {
  const m = MODES?.[mode] || MODES?.idle;
  return m ? [...m.color] : [0.63, 0.2, 272];
}

/**
 * The gentle pulse while Orbit speaks: a scale around the tip (so the tip stays on its target) from
 * the voice's level before the volume (as Qubit's mouth uses it). At most 14% bigger; nothing with
 * reduced motion or while not speaking.
 */
export function pulseScale(level, { speaking = true, reduced = false } = {}) {
  if (!speaking || reduced) return 1;
  const l = Math.min(1, Math.max(0, Number(level) || 0));
  return 1 + 0.14 * Math.sqrt(l);
}

/**
 * The press, as the arrow's scale around its tip (ms since the press): a quick dip to 84% and back
 * in 260 ms. With reduced motion, no animation: one small step down for 180 ms, then back.
 */
export function pressAt(ms, { reduced = false } = {}) {
  const t = Number(ms);
  if (!(t >= 0)) return 1;
  if (reduced) return t < 180 ? 0.9 : 1;
  const down = 90;
  if (t >= down + 170) return 1;
  return t < down ? 1 - 0.16 * (t / down) : 0.84 + 0.16 * ((t - down) / 170);
}

/** Ease in and out (cubic), for the glides. */
export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Where a glide `{ from, to, t0, ms }` is at time `t` (ms, same clock), in its own coordinates. */
export function glideAt(motion, t) {
  if (!motion) return null;
  const k = motion.ms > 0 ? ease((t - motion.t0) / motion.ms) : 1;
  return { x: motion.from.x + (motion.to.x - motion.from.x) * k, y: motion.from.y + (motion.to.y - motion.from.y) * k, done: k >= 1 };
}

