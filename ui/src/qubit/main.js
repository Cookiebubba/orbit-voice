// Qubit's window: a transparent strip along the bottom of the Claude window (see
// electron/avatar.js). His engine (vendor/avatars/qubit-engine.js, with orbit-nav.js for pathing)
// draws him as one SVG path at the display's full refresh rate; director.js turns Orbit's state
// into his moods and moves. The strip's floor is the window's bottom edge; Claude's prompt box,
// when the app found it, is a block he stands on, and its Send button a spot he stomps.
//
// The window ignores the mouse (clicks go through to Claude) except while the cursor is on him.
// He follows the cursor with his eye. With him:
//   - a quick click (press and release without dragging) starts talking to Orbit, the same as saying
//     "Hey Orbit" with this window in front (Settings: "Click your avatar to talk"; off, a click is a
//     little poke);
//   - press and hold, or drag: he's picked up and follows the pointer; let go and he's thrown
//     (throw.js), with the pointer's speed (Settings: "Throw your avatar"). While he's held or in the
//     air his window covers the window he lives on (electron/avatar.js lift; free-floating, the work
//     area), so he stays inside it: dragged past its edge he stops there, thrown he bounces off its
//     edges, and he never shows over another window. It's still click-through except over him. He
//     lands on its floor or the prompt box, reacts, and carries on from where he landed; then the
//     window is his strip again. If that window moves or resizes meanwhile, his bounds follow it.
//
// Frame budget: nothing runs until he is placed; asleep and still, he drops to 30 fps (see
// lowPower below); while the window is hidden (Claude minimized) the frame loop stops altogether.

import '../vendor/avatars/orbit-nav.js';
import '../vendor/avatars/qubit-engine.js';
import { FLOOR, createDirector, sideFor } from './director.js';
import { createThrow, headBack } from './throw.js';
import { liftedStage, onStrip, pressKind, pushSample, throwVelocity } from '../buddy/throw.js';

const E = window.QubitEngine;
const desktop = window.desktop;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FADE_MS = 280;

document.documentElement.style.background = 'transparent';
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden;touch-action:none;user-select:none';
const mount = document.createElement('div');
Object.assign(mount.style, { position: 'fixed', inset: '0', opacity: '0', transition: `opacity ${FADE_MS}ms ease` });
document.body.appendChild(mount);

let st = { voice: { phase: 'off' }, box: null, send: null, boxKnown: false, scale: 2, visible: true, bounds: null, lift: null, prefs: { clickTalk: true, throw: true } };
let q = null;
let dir = null;
let th = null; // picking him up and throwing him (throw.js)
let entrance = false; // switched to Qubit live: he drops in
let gone = false; // switched away: fading out
let running = true;

// Which stage he's in: his usual strip, or (lifted: held, flying, or on his way back) the work area.
let frame = 'strip';
let stage = null; // the lifted stage (liftedStage), while frame is 'area'
let liftedAt = null; // the { area, strip } his window was lifted with

const stripSize = () => (st.bounds ? { W: st.bounds.width, H: st.bounds.height } : { W: innerWidth, H: innerHeight });
const geometry = () => ({ ...stripSize(), box: st.box, send: st.send, side: sideFor(st.scale) });

