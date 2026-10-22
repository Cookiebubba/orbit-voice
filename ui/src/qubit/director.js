// Qubit's director: turns Orbit's state into what Qubit does on the Claude window. No DOM here (the
// engine instance is passed in), so it runs in node for the tests, with the real engine.
//
// Two layers:
//   - A base state, from Orbit's voice state (see baseState): asleep, waking, listening, thinking,
//     speaking, waiting for a yes by Send, sending, watching Claude work, muted, a quiet call (idle,
//     where his seeded idle wander takes over), going to sleep. Entering one sets his mode (colour,
//     eye, idle loop) and, where it has a place, sends him there by the best route.
//   - Reactions to events, which run to the end (a couple of seconds at most) before the base state
//     takes over again: a draft (he goes to the text and follows it along), a send (he stomps
//     Claude's Send button), Claude finishing (he celebrates; asleep, he jolts awake and dozes off
//     again) and an error (red, a shiver).
// Mode changes always apply at once (a spring retarget, so they're smooth); only moves wait for a
// reaction to finish. Nothing new is drawn: only his engine's own modes and actions.
//
// Geometry is the avatar strip's CSS px (y down): the window's bottom edge is the floor, Claude's
// prompt box (when known) a solid block whose top he stands on, and Claude's Send button (when
// known) a spot on that top.

export const FLOOR = 3; // px between the floor line and the strip's bottom edge
export const QUIET_TO_IDLE_S = 8; // a call with nothing going on for this long: idle life takes over
const SIDES = { 1: 26, 2: 36, 3: 50 }; // body side (px) per avatar size setting

/** Qubit's side in px for the avatar size setting (1 tiny, 2 small, 3 big). */
export const sideFor = (scale) => SIDES[Math.round(Number(scale))] || SIDES[2];

/** His mode for each base state (the asleep and waking ones go through his sleep/wake actions). */
export const MODE_FOR = Object.freeze({
  asleep: 'asleep',
  sleepy: 'sleepy',
  waking: 'listening',
  listening: 'listening',
  speaking: 'speaking',
  thinking: 'thinking',
  confirm: 'curious',
  sending: 'happy',
  watching: 'focused',
  muted: 'idle',
  idle: 'idle',
});

/**
 * The base state for Orbit's voice state `v` ({ phase, asleep, hearing, muted, draft, sending,
 * claudeWorking }) after `quietFor` seconds of nothing happening in a call.
 */
export function baseState(v = {}, quietFor = 0) {
  switch (v.phase) {
    case 'connecting':
      return 'waking';
    case 'speaking':
      return 'speaking';
    case 'thinking':
      return 'thinking';
    case 'listening':
      if (v.asleep) return 'sleepy'; // going to sleep (or, one question at a time, mic closed)
      if (v.hearing) return 'listening';
      if (v.muted) return 'muted';
      if (v.sending) return 'sending';
      if (v.draft) return 'confirm'; // "Send it?": by the Send button, waiting for your yes
      if (v.claudeWorking) return 'watching';
      return quietFor >= QUIET_TO_IDLE_S ? 'idle' : 'listening';
    default:
      return 'asleep'; // off: hung up
  }
}

/**
 * Where things are, for a strip W x H with the prompt box `box` and Send button `send` (strip px,
 * either may be null) and a body side `side`. Points are { x, y, onBox } with y the surface's y.
 */
export function layout({ W, H, box, send, side }) {
  const ground = H - FLOOR;
  const half = side / 2;
  // A box he can stand on: wide enough, with room above it for him in the strip.
  const usable = box && box.w >= side * 1.6 && box.y > side * 1.2 && box.y < ground - 6 ? box : null;
  const floorX = (x) => Math.min(W - 8 - half, Math.max(8 + half, x));
  if (!usable) {
    const at = (fx) => ({ x: floorX(W * fx), y: ground, onBox: false });
    return { W, H, ground, side, box: null, send: null, solids: [], home: at(0.82), onBox: null, sendAt: null, confirm: at(0.76), watch: at(0.66), top: ground };
  }
  const b = usable;
  const onBox = (x) => ({ x: Math.min(b.x + b.w - side * 0.55, Math.max(b.x + side * 0.55, x)), y: b.y, onBox: true });
  // Claude's Send button: where UI Automation found it, else the right end of the box's text row
  // (where it appears once there is text; the box is padded 12 px each side).
  const sx = send && send.w > 0 ? send.x + send.w / 2 : b.x + b.w - 12 - 16;
  const sendAt = onBox(sx);
  return {
    W,
    H,
    ground,
    side,
    box: b,
    send: send || null,
    // The box is solid down to the floor (the gap under it is far too low for him).
    solids: [{ id: 'box', x: b.x, y: b.y, w: b.w, h: ground - b.y }],
    // His places are all near the Send end, so the moves between them are a few hops.
    home: onBox(b.x + b.w * 0.86),
    onBox,
    sendAt,
    confirm: onBox(sendAt.x - side * 1.4),
    watch: onBox(b.x + b.w * 0.66),
    top: b.y,
  };
}

