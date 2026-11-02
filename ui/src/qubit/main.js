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
//   - a double-click opens settings without starting voice; the adjacent microphone control starts
//     or stops voice explicitly, and right-click keeps the orb's original sleep/wake action;
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
import { bodyExtents, createThrow, headBack } from './throw.js';
import { createRoamClassifier } from './roam.js';
import { createAvatarClicks } from '../buddy/interactions.js';
import { createVoiceControl } from './controls.js';
import { liftedStage, onStrip, pressKind, pushSample, throwSoundFor, throwVelocity } from '../buddy/throw.js';

const E = window.QubitEngine;
const desktop = window.desktop;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FADE_MS = 280;

document.documentElement.style.background = 'transparent';
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden;touch-action:none;user-select:none';
const mount = document.createElement('div');
Object.assign(mount.style, { position: 'fixed', inset: '0', opacity: '0', transition: `opacity ${FADE_MS}ms ease` });
document.body.appendChild(mount);
const voiceControl = createVoiceControl({ desktop });

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
let movementFrame = null;
const roam = createRoamClassifier();
const isAuto = () => st.stage?.automatic === true;
const revision = () => st.stage?.revision || 0;
const autoSolids = () => {
  const s = st.stage;
  return s?.automatic && !s.eligible && s.hostRegion ? [{ id: '__excluded', ...s.hostRegion, noTop: true }] : s?.solids || [];
};

