// Qubit's window: a transparent strip along the bottom of the Claude window (see
// electron/avatar.js). His engine (vendor/avatars/qubit-engine.js, with orbit-nav.js for pathing)
// draws him as one SVG path at the display's full refresh rate; director.js turns Orbit's state
// into his moods and moves. The strip's floor is the window's bottom edge; Claude's prompt box,
// when the app found it, is a block he stands on, and its Send button a spot he stomps.
//
// The window ignores the mouse (clicks go through to Claude) except while the cursor is on him:
// then a click gets a small reaction. He follows the cursor with his eye.
//
// Frame budget: nothing runs until he is placed; asleep and still, he drops to 30 fps (see
// lowPower below); while the window is hidden (Claude minimized) the frame loop stops altogether.

import '../vendor/avatars/orbit-nav.js';
import '../vendor/avatars/qubit-engine.js';
import { FLOOR, createDirector, sideFor } from './director.js';

const E = window.QubitEngine;
const desktop = window.desktop;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FADE_MS = 280;

document.documentElement.style.background = 'transparent';
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
const mount = document.createElement('div');
Object.assign(mount.style, { position: 'fixed', inset: '0', opacity: '0', transition: `opacity ${FADE_MS}ms ease` });
document.body.appendChild(mount);

let st = { voice: { phase: 'off' }, box: null, send: null, boxKnown: false, scale: 2, visible: true };
let q = null;
let dir = null;
let entrance = false; // switched to Qubit live: he drops in
let gone = false; // switched away: fading out
let running = true;

const geometry = () => ({ W: innerWidth, H: innerHeight, box: st.box, send: st.send, side: sideFor(st.scale) });

/** Place him, once the strip knows where the prompt box is (or after a moment without it). */
function start() {
  if (q || gone || innerWidth < 40 || innerHeight < 40) return;
  q = E.create({ mount, width: innerWidth, height: innerHeight, size: sideFor(st.scale), floor: FLOOR, mode: 'asleep', keepAlive: true });
  // Idle life is the director's (a seeded wander); no random tricks of the engine's own brain.
  q.brainT.play = q.brainT.stunt = Infinity;
  dir = createDirector(q, { seed: Math.floor(Math.random() * 0xffffff) + 1, reduceMotion });
  dir.setVoice(st.voice);
  dir.setGeometry(geometry());
  dir.place({ entrance });
  entrance = false;
  E.ticker.hooks.add((dt) => {
    dir.tick(dt);
    setLow(dir.lowPower());
  });
  setRunning(st.visible && !document.hidden);
  requestAnimationFrame(() => (mount.style.opacity = '1'));
}
setTimeout(start, 2500); // the box never turned up: the floor will do

// The frame loop: the engine's own ticker at the display's full rate, or (asleep and still) a
// 30 fps one here. (The engine's ticker.lowPower is not used: it counts the skipped frames' time
// more than once, so everything ran about twice as fast in it.)
let low = false;
let lowRaf = 0;
let lowLast = 0;
function stopEngineLoop() {
  cancelAnimationFrame(E.ticker._raf);
  E.ticker._raf = 0;
}
function lowLoop(now) {
  lowRaf = requestAnimationFrame(lowLoop);
  if (now - lowLast < 1000 / 30 - 2) return;
  const dt = Math.min((now - lowLast) / 1000, 1 / 20);
  lowLast = now;
  q.update(dt);
  for (const fn of E.ticker.hooks) fn(dt, now);
}
function startLoop() {
  if (low) {
    lowLast = performance.now();
    if (!lowRaf) lowRaf = requestAnimationFrame(lowLoop);
  } else E.ticker.start();
}
function stopLoops() {
  stopEngineLoop();
  cancelAnimationFrame(lowRaf);
  lowRaf = 0;
}
function setLow(on) {
  if (on === low) return;
  low = on;
  if (!running) return;
  stopLoops();
  startLoop();
}

/** Run the frame loop, or stop it (the window is hidden). */
function setRunning(on) {
  if (!q || on === running) return;
  running = on;
  if (on) startLoop();
  else stopLoops();
}
document.addEventListener('visibilitychange', () => setRunning(st.visible && !document.hidden));

addEventListener('resize', () => dir?.setGeometry(geometry()));

// ---------- the mouse ----------
// Mouse moves arrive even while the window lets clicks through (Electron forwards them), so he can
// look at the cursor; the window takes the mouse only while the cursor is on him.
let hovering = false;
function setHover(on) {
  if (on === hovering) return;
  hovering = on;
  document.body.style.cursor = on ? 'pointer' : 'default';
  desktop?.buddyHover?.(on);
}
addEventListener('mousemove', (e) => {
  if (!q) return;
  q.setPointer({ x: e.clientX, y: e.clientY });
  setHover(!gone && dir.hit(e.clientX, e.clientY));
});
addEventListener('mouseleave', () => {
  q?.setPointer(null);
  setHover(false);
});
addEventListener('mousedown', (e) => {
  if (e.button === 0 && q && !gone && dir.hit(e.clientX, e.clientY)) dir.poke();
});

// ---------- from Orbit ----------
desktop?.onBuddyState?.((s) => {
  if (!s || typeof s !== 'object') return;
  const rect = (r) => (r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null);
  const next = {
    voice: s.voice && typeof s.voice === 'object' ? s.voice : st.voice,
    box: 'box' in s ? rect(s.box) : st.box,
    send: 'send' in s ? rect(s.send) : st.send,
    boxKnown: !!s.boxKnown || st.boxKnown,
    scale: Number.isFinite(s.scale) ? s.scale : st.scale,
    visible: s.visible !== false,
  };
  const geoChanged = JSON.stringify([next.box, next.send, next.scale]) !== JSON.stringify([st.box, st.send, st.scale]);
  st = next;
  if (!q) {
    if (st.boxKnown) start();
    return;
  }
  dir.setVoice(st.voice);
  if (geoChanged) dir.setGeometry(geometry());
  setRunning(st.visible && !document.hidden);
});
desktop?.onBuddyEvent?.((name) => {
  if (name === 'enter') {
    if (q) dir.place({ entrance: true });
    else entrance = true;
  } else if (name === 'leave') {
    gone = true;
    setHover(false);
    mount.style.opacity = '0';
  } else if (typeof name === 'string' && q && !gone) dir.event(name);
});

// Something you asked him to do ("do a backflip"), by voice.
desktop?.onBuddyCommand?.((c) => {
  if (c && typeof c === 'object' && q && !gone) dir.command({ action: String(c.action), dir: c.dir === 'left' || c.dir === 'right' ? c.dir : undefined });
});

// A feeling as the voice's words play ("<happy> Done!"): the main window times it to the audio.
desktop?.onBuddyEmote?.((name) => {
  if (typeof name === 'string' && q && !gone) dir.emote(name);
});

// For the tests (read-only use): the engine, his instance and the director.
window.__qubit = {
  E,
  get q() {
    return q;
  },
  get dir() {
    return dir;
  },
  get state() {
    return st;
  },
  get running() {
    return running;
  },
  get lowPower() {
    return low;
  },
};