/** Place him, once the strip knows where the prompt box is (or after a moment without it). */
function start() {
  if (q || gone || innerWidth < 40 || innerHeight < 40) return;
  q = E.create({ mount, width: innerWidth, height: innerHeight, size: sideFor(st.scale), floor: FLOOR, mode: 'asleep', keepAlive: true });
  // Idle life is the director's (a seeded wander); no random tricks of the engine's own brain.
  q.brainT.play = q.brainT.stunt = Infinity;
  dir = createDirector(q, { seed: Math.floor(Math.random() * 0xffffff) + 1, reduceMotion });
  th = createThrow(q);
  th.on('bounce', () => q.blink('h'));
  th.on('land', landed);
  dir.setVoice(st.voice);
  dir.setGeometry(geometry());
  dir.place({ entrance });
  entrance = false;
  E.ticker.hooks.add((dt, now) => {
    dir.tick(dt);
    frameTick(dt, now);
    setLow(dir.lowPower() && !th.active && !press && frame === 'strip');
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

// ---------- his stage: the strip, or the work area while he's lifted ----------
const sameSize = (r) => r && Math.abs(innerWidth - r.width) <= 1 && Math.abs(innerHeight - r.height) <= 1;

/** The window has (or hasn't yet) become what Orbit says it is: carry him over to that stage. */
function syncFrame() {
  if (!q) return;
  const lift = st.lift;
  if (lift && frame === 'strip' && sameSize(lift.area)) {
    liftedAt = lift;
    th.reframe({ shift: { x: lift.strip.x - lift.area.x, y: lift.strip.y - lift.area.y }, W: lift.area.width, H: lift.area.height, floor: FLOOR });
    frame = 'area';
    stage = null;
    restage();
    return;
  }
  if (!lift && frame === 'area' && st.bounds && sameSize(st.bounds)) {
    const area = liftedAt.area;
    th.reframe({ shift: { x: area.x - st.bounds.x, y: area.y - st.bounds.y }, W: st.bounds.width, H: st.bounds.height, floor: FLOOR });
    frame = 'strip';
    stage = null;
    liftedAt = null;
    dir.setGeometry(geometry(), { keepBody: true });
    // Orbit made the strip click-through again as it gave it back: start from there.
    hovering = false;
    heldSent = false;
    hitSent = '';
    if (!press) hoverNow();
    return;
  }
  if (lift && frame === 'area' && liftedAt && JSON.stringify(lift.area) !== JSON.stringify(liftedAt.area) && sameSize(lift.area)) {
    // The window he lives on moved or resized mid-throw: he goes with it (same place from its left
    // edge and its floor), inside its new edges.
    const prev = liftedAt.area;
    liftedAt = lift;
    th.reframe({ shift: { x: 0, y: lift.area.height - prev.height }, W: lift.area.width, H: lift.area.height, floor: FLOOR });
    const half = q.side / 2;
    q.cx = Math.min(Math.max(q.cx, half), lift.area.width - half);
    if (q.cy > q.ground - half) q.cy = q.ground - half;
    restage();
    return;
  }
  if (lift && frame === 'area') liftedAt = { ...liftedAt, strip: lift.strip };
  if (frame === 'strip' && !lift) dir.setGeometry(geometry());
  else if (frame === 'area') restage();
}

/** The lifted stage from Orbit's latest word on where his strip and the prompt box are. */
function restage() {
  const lift = st.lift || liftedAt;
  if (!lift || frame !== 'area') return;
  stage = liftedStage({ area: lift.area, strip: lift.strip, box: st.box, floor: FLOOR });
  if (!stage) return;
  q.bounds = [0, stage.W];
  // However high his strip's floor is over the screen's bottom edge, he can get back up to it.
  q.abilityOverrides = { jumpUp: Math.max(q.S * 2.6, Math.min(stage.ground - Math.min(stage.stripGround, stage.box ? stage.box.y : Infinity) + q.S * 0.8, stage.H - q.S)), dropDown: stage.H };
  q.nav = null;
  th.setSolids(stage.solids);
}

addEventListener('resize', syncFrame);

// ---------- the mouse ----------
// The window takes the mouse only while the cursor is on him (or he's held). Orbit decides that
// itself from the real cursor and the rect this page reports every frame he moves (sendHit;
// electron/avatar-hover.js), so it never rests on forwarded mouse moves alone: those stop for good
// if Windows drops Electron's mouse hook (a main-thread stall). Forwarded moves, while they come,
// still update hover at once and his eye; the polled cursor (buddy:cursor) keeps his eye on it
// otherwise.
let hovering = false;
let heldSent = false;
let pointer = null; // the cursor in screen px (DIPs), for his eye and hover between moves
let movedAt = 0; // the last forwarded mouse move (performance.now())
function setHover(on) {
  const held = !!press;
  if (on === hovering && held === heldSent) return;
  hovering = on;
  heldSent = held;
  desktop?.buddyHover?.(on, held);
}
let hitSent = '';
/** His rect in this window's px, for Orbit's own hover check (only when it changed). */
function sendHit() {
  if (!q || gone) return;
  const r = q.side * 0.62;
  const x = q._rx ?? q.cx;
  const y = q._ry ?? q.ground - q.cy;
  const rect = { x: Math.round(x - r), y: Math.round(y - r), w: Math.round(2 * r), h: Math.round(2 * r) };
  const key = `${rect.x},${rect.y},${rect.w},${frame}`;
  if (key === hitSent) return;
  hitSent = key;
  desktop?.buddyHit?.(rect);
}
const frameOrigin = () => (frame === 'area' && liftedAt ? liftedAt.area : st.bounds || { x: screenX, y: screenY });
const toStage = (p) => {
  const o = frameOrigin();
  return p && { x: p.x - o.x, y: p.y - o.y };
};
function cursor() {
  document.body.style.cursor = press?.dragging ? 'grabbing' : hovering ? (st.prefs.throw && !reduceMotion ? 'grab' : 'pointer') : 'default';
}
addEventListener('mousemove', (e) => {
  if (!q) return;
  movedAt = performance.now();
  pointer = { x: e.screenX, y: e.screenY };
  if (!press) {
    q.setPointer({ x: e.clientX, y: e.clientY });
    setHover(!gone && dir.hit(e.clientX, e.clientY));
    cursor();
  }
});
addEventListener('mouseleave', () => {
  if (press) return;
  pointer = null;
  q?.setPointer(null);
  setHover(false);
  cursor();
});

// ---------- click, hold, drag, throw ----------
let press = null; // { id, x, y, t, off: { x, y } (pointer minus his centre), samples, dragging }
const canThrow = () => st.prefs.throw !== false && !reduceMotion;
let keepAliveAt = 0;
let returning = false; // landed away from his strip: on his way back

addEventListener('pointerdown', (e) => {
  // (On his way back to his strip too: a click still talks, and a press picks him up again.)
  if (e.button !== 0 || !q || gone || press) return;
  if (!dir.hit(e.clientX, e.clientY) && !th.flying) return;
  if (th.flying && !dir.hit(e.clientX, e.clientY)) return;
  try {
    document.documentElement.setPointerCapture(e.pointerId);
  } catch {}
  const cx = q._rx ?? q.cx;
  const cy = q._ry ?? q.ground - q.cy;
  press = { id: e.pointerId, x: e.screenX, y: e.screenY, t: e.timeStamp, off: { x: e.clientX - cx, y: e.clientY - cy }, samples: [{ x: e.screenX, y: e.screenY, t: e.timeStamp }], dragging: false, frame };
  setHover(true); // the window keeps the mouse for the whole press
  // Caught in the air: picked straight up.
  if (th.flying && canThrow()) pickUp();
});
addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  for (const c of e.getCoalescedEvents?.() || [e]) pushSample(press.samples, { x: c.screenX, y: c.screenY, t: c.timeStamp });
  pointer = { x: e.screenX, y: e.screenY };
  if (!press.dragging && canThrow() && pressKind({ dx: e.screenX - press.x, dy: e.screenY - press.y, ms: e.timeStamp - press.t }) === 'drag') pickUp();
  if (press.dragging) th.move(heldTarget());
});
addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const p = press;
  press = null;
  try {
    document.documentElement.releasePointerCapture(e.pointerId);
  } catch {}
  if (p.dragging) {
    pushSample(p.samples, { x: e.screenX, y: e.screenY, t: e.timeStamp });
    letGo(throwVelocity(p.samples, e.timeStamp, { windowMs: 80 }));
  } else {
    const kind = pressKind({ dx: e.screenX - p.x, dy: e.screenY - p.y, ms: e.timeStamp - p.t, released: true });
    if (kind === 'click' && st.prefs.clickTalk !== false) {
      // "Hey Orbit", with this window in front: the same wake path (see electron/main.js buddy:talk).
      desktop?.buddyTalk?.();
      dir.ack();
    } else dir.poke();
  }
  hoverNow();
  cursor();
});
addEventListener('pointercancel', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const p = press;
  press = null;
  if (p.dragging) letGo({ x: 0, y: 0 });
  hoverNow();
});
addEventListener('blur', () => {
  if (!press) return;
  const p = press;
  press = null;
  if (p.dragging) letGo({ x: 0, y: 0 });
  hoverNow();
});