const stripSize = () => (st.bounds ? { W: st.bounds.width, H: st.bounds.height } : { W: innerWidth, H: innerHeight });
const geometry = () => ({ ...stripSize(), box: st.box, send: st.send, side: sideFor(st.scale), stage: st.stageEnabled ? st.stage || { persistent: true, solids: [] } : null });

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
  if (st.stageEnabled) { frame = isAuto() ? 'auto' : 'client'; stage = { ...st.stage, ground: q.ground }; th.setSolids(isAuto() ? autoSolids() : dir.geometry.solids, { continuous: true, automatic: isAuto(), forbidden: isAuto() && !st.stage.eligible ? st.stage.hostRegion : null }); movementFrame = st.stage; }
  dir.place({ entrance });
  if (isAuto()) { syncFrame(); classify(true); }
  entrance = false;
  E.ticker.hooks.add((dt, now) => {
    dir.tick(dt);
    frameTick(dt, now);
    setLow(dir.lowPower() && !th.active && !press && (frame === 'strip' || frame === 'client' || frame === 'auto'));
  });
  setRunning(st.visible && !document.hidden);
  requestAnimationFrame(() => (mount.style.opacity = '1'));
}
setTimeout(start, 2500); // the box never turned up: the floor will do
// His rect and press state, every half second on a timer of their own: it never waits on a frame
// being drawn (Chromium stops drawing a window it thinks is covered, and a frame hook that throws
// would stop it too). Orbit forgets a rect it hasn't heard for 3 s.
setInterval(() => sendHit(performance.now()), 500);

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
  if (st.stageEnabled) {
    // Stage invalidation clears colliders even when Chromium has not resized its viewport yet.
    if (!st.stage) { dir.setGeometry(geometry(), { manual: true }); th.setSolids([]); stage = null; return; }
    if (!sameSize(st.bounds)) return;
    if (isAuto()) {
      const oldEx = bodyExtents(q).x;
      const priorSupport = !th.active && !q.air && dir.geometry?.solids.find((s) => !s.noTop && Math.abs(q.ground - q.sy - s.y) < 2 && q.cx + oldEx > s.x && q.cx - oldEx < s.x + s.w);
      if (movementFrame?.automatic && st.stage.recovery !== movementFrame.recovery) {
        finishPress(null, { cancel: true }); th.recover(); dir.homeAgain();
      }
      if (movementFrame?.origin) {
        const shift = { x: movementFrame.origin.x - st.stage.origin.x, y: movementFrame.origin.y - st.stage.origin.y };
        if (shift.x || shift.y || q.W !== st.bounds.width || q.H !== st.bounds.height) th.reframe({ shift, W: st.bounds.width, H: st.bounds.height, floor: FLOOR });
      }
      frame = 'auto'; returning = false; liftedAt = null;
      const ex = bodyExtents(q).x;
      const support = !th.active && !q.air && dir.geometry?.solids.find((s) => !s.noTop && Math.abs(q.ground - q.sy - s.y) < 2 && q.cx + ex > s.x && q.cx - ex < s.x + s.w);
      dir.setGeometry({ ...geometry(), stage: { ...st.stage, solids: autoSolids() } }, { manual: th.active || !!press });
      const list = th.setSolids(autoSolids(), { continuous: true, automatic: true, preserveSupport: !q.air ? (support || priorSupport)?.id : null, forbidden: !st.stage.eligible ? st.stage.hostRegion : null });
      if (JSON.stringify(list) !== JSON.stringify(dir.geometry.solids)) dir.setGeometry({ ...geometry(), stage: { ...st.stage, solids: list } }, { keepBody: true, manual: true });
      stage = { ...st.stage, solids: list, ground: q.ground };
      movementFrame = st.stage;
      return;
    }
    if (th.active && (q.W !== st.bounds.width || q.H !== st.bounds.height)) th.reframe({ shift: { x: 0, y: 0 }, W: st.bounds.width, H: st.bounds.height, floor: FLOOR });
    frame = 'client';
    liftedAt = null;
    returning = false;
    dir.setGeometry(geometry(), { manual: th.active || !!press });
    stage = { ...dir.geometry, persistent: true };
    th.setSolids(stage.solids, { continuous: true });
    return;
  }
  if (frame === 'client' || frame === 'auto') {
    finishPress(null, { cancel: true });
    movementFrame = null;
    // Capability withdrawal returns to honest window-only behavior, with no client colliders left.
    frame = 'strip'; stage = null; liftedAt = null; returning = false;
    if (th.held) th.release({ x: 0, y: 0 });
    dir.setGeometry(geometry());
    th.setSolids(dir.geometry.solids);
    dir.place();
    return;
  }
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
let hitSentAt = 0;
let hoverSentAt = 0;
/** How far from his centre a press counts as on him (px): the same for Orbit's check and this page's. */
const hitR = () => Math.max(q.side * 0.62, 18);
const onHim = (x, y) => {
  const cx = q._rx ?? q.cx;
  const cy = q._ry ?? q.ground - q.cy;
  const r = hitR();
  return Math.abs(x - cx) <= r && Math.abs(y - cy) <= r;
};
/** A press's outcome, for Orbit's log (fixed words only, rate-limited there). */
const pressLog = (outcome, why = '') => desktop?.buddyPress?.(outcome, why);
let settingsOpenedAt = -Infinity;
function openSettings() {
  if (performance.now() - settingsOpenedAt < 500) return;
  settingsOpenedAt = performance.now();
  pressLog('click', 'settings'); desktop?.buddySettings?.();
}
const clicks = createAvatarClicks({
  single: () => {
    if (gone) return;
    pressLog('click', st.prefs.clickTalk !== false ? 'talk' : 'poke');
    if (st.prefs.clickTalk !== false) { desktop?.buddyTalk?.(); dir?.ack(); }
    else dir?.poke();
  },
  double: openSettings,
});
/**
 * His rect in this window's px, for Orbit's own hover check: when it changes, and every half second
 * anyway (Orbit forgets a rect it hasn't heard for 3 s, so nothing it was told can go stale). The
 * press state rides the same heartbeat.
 */
