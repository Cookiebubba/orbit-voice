// Qubit's director: turns Orbit's state into what Qubit does on the Claude window. No DOM here (the
// engine instance is passed in), so it runs in node for the tests, with the real engine.
//
// Two layers:
//   - A base state, from Orbit's voice state (see baseState): asleep, waking, listening, thinking,
//     speaking, waiting for a yes by Send, sending, watching Claude work, muted, a quiet call (idle,
//     where his seeded idle wander takes over), going to sleep. Entering one sets his mode (colour,
//     eye, idle loop) and, where it has a place, sends him there by the best route.
//   - His own life, while Orbit is off or asleep (nobody is talking to him): he dozes off, and after
//     a few seconds gets up and lives (see LIFE): wanders the prompt box and the floor, hops, rolls,
//     practises his flips, looks about, and takes the odd nap, all seeded so it never loops. The
//     longer nothing happens, the longer his naps, until he sleeps for good (CPU: asleep and still,
//     the page drops to low power). Anything real (the wake word, a call, Claude finishing) wins at
//     once, from wherever he is: a mode change is a spring retarget, and a move in progress is cut
//     short (physics lands him), so the hand-off is smooth.
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

/**
 * What he can be asked to do (src/avatar-commands.js AVATAR_ACTIONS for Qubit): "do a backflip".
 * A command overrides idle life and whatever he's doing (his engine takes over from where he is, so
 * it's smooth), and Orbit's own state waits for it like a reaction, then takes over again.
 */
export const COMMANDS = Object.freeze(['backflip', 'frontflip', 'roll', 'jump', 'hop', 'grow', 'shrink', 'celebrate', 'dance', 'nod', 'shake', 'look_around', 'stretch', 'blink', 'happy', 'sad', 'surprised', 'curious', 'move', 'go_home', 'nap', 'wake']);
export const COMMAND_TIMES = Object.freeze({ dance: 6, mood: 4, nap: 12, grow: 15 }); // seconds: dancing, a mood, a nap, staying big

/**
 * His own life (Orbit off or asleep), in seconds ([min, max] are drawn from his seed): the doze
 * before he gets up, how long he's up between naps, and the naps. After `tiredS` with nothing
 * happening (no call, no cursor near him, nothing from Claude) his naps get long; after `nightS`
 * he sleeps until something happens.
 */
export const LIFE = Object.freeze({ dozeS: [5, 9], awakeS: [40, 100], napS: [6, 15], tiredS: 600, tiredNapS: [40, 90], nightS: 1800 });
/** How he is when he's up and about on his own: livelier than in a quiet call (OrbitNav temperament). */
export const LIVELY = Object.freeze({ energy: 1, curiosity: 0.55, sociability: 0.5, boldness: 0.8, playfulness: 1, patience: 0, homebody: 0.25 });
/** ...and what he leans toward: more play and shorter walks, fewer long rests (OrbitNav idle bias). */
export const LIFE_BIAS = Object.freeze({ fidget: 2.4, rest: 0.55, look: 0.7, explore: 0.55, go: 1.1 });
/** What he does on the spot when he's up (his engine's own actions; tricks scale with playfulness). */
export const LIFE_FIDGETS = Object.freeze([
  { name: 'hopInPlace', weight: 1.1 },
  { name: 'lookAround', weight: 0.9 },
  { name: 'wonder', weight: 0.6 },
  { name: 'eyeMorph', weight: 0.5 },
  { name: 'eyeTurn', weight: 0.45 },
  { name: 'stretch', weight: 0.45 },
  { name: 'doubleBlink', weight: 0.35 },
  { name: 'flip', weight: 0.75, trick: true, params: { outcome: 'auto' } }, // practising (mostly misses)
  { name: 'roll', weight: 0.55, trick: true },
  { name: 'jump', weight: 0.45, trick: true },
]);

/** A small seeded random source (mulberry32): his life's timing is reproducible per seed. */
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Feelings while he talks: the voice's emote cues (src/emote-cues.js CUES), each one of his own moods
 * for a moment (`mode`, `hold` seconds; his eye stays his mouth) and/or one of his own moves in
 * place (`act`). They fire as the words play (ui/src/emote-sync.js) and he returns to speaking.
 */