/**
 * The director for one Qubit `q` (a QubitEngine instance). `setLowPower(on)` is told when nothing
 * is happening (asleep and still), so the page can drop to the engine's low-power frame rate.
 */
export function createDirector(q, { seed = 1, reduceMotion = false } = {}) {
  let t = 0;
  let v = { phase: 'off' };
  let geo = null;
  let state = null; // the base state whose entry has run
  let lastActive = 0;
  let react = null; // { kind, mode, until } while a reaction runs
  let sleeping = false; // the walk home and doze-off is under way
  let wander = false;
  let relocate = false; // the box moved (the window resized): back to his place once he's settled
  const log = []; // what it did, for tests and the e2e harness (state and reaction names only)
  const note = (what) => {
    log.push({ t: Math.round(t * 100) / 100, what });
    if (log.length > 200) log.shift();
  };

  const side = () => q.side;
  const asleepLike = () => q.mode === 'asleep' || q.mode === 'sleepy' || sleeping;
  const near = (p) => p && Math.abs(q.cx - p.x) < side() * 0.3 && Math.abs(q.ground - q.sy - p.y) < 2 && !q.air;

  /** Go to a point by the best route (his own hops and jumps). Queued unless `interrupt`. */
  function moveTo(p, { style = 'brisk', interrupt = true } = {}) {
    if (!p || (near(p) && interrupt && !q.busy)) return;
    q.goTo(p.x, p.y - 1, { style, interrupt });
  }

  function setWander(on) {
    on = on && !reduceMotion && !!geo;
    if (on === wander) return;
    wander = on;
    if (on) q.setWander(true, { seed, home: geo.home, quiet: 3, delay: 1.5, interests: interests() });
    else q.setWander(false);
  }
  const interests = () => (geo?.sendAt ? [{ x: geo.sendAt.x, y: geo.sendAt.y, kind: 'send', weight: 0.5 }] : []);

  /** Wake first if he's asleep (the lid lifts, a little hop), into this state's mode. */
  function wakeInto(mode) {
    sleeping = false;
    q.do('wake', { to: mode }, { interrupt: true });
  }

  /** Enter base state `s` (from `prev`). `motion: false`: mode only (a reaction owns his moves). */
  function enter(s, prev, { motion = true } = {}) {
    note(`state ${s}`);
    const g = geo;
    q.brainT.glance = s === 'watching' || s === 'confirm' ? 99 : Math.min(q.brainT.glance, 1.5);
    setWander(s !== 'muted');
    if (s === 'asleep') {
      if (!motion) return; // a reaction is on; he dozes off when it ends
      if (q.mode === 'asleep' && near(g?.home)) return;
      sleeping = true;
      if (q.mode !== 'asleep') q.setMode('sleepy');
      moveTo(g?.home, { style: 'amble' });
      q.do('sleep').then(() => (sleeping = false));
      return;
    }
    const mode = MODE_FOR[s];
    const wasAsleep = asleepLike();
    if (s === 'sleepy') {
      sleeping = false;
      if (q.mode !== 'asleep') q.setMode('sleepy');
      return;
    }
    if (wasAsleep && motion) wakeInto(mode);
    else if (q.mode !== mode || s === 'muted') q.setMode(mode);
    if (s === 'muted') {
      if (motion) q.do('shake', {}, { interrupt: !wasAsleep }); // not listening
      return;
    }
    if (prev === 'muted' && motion && (s === 'listening' || s === 'idle')) q.do('nod', {}, { interrupt: true }); // listening again
    if (!motion || !g) return;
    const queue = wasAsleep; // after the wake action
    if (s === 'confirm') {
      moveTo(g.confirm, { interrupt: !queue });
      q.do('glance', { x: 0.9, y: g.box ? 0.45 : 0, hold: 0.2 }); // at the Send button
    } else if (s === 'sending') {
      moveTo(g.sendAt || g.confirm, { interrupt: !queue });
    } else if (s === 'watching') {
      moveTo(g.watch, { style: 'amble', interrupt: !queue });
      q.do('glance', { x: -0.2, y: -0.9, hold: 0.2 }); // up at Claude's messages
    }
  }

  /** A reaction to an event (see the top). */
  function event(name) {
    if (!geo) return;
    const g = geo;
    const base = baseState(v, t - lastActive);
    lastActive = t;
    if (name === 'error') {
      note('react error');
      sleeping = false;
      react = { kind: 'error', mode: 'error', until: t + 2.2 };
      q.setMode('error');
      q.do('shiver', {}, { interrupt: true });
      return;
    }
    if (name === 'finished') {
      note('react finished');
      if (base === 'asleep' || base === 'sleepy') {
        // Asleep: a start, a celebration, and he dozes off again (when the reaction ends).
        react = { kind: 'finished', mode: null, until: t + 1 };
        wakeInto('happy');
        q.do('celebrate');
      } else {
        react = { kind: 'finished', mode: 'happy', until: t + 1.6 };
        q.setMode('happy');
        q.do('celebrate', {}, { interrupt: true });
      }
      return;
    }
    if (base === 'asleep') return; // drafts and sends only happen in a call
    if (name === 'draft' && g.box) {
      // He reads the draft as it goes into the box under him: onto the box (if he isn't on it), his
      // eye runs along the text from left to right, a hop along with it.
      note('react draft');
      react = { kind: 'draft', mode: null, until: t + 1 };
      const wasAsleep = asleepLike();
      if (wasAsleep) wakeInto(MODE_FOR[base]);
      const spot = g.onBox(Math.min(q.cx, g.box.x + g.box.w - side() * 2.2));
      moveTo(spot, { interrupt: !wasAsleep });
      const dir = 1;
      q.do('glance', { x: -0.75, y: 0.9, hold: 0.35 });
      q.do('glance', { x: -0.2, y: 1, hold: 0.3 });
      q.do('hop', { dir, dist: 0.4 });
      q.do('glance', { x: 0.4, y: 1, hold: 0.3 });
      q.do('hop', { dir, dist: 0.4 });
      q.do('glance', { x: 0.8, y: 0.8, hold: 0.25 });
      return;
    }
    if (name === 'sent') {
      // He stomps Claude's Send button: over to it (if he isn't there yet), a jump, the landing.
      note('react sent');
      react = { kind: 'sent', mode: 'happy', until: t + 0.8 };
      if (asleepLike()) wakeInto('happy');
      else q.setMode('happy');
      const at = g.sendAt;
      // (Already on his way there while it was being sent: the stomp follows that move.)
      const goingThere = at && q.task && q.taskName === 'goTo' && Math.abs((q.task.job.params.x ?? -1e9) - at.x) < 2;
      if (at && !near(at) && !goingThere) moveTo(at, { interrupt: !asleepLike() });
      q.do('pause', { secs: 0.06 });
      q.do('jump', { height: 1.1 });
      if (at) moveTo(g.confirm, { interrupt: false });
    }
  }

  return {
    /** Orbit's voice state (see baseState). */
    setVoice(next) {
      if (next && typeof next === 'object') v = next;
    },
    /** The strip's size and what's in it (strip px), and his size (side, px). */
    setGeometry({ W, H, box = null, send = null, side: S }) {
      const next = layout({ W, H, box, send, side: S });
      const prev = geo;
      // Standing on the box when it moves (it grows with a long draft, shrinks after a send): he rides it.
      const onBox = prev?.box && !q.air && !q.pivot && Math.abs(q.sy - (prev.ground - prev.box.y)) < 1.5;
      if (q.W !== W || q.H !== H || q.floor !== FLOOR) {
        q.resize(W, H, FLOOR);
      }
      q.bounds = [6, W - 6];
      if (S && S !== q.S) {
        // A new size grows (or shrinks) him there with a springy overshoot, like a power-up.
        const old = q.side;
        q.S = S;
        q.sp.grow.snap(old / S).to(1);
        q.nav = null; // the nav graph is for a body this size
      }
      // He can always jump onto the box, however tall it gets (a long draft makes it taller).
      const needUp = next.box ? next.ground - next.box.y + q.S * 0.6 : 0;
      const jumpUp = Math.max(q.S * 2.6, Math.min(needUp, H - q.S));
      if (!q.abilityOverrides || q.abilityOverrides.jumpUp !== jumpUp) {
        q.abilityOverrides = { jumpUp };
        q.nav = null;
      }
      if (prev && JSON.stringify(prev.box) !== JSON.stringify(next.box)) relocate = true;
      geo = next;
      q.setEnvironment({ solids: next.solids });
      if (onBox && next.box) {
        const top = next.ground - next.box.y;
        if (Math.abs(top - q.sy) > 0.5 && q.cx > next.box.x && q.cx < next.box.x + next.box.w) {
          q.sy = top;
          q.cy = top + q.side / 2;
        }
      } else if (next.box && !q.air && q.sy < 1 && q.cx + q.side / 2 > next.box.x && q.cx - q.side / 2 < next.box.x + next.box.w) {
        // The box turned up where he stood on the floor: it scoops him up onto its top.
        q.sy = next.ground - next.box.y;
        q.cy = q.sy + q.side / 2;
      }
      if (q.wander) {
        q.wander.planner.setHome(next.home);
        q.wander.planner.setInterests(interests());
      }
    },
    /** Put him in place for the first time: at home, in his state (or dropping in, on a live switch). */
    place({ entrance = false } = {}) {
      const g = geo;
      const s = baseState(v, 0);
      q.cx = g.home.x;
      if (entrance && !reduceMotion) {
        // He drops in from the top of the strip and lands (then gets on with whatever's going on).
        q.setMode('idle', { instant: true });
        q.air = true;
        q.vy = 0;
        q.vx = 0;
        q.cy = Math.max(g.ground - g.top + q.side, q.H - FLOOR - q.side * 0.7);
        state = null;
        react = { kind: 'enter', mode: null, until: t + 0.9 };
        note('enter');
        return;
      }
      q.sy = g.ground - g.home.y;
      q.cy = q.sy + q.side / 2;
      q.air = false;
      const mode = s === 'asleep' ? 'asleep' : MODE_FOR[s];
      q.setMode(mode, { instant: true });
      state = s;
      lastActive = t;
      setWander(s !== 'muted');
      note(`place ${s}`);
    },
    event,
    /** One frame (after the engine's own update). */
    tick(dt) {
      t += dt;
      q.setLevels(v.muted ? 0 : Number(v.input) || 0, Number(v.output) || 0);
      if (v.phase !== 'listening' || v.hearing || v.draft || v.sending || v.claudeWorking || v.asleep || v.muted) lastActive = t;
      const s = baseState(v, t - lastActive);
      if (react) {
        if (t < react.until || q.busy || q.air || q.pivot) {
          // Modes still follow the state while a reaction without its own mode runs.
          if (s !== state) {
            const prev = state;
            state = s;
            if (!react.mode) enter(s, prev, { motion: false });
          }
          return;
        }
        note(`end ${react.kind}`);
        react = null;
        const prev = state;
        state = s;
        return enter(s, prev === s ? 'reaction' : prev);
      }
      if (s !== state) {
        const prev = state;
        state = s;
        enter(s, prev);
      } else if (relocate && !q.air && !q.pivot && !q.busy) {
        // The window changed under him: back to his place (asleep, he sleepwalks there).
        relocate = false;
        const place = { asleep: geo.home, confirm: geo.confirm, sending: geo.sendAt, watching: geo.watch }[s];
        if (place && !near(place)) {
          note('relocate');
          enter(s, 'relocate');
        }
      }
    },
    /** A click on him: a little reaction (asleep, he stirs and dozes off again). */
    poke() {
      if (!geo || react) return;
      if (asleepLike()) {
        react = { kind: 'poke', mode: null, until: t + 0.5 };
        q.do('wake', { to: 'sleepy' }, { interrupt: true });
        return;
      }
      const all = ['wonder', 'hopInPlace', 'doubleBlink'];
      q.do(all[Math.floor(Math.random() * all.length)], {}, { interrupt: true });
    },
    /** Is (x, y) (strip px) on him? */
    hit(x, y) {
      const cx = q._rx ?? q.cx;
      const cy = q._ry ?? q.ground - q.cy;
      return Math.abs(x - cx) < q.side * 0.6 && Math.abs(y - cy) < q.side * 0.6;
    },
    /** Nothing is happening: asleep, settled and still (the page drops to low power). */
    lowPower() {
      return q.mode === 'asleep' && !q.task && !q.queue.length && !q.air && !q.pivot && !react;
    },
    get state() {
      return state;
    },
    get reaction() {
      return react?.kind || null;
    },
    get geometry() {
      return geo;
    },
    get log() {
      return log;
    },
  };
}