function sendHit(now = performance.now()) {
  if (!q || gone) return;
  const r = hitR();
  const x = q._rx ?? q.cx;
  const y = q._ry ?? q.ground - q.cy;
  const control = voiceControl.update(st.voice, { x, y, radius: r, width: innerWidth, height: innerHeight, visible: st.visible && !th.blocked, held: !!press?.dragging, hovering, now });
  const rect = { x: Math.round(x - r), y: Math.round(y - r), w: Math.round(2 * r), h: Math.round(2 * r), revision: revision(), controls: control ? [control] : [] };
  const key = JSON.stringify([rect, frame, th.blocked]);
  if (key !== hitSent || now - hitSentAt > 500) {
    hitSent = key;
    hitSentAt = now;
    desktop?.buddyHit?.(th.blocked ? null : rect);
  }
  if (now - hoverSentAt > 500) {
    hoverSentAt = now;
    desktop?.buddyHover?.(hovering, !!press);
  }
}
const frameOrigin = () => (frame === 'area' && liftedAt ? liftedAt.area : st.bounds || { x: screenX, y: screenY });
const toStage = (p) => {
  const o = frameOrigin();
  return p && { x: p.x - o.x, y: p.y - o.y };
};
function cursor() {
  document.body.style.cursor = press?.dragging ? 'grabbing' : hovering ? (st.prefs.throw ? 'grab' : 'pointer') : 'default';
}
addEventListener('mousemove', (e) => {
  if (!q) return;
  movedAt = performance.now();
  pointer = { x: e.screenX, y: e.screenY };
  if (press) movePress(e);
  if (!press) {
    q.setPointer({ x: e.clientX, y: e.clientY });
    setHover(!gone && onHim(e.clientX, e.clientY));
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
let nextGesture = 1;
const canThrow = () => st.prefs.throw !== false;
let keepAliveAt = 0;
let returning = false; // landed away from his strip: on his way back

addEventListener('pointerdown', (e) => {
  if (e.target?.closest?.('[data-avatar-control]')) return;
  // (On his way back to his strip too: a click still talks, and a press picks him up again.)
  if (e.button !== 0 || !q) return;
  // Only a new primary down may supersede a lost old press, never a secondary-button event.
  if (press && e.pointerId === press.id && e.timeStamp >= press.t) finishPress(null, { cancel: true });
  if (gone) return pressLog('ignored', 'leaving');
  if (press) return pressLog('ignored', 'press-already');
  if (!onHim(e.clientX, e.clientY)) return pressLog('ignored', 'not-on-him');
  clicks.begin();
  try {
    document.documentElement.setPointerCapture(e.pointerId);
  } catch {}
  const cx = q._rx ?? q.cx;
  const cy = q._ry ?? q.ground - q.cy;
  press = { id: e.pointerId, x: e.screenX, y: e.screenY, t: e.timeStamp, off: { x: e.clientX - cx, y: e.clientY - cy }, samples: [{ x: e.screenX, y: e.screenY, t: e.timeStamp }], dragging: false, frame, gesture: nextGesture++, sequence: 0, fallback: false, nativeAt: performance.now(), domAt: performance.now(), nativeLost: false, keepAt: 0, upTimer: null };
  pointer = { x: e.screenX, y: e.screenY };
  desktop?.buddyGesture?.({ phase: 'begin', id: press.gesture, revision: revision() });
  setHover(true); // the window keeps the mouse for the whole press
  // Caught in the air: picked straight up.
  if (th.flying && canThrow()) pickUp();
});
addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id || e.timeStamp < press.t) return;
  movePress(e);
});
function movePress(e) {
  if (!press || e.timeStamp < press.t) return;
  // (No "button is up" guess from a move here: a move reporting no button can arrive mid-press, and
  // ending the press on it meant no press ever became a pickup. A press whose pointerup was lost is
  // cleared by the next press instead, and Orbit lets go of a press it stops hearing about.)
  const now = performance.now(); press.domAt = now;
  if (now - press.keepAt > 100) { press.keepAt = now; desktop?.buddyGesture?.({ phase: 'update', id: press.gesture, revision: revision() }); }
  const coalesced = e.getCoalescedEvents?.();
  for (const c of coalesced?.length ? coalesced : [e]) pushSample(press.samples, { x: c.screenX, y: c.screenY, t: c.timeStamp });
  pointer = { x: e.screenX, y: e.screenY };
  if (!press.dragging && canThrow() && pressKind({ dx: e.screenX - press.x, dy: e.screenY - press.y, ms: e.timeStamp - press.t }) === 'drag') pickUp();
  if (press.dragging) th.move(heldTarget());
}
addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.id || e.timeStamp < press.t) return;
  finishPress(e);
});
addEventListener('dblclick', (event) => {
  if (event.target?.closest?.('[data-avatar-control]') || !q || !onHim(event.clientX, event.clientY)) return;
  clicks.cancel(); openSettings();
});
addEventListener('contextmenu', (event) => {
  if (event.target?.closest?.('[data-avatar-control]') || !q || !onHim(event.clientX, event.clientY)) return;
  event.preventDefault(); clicks.cancel(); desktop?.orbAction?.('toggle-sleep');
});
function finishPress(e, { cancel = false, native = false } = {}) {
  const p = press;
  if (!p) return false;
  press = null; // exactly once, before releasePointerCapture can dispatch lostcapture
  clearTimeout(p.upTimer);
  desktop?.buddyGesture?.({ phase: 'end', id: p.gesture, revision: revision() });
  try {
    document.documentElement.releasePointerCapture(p.id);
  } catch {}
  const fallback = cancel || native || p.fallback;
  if (p.dragging) {
    if (e && !cancel) pushSample(p.samples, { x: e.screenX, y: e.screenY, t: e.timeStamp });
    letGo(cancel ? { x: 0, y: 0 } : throwVelocity(p.samples, e?.timeStamp ?? performance.now(), { windowMs: 80 }));
  } else if (!fallback && e) {
    const kind = pressKind({ dx: e.screenX - p.x, dy: e.screenY - p.y, ms: e.timeStamp - p.t, released: true });
    if (kind === 'click') clicks.click({ x: e.screenX, y: e.screenY });
    else {
      clicks.cancel();
      pressLog('click', kind === 'click' ? 'poke' : !canThrow() ? 'throw-off' : 'too-long-for-a-click');
      dir.poke();
    }
  }
  if (fallback) clicks.cancel();
  hoverNow();
  cursor();
  return true;
}
function captureLost(e) {
  if (!press || e?.pointerId != null && e.pointerId !== press.id || e?.timeStamp != null && e.timeStamp < press.t) return;
  press.fallback = true;
  // With the button physically down, continue the same gesture from native samples. Otherwise
  // native-confirmed up/stale failure finishes it. Never infer a click or synthesize a press.
  if (!desktop?.buddyGesture || press.nativeLost) finishPress(null, { cancel: true });
}
addEventListener('pointercancel', captureLost);
addEventListener('lostpointercapture', captureLost, true);
addEventListener('blur', captureLost);
desktop?.onBuddyGesture?.((sample) => {
  const p = press;
  if (!p || !sample || sample.id !== p.gesture || sample.revision !== revision() || !Number.isSafeInteger(sample.sequence) || sample.sequence <= p.sequence) return;
  p.sequence = sample.sequence; p.nativeAt = performance.now();
  clicks.setDelay(sample.doubleClickMs);
  if (sample.trackingLost) { p.nativeLost = true; if (p.fallback) finishPress(null, { cancel: true }); return; }
  if (sample.cancel) return finishPress(null, { cancel: true });
  if (![sample.x, sample.y].every(Number.isFinite) || typeof sample.down !== 'boolean') return;
  const now = performance.now();
  if (!sample.down) {
    // Let Chromium deliver its real pointerup before falling back to native release.
    clearTimeout(p.upTimer);
    p.upTimer = setTimeout(() => { if (press === p) finishPress({ screenX: sample.x, screenY: sample.y, timeStamp: performance.now() }, { native: true }); }, 75);
    return;
  }
  if (!p.fallback && now - p.domAt < 80) return;
  pointer = { x: sample.x, y: sample.y };
  pushSample(p.samples, { ...pointer, t: now });
  if (!p.dragging && canThrow() && pressKind({ dx: sample.x - p.x, dy: sample.y - p.y, ms: now - p.t }) === 'drag') pickUp();
  if (p.dragging) th.move(heldTarget());
});