/** Where the pointer wants his centre (stage px). */
function heldTarget() {
  const s = toStage(pointer);
  return s && { x: s.x - press.off.x, y: s.y - press.off.y };
}

function pickUp() {
  press.dragging = true;
  returning = false; // (picked up on his way back: that walk is over)
  th.hold(heldTarget());
  dir.grabbed();
  lift(true);
  cursor();
}

function letGo(v) {
  th.release(v);
  dir.thrown();
}

/** Ask Orbit for the work area (and keep asking now and then while he needs it), or give it back. */
function lift(on) {
  keepAliveAt = performance.now();
  desktop?.buddyLift?.(on);
}

/** He came down. On his strip: back to it (the window shrinks back). Elsewhere: he heads back. */
function landed(info) {
  const half = q.side / 2;
  const at = frame === 'area' && stage ? onStrip(stage, { x: q.cx, y: q.ground - q.sy, half }) : 'strip';
  const away = frame === 'area' && !at;
  const secs = dir.landed({ impact: info.impact, bounces: info.bounces, away });
  if (!away) return lift(false);
  // He shakes it off, then goes back to his strip by his own route (orbit-nav), from right here.
  returning = true;
  setTimeout(() => goBack(), Math.round(secs * 1000));
}

async function goBack() {
  if (!q || gone || frame !== 'area' || !stage || th.active) {
    returning = false;
    return;
  }
  await headBack(q, stage, { stillOk: () => !th.active && frame === 'area' && !!stage });
  if (th.active) return; // picked up again on the way
  returning = false;
  dir.homeAgain();
  lift(false);
}