export const EMOTES = Object.freeze({
  happy: { mode: 'happy', act: 'hopInPlace', hold: 1.3 },
  excited: { act: 'celebrate', hold: 1.6 },
  curious: { mode: 'curious', hold: 1.4 },
  surprised: { mode: 'surprised', hold: 0.9 },
  proud: { mode: 'happy', act: 'stretch', hold: 1.3 },
  sad: { mode: 'sad', hold: 1.6 },
  embarrassed: { mode: 'embarrassed', hold: 1.4 },
  nod: { act: 'nod', hold: 0.6 },
  shake: { act: 'shake', hold: 0.7 },
  wonder: { act: 'wonder', hold: 1.1 },
  hop: { act: 'hopInPlace', hold: 0.6 },
});
const EMOTE_ACTS = new Set(Object.values(EMOTES).map((e) => e.act).filter(Boolean));

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
export function createDirector(q, { seed = 1, reduceMotion = false, life: lifeTiming = {} } = {}) {
  let t = 0;
  let v = { phase: 'off' };
  let geo = null;
  let state = null; // the base state whose entry has run
  let lastActive = 0;
  let react = null; // { kind, mode, until } while a reaction runs
  let sleeping = false; // the walk home and doze-off is under way
  let wander = null; // the idle wander that's on: null, 'calm' (a quiet call) or 'life' (his own life)
  let relocate = false; // the box moved (the window resized): back to his place once he's settled
  let grownUntil = 0; // "get bigger": he shrinks back by himself then
  // His own life (Orbit off or asleep): { phase: 'doze' | 'stir' | 'up' | 'nap', until }. `until` is
  // null while he's still dozing off (it starts once he's asleep and still).
  let life = null;
  const timing = { ...LIFE, ...lifeTiming };
  const lifeRand = rng(seed * 2654435761 + 17);
  const draw = ([a, b]) => a + (b - a) * lifeRand();
  let seenAt = 0; // the last time anything happened (for how tired he gets)
  let lastPointer = null;
  let lives = 0;
  let feel = null; // a feeling while he talks: { name, mode, until } // a new idle planner each time his life starts, each with its own seed
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
    // A long way (his own life took him off to the far end): his bolder gait, so he gets there in time.
    if (style === 'brisk' && Math.abs(q.cx - p.x) > side() * 8) style = 'bold';
    q.goTo(p.x, p.y - 1, { style, interrupt });
  }

  /** Idle wander off (null), calm (a quiet call) or lively (his own life). */
  function setWander(kind) {
    kind = kind && !reduceMotion && geo ? kind : null;
    if (kind === wander) return;
    wander = kind;
    if (kind === 'life') q.setWander(true, { seed: seed + 1 + 7919 * lives++, home: geo.home, quiet: 1.1, delay: 0.6, temperament: LIVELY, fidgets: LIFE_FIDGETS, bias: LIFE_BIAS, interests: interests(), cursorWeight: 0.9 });
    else if (kind) q.setWander(true, { seed, home: geo.home, quiet: 3, delay: 1.5, interests: interests() });
    else q.setWander(false);
  }
  const interests = () => (geo?.sendAt ? [{ x: geo.sendAt.x, y: geo.sendAt.y, kind: 'send', weight: 0.5 }] : []);

  // ---- his own life ----
  const lifeState = (s) => s === 'asleep' || s === 'sleepy';
  const lifeOn = () => !reduceMotion && !!geo;
  /** Off to sleep (from wherever he is, or home first): a doze, or a nap in the middle of his day. */
  function doze(phase, { home = false } = {}) {
    life = { phase, until: null };
    sleeping = true;
    if (q.mode !== 'asleep') q.setMode('sleepy');
    if (home) moveTo(geo?.home, { style: 'amble' });
    q.do('sleep').then(() => (sleeping = false));
  }
  /** He wakes by himself: his lid lifts, a blink or two, a stretch, and he's up. */
  function stir() {
    note('life stir');
    life = { phase: 'stir', until: t + 1.1 };
    q.setMode('sleepy');
    q.do('doubleBlink', { axis: 'h' }, { interrupt: true });
  }
  function getUp() {
    note('life up');
    life = { phase: 'up', until: t + draw(timing.awakeS) };
    q.setMode('idle');
    q.do('stretch');
    setWander('life');
  }
  /** One frame of his own life (only while Orbit is off or asleep, and nothing else is on). */
  function liveTick() {
    if (!life) return;
    const still = !q.air && !q.pivot && !q.busy;
    const idleFor = t - seenAt;
    if (life.phase === 'doze' || life.phase === 'nap') {
      if (q.mode !== 'asleep' && still && !sleeping && !q.task) return doze(life.phase); // (his doze-off was cut short)
      if (q.mode !== 'asleep' || !still || sleeping) return;
      if (life.until == null) {
        // He's asleep now: how long for (naps get longer as he tires; at night, until something happens).
        const tired = idleFor > timing.tiredS;
        life.until = idleFor > timing.nightS ? Infinity : t + draw(life.phase === 'nap' && tired ? timing.tiredNapS : life.phase === 'nap' ? timing.napS : timing.dozeS);
        note(`life ${life.phase} ${Number.isFinite(life.until) ? Math.round(life.until - t) + 's' : 'for the night'}`);
      } else if (t >= life.until) stir();
    } else if (life.phase === 'stir') {
      if (t >= life.until && still) getUp();
    } else if (life.phase === 'up') {
      if (q.mode !== 'idle' && still && !q.task) q.setMode('idle'); // (back from a flip's embarrassment)
      if (t >= life.until && still) {
        note('life nap');
        doze('nap', { home: lifeRand() < 0.35 }); // (his wander waits: asleep, it doesn't run)
      }
    }
  }
  /** Something happened (a call, Claude, the cursor near him): he isn't tired, and at night he wakes. */
  function seen() {
    seenAt = t;
    if (life && (life.phase === 'doze' || life.phase === 'nap') && life.until === Infinity) life.until = t + 1.5;
  }

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
    if (lifeState(s) && lifeOn()) {
      // Orbit is off or asleep: his own life. Back from a reaction (Claude finished, a poke) while
      // he's up and about, he carries on; otherwise he dozes off (at home, if Orbit just hung up).
      if (!motion) return; // a reaction is on; this runs when it ends
      if (life && (life.phase === 'up' || life.phase === 'stir') && (prev === 'reaction' || prev === 'relocate')) {
        if (life.phase === 'stir') return getUp();
        if (q.mode !== 'idle') q.setMode('idle');
        setWander('life');
        return;
      }
      if (life && (life.phase === 'doze' || life.phase === 'nap') && q.mode === 'asleep' && (prev === 'reaction' || prev === 'relocate' || prev === 'asleep' || prev === 'sleepy') && !(prev === 'relocate' && !near(g?.home))) return;
      setWander(null);
      if (q.mode === 'asleep' && near(g?.home) && life) return;
      doze(life?.phase === 'nap' ? 'nap' : 'doze', { home: (s === 'asleep' && prev !== 'reaction') || prev === 'relocate' });
      return;
    }
    life = null;
    setWander(s !== 'muted' && 'calm');
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
    if (s === 'waking' || s === 'listening') q.look = { x: 0, y: 0 }; // he looks at you
    const fromLife = lifeState(prev) && !!g && !near(g.home); // his own life left him away from his spot
    if (wasAsleep && motion) wakeInto(mode);
    else if ((q.mode !== mode || s === 'muted') && !(s === 'speaking' && feel?.mode && q.mode === feel.mode)) q.setMode(mode); // (a feeling his first words brought stays its moment)
    if (s === 'muted') {
      if (motion) q.do('shake', {}, { interrupt: !wasAsleep }); // not listening
      return;
    }
    if (prev === 'muted' && motion && (s === 'listening' || s === 'idle')) q.do('nod', {}, { interrupt: true }); // listening again
    if (!motion || !g) return;
    const queue = wasAsleep; // after the wake action
    if (fromLife && (s === 'waking' || s === 'listening')) {
      // Orbit woke up while he was off somewhere: he attends at once where he is, then hops back
      // to his spot by Claude's Send button (where the call's drafts and sends will want him).
      q.do('pause', { secs: 0.4 });
      moveTo(g.home, { interrupt: false });
      return;
    }
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
    seen();
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
      if ((base === 'asleep' || base === 'sleepy') && asleepLike()) {
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

  /** Is he standing on the prompt box? */
  const onTheBox = () => !!geo?.box && !q.air && !q.pivot && Math.abs(geo.ground - q.sy - geo.box.y) < 2 && q.cx > geo.box.x && q.cx < geo.box.x + geo.box.w;
  const grown = () => q.sp.grow.t > 1.05;
  /** Which way to go (dir 'left' | 'right', else toward the side with more room) and how far there's room. */
  function room(dir) {
    const half = side() / 2;
    const lo = onTheBox() ? geo.box.x + half : 6 + half;
    const hi = onTheBox() ? geo.box.x + geo.box.w - half : geo.W - 6 - half;
    const left = q.cx - lo;
    const right = hi - q.cx;
    const d = dir === 'left' ? -1 : dir === 'right' ? 1 : right >= left ? 1 : -1;
    return { d, space: d > 0 ? right : left, lo, hi };
  }

  /** A command for him ({ action, dir }; see COMMANDS). Returns false if it isn't one, or he isn't placed yet. */
  function command(cmd) {
    const a = cmd?.action;
    if (!geo || !COMMANDS.includes(a)) return false;
    const g = geo;
    const base = baseState(v, t - lastActive);
    note(`command ${a}`);
    lastActive = t;
    seen();
    if (a === 'wake') {
      react = { kind: 'command', mode: null, until: t + 0.6, action: a };
      if (asleepLike()) wakeInto(MODE_FOR[base] || 'listening');
      else q.do('hopInPlace', {}, { interrupt: true });
      return true;
    }
    if (a === 'nap') {
      // A short nap with the call still on: Orbit's state takes over again when it ends (he wakes).
      sleeping = true;
      if (q.mode !== 'asleep') q.setMode('sleepy');
      q.do('sleep', {}, { interrupt: true }).then(() => (sleeping = false));
      react = { kind: 'command', mode: 'asleep', until: t + COMMAND_TIMES.nap, action: a };
      return true;
    }
    const mode = { celebrate: 'happy', dance: 'music', happy: 'happy', sad: 'sad', curious: 'curious', surprised: 'surprised' }[a] || null;
    const woke = asleepLike();
    if (woke) wakeInto(mode || MODE_FOR[base] || 'listening'); // the trick follows the wake-up
    else if (mode) q.setMode(mode);
    const opt = { interrupt: !woke };
    let hold = 0.5;
    switch (a) {
      case 'backflip':
      case 'frontflip':
        q.do('flip', { dir: a === 'backflip' ? -1 : 1, outcome: 'success' }, opt);
        break;
      case 'roll': {
        let r = room(cmd.dir);
        if (r.space < side() * 0.9) r = room(r.d > 0 ? 'left' : 'right'); // no room that way: the other
        q.do('roll', { dir: r.d, n: Math.max(1, Math.min(4, Math.floor(r.space / side()))) }, opt);
        break;
      }
      case 'jump':
        q.do('jump', { height: 1.6 }, opt);
        break;
      case 'hop':
        q.do('hopInPlace', {}, opt);
        break;
      case 'grow':
        if (!grown()) q.do('grow', { scale: 1.5 }, opt);
        else q.do('hopInPlace', {}, opt);
        grownUntil = t + COMMAND_TIMES.grow;
        break;
      case 'shrink':
        if (grown()) q.do('shrink', {}, opt);
        else q.do('doubleBlink', {}, opt); // already his own size
        grownUntil = 0;
        break;
      case 'celebrate':
        hold = 1.6;
        q.do('celebrate', {}, opt);
        break;
      case 'dance':
        // (music: he bops on the beat, his colour stepping round the wheel)
        hold = COMMAND_TIMES.dance;
        q.do('hopInPlace', {}, opt);
        break;
      case 'nod':
      case 'shake':
      case 'stretch':
        q.do(a, {}, opt);
        break;
      case 'look_around':
        q.do('lookAround', {}, opt);
        break;
      case 'blink':
        q.do('doubleBlink', {}, opt);
        break;
      case 'happy':
      case 'sad':
      case 'curious':
      case 'surprised':
        hold = COMMAND_TIMES.mood;
        if (a === 'happy') q.do('hopInPlace', {}, opt);
        if (a === 'surprised') q.do('wonder', {}, opt);
        break;
      case 'move': {
        const r = room(cmd.dir);
        const x = Math.max(r.lo, Math.min(r.hi, q.cx + r.d * side() * 3));
        moveTo(onTheBox() ? g.onBox(x) : { x, y: g.ground, onBox: false }, { interrupt: !woke });
        break;
      }
      case 'go_home':
        moveTo(g.home, { interrupt: !woke });
        break;
    }
    react = { kind: 'command', mode, until: t + hold, action: a };
    return true;
  }

  /**
   * A feeling as his words play (an emote cue; see EMOTES). Only while he's talking or about to (not
   * while you talk, asleep, or during a reaction or something you asked him to do: those win).
   * Returns whether he showed it.
   */
  function emote(name) {
    const e = Object.hasOwn(EMOTES, name) ? EMOTES[name] : null;
    if (!e || !geo || react || v.hearing || v.muted) return false;
    const s = baseState(v, t - lastActive);
    if (s !== 'speaking' && s !== 'thinking' && state !== 'speaking') return false;
    note(`emote ${name}`);
    if (e.mode) q.setMode(e.mode);
    // A move in place: over another feeling's move, or on its own; never over a move to a place.
    if (e.act) {
      const mine = !q.busy || EMOTE_ACTS.has(q.taskName);
      if (mine) q.do(e.act, {}, { interrupt: q.busy });
    }
    feel = { name, mode: e.mode || null, until: t + e.hold };
    return true;
  }

  return {
    command,
    emote,
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
        grownUntil = 0;
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
      seen();
      if (lifeState(s) && lifeOn()) {
        // Already asleep: his doze has begun (he gets up after it).
        q.setMode('asleep', { instant: true });
        life = { phase: 'doze', until: null };
        setWander(null);
      } else setWander(s !== 'muted' && 'calm');
      note(`place ${s}`);
    },
    event,
    /** One frame (after the engine's own update). */
    tick(dt) {
      t += dt;
      q.setLevels(v.muted ? 0 : Number(v.input) || 0, Number(v.output) || 0);
      if (v.phase !== 'listening' || v.hearing || v.draft || v.sending || v.claudeWorking || v.asleep || v.muted) lastActive = t;
      const s = baseState(v, t - lastActive);
      q.talking = s === 'speaking';
      if (feel && (t >= feel.until || (s !== 'speaking' && s !== 'thinking') || react)) {
        // Back to speaking (or whatever Orbit's state is now: enter() has already set a new one).
        if (feel.mode && q.mode === feel.mode && (s === 'speaking' || s === 'thinking') && !react) q.setMode(MODE_FOR[s]);
        feel = null;
      }
      // What keeps him from tiring: a call, Claude at work, the cursor moving near him.
      if ((v.phase && v.phase !== 'off') || v.claudeWorking) seen();
      if (q.pointer && q.pointer !== lastPointer && Math.abs(q.pointer.x - q.cx) < q.side * 8) seen();
      lastPointer = q.pointer;
      // Big for a while after "get bigger", then back to his own size.
      if (grownUntil && t > grownUntil && !react && !q.busy && !q.air && !q.pivot) {
        grownUntil = 0;
        if (grown()) q.do('shrink');
      }
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
        // The window changed under him: back to his place (asleep, he sleepwalks there; up and
        // about in his own life, he has no place: he carries on from where he is).
        relocate = false;
        const place = life?.phase === 'up' || life?.phase === 'stir' ? null : { asleep: geo.home, confirm: geo.confirm, sending: geo.sendAt, watching: geo.watch }[s];
        if (place && !near(place)) {
          note('relocate');
          enter(s, 'relocate');
        }
      } else if (lifeState(s) && lifeOn()) liveTick();
    },
    /** A click on him: a little reaction (asleep, he stirs and dozes off again). */
    poke() {
      if (!geo || react) return;
      seen();
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
    /** Retune his own life (see LIFE; the e2e keeps him dozing for its sleep checks). A doze under way is re-timed. */
    setLifeTiming(patch = {}) {
      for (const k of Object.keys(LIFE)) if (Array.isArray(patch[k]) || Number.isFinite(patch[k])) timing[k] = patch[k];
      if (life && (life.phase === 'doze' || life.phase === 'nap')) life.until = null;
    },
    /** His own life's phase: 'doze' | 'stir' | 'up' | 'nap', or null (Orbit is on). */
    get life() {
      return life?.phase || null;
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