/** Where the pointer wants his centre (stage px). */
function heldTarget() {
  const s = toStage(pointer);
  return s && { x: s.x - press.off.x, y: s.y - press.off.y };
}

function pickUp(how = 'drag') {
  clicks.cancel();
  pressLog('pickup', how);
  press.dragging = true;
  returning = false; // (picked up on his way back: that walk is over)
  th.hold(heldTarget());
  dir.grabbed();
  lift(true);
  cursor();
}

function letGo(v) {
  if (reduceMotion) v = { x: 0, y: 0 };
  // A real throw (not a put-down): "Wheee!" (played by Orbit's main window, at the voice volume).
  if (throwSoundFor(v, q.side, st.prefs)) desktop?.buddySound?.('throw');
  th.release(v);
  dir.thrown();
}

/** Ask Orbit for the work area (and keep asking now and then while he needs it), or give it back. */
function lift(on) {
  if (st.stageEnabled) return;
  keepAliveAt = performance.now();
  desktop?.buddyLift?.(on);
}

/** He came down. On his strip: back to it (the window shrinks back). Elsewhere: he heads back. */
function landed(info) {
  const half = bodyExtents(q).x;
  if (frame === 'client' || frame === 'auto') { returning = false; dir.landed({ impact: info.impact, bounces: info.bounces, away: false }); return; }
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
  setHover(!!s && !gone && !!q && onHim(s.x, s.y));
}