/** After a release or landing: does the cursor still sit on him? (else the window lets clicks through) */
function hoverNow() {
  const s = toStage(pointer);
  setHover(!!s && !gone && !!q && dir.hit(s.x, s.y));
}

function frameTick(dt, now) {
  sendHit();
  // Held still a moment: picked up. (Event and frame times share one clock.)
  if (press && !press.dragging && canThrow() && pressKind({ ms: Math.max(0, now - press.t) }) === 'hold') pickUp();
  if (press?.dragging) th.move(heldTarget());
  if (!press && (th.active || returning || frame === 'area')) {
    hoverNow();
    if (pointer) {
      const s = toStage(pointer);
      q.setPointer(s);
    }
  }
  // Keep the work area while he needs it (Orbit drops it by itself if this page goes quiet).
  if ((th.active || returning || press?.dragging) && now - keepAliveAt > 4000) lift(true);
}

// ---------- from Orbit ----------
desktop?.onBuddyState?.((s) => {
  if (!s || typeof s !== 'object') return;
  const rect = (r) => (r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null);
  const brect = (r) => (r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
  const lift = s.lift && brect(s.lift.area) && brect(s.lift.strip) ? { area: brect(s.lift.area), strip: brect(s.lift.strip) } : null;
  const next = {
    voice: s.voice && typeof s.voice === 'object' ? s.voice : st.voice,
    box: 'box' in s ? rect(s.box) : st.box,
    send: 'send' in s ? rect(s.send) : st.send,
    boxKnown: !!s.boxKnown || st.boxKnown,
    scale: Number.isFinite(s.scale) ? s.scale : st.scale,
    visible: s.visible !== false,
    bounds: 'bounds' in s ? brect(s.bounds) : st.bounds,
    lift: 'lift' in s ? lift : st.lift,
    prefs: s.prefs && typeof s.prefs === 'object' ? { clickTalk: s.prefs.clickTalk !== false, throw: s.prefs.throw !== false } : st.prefs,
  };
  const geoChanged = JSON.stringify([next.box, next.send, next.scale, next.bounds && [next.bounds.width, next.bounds.height]]) !== JSON.stringify([st.box, st.send, st.scale, st.bounds && [st.bounds.width, st.bounds.height]]);
  const liftChanged = JSON.stringify(next.lift) !== JSON.stringify(st.lift);
  st = next;
  if (!q) {
    if (st.boxKnown) start();
    return;
  }
  dir.setVoice(st.voice);
  if (liftChanged || frame === 'area') syncFrame();
  else if (geoChanged) dir.setGeometry(geometry());
  // Orbit took the work area back (hidden, or he was up there too long): whatever he was doing ends.
  if (!st.lift && frame === 'strip' && (th.active || returning)) {
    if (th.held) th.release({ x: 0, y: 0 });
    returning = false;
  }
  setRunning(st.visible && !document.hidden);
});
desktop?.onBuddyEvent?.((name) => {
  if (name === 'enter') {
    if (q) dir.place({ entrance: true });
    else entrance = true;
  } else if (name === 'leave') {
    gone = true;
    press = null;
    setHover(false);
    mount.style.opacity = '0';
  } else if (typeof name === 'string' && q && !gone && !th.active) dir.event(name);
});

// The real cursor near his window, polled by Orbit (screen px; null: away). His eye follows it when
// no forwarded mouse moves are coming.
desktop?.onBuddyCursor?.((c) => {
  if (!q || press || performance.now() - movedAt < 300) return;
  pointer = c && Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: c.x, y: c.y } : null;
  q.setPointer(pointer ? toStage(pointer) : null);
});

// Something you asked him to do ("do a backflip"), by voice.
desktop?.onBuddyCommand?.((c) => {
  if (c && typeof c === 'object' && q && !gone && !th.active && !returning) dir.command({ action: String(c.action), dir: c.dir === 'left' || c.dir === 'right' ? c.dir : undefined });
});

// A feeling as the voice's words play ("<happy> Done!"): the main window times it to the audio.
desktop?.onBuddyEmote?.((name) => {
  if (typeof name === 'string' && q && !gone && !th.active) dir.emote(name);
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
  get throw() {
    return th;
  },
  get state() {
    return st;
  },
  get frame() {
    return frame;
  },
  get stage() {
    return stage;
  },
  get returning() {
    return returning;
  },
  get press() {
    return press ? { dragging: press.dragging } : null;
  },
  get hovering() {
    return hovering;
  },
  get running() {
    return running;
  },
  get lowPower() {
    return low;
  },
};
