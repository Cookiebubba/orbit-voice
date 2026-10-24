// Orbit's mouse: the page in one display's overlay (electron/orbit-mouse.js), a transparent,
// click-through window inside that display's work area. It draws Orbit's cursor (look.js) where the
// main process says, gliding on the shared clock (Date.now), so a glide from one display to another
// is seamless: each display's page draws the part that falls on it.
//
// Qubit's art rules: the only thing drawn is the arrow, one vector path with one solid, fully opaque
// fill (his live colour). No stroke, outline, ring, shadow, glow, blur or gradient. Where Orbit
// points is shown by the arrow alone: its glide, where it rests, and its press dip. The whole
// cursor fades in and out; nothing else is translucent.
//
// Frames run only while something moves: a glide, a fade, a press, the colour changing, or the
// pulse while Orbit speaks. Otherwise the page is still and draws nothing new.

import '../vendor/avatars/qubit-engine.js';
import { ARROW_PATH, css, glideAt, lchFor, mouseMode, pressAt, pulseScale } from './look.js';

const E = window.QubitEngine;
const desktop = window.desktop;
const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const NS = 'http://www.w3.org/2000/svg';
const FADE_IN_MS = 160;
const FADE_OUT_MS = 240;

document.documentElement.style.background = 'transparent';
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden;pointer-events:none';

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const svg = el('svg', { width: '100%', height: '100%', style: 'position:fixed;inset:0;overflow:visible' }, document.body);
// The fade (the one translucency there is) is on the cursor as a whole.
const all = el('g', { opacity: '0' }, svg);
const arrow = el('g', {}, all);
const arrowPath = el('path', { d: ARROW_PATH }, arrow);

let st = { visible: false, enter: false, motion: null, press: null, voice: { phase: 'off' }, area: null, wa: null, origin: { x: 0, y: 0 }, scale: 1 };
const T = E.TUNING;
const start = lchFor('idle', E.MODES);
const L = new E.Spring(start[0], ...T.L);
const C = new E.Spring(start[1], ...T.C);
const H = new E.HueSpring(start[2], ...T.H);
const level = new E.Spring(0, 7, 0.75);
let opacity = 0;
let raf = 0;
let last = 0;
let frames = 0;
let presses = 0;
let pos = null; // the tip, in this page's CSS px

// A physical screen point in this page's CSS px: by the display (its work area's physical and DIP
// origins) and where this window is now (screenX/Y: the window grows as glides need room, and this
// stays right through a resize); else by the origin the main process sent.
const local = (p) =>
  st.area && st.wa
    ? { x: (p.x - st.area.x) / st.scale + st.wa.x - (window.screenX || 0), y: (p.y - st.area.y) / st.scale + st.wa.y - (window.screenY || 0) }
    : { x: (p.x - st.origin.x) / st.scale, y: (p.y - st.origin.y) / st.scale };
const settled = (s, eps) => Math.abs(s.v - s.t) < eps && Math.abs(s.vel) < eps * 4;

// At most 60 frames a second (a fast display needn't redraw it more often), and 30 while all that
// moves is the gentle pulse with the voice.
let pulseOnly = false;
function frame(now) {
  raf = 0;
  if (last && now - last < (pulseOnly ? 1000 / 30 : 1000 / 60) - 2) {
    raf = requestAnimationFrame(frame);
    return;
  }
  frames++;
  const dt = Math.min(0.05, Math.max(0.001, (now - (last || now)) / 1000));
  last = now;
  const t = Date.now();
  // Colour: Qubit's for this moment, gliding there like his does.
  const [l, c, h] = lchFor(mouseMode(st.voice), E.MODES);
  L.to(l).step(dt);
  C.to(c).step(dt);
  H.to(h).step(dt);
  const speaking = st.voice?.phase === 'speaking';
  level.to(speaking ? Number(st.voice.output) || 0 : 0).step(dt);
  // Fade in (or out).
  const want = st.visible ? 1 : 0;
  if (want > opacity) opacity = Math.min(1, opacity + (dt * 1000) / FADE_IN_MS);
  else if (want < opacity) opacity = Math.max(0, opacity - (dt * 1000) / FADE_OUT_MS);
  // Where: on the glide (straight to its end with reduced motion).
  const g = st.motion ? (reduced ? { ...st.motion.to, done: true } : glideAt(st.motion, t)) : null;
  if (g) pos = local(g);
  all.setAttribute('opacity', opacity.toFixed(3));
  if (pos) {
    const pr = st.press ? pressAt(t - st.press.at, { reduced }) : 1;
    const s = pulseScale(level.v, { speaking: true, reduced }) * pr;
    arrow.setAttribute('transform', `translate(${pos.x.toFixed(2)} ${pos.y.toFixed(2)}) scale(${s.toFixed(4)})`);
    arrowPath.setAttribute('fill', css([L.v, C.v, H.v]));
  }
  // Another frame only while something still moves.
  const pressing = st.press && t - st.press.at <= 300;
  const pulsing = !reduced && speaking && st.visible;
  const moving = (g && !g.done) || opacity !== want || pressing || pulsing || !settled(L, 0.001) || !settled(C, 0.001) || !settled(H, 0.2) || !settled(level, 0.002);
  pulseOnly = pulsing && !(g && !g.done) && opacity === want && !pressing;
  if (moving && (st.visible || opacity > 0)) raf = requestAnimationFrame(frame);
  else last = 0;
}
const kick = () => {
  if (!raf) raf = requestAnimationFrame(frame);
};
addEventListener('resize', () => kick());

desktop?.onMouseState?.((s) => {
  if (!s || typeof s !== 'object') return;
  const pt = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null);
  const motion = s.motion && pt(s.motion.from) && pt(s.motion.to) ? { from: pt(s.motion.from), to: pt(s.motion.to), t0: Number(s.motion.t0) || 0, ms: Math.max(0, Number(s.motion.ms) || 0) } : null;
  const press = s.press && Number.isFinite(s.press.at) ? { at: s.press.at } : null;
  if (press && press.at !== st.press?.at) presses++;
  // A fresh appearance starts from nothing (it fades in where the glide begins).
  if (s.visible && !st.visible && s.enter) opacity = 0;
  st = {
    visible: !!s.visible,
    enter: !!s.enter,
    motion,
    press,
    voice: s.voice && typeof s.voice === 'object' ? s.voice : st.voice,
    area: pt(s.area),
    wa: pt(s.wa),
    origin: pt(s.origin) || st.origin,
    scale: Number(s.scale) > 0 ? Number(s.scale) : st.scale,
  };
  kick();
});

// For the tests (read-only): where the tip is drawn, what is drawn, and how much the page has worked.
window.__mouse = {
  get pos() {
    return pos && { ...pos };
  },
  get opacity() {
    return opacity;
  },
  get fill() {
    return arrowPath.getAttribute('fill');
  },
  get mode() {
    return mouseMode(st.voice);
  },
  /** Every element drawn, as [tag, attributes] (one svg, two groups, one path). */
  get drawn() {
    const out = [];
    const walk = (e) => {
      out.push([String(e.tagName || e.localName || e.tag || '').toLowerCase(), Object.fromEntries([...(e.attributes || [])].map((a) => [a.name, a.value]))]);
      for (const k of e.children || []) walk(k);
    };
    walk(svg);
    return out;
  },
  get frames() {
    return frames;
  },
  get running() {
    return !!raf;
  },
  get presses() {
    return presses;
  },
  reduced,
};
