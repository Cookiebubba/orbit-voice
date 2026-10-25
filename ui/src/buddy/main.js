// The pixel buddy's window: a transparent strip along the bottom of the Claude window. It draws
// the buddy (engine.js + sprite.js) on a canvas and feeds it Orbit's state, the prompt box's
// position (a platform to jump onto), the cursor, and clicks and drags.
//
// The window ignores the mouse (clicks go through to Claude) except while the cursor is over the
// buddy itself: then it can be clicked (poked) or picked up and dropped.
//
// ?demo=1 runs it on its own (no Orbit): it cycles through Orbit's states and events, with a pretend
// prompt box, for trying it in a browser and for the visual tests.

import { createBuddy } from './engine.js';
import { drawBuddy, glyph } from './sprite.js';
import { pressKind } from './throw.js';

const desktop = window.desktop;
const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const GROUND = 2; // art pixels between the feet and the window's bottom edge

const canvas = document.createElement('canvas');
// It fades in when it turns up and out when you switch to another avatar (Settings -> Avatar).
Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', imageRendering: 'pixelated', opacity: DEMO ? '1' : '0', transition: 'opacity 280ms ease' });
document.documentElement.style.background = 'transparent';
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');

let scale = Math.max(1, Math.min(4, Number(params.get('scale')) || 2)); // CSS px per art pixel
let voice = { phase: 'off' };
let box = null; // the prompt box in CSS px, relative to this window: { x, y, w, h }
const events = [];
const bd = createBuddy({ x: 30 });
let cursor = null; // in art px
let lastFrame = null;
let prefs = { clickTalk: true, throw: true }; // Settings -> Avatar: click to talk, pick up

const toArt = (cx, cy) => ({ x: cx / scale, y: (innerHeight - cy) / scale - GROUND });
const world = () => {
  const w = innerWidth / scale;
  const h = innerHeight / scale;
  const platforms = [];
  if (box && box.w > 0) {
    // The box's top edge is a platform (inset a little from its rounded corners).
    const top = (innerHeight - box.y) / scale - GROUND;
    const bottom = (innerHeight - (box.y + box.h)) / scale - GROUND; // the gap under it
    platforms.push({ id: 'box', x0: box.x / scale + 2, x1: (box.x + box.w) / scale - 2, y: top, bottom });
  }
  return { w, h, platforms };
};

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
addEventListener('resize', resize);
resize();

// ---------- drawing ----------
function plot(pixels, ox, oy, alpha = 1) {
  ctx.globalAlpha = alpha;
  const H = innerHeight;
  for (const [x, y, color] of pixels) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round((ox + x) * scale), Math.round(H - (oy + y + 1 + GROUND) * scale), scale, scale);
  }
  ctx.globalAlpha = 1;
}

function draw(f) {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  // A soft shadow under it (smaller the higher it is).
  const ground = f.on === null ? groundBelow(f.x, f.y) : f.y;
  const lift = Math.max(0, f.y - ground);
  const sw = Math.max(2, 9 - lift / 6);
  ctx.globalAlpha = Math.max(0.08, 0.28 - lift / 200);
  ctx.fillStyle = '#000';
  ctx.fillRect(Math.round((f.x - sw / 2) * scale), Math.round(innerHeight - (ground + GROUND) * scale - scale * 0.5), Math.round(sw * scale), Math.max(1, Math.round(scale * 0.75)));
  ctx.globalAlpha = 1;
  const fx = Math.round(f.x);
  const fy = Math.round(f.y);
  plot(drawBuddy(f.pose), fx, fy);
  if (f.prop) {
    const g = glyph(f.prop.g, f.prop.color, f.prop.color2);
    const dir = f.pose.facing === -1 ? -1 : 1;
    if (g) plot(g, fx + (dir === 1 ? f.prop.dx : -f.prop.dx - 6), fy + f.prop.dy);
  }
  for (const e of f.fx) {
    const g = glyph(e.g, e.color, e.color2);
    if (g) plot(g, Math.round(e.x), Math.round(e.y), e.alpha);
  }
}

function groundBelow(x, y) {
  let best = 0;
  for (const p of world().platforms) if (x >= p.x0 && x <= p.x1 && p.y <= y + 0.01) best = Math.max(best, p.y);
  return best;
}

// ---------- the loop ----------
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (DEMO) demoStep(dt);
  lastFrame = bd.step({ dt, world: world(), voice, cursor, events: events.splice(0) });
  draw(lastFrame);
  sendHit(lastFrame);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- the mouse ----------