let stuckSince = 0; // a throw or walk back that never ends (it can't: it's ended here after 25 s)
function classify(initialize = false) {
  if (!isAuto() || !q) return;
  const e = bodyExtents(q);
  roam.update({ region: st.stage.hostRegion, eligible: st.stage.eligible, identity: st.stage.identity, body: { x: q.cx, y: q.ground - q.cy, ex: e.x, ey: e.y }, pointer: press?.dragging ? toStage(pointer) : null, initialize });
}
function frameTick(dt, now) {
  if (isAuto()) {
    classify();
    mount.style.visibility = th.blocked ? 'hidden' : 'visible';
    const list = th.solids;
    if (JSON.stringify(list) !== JSON.stringify(dir.geometry.solids)) dir.setGeometry({ ...geometry(), stage: { ...st.stage, solids: list } }, { keepBody: true, manual: true });
  }
  if (press?.fallback && desktop?.buddyGesture && now - press.nativeAt > 1100) finishPress(null, { cancel: true });
  sendHit(now);
  if (!isAuto() && (th.active || returning) && !press) {
    stuckSince ||= now;
    if (now - stuckSince > 25_000) {
      stuckSince = 0;
      if (th.held) th.release({ x: 0, y: 0 });
      returning = false;
      dir.homeAgain();
      lift(false);
    }
  } else stuckSince = 0;
  // Held still a moment: picked up. (Event and frame times share one clock.)
  if (press && !press.dragging && canThrow() && pressKind({ ms: Math.max(0, now - press.t) }) === 'hold') pickUp('hold');
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
    stageEnabled: s.stageEnabled === true,
    stage: s.stage?.persistent && Array.isArray(s.stage.solids) ? s.stage : null,
    prefs: s.prefs && typeof s.prefs === 'object' ? { clickTalk: s.prefs.clickTalk !== false, throw: s.prefs.throw !== false, throwSound: s.prefs.throwSound !== false } : st.prefs,
  };
  if (next.stage?.automatic && st.stage?.automatic && next.stage.revision < st.stage.revision) return;
  const geoChanged = JSON.stringify([next.box, next.send, next.scale, next.bounds && [next.bounds.width, next.bounds.height]]) !== JSON.stringify([st.box, st.send, st.scale, st.bounds && [st.bounds.width, st.bounds.height]]);
  const liftChanged = JSON.stringify(next.lift) !== JSON.stringify(st.lift);
  const stageChanged = next.stageEnabled !== st.stageEnabled || JSON.stringify(next.stage) !== JSON.stringify(st.stage);
  st = next;
  if (!q) {
    if (st.boxKnown) start();
    return;
  }
  dir.setVoice(st.voice);
  if (stageChanged || st.stageEnabled && geoChanged || liftChanged || frame === 'area') syncFrame();
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
    clicks.cancel();
    voiceControl.hide();
    gone = true;
    finishPress(null, { cancel: true });
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
  get domain() { return roam.domain; },
  get movementFrame() { return movementFrame; },
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