// Where it's drawn (its hit box, in this window's px), for Orbit's own hover check from the real
// cursor (electron/avatar-hover.js): clicks and grabs work even when forwarded mouse moves stop.
let hitSent = '';
function sendHit(f) {
  if (!f || leaving) return;
  const rect = { x: Math.round((f.x - 8) * scale), y: Math.round(innerHeight - (f.y + 19 + GROUND) * scale), w: Math.round(16 * scale), h: Math.round(21 * scale) };
  const key = `${rect.x},${rect.y},${rect.w},${rect.h}`;
  if (key === hitSent) return;
  hitSent = key;
  desktop?.buddyHit?.(rect);
}
// Mouse moves arrive even while the window lets clicks through (Electron forwards them), so it
// can look at the cursor; it only takes the mouse while the cursor is on the buddy.
let hovering = false;
let press = null; // { x, y, dragging }
function setHover(on) {
  if (on === hovering) return;
  hovering = on;
  canvas.style.cursor = on ? 'grab' : 'default';
  desktop?.buddyHover?.(on);
}
addEventListener('mousemove', (e) => {
  const a = toArt(e.clientX, e.clientY);
  cursor = a;
  if (press) {
    if (!press.dragging && prefs.throw && pressKind({ dx: e.clientX - press.x, dy: e.clientY - press.y }) === 'drag') press.dragging = true;
    if (press.dragging) {
      canvas.style.cursor = 'grabbing';
      bd.grab(a.x, a.y);
    }
    return;
  }
  setHover(bd.hit(a.x, a.y));
});
addEventListener('mouseleave', () => {
  cursor = null;
  if (!press) setHover(false);
});
addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const a = toArt(e.clientX, e.clientY);
  if (!bd.hit(a.x, a.y)) return;
  press = { x: e.clientX, y: e.clientY, t: e.timeStamp, dragging: false };
});
addEventListener('mouseup', (e) => {
  if (!press) return;
  if (press.dragging) bd.release();
  else {
    // A quick click starts talking to Orbit (the same path as Qubit's; see electron/main.js buddy:talk).
    if (prefs.clickTalk && pressKind({ dx: e.clientX - press.x, dy: e.clientY - press.y, ms: e.timeStamp - press.t, released: true }) === 'click') desktop?.buddyTalk?.();
    bd.poke();
  }
  press = null;
  canvas.style.cursor = hovering ? 'grab' : 'default';
});
addEventListener('blur', () => {
  if (press?.dragging) bd.release();
  press = null;
});

// ---------- from Orbit ----------
let leaving = false; // switched to another avatar: fading out
desktop?.onBuddyState?.((s) => {
  if (!s || typeof s !== 'object') return;
  if (!leaving) canvas.style.opacity = '1';
  if (s.voice) voice = s.voice;
  if ('box' in s) box = s.box && Number.isFinite(s.box.x) ? s.box : null;
  if (Number.isFinite(s.scale)) scale = Math.max(1, Math.min(4, s.scale));
  if (s.prefs && typeof s.prefs === 'object') prefs = { clickTalk: s.prefs.clickTalk !== false, throw: s.prefs.throw !== false };
});
desktop?.onBuddyEvent?.((name) => {
  if (name === 'leave') {
    leaving = true;
    canvas.style.opacity = '0';
    desktop?.buddyHover?.(false);
  } else if (typeof name === 'string') events.push(name);
});

// Something you asked it to do ("dance"), by voice.
desktop?.onBuddyCommand?.((c) => {
  if (c && typeof c === 'object' && !leaving) bd.command({ action: String(c.action), dir: c.dir });
});

// ---------- demo (no Orbit) ----------
let demoT = 0;
const DEMO_SCRIPT = [
  [0, { phase: 'off' }],
  [6, { phase: 'connecting' }],
  [7.5, { phase: 'listening' }],
  [22, { phase: 'listening', hearing: true, input: 0.3 }],
  [25, { phase: 'thinking' }],
  [28, { phase: 'speaking', output: 0.25 }],
  [32, { phase: 'listening' }, 'draft'],
  [38, { phase: 'listening' }, 'sent'],
  [44, { phase: 'listening', claudeWorking: true }],
  [54, { phase: 'listening' }, 'finished'],
  [60, { phase: 'off' }],
  [70, null],
];
let demoI = 0;
function demoStep(dt) {
  demoT += dt;
  if (!box) box = { x: innerWidth * 0.3, y: innerHeight - 130, w: innerWidth * 0.45, h: 110 };
  while (demoI < DEMO_SCRIPT.length && demoT >= DEMO_SCRIPT[demoI][0]) {
    const [, v, ev] = DEMO_SCRIPT[demoI++];
    if (!v) {
      demoT = 0;
      demoI = 0;
      break;
    }
    voice = { ...v };
    if (ev) events.push(ev);
  }
  if (voice.phase === 'speaking') voice.output = 0.15 + 0.15 * Math.sin(demoT * 9);
  if (voice.hearing) voice.input = 0.2 + 0.2 * Math.sin(demoT * 7);
}

// For the visual tests: what it's doing right now (read-only).
if (params.get('debug') === '1') window.__buddy = { get frame() { return lastFrame; }, events, setVoice: (v) => (voice = v), setBox: (b) => (box = b), bd };
