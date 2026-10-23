/* Qubit motion engine. One file, no dependencies, plain SVG.
 *
 * Qubit is a square with one rectangular eye. Everything he does is driven by springs and a little
 * physics, so a new state or action always starts from wherever he is, with his momentum intact:
 * nothing snaps.
 *
 *   - Only two shapes are ever drawn: the square, and his eye, which is a hole cut through it. One
 *     solid colour fills the whole square; changing hue changes that whole fill (never a gradient).
 *     No shading, shadow, stroke, particles or any other marks.
 *   - Springs: pose, squash, eye position, eye size, eye rotation, the two blink lids, and colour
 *     (OKLCH lightness, chroma and hue; hue takes the short way round the wheel).
 *   - Physics: gravity, jumps and flips (angular velocity). Landing flat squashes him; landing on a
 *     corner hands over to a pivot simulation, where he rocks on the corner and topples onto
 *     whichever face gravity picks. Rolling uses the same pivot, with a push.
 *   - A square looks the same from every side, so after a roll or flip his body is re-labelled
 *     upright and the eye is moved by the same amount. It then glides back to his top face and
 *     swivels upright again, which reads as him righting himself.
 *   - Modes (idle, listening, thinking, speaking, happy...) set spring targets and loops. Actions
 *     (hop, jump, flip, roll, grow, blink...) are generator scripts that can be queued or interrupted.
 *     A small "brain" fills quiet time with blinks, glances and the odd flip practice.
 *   - One shared requestAnimationFrame ticker drives every instance; instances that are off screen
 *     sleep. A low-power mode caps at 30 fps.
 *   - Environments: q.setEnvironment({ solids: [{ id, x, y, w, h }] }) in stage units (CSS px, y down)
 *     gives him things to stand on. Physics stays whole-square: he lands on their tops, is stopped by
 *     their sides and bonks their undersides, and falls when what he stands on goes away.
 *   - Pathing (needs orbit-nav.js, global OrbitNav): q.goTo(x, y) plans a route and runs it with his
 *     own moves: hops along a surface, a ballistic jump that lands exactly on the next platform (up or
 *     across), a small hop off an edge to drop, and a graceful turn (the eye leads) when he reverses.
 *   - Idle wander: q.setWander(true, { seed }) hands quiet time to a seeded idle planner (wander,
 *     rest, look at things, fidget, practise a flip, go home). Anything explicit (q.do, q.goTo, a mood
 *     change) pre-empts it at once; it resumes after a few quiet seconds.
 *
 * Units: Qubit's side is 100 at size 1 (QubitEngine.create({ size })). World y grows downward in
 * the SVG; the physics uses "height above the ground".
 */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const f2 = (n) => (Math.abs(n) < 1e-4 ? 0 : Math.round(n * 100) / 100);
  const f3 = (n) => Math.round(n * 10000) / 10000; // scales: finer, so big sizes never step

  // ---------------------------------------------------------------- springs
  class Spring {
    constructor(v = 0, freq = 4, damp = 0.7) {
      this.v = v;
      this.t = v;
      this.vel = 0;
      this.tune(freq, damp);
    }
    /** Frequency in Hz and damping ratio (1 = no overshoot, < 1 bouncy). */
    tune(freq, damp) {
      this.freq = freq;
      this.damp = damp;
      const w = TAU * freq;
      this.k = w * w;
      this.c = 2 * damp * w;
      return this;
    }
    to(t) {
      this.t = t;
      return this;
    }
    snap(v) {
      this.v = this.t = v;
      this.vel = 0;
      return this;
    }
    kick(dv) {
      this.vel += dv;
      return this;
    }
    step(dt) {
      // Semi-implicit Euler, substepped so stiff springs stay stable on slow frames.
      const n = Math.max(1, Math.ceil(dt * this.freq * 10));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        this.vel += (-this.k * (this.v - this.t) - this.c * this.vel) * h;
        this.v += this.vel * h;
      }
      return this.v;
    }
  }
  /** A hue spring: degrees, always heading the short way round. */
  class HueSpring extends Spring {
    to(h) {
      const d = ((((h - this.v) % 360) + 540) % 360) - 180;
      this.t = this.v + d;
      return this;
    }
  }

  // ---------------------------------------------------------------- the look
  // Colours are OKLCH [lightness, chroma, hue]: hue shifts keep the same perceived brightness.
  const PALETTE = {
    indigo: [0.63, 0.2, 272], // Qubit's own colour
    cyan: [0.78, 0.13, 205],
    violet: [0.62, 0.22, 300],
    amber: [0.8, 0.15, 78],
    lime: [0.84, 0.19, 135],
    orange: [0.76, 0.16, 52],
    claude: [0.7, 0.14, 42],
    pink: [0.72, 0.15, 8],
    dusk: [0.47, 0.06, 268],
    night: [0.38, 0.05, 268],
    slate: [0.56, 0.06, 245],
    red: [0.64, 0.21, 27],
    flash: [0.86, 0.17, 95],
  };
  const color = (l, c, h, a = 1) => `oklch(${f2(l)} ${f2(c)} ${f2(((h % 360) + 360) % 360)}${a < 1 ? ` / ${f2(a)}` : ''})`;

  // ---------------------------------------------------------------- modes
  // Each mode is a mood: a colour, an eye, and how the body idles. Eye sizes are in body units (side
  // 100); y is the eye's height on the face (negative = up). Changing mode only retargets springs.
  const MODES = {
    idle: {
      label: 'Idle',
      about: 'At rest. Breathes, blinks (mostly top-down, sometimes side to side), glances about, follows your cursor, and now and then practises a flip.',
      color: PALETTE.indigo,
      eye: { w: 30, h: 13, x: 0, y: -16, rot: 0 },
      breathe: 0.014,
      brain: true,
    },
    listening: {
      label: 'Listening',
      about: 'Heard "Hey Qubit". Turns cyan, opens his eye wider and leans in for a moment, then settles back. His eye stretches taller as you get louder, so you can see him hearing you.',
      color: PALETTE.cyan,
      eye: { w: 27, h: 19, x: 0, y: -17, rot: 0 },
      leanPulse: 3, // he leans in for a moment as he starts listening, then tips back (never holds it)
      breathe: 0.01,
      listens: true,
    },
    thinking: {
      label: 'Thinking',
      about: 'Superposition. His eye spins slowly through horizontal |0> and vertical |1>. He floats a few units off the ground while his whole colour drifts between violet and magenta.',
      color: PALETTE.violet,
      eye: { w: 24, h: 8, x: 0, y: -18, rot: 0 },
      hueCycle: [286, 332, 0.45],
      hover: 9,
      superpose: true,
      breathe: 0.006,
    },
    speaking: {
      label: 'Speaking',
      about: 'Warm amber. His eye is also his mouth: it opens taller with the loudness of his voice, and his body pulses a little on stressed syllables.',
      color: PALETTE.amber,
      eye: { w: 30, h: 12, x: 0, y: -15, rot: 0 },
      speaks: true,
      breathe: 0.01,
    },
    happy: {
      label: 'Happy',
      about: 'Lime green. His eye squints to a thin, wide bar, like a closed-eye smile, and he gives a little bounce.',
      color: PALETTE.lime,
      eye: { w: 36, h: 6, x: 0, y: -16, rot: 0 },
      bounce: 0.03,
      breathe: 0.02,
    },
    curious: {
      label: 'Curious',
      about: 'Orange. His eye turns tall and tilts toward whatever caught his interest. His body stays level.',
      color: PALETTE.orange,
      eye: { w: 20, h: 24, x: 4, y: -16, rot: -10 },
      breathe: 0.012,
    },
    focused: {
      label: 'Watching Claude',
      about: 'Claude is working. He takes on Claude\'s orange, narrows his eye to a steady bar and keeps his gaze on the work, with an occasional small nod.',
      color: PALETTE.claude,
      eye: { w: 32, h: 9, x: 0, y: -13, rot: 0 },
      breathe: 0.008,
      nods: true,
    },
    embarrassed: {
      label: 'Embarrassed',
      about: 'Pink. A flip that didn\'t land. His eye shrinks low and looks away while he gathers himself.',
      color: PALETTE.pink,
      eye: { w: 22, h: 7, x: -8, y: -8, rot: 0 },
      breathe: 0.016,
    },
    sad: {
      label: 'Sad',
      about: 'Muted blue-grey. He droops slightly and his eye sinks low and narrow.',
      color: PALETTE.slate,
      eye: { w: 22, h: 7, x: 0, y: -6, rot: 0 },
      droop: 0.93,
      breathe: 0.01,
    },
    surprised: {
      label: 'Surprised',
      about: 'A yellow flash. His eye pops into a square and he stretches tall.',
      color: PALETTE.flash,
      eye: { w: 24, h: 24, x: 0, y: -18, rot: 0 },
      stretch: 1.08,
    },
    sleepy: {
      label: 'Sleepy',
      about: 'Dusk. Heavy lid: his eye flattens to a sliver and drifts down, and his breathing slows.',
      color: PALETTE.dusk,
      eye: { w: 28, h: 4, x: 0, y: -10, rot: 0 },
      breathe: 0.022,
      breatheRate: 0.55,
    },
    asleep: {
      label: 'Asleep',
      about: 'Night blue. His eye is a closed line and he sinks a little with each slow, deep breath.',
      color: PALETTE.night,
      eye: { w: 28, h: 2.2, x: 0, y: -8, rot: 0 },
      breathe: 0.034,
      breatheRate: 0.32,
    },
    music: {
      label: 'Music',
      about: 'Playing a song. He bops on every beat (squash on the downbeat), his whole colour steps 45 degrees round the wheel each beat, and his eye pulses like an equaliser.',
      color: PALETTE.indigo,
      eye: { w: 30, h: 11, x: 0, y: -15, rot: 0 },
      bpm: 104,
    },
    error: {
      label: 'Something went wrong',
      about: 'Red. A short shiver, then his eye goes flat. For tool errors and failed sends.',
      color: PALETTE.red,
      eye: { w: 26, h: 6, x: 0, y: -14, rot: 0 },
      breathe: 0.01,
    },
  };

  // Spring settings per property: [frequency Hz, damping ratio].
  const TUNING = {
    stretch: [5.2, 0.42], // squash and stretch: bouncy
    grow: [7, 0.32], // growing: overshoots like a power-up
    tilt: [2.4, 0.55],
    hover: [1.6, 0.7],
    eyeX: [5, 0.62],
    eyeY: [5, 0.62],
    eyeW: [6.5, 0.48],
    eyeH: [6.5, 0.48],
    eyeRot: [3.2, 0.6],
    lid: [16, 0.85], // blinks are fast
    L: [1.6, 0.9],
    C: [1.6, 0.9],
    H: [0.9, 0.95], // hue glides
    lean: [2, 0.7],
  };

  // ---------------------------------------------------------------- the ticker (shared)
  const instances = new Set();
  const ticker = {
    lowPower: false,
    fps: 60,
    _frames: 0,
    _fpsAt: 0,
    _last: 0,
    _raf: 0,
    _acc: 0,
    hooks: new Set(), // extra per-frame callbacks: ticker.hooks.add((dt, now) => ...)
    start() {
      if (this._raf) return;
      this._last = this._fpsAt = performance.now();
      const loop = (now) => {
        this._raf = requestAnimationFrame(loop);
        let dt = (now - this._last) / 1000;
        this._last = now;
        if (this.lowPower) {
          // 30 fps: skip every other frame (keep the time, counted once).
          this._acc += dt;
          if (this._acc < 1 / 31) return;
          dt = this._acc;
          this._acc = 0;
        }
        dt = Math.min(dt, 1 / 20); // a hitch never makes him tunnel through the floor
        if (dt <= 0) return;
        this._frames++;
        if (now - this._fpsAt > 1000) {
          this.fps = Math.round((this._frames * 1000) / (now - this._fpsAt));
          this._frames = 0;
          this._fpsAt = now;
        }
        for (const q of instances) if (q.awake) q.update(dt);
        for (const fn of this.hooks) fn(dt, now); // page overlays (speech bubbles, readouts) ride the same frame
      };
      this._raf = requestAnimationFrame(loop);
    },
    get count() {
      return instances.size;
    },
    get active() {
      let n = 0;
      for (const q of instances) if (q.awake) n++;
      return n;
    },
  };
  // Instances off screen don't update (or draw) at all.
  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) e.target.__qubit && (e.target.__qubit.visible = e.isIntersecting);
          },
          { rootMargin: '120px' },
        )
      : null;

  // ---------------------------------------------------------------- one Qubit
  function el(name, attrs = {}, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  let uid = 0;

  class Qubit {
    /**
     * opts: mount (element), width, height (the stage, in world units = CSS px at 1:1), size (body
     * side in px, default 100), x (centre), floor (ground's distance from the stage's bottom),
     * mode, brain (true: lively idle behaviour), shadow, keepAlive (update even off screen).
     */
    constructor(opts = {}) {
      this.id = ++uid;
      this.W = opts.width || 480;
      this.H = opts.height || 300;
      this.S = opts.size || 100;
      this.floor = opts.floor ?? 24;
      this.ground = this.H - this.floor;
      this.brainOn = opts.brain !== false;
      this.listeners = {};
      this.visible = true;
      this.keepAlive = !!opts.keepAlive;
      this.t = 0;
      this.levels = { input: 0, output: 0 };
      this.pointer = null;
      this.bounds = [0, this.W];

      // Body: centre position (x, height of the centre above the ground), rotation, velocities.
      const s0 = this.S;
      this.cx = opts.x ?? this.W / 2;
      this.cy = s0 / 2;
      this.vx = 0;
      this.vy = 0;
      this.angle = 0; // degrees, clockwise
      this.av = 0; // degrees per second
      this.air = false;
      this.pivot = null; // { px, d, phi, w, base, push } while rocking or rolling on a corner
      this.angleSettle = new Spring(0, 9, 0.5); // the last few degrees after a flat landing

      const T = TUNING;
      this.sp = {
        stretch: new Spring(1, ...T.stretch),
        grow: new Spring(1, ...T.grow),
        tilt: new Spring(0, ...T.tilt),
        hover: new Spring(0, ...T.hover),
        ex: new Spring(0, ...T.eyeX),
        ey: new Spring(-16, ...T.eyeY),
        ew: new Spring(30, ...T.eyeW),
        eh: new Spring(13, ...T.eyeH),
        er: new Spring(0, ...T.eyeRot),
        lidH: new Spring(1, ...T.lid), // vertical squeeze (a top-down blink)
        lidV: new Spring(1, ...T.lid), // horizontal squeeze (a side-to-side blink)
        L: new Spring(PALETTE.indigo[0], ...T.L),
        C: new Spring(PALETTE.indigo[1], ...T.C),
        H: new HueSpring(PALETTE.indigo[2], ...T.H),
        lean: new Spring(0, ...T.lean),
      };
      this.look = { x: 0, y: 0 }; // where the eye points: -1..1 each way
      this.colorOverride = null; // (t) => [L, C, H] for sweeps
      this.eyeHold = 0; // seconds the eye stays where a landing put it
      this.eyeSpin = 0; // superposition spin (degrees)
      this.queue = [];
      this.task = null;
      this.taskName = '';
      this.brainT = { blink: rand(1, 3), glance: rand(1, 2.5), play: rand(14, 24), stunt: rand(40, 70) };
      this.lastInteraction = 0;
      // Environment and pathing
      this.sy = 0; // height above the ground line of the surface he rests on
      this.solids = []; // in physics units: { id, L, R, T (top height), B (bottom height) }
      this.envSrc = null;
      this.nav = null;
      this.route = null;
      this.wander = null;
      this.facing = 0;

      this._build(opts);
      this.setMode(opts.mode || 'idle', { instant: true });
      instances.add(this);
      ticker.start();
    }

    // ---------- DOM
    _build(opts) {
      const svg = el('svg', { viewBox: `0 0 ${this.W} ${this.H}`, width: '100%', height: '100%', 'aria-hidden': 'true', style: 'display:block;overflow:visible' });
      svg.__qubit = this;
      // He is one path: the square, with the eye cut out of it (even-odd), so whatever is behind him
      // shows through the eye. One element, no masks or filters, so a frame costs almost nothing.
      this.bodyG = el('g', {}, svg);
      this.body = el('path', { 'fill-rule': 'evenodd', 'shape-rendering': 'geometricPrecision' }, this.bodyG);
      this.svg = svg;
      if (opts.mount) opts.mount.appendChild(svg);
      io?.observe(svg);
    }

    get awake() {
      return this.keepAlive || this.visible;
    }

    on(type, fn) {
      (this.listeners[type] ||= []).push(fn);
      return this;
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || []) fn(data, this);
    }

    /** The side of his body right now (power-ups included). */
    get side() {
      return this.S * this.sp.grow.v;
    }

    // ---------- modes
    setMode(name, { instant = false } = {}) {
      const m = MODES[name];
      if (!m) return this;
      const prev = this.mode;
      this.mode = name;
      this.M = m;
      this.modeT = 0;
      const s = this.sp;
      const [L, C, H] = m.color;
      if (instant) (s.L.snap(L), s.C.snap(C), s.H.snap(H));
      else (s.L.to(L), s.C.to(C), s.H.to(H));
      if (this.eyeHold <= 0) this._eyeToMode(instant);
      s.hover.to(m.hover || 0);
      s.tilt.to(m.tilt || 0);
      s.lean.to(m.lean || 0);
      // A lean-in or a tilt is a moment, not a pose: he tips, then settles back level.
      this.leanBackAt = 0;
      if (m.leanPulse && !instant) (s.lean.to(m.leanPulse), (this.leanBackAt = this.t + 0.5));
      if (m.tiltPulse && !instant) (s.tilt.to(m.tiltPulse), (this.leanBackAt = this.t + 0.6));
      if (m.stretch) s.stretch.kick(2.2);
      if (!m.brain) this._dropIdle(); // a mood with somewhere to be: idle life steps aside
      this.beatAt = 0;
      this.emit('mode', { mode: name, prev });
      return this;
    }
    _eyeToMode(instant) {
      const e = this.M.eye;
      const s = this.sp;
      const set = (sp, v) => (instant ? sp.snap(v) : sp.to(v));
      set(s.ew, e.w);
      set(s.eh, e.h);
      set(s.ex, e.x);
      set(s.ey, e.y);
      set(s.er, e.rot);
    }

    /** Microphone and voice loudness, 0..1, for listening and speaking. */
    setLevels(input = 0, output = 0) {
      this.levels.input = clamp(input, 0, 1);
      this.levels.output = clamp(output, 0, 1);
    }
    /** Where the cursor is, in stage units (or null). He follows it with his eye when idle. */
    setPointer(p) {
      this.pointer = p;
    }

    // ---------- actions (queued generator scripts)
    /** Run an action. Returns a promise that resolves when it has finished. */
    do(name, params = {}, { interrupt = false, idle = false } = {}) {
      const fn = ACTIONS[name];
      if (!fn) return Promise.resolve(false);
      if (!idle) {
        // Anything explicit takes priority over idle life, immediately.
        this.lastInteraction = this.t;
        this._dropIdle();
      }
      return new Promise((resolve) => {
        const job = { name, params, resolve, idle };
        if (interrupt) {
          for (const j of this.queue) j.resolve(false);
          this.queue = [job];
          if (this.task) this.task.cancelled = true;
        } else this.queue.push(job);
      });
    }
    /** Cancel idle-life jobs (the running one stops at once; physics carries him to a landing). */
    _dropIdle() {
      if (this.task && this.task.idle) this.task.cancelled = true;
      if (this.queue.some((j) => j.idle)) this.queue = this.queue.filter((j) => (j.idle ? (j.resolve(false), false) : true));
      if (this.wander) this.wander.lookAt = null;
    }
    /** True while he's doing something he was asked to do (idle life doesn't count). */
    get busy() {
      return (!!this.task && !this.task.idle) || this.queue.some((j) => !j.idle);
    }
    _nextTask() {
      const job = this.queue.shift();
      if (!job) return;
      const ctx = { cancelled: false };
      this.task = { job, ctx, gen: ACTIONS[job.name](this, job.params, ctx), cancelled: false, idle: !!job.idle };
      this.taskName = job.name;
      this.emit('action', { name: job.name, params: job.params });
    }

    // ---------- physics helpers used by actions
    /** Jump: height in body sides, optional horizontal speed and spin (degrees/second). */
    launch(height, vx = 0, av = 0) {
      const g = this.gravity;
      this.vy = Math.sqrt(2 * g * Math.max(0.05, height) * this.side);
      if (!this.air && !this.pivot && this._rh != null) {
        // Leave the ground from exactly where he's drawn: crouched, tilted onto a corner, all of it.
        this.cx = this._rx;
        this.cy = this._rh;
      }
      this.vx = vx;
      this.av = av;
      this.air = true;
      this.pivot = null;
      this.sp.stretch.to(1); // out of the crouch: the spring's overshoot is the take-off stretch
      this.emit('launch');
    }
    /** Angular acceleration scale for a square rocking on a corner (solid square about its edge). */
    _pivotK() {
      return ((3 * this.gravity) / (2 * Math.SQRT2 * this.side)) * 1.15;
    }
    /** Mood tilt and leaning in, degrees: drawn on top of his physical angle. */
    _tilt() {
      return this.sp.tilt.v + this.sp.lean.v;
    }
    /** His half-width and half-height right now, squash included. */
    _halfExtents() {
      const st = this.sp.stretch.v;
      return [(this.side / 2) * (1 + (1 - st) * 0.85), (this.side / 2) * st];
    }
    get gravity() {
      return 26 * this.S; // feels right for a body this size (and scales with it)
    }
    /** Seconds of flight for a jump of that height. */
    flightTime(height) {
      return (2 * Math.sqrt(2 * this.gravity * height * this.side)) / this.gravity;
    }
    /** Start rolling over a bottom corner: dir +1 right, -1 left. */
    roll(dir) {
      const s = this.side;
      const d = dir >= 0 ? 1 : -1;
      // Lifting the centre over the edge costs K(1 - 1/sqrt 2); push with a little more than that.
      const over = Math.sqrt(2 * this._pivotK() * (1 - Math.SQRT1_2));
      this.pivot = { px: this.cx + d * s * 0.5, d, phi: 0, w: over * 1.16, base: this.angle + this._tilt(), push: 0 };
      this.emit('roll', { dir: d });
    }
    /**
     * A ballistic leap that lands exactly: to x, onto a surface `level` high (height above the ground
     * line), with his bottom face peaking at `apex` (also a height). Returns the flight time.
     */
    launchTo(x, level, apex, av = 0) {
      const g = this.gravity;
      if (!this.air && !this.pivot && this._rh != null) {
        this.cx = this._rx;
        this.cy = this._rh;
      }
      const half = this.side / 2;
      const top = Math.max(apex, this.sy, level) + half; // the centre's apex
      const rise = Math.max(0.5, top - this.cy);
      const fall = Math.max(0.5, top - (level + half));
      const T = Math.sqrt((2 * rise) / g) + Math.sqrt((2 * fall) / g);
      this.vy = Math.sqrt(2 * g * rise);
      this.vx = (x - this.cx) / T;
      this.av = av;
      this.air = true;
      this.pivot = null;
      this.sp.stretch.to(1);
      this.emit('launch');
      return T;
    }

    // ---------- environment and pathing
    /**
     * The things he can stand on: { solids: [{ id, x, y, w, h, kind, oneWay }] } in stage units (y down,
     * the same space as width/height). His floor stays the stage floor; null clears it. oneWay: a ledge
     * he can jump up through from below and land on (a line of text, say); it never blocks him.
     */
    setEnvironment(env) {
      this.envSrc = env || null;
      const solids = (env && env.solids) || [];
      const G = this.ground;
      this.solids = solids.filter((s) => s && s.w > 0 && s.h > 0).map((s) => ({ id: s.id, L: s.x, R: s.x + s.w, T: G - s.y, B: G - s.y - s.h, oneWay: !!(s.oneWay || s.kind === 'oneway') }));
      this._syncNav();
      return this;
    }
    _abilities() {
      const s = this.S;
      return { bodyW: s, bodyH: s, walk: true, stepUp: s * 0.34, jumpUp: s * 2.6, jumpAcross: s * 3.4, dropDown: s * 9, edgeInset: s * 0.35, margin: s * 0.07, ...(this.abilityOverrides || {}) };
    }
    _syncNav() {
      const Nav = global.OrbitNav;
      if (!Nav) return null;
      const solids = ((this.envSrc && this.envSrc.solids) || []).filter((s) => s && s.w > 0 && s.h > 0);
      const env = { left: this.bounds[0], width: this.bounds[1], height: this.H, floor: this.ground, solids };
      if (this.nav && this.nav.abilities.bodyW === this.S) this.nav.update(env);
      else {
        this.nav = Nav.build(env, this._abilities());
        if (this.wander) this.wander.planner.nav = this.nav;
      }
      return this.nav;
    }
    /** Plan a route from where he is to (x, y), stage units. null if there's no way there. */
    plan(x, y, opts = {}) {
      const nav = this.nav || this._syncNav();
      if (!nav) return null;
      if (this.bounds[0] !== nav.env.left || this.bounds[1] !== nav.env.width || this.ground !== nav.env.floor) this._syncNav();
      const from = { x: this.cx, y: this.ground - this.sy };
      return nav.path(from, { x, y, surface: opts.surface }, { mode: opts.mode || 'gravity' });
    }
    /** Go to (x, y) by the best route. Resolves true on arrival, false if interrupted or unreachable. */
    goTo(x, y, opts = {}) {
      return this.do('goTo', { x, y, ...opts }, { interrupt: opts.interrupt !== false });
    }
    /** Highest surface (height) under [x - hw, x + hw] that he could be standing on at height h. */
    _supportAt(x, hw, h) {
      let best = 0;
      for (const s of this.solids) if (x + hw > s.L + 0.5 && x - hw < s.R - 0.5 && s.T <= h + this.side * 0.5 && s.T > best) best = s.T;
      return best;
    }
    /** Free height above his head over [x1, x2] (Infinity if open sky). */
    _headroom(x1, x2) {
      let room = Infinity;
      const head = this.sy + this.side;
      for (const s of this.solids) if (!s.oneWay && x2 > s.L && x1 < s.R && s.B >= head - 1) room = Math.min(room, s.B - head);
      return room;
    }
    /** A solid right beside him (within dist) in direction dir. */
    _blocked(dir, dist) {
      const half = this.side / 2;
      for (const s of this.solids) {
        if (s.oneWay || !(s.T > this.sy + 1 && s.B < this.sy + this.side - 1)) continue;
        if (dir > 0 && s.L >= this.cx + half - 1 && s.L < this.cx + half + dist) return true;
        if (dir < 0 && s.R <= this.cx - half + 1 && s.R > this.cx - half - dist) return true;
      }
      return false;
    }
    /** Point his eye at a stage point. */
    _gazeAt(p) {
      if (!p) return;
      const sx = p.x - this.cx;
      const sy = p.y - (this.ground - this.cy - this.sp.hover.v);
      this.look = { x: clamp(sx / (this.side * 2.2), -1, 1), y: clamp(sy / (this.side * 2.2), -1, 1) };
    }

    /**
     * Idle wander: a seeded idle planner fills quiet time (in moods that allow it, i.e. idle).
     * opts: seed, home {x, y}, temperament, interests [{ x, y, kind, weight }], quiet (seconds after
     * anything explicit before idle life resumes), cursorWeight.
     */
    setWander(on = true, opts = {}) {
      if (!on) {
        this._dropIdle();
        this.wander = null;
        return this;
      }
      const Nav = global.OrbitNav;
      const nav = this.nav || this._syncNav();
      if (!Nav || !nav) return this;
      const planner = Nav.idle(nav, {
        seed: opts.seed ?? Math.floor(Math.random() * 1e9),
        home: opts.home || { x: this.cx, y: this.ground - this.sy },
        temperament: opts.temperament || 'qubit',
        fidgets: opts.fidgets || QUBIT_FIDGETS,
        interests: opts.interests || [],
        cursorWeight: opts.cursorWeight ?? 0.8,
      });
      this._dropIdle();
      this.wander = { planner, until: this.t + (opts.delay ?? 0.6), lookAt: null, last: null, quiet: opts.quiet ?? 2.5 };
      return this;
    }
    get seed() {
      return this.wander ? this.wander.planner.seed : null;
    }
    /** New seed: idle life changes course from here, smoothly. */
    reseed(seed) {
      if (!this.wander) return this.setWander(true, { seed });
      this._dropIdle();
      this.wander.planner.reseed(seed);
      this.wander.until = this.t + 0.3;
      return this;
    }
    /** Something worth noticing (a new message, a button): he looks, and may go and see. */
    notice(i) {
      if (this.wander) {
        this.wander.planner.notice({ ...i, at: this.t });
        if (this.task && this.task.idle && !this.air) this.task.cancelled = true;
        this.wander.until = Math.min(this.wander.until, this.t + 0.15);
      }
      if (!this.busy && this.M.brain) this._gazeAt(i);
    }
    _wanderTick() {
      const W = this.wander;
      if (this.task || this.queue.length || this.air || this.pivot) return;
      if (this.t - this.lastInteraction < W.quiet) return;
      if (this.t < W.until) {
        if (W.lookAt) this._gazeAt(W.lookAt);
        return;
      }
      W.lookAt = null;
      const it = W.planner.next({ x: this.cx, y: this.ground - this.sy, t: this.t, pointer: this.pointer });
      W.last = it;
      this.emit('intent', it);
      if (it.kind === 'rest') {
        W.until = this.t + it.duration;
        if (it.style === 'shift') this.sp.stretch.kick(-0.5);
        if (it.style === 'deep') this.look = { x: 0, y: 0.2 };
      } else if (it.kind === 'look') {
        W.lookAt = it.target;
        W.until = this.t + it.duration;
        this._gazeAt(it.target);
      } else if (it.kind === 'fidget') {
        let name = it.action;
        let params = { ...(it.params || {}) };
        const room = this._headroom(this.cx - this.side / 2, this.cx + this.side / 2);
        if (name === 'flip' && room < this.side * 2.7) name = 'lookAround';
        if (name === 'flip') params = { outcome: 'auto', dir: it.rand < 0.5 ? 1 : -1, ...params };
        if (name === 'roll') {
          const home = W.planner.home;
          const dir = home && Math.abs(home.x - this.cx) > this.side ? Math.sign(home.x - this.cx) : it.rand < 0.5 ? -1 : 1;
          if (this._blocked(dir, this.side * 1.05) || !this._rollRoom(dir)) name = 'stretch';
          else params = { dir, n: 1 };
        }
        if (name === 'hopInPlace' && room < this.side * 0.45) name = 'eyeMorph';
        this.do(name, params, { idle: true });
      } else {
        this.do('_wanderMove', { intent: it }, { idle: true });
      }
    }
    /** Room to roll a full side that way (stays on the surface he's on, inside the stage). */
    _rollRoom(dir) {
      const x = this.cx + dir * this.side;
      const half = this.side / 2;
      if (x - half < this.bounds[0] || x + half > this.bounds[1]) return false;
      return this._supportAt(x, half * 0.6, this.sy) >= this.sy - 0.5;
    }

    // ---------- the frame
    update(dt) {
      if (this.leanBackAt && this.t >= this.leanBackAt) {
        if (this.M.leanPulse) this.sp.lean.to(this.M.lean || 0);
        if (this.M.tiltPulse) this.sp.tilt.to(this.M.tilt || 0);
        this.leanBackAt = 0;
      }
      this._dt = dt;
      this.t += dt;
      this.modeT += dt;
      const s = this.sp;
      const M = this.M;

      // Actions
      if (!this.task) this._nextTask();
      if (this.task) {
        const { gen, ctx } = this.task;
        ctx.cancelled = this.task.cancelled;
        let r;
        try {
          r = gen.next(dt);
        } catch (e) {
          r = { done: true };
          console.error(e);
        }
        if (r.done) {
          this.task.job.resolve(!this.task.cancelled && !ctx.failed);
          this.emit('done', { name: this.taskName });
          this.task = null;
          this.taskName = '';
        }
      }
      // The brain fills quiet time; during idle-life moves it only keeps him blinking.
      if (this.brainOn && (!this.task || this.task.idle)) this._brain(dt, !!this.task);

      // Mode loops
      const breatheRate = M.breatheRate || 1;
      const breath = Math.sin(this.t * TAU * 0.31 * breatheRate);
      if (!this.air && !this.pivot && !this.task) {
        let st = 1 + (M.breathe || 0) * breath;
        if (M.droop) st *= M.droop;
        if (M.bounce) st += M.bounce * Math.max(0, Math.sin(this.t * TAU * 1.6));
        s.stretch.to(st);
      } else if (!this.task) s.stretch.to(1);
      if (M.hueCycle && !this.colorOverride) {
        const [a, b, hz] = M.hueCycle;
        s.H.to(a + (b - a) * (0.5 + 0.5 * Math.sin(this.t * TAU * hz)));
      }
      if (M.listens && this.eyeHold <= 0) {
        const lv = this.levels.input;
        s.eh.to(M.eye.h + lv * 12);
        s.ew.to(M.eye.w - lv * 4);
        s.L.to(M.color[0] + lv * 0.06);
      }
      if (M.speaks && this.eyeHold <= 0) {
        const lv = this.levels.output;
        s.eh.to(M.eye.h * 0.55 + lv * 22);
        if (lv > 0.5 && !this.air && !this.task) s.stretch.to(1 + (lv - 0.5) * 0.05);
      }
      if (M.bpm) this._musicBeat(dt);
      if (M.nods) {
        this.nodAt = (this.nodAt ?? rand(2, 4)) - dt;
        if (this.nodAt <= 0 && !this.task) {
          this.nodAt = rand(3, 6);
          s.ey.kick(60);
          s.stretch.kick(-0.6);
        }
      }

      // Gaze: the eye follows `look` (or the cursor while idle), within the face.
      if (this.eyeHold > 0) this.eyeHold -= dt;
      else {
        let lx = this.look.x;
        let ly = this.look.y;
        if (this.pointer && !this.task && (this.mode === 'idle' || this.mode === 'curious' || this.mode === 'happy')) {
          const dx = this.pointer.x - this.cx;
          const dy = this.ground - this.cy - this.sp.hover.v - this.pointer.y; // pointer above = positive... (screen y down)
          const dist = Math.hypot(dx, dy);
          if (dist < this.side * 6) {
            lx = clamp(dx / (this.side * 2.2), -1, 1);
            ly = clamp(-dy / (this.side * 2.2), -1, 1);
          }
        }
        const e = M.eye;
        if (!this.task && !M.listens && !M.speaks) {
          s.ew.to(e.w);
          s.eh.to(e.h);
        }
        s.ex.to(e.x + lx * 17);
        s.ey.to(e.y + ly * 11);
        if (!this.eyeSpinning && !this.task) s.er.to(e.rot + lx * 2);
      }
      if (M.superpose) {
        this.eyeSpin += dt * 70;
        s.er.to(this.eyeSpin);
        this.eyeSpinning = true;
      } else if (this.eyeSpinning) {
        // Leave superposition on the nearest basis state, |0> (flat) or |1> (upright).
        this.eyeSpinning = false;
        const r = ((s.er.v % 180) + 180) % 180;
        const shift = (r > 90 ? r - 180 : r) - s.er.v;
        s.er.v += shift;
        s.er.to(0);
        this.eyeSpin = 0;
      }

      // Colour override (celebration sweeps, music)
      if (this.colorOverride) {
        const c = this.colorOverride(this.t);
        if (!c) this.colorOverride = null;
        else (s.L.to(c[0]), s.C.to(c[1]), s.H.to(c[2]));
      }

      for (const k in s) s[k].step(dt);
      this._physics(dt);
      this._render();
    }

    _musicBeat(dt) {
      const M = this.M;
      const beat = 60 / M.bpm;
      this.beatAt = (this.beatAt || 0) - dt;
      const s = this.sp;
      if (this.beatAt <= 0) {
        this.beatAt += beat;
        this.beatN = (this.beatN || 0) + 1;
        if (!this.air && !this.pivot && !this.task) s.stretch.kick(-4.6); // the downbeat: a push, not a jump
        s.H.to(s.H.t + 45);
        s.C.to(0.2);
        s.L.to(0.72);
        s.eh.to(M.eye.h).kick(110); // the eye pops open on the beat (a kick, not a snap)
        s.tilt.to(this.beatN % 2 ? 6 : -6);
      }
    }

    _physics(dt) {
      const s = this.side;
      const half = s / 2;
      const [minX, maxX] = this.bounds;
      if (this.pivot) {
        // Rocking or rolling on a corner. phi is the turn away from the face it was resting on;
        // the square falls toward whichever face is nearer, with a gentle push for rolls.
        const P = this.pivot;
        const K = this._pivotK();
        const push = P.phi < Math.PI / 4 ? P.push * K : 0; // a roll's push, until it tips over the corner
        P.w += (K * Math.sin(P.phi - Math.PI / 4) + push) * dt;
        P.w *= Math.pow(0.6, dt); // a little friction at the corner
        P.phi += P.w * dt;
        let done = null;
        if (P.phi >= Math.PI / 2) done = 1;
        else if (P.phi <= 0) done = 0;
        const phi = clamp(P.phi, 0, Math.PI / 2);
        this.cx = P.px - P.d * half * Math.cos(phi) + P.d * half * Math.sin(phi);
        this.cy = this.sy + half * Math.cos(phi) + half * Math.sin(phi);
        this.angle = P.base + P.d * (phi / DEG);
        if (done !== null) {
          const impact = Math.abs(P.w);
          this.pivot = null;
          // Rest on the face he fell onto, centred where the render had him (his half-extents, squash included).
          const [ehw, ehh] = this._halfExtents();
          const odd = Math.round(P.base / 90) % 2 !== 0;
          const along = done ? (odd ? ehw : ehh) : odd ? ehh : ehw;
          this.cx = P.px + (done ? 1 : -1) * P.d * along;
          this.cy = this.sy + half;
          // A thud, and a small rock back off the face it slammed onto.
          this._landFlat(P.base + (done ? P.d * 90 : 0), impact * s * 0.35, 'roll', 0, (done ? -P.d : P.d) * (impact / DEG) * 0.6);
        }
      } else if (this.air) {
        const px0 = this.cx;
        const py0 = this.cy;
        this.vy -= this.gravity * dt;
        this.cx += this.vx * dt;
        this.cy += this.vy * dt;
        this.angle += this.av * dt;
        if (this.cx < minX + half) (this.cx = minX + half), (this.vx = Math.abs(this.vx) * 0.4);
        if (this.cx > maxX - half) (this.cx = maxX - half), (this.vx = -Math.abs(this.vx) * 0.4);
        // Contact: the lowest point of the turned square reaches the ground.
        const seen = this.angle + this._tilt(); // the angle as drawn
        const a = seen * DEG;
        const [hw0, hh0] = this._halfExtents();
        const ext = hh0 * Math.abs(Math.cos(a)) + hw0 * Math.abs(Math.sin(a));
        // Solids: stopped by their sides, bonks on their undersides, and their tops to land on.
        const level = this.solids.length ? this._airCollide(px0, py0, hw0 * Math.abs(Math.cos(a)) + hh0 * Math.abs(Math.sin(a)), ext) : 0;
        if (this.vy < 0 && this.cy - ext <= level) {
          const rel = ((((seen % 90) + 135) % 90) + 90) % 90 - 45; // -45..45 from the nearest face
          const base = seen - rel;
          const impact = -this.vy;
          // Extents along the face he's landing on (a quarter-turned body has them swapped).
          const odd = Math.round(base / 90) % 2 !== 0;
          const hw = odd ? hh0 : hw0;
          const hh = odd ? hw0 : hh0;
          this.air = false;
          this.vy = 0;
          this.sy = level;
          if (Math.abs(rel) < 15) {
            // He touched down on a corner, nearly flat: from here he rests on that corner (see
            // _render) and rocks down onto the face. Keep his centre where it is on screen.
            const d = rel >= 0 ? 1 : -1;
            const phi = Math.abs(rel) * DEG;
            this.cx -= d * (hw * (1 - Math.cos(phi)) + hh * Math.sin(phi));
            this.cy = level + half;
            this._landFlat(base, impact, 'flat', rel, this.av * 0.15);
          } else {
            // On a corner: rock on it and fall onto whichever face gravity picks.
            const d = rel > 0 ? 1 : -1;
            const phi = Math.abs(rel) * DEG;
            this.pivot = { px: this.cx + d * hw * Math.cos(phi) - d * hh * Math.sin(phi), d, phi, w: d * this.av * DEG * 0.35, base, push: 0 };
            this.av = 0;
            this.vx = 0;
            this.sp.stretch.kick(-0.8);
            this.emit('corner', { rel });
          }
        }
      } else {
        // On the ground: he sits on his bottom face; small slides from nudges.
        this.cx += this.vx * dt;
        this.vx *= Math.pow(0.0008, dt);
        this.angle = this.angleSettle.step(dt);
        if (this.cx < minX + half) (this.cx = minX + half), (this.vx = 0);
        if (this.cx > maxX - half) (this.cx = maxX - half), (this.vx = 0);
        if (this.solids.length) {
          for (const o of this.solids) {
            // A solid's side stops a slide.
            if (o.oneWay || !(o.T > this.sy + 1 && o.B < this.sy + s - 1)) continue;
            if (this.cx + half > o.L && this.cx - half < o.R) {
              if (this.vx > 0 || this.cx < (o.L + o.R) / 2) this.cx = Math.min(this.cx, o.L - half);
              else this.cx = Math.max(this.cx, o.R + half);
              this.vx = 0;
            }
          }
        }
        // What he stands on: ride it if it moves a little, fall if it goes away.
        const sup = this.solids.length ? this._supportAt(this.cx, half, this.sy) : 0;
        if (sup < this.sy - 0.5) {
          this.air = true;
          this.vy = 0;
        } else this.sy = sup;
        this.cy = this.sy + half;
      }
    }

    /** Landed on a face. The body is re-labelled upright; the eye keeps its place on screen. */
    _landFlat(base, impact, how, rel = 0, spin = 0) {
      const turns = Math.round(base / 90);
      const quarter = ((turns % 4) + 4) % 4; // which face is now on the ground
      const s = this.sp;
      if (quarter % 2) {
        // His local axes turn a quarter with the re-label: carry the squash across so his outline
        // stays exactly where it was (tall becomes wide).
        s.stretch.v = 2 - s.stretch.v;
        s.stretch.vel = -s.stretch.vel;
      }
      if (quarter) {
        // Carry the eye round by the same quarter turns, so nothing jumps on screen.
        const a = quarter * 90 * DEG;
        const x = s.ex.v;
        const y = s.ey.v;
        s.ex.v = x * Math.cos(a) - y * Math.sin(a);
        s.ey.v = x * Math.sin(a) + y * Math.cos(a);
        let r = (((s.er.v + quarter * 90) % 180) + 180) % 180;
        if (r > 90) r -= 180;
        s.er.v = r;
        s.ex.vel = s.ey.vel = s.er.vel = 0;
        this.eyeHold = Math.max(this.eyeHold, 0.35);
      }
      const t = this._tilt();
      this.angle = rel - t;
      this.angleSettle.snap(rel - t).to(0);
      this.angleSettle.vel = spin;
      this.av = 0;
      this.vx *= 0.25;
      const k = clamp(impact / (this.S * 7), 0, 1.4);
      // Squashed by the impact, springing back to 1 (only the value moves; the rest target stays 1).
      s.stretch.to(1);
      s.stretch.vel = Math.min(s.stretch.vel, 0) - 9.5 * k; // the impact pushes the squash in
      this.emit('land', { how, sideways: !!quarter, quarter, impact });
    }

    /** Air contact with solids. Returns the highest top he's coming down onto (or the ground, 0). */
    _airCollide(px0, py0, ex, ey) {
      let level = 0;
      const band = this.side * 0.14; // take-off squash/stretch never counts as hitting what he left
      for (const o of this.solids) {
        if (!(this.cx + ex > o.L + 0.3 && this.cx - ex < o.R - 0.3)) continue;
        const bottom = this.cy - ey;
        const top = this.cy + ey;
        if (py0 - ey >= o.T - band) {
          // Above it: a landing when he comes down onto its top.
          if (bottom <= o.T && o.T > level) level = o.T;
          continue;
        }
        if (o.oneWay) continue; // passing up through a ledge: no contact
        if (top <= o.B || bottom >= o.T) continue;
        if (py0 + ey <= o.B + 0.75 && this.vy > 0) {
          // Head first into its underside.
          this.cy = o.B - ey;
          this.vy = -this.vy * 0.2;
          this.emit('bonk', { id: o.id });
          continue;
        }
        // Into its side.
        if (px0 <= (o.L + o.R) / 2) {
          this.cx = o.L - ex - 0.3;
          this.vx = -Math.abs(this.vx) * 0.3;
        } else {
          this.cx = o.R + ex + 0.3;
          this.vx = Math.abs(this.vx) * 0.3;
        }
        this.emit('bump', { id: o.id });
      }
      return level;
    }

    _brain(dt, during = false) {
      const b = this.brainT;
      const s = this.sp;
      for (const k in b) b[k] -= dt;
      if (b.blink <= 0) {
        b.blink = this.mode === 'sleepy' ? rand(0.8, 1.6) : rand(2.2, 5.5);
        if (this.mode !== 'asleep') this.blink(Math.random() < 0.25 ? 'v' : 'auto');
      }
      if (during) return;
      if (b.glance <= 0) {
        b.glance = rand(1.1, 3.4);
        if ((!this.pointer || Math.random() < 0.3) && !(this.wander && this.wander.lookAt)) {
          // A saccade: a quick jump of the eye, then a hold.
          this.look = Math.random() < 0.35 ? { x: 0, y: 0 } : { x: rand(-0.9, 0.9), y: rand(-0.6, 0.5) };
        }
      }
      if (!this.M.brain) return;
      if (this.wander) return this._wanderTick();
      if (b.play <= 0) {
        b.play = rand(12, 26);
        this.do(pick(['eyeMorph', 'eyeTurn', 'stretch', 'hopInPlace', 'lookAround']));
      }
      if (b.stunt <= 0) {
        b.stunt = rand(45, 80);
        if (Math.random() < 0.6) this.do('flip', { outcome: 'auto', dir: Math.random() < 0.5 ? 1 : -1 });
        else this.do('roll', { dir: this.cx < this.W / 2 ? 1 : -1, n: 1 });
      }
    }

    /** A blink: 'h' closes top-down, 'v' closes side to side, 'auto' picks by the eye's shape. */
    blink(axis = 'auto') {
      const s = this.sp;
      if (axis === 'auto') axis = 'h';
      // The lids live in the eye's own frame: when the eye is turned upright, they swap roles.
      const turned = Math.abs((((s.er.v % 180) + 180) % 180) - 90) < 45;
      const lid = (axis === 'v') !== turned ? s.lidV : s.lidH;
      lid.to(0.06);
      clearTimeout(this._blinkT);
      this._blinkT = setTimeout(() => lid.to(1), 85);
    }

    // ---------- draw
    _render() {
      const s = this.sp;
      const S = this.side;
      const st = s.stretch.v;
      const sy = st;
      const sx = 1 + (1 - st) * 0.85;
      // The float's bob grows and fades with the hover itself, so entering or leaving thinking never jumps.
      const hov = s.hover.v + Math.sin(this.t * TAU * 0.45) * 2.4 * clamp(s.hover.v / 9, 0, 1);
      // The whole square is the body that meets the floor. Squash is along his own axes (a turning
      // square never skews), and whatever touches the floor, a face or a corner, stays on it.
      let hw = (S / 2) * sx;
      let hh = (S / 2) * sy;
      let rx, rh, ang;
      const onCorner = (px, d, phi) => {
        rx = px - d * hw * Math.cos(phi) + d * hh * Math.sin(phi);
        rh = hw * Math.sin(phi) + hh * Math.cos(phi);
      };
      if (this.pivot) {
        const P = this.pivot;
        if (Math.round(P.base / 90) % 2) {
          const t = hw;
          hw = hh;
          hh = t;
        }
        onCorner(P.px, P.d, clamp(P.phi, 0, Math.PI / 2));
        ang = this.angle;
      } else if (!this.air) {
        // Tilts (moods, leaning in, the beat, settling after a landing) tip him onto a bottom corner.
        ang = this.angle + s.tilt.v + s.lean.v;
        const d = ang >= 0 ? 1 : -1;
        onCorner(this.cx + d * hw, d, Math.min(Math.abs(ang), 44) * DEG);
      } else {
        rx = this.cx;
        rh = this.cy;
        ang = this.angle + s.tilt.v + s.lean.v;
      }
      if (!this.air) {
        rh += this.sy; // resting on a solid's top, not the stage floor
        // Squashed wide against a solid's side, he bulges away from it, never into it.
        if (this.solids.length && !this.pivot) {
          const a = Math.abs(ang) * DEG;
          const ext = hw * Math.cos(a) + hh * Math.sin(a);
          for (const o of this.solids) {
            if (o.oneWay || !(o.T > this.sy + 1 && o.B < this.sy + S - 1)) continue;
            if (rx < o.L && rx + ext > o.L) rx = o.L - ext;
            else if (rx > o.R && rx - ext < o.R) rx = o.R + ext;
          }
        }
      }
      this._rh = rh;
      const cyScreen = this.ground - rh - hov;
      this._rx = rx;
      this._ry = cyScreen;
      const tf = `translate(${f2(rx)} ${f2(cyScreen)}) rotate(${f2(ang)}) scale(${f3((sx * S) / 100)} ${f3((sy * S) / 100)})`;
      if (tf !== this._tf) {
        this.bodyG.setAttribute('transform', tf);
        this._tf = tf;
      }
      // Colour: one solid fill for the whole body. Hue shifts change all of it at once.
      const fill = color(s.L.v, Math.max(0, s.C.v), s.H.v);
      if (fill !== this._fill) {
        this.body.style.fill = fill;
        this._fill = fill;
      }
      // Eye: a rectangular hole, turned by its rotation, cut out of the square.
      const ew = Math.max(0.5, s.ew.v);
      const eh = Math.max(0.5, s.eh.v);
      const lidH = clamp(s.lidH.v, 0.04, 1.2);
      const lidV = clamp(s.lidV.v, 0.04, 1.2);
      const w2 = (ew * lidV) / 2;
      const h2 = (eh * lidH) / 2;
      const er = s.er.v * DEG;
      const ec = Math.cos(er);
      const es = Math.sin(er);
      const ex = s.ex.v;
      const ey = s.ey.v;
      const pt = (x, y) => `${f2(ex + x * ec - y * es)} ${f2(ey + x * es + y * ec)}`;
      const d = `M-50 -50H50V50H-50ZM${pt(-w2, -h2)}L${pt(w2, -h2)}L${pt(w2, h2)}L${pt(-w2, h2)}Z`;
      if (d !== this._d) {
        this.body.setAttribute('d', d);
        this._d = d;
      }
    }

    /** Where to anchor a speech bubble: the top centre of his head, in stage units. */
    anchor() {
      return { x: this._rx ?? this.cx, y: (this._ry ?? this.ground - this.cy - this.sp.hover.v) - this.side * 0.62 };
    }

    /** A plain snapshot of the current state, for feedback and debugging. */
    snapshot() {
      const s = this.sp;
      const r = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
      return {
        mode: this.mode,
        action: this.taskName || null,
        body: { x: r(this.cx, 1), height: r(this.cy, 1), angle: r(this.angle, 1), squash: r(s.stretch.v, 3), grow: r(s.grow.v, 2), airborne: this.air, onCorner: !!this.pivot, support: r(this.sy, 1) },
        eye: { x: r(s.ex.v, 1), y: r(s.ey.v, 1), w: r(s.ew.v, 1), h: r(s.eh.v, 1), rotation: r(s.er.v, 1), lidH: r(s.lidH.v), lidV: r(s.lidV.v) },
        colour: { oklch: [r(s.L.v, 3), r(s.C.v, 3), r(((s.H.v % 360) + 360) % 360, 1)] },
        ...(this.wander ? { wander: { seed: this.wander.planner.seed, intent: this.wander.last ? this.wander.last.kind : null } } : {}),
      };
    }

    /** Move the stage size (e.g. on resize). */
    resize(width, height, floor = this.floor) {
      this.W = width;
      this.H = height;
      this.floor = floor;
      this.ground = height - floor;
      this.bounds = [0, width];
      this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      if (this.envSrc || this.nav) this.setEnvironment(this.envSrc);
    }

    destroy() {
      instances.delete(this);
      io?.unobserve(this.svg);
      this.svg.remove();
    }
  }

  // ---------------------------------------------------------------- actions
  // Each action is a generator: `yield` waits one frame and receives dt. Helpers below.
  function* wait(q, secs, ctx) {
    let t = 0;
    while (t < secs) {
      if (ctx?.cancelled) return;
      t += yield;
    }
  }
  function* untilGrounded(q, ctx, max = 4) {
    let t = 0;
    yield;
    while ((q.air || q.pivot) && t < max) t += yield;
  }
  function* crouch(q, depth = 0.8, secs = 0.14) {
    if (q.air || q.pivot) yield* untilGrounded(q, null); // no pushing off thin air: land first
    q.sp.stretch.to(depth);
    q.sp.ew.to(q.M.eye.w + 4);
    q.sp.eh.to(Math.max(3, q.M.eye.h * 0.6));
    let t = 0;
    while (t < secs) t += yield;
  }
  function eyeBack(q) {
    q.sp.ew.to(q.M.eye.w);
    q.sp.eh.to(q.M.eye.h);
  }

  const ACTIONS = {
    /** A small hop in place. */
    *hopInPlace(q) {
      yield* crouch(q, 0.86, 0.1);
      eyeBack(q);
      q.launch(0.32);
      yield* untilGrounded(q);
    },
    /** Hop sideways: dir -1 or 1, distance in body sides. */
    *hop(q, { dir = 1, dist = 0.6 } = {}) {
      q.look = { x: dir, y: 0 };
      yield* crouch(q, 0.84, 0.09);
      eyeBack(q);
      const h = 0.22;
      const T = q.flightTime(h);
      q.launch(h, (dir * dist * q.side) / T, dir * 8);
      yield* untilGrounded(q);
      q.av = 0;
    },
    /** Hop over to an x position (stage units). With an environment, he takes the best route there. */
    *moveTo(q, { x }, ctx) {
      if (q.envSrc && q.nav) return yield* ACTIONS.goTo(q, { x, y: q.ground - q.sy, mode: 'nearest' }, ctx);
      const target = clamp(x, q.side / 2, q.W - q.side / 2);
      for (let i = 0; i < 40; i++) {
        if (ctx.cancelled) break;
        const d = target - q.cx;
        if (Math.abs(d) < q.side * 0.12) break;
        const dist = Math.min(Math.abs(d) / q.side, 0.75);
        yield* ACTIONS.hop(q, { dir: Math.sign(d), dist });
        yield* wait(q, 0.04, ctx);
      }
      q.look = { x: 0, y: 0 };
    },
    *move(q, { dx = 1 }, ctx) {
      yield* ACTIONS.moveTo(q, { x: q.cx + dx * q.side }, ctx);
    },
    /** A big straight jump. */
    *jump(q, { height = 1.1 } = {}) {
      q.look = { x: 0, y: -0.8 };
      yield* crouch(q, 0.72, 0.16);
      eyeBack(q);
      q.sp.stretch.to(1);
      q.sp.stretch.kick(1.8);
      q.launch(height);
      yield* untilGrounded(q);
      q.look = { x: 0, y: 0 };
    },
    /**
     * A flip. dir 1 = forward (clockwise), -1 = backflip. outcome: 'success' (lands it and
     * celebrates), 'side' (a quarter short: lands on his side), 'corner' (lands on a corner, rocks,
     * topples), or 'auto' (he's still learning: mostly misses, sometimes nails it).
     */
    *flip(q, { dir = -1, outcome = 'auto', height = 1.5 } = {}, ctx) {
      if (outcome === 'auto') outcome = pick(['side', 'corner', 'success', 'side', 'corner']);
      // Wind-up: look up, squint with determination, deep crouch.
      q.look = { x: 0, y: -1 };
      q.sp.ew.to(36);
      q.sp.eh.to(5);
      yield* wait(q, 0.25, ctx);
      yield* crouch(q, 0.62, 0.22);
      q.sp.eh.to(q.M.eye.h);
      const T = q.flightTime(height);
      // How far round he gets: a full turn, or short of it.
      const miss = outcome === 'success' ? rand(-6, 6) : outcome === 'side' ? -90 + rand(-4, 4) : -rand(30, 58);
      const total = 360 + miss;
      // Contact comes a little before the full flight time (the corner sweeps down), so aim for
      // the turn to complete just at touchdown.
      q.launch(height, 0, (dir * total) / (T * 0.97));
      q.sp.stretch.kick(2.4);
      q.emit('say', { text: pick(['Hup!', 'Here goes!', 'Watch this!']) });
      yield* untilGrounded(q, ctx, 6);
      // How did it go?
      const landedUpright = !q.lastLand?.sideways;
      if (outcome === 'success' && landedUpright) {
        yield* ACTIONS.celebrate(q, {}, ctx);
      } else {
        // Missed: he's on his side (or tipped over). A beat of embarrassment, then he rights his eye.
        const prev = q.mode;
        q.setMode('embarrassed');
        q.eyeHold = 1.4;
        q.emit('say', { text: pick(['Almost.', 'Nailed it. Mostly.', 'I meant to do that.', 'Next one.']) });
        yield* wait(q, 1.6, ctx);
        q.eyeHold = 0;
        q.setMode(prev === 'embarrassed' ? 'idle' : prev);
        yield* wait(q, 0.6, ctx);
      }
    },
    /** Roll over: dir -1 or 1, n quarter turns. */
    *roll(q, { dir = 1, n = 1 } = {}, ctx) {
      for (let i = 0; i < n; i++) {
        if (ctx.cancelled) break;
        if (q.air || q.pivot) yield* untilGrounded(q, ctx);
        q.look = { x: dir, y: 0.3 };
        q.sp.stretch.to(1);
        q.sp.tilt.to(0);
        q.sp.lean.to(0);
        yield* wait(q, Math.abs(q._tilt()) > 1 ? 0.22 : 0.06, ctx);
        const blocked = q._blocked(dir, q.side * 1.05);
        q.roll(dir);
        if (blocked && q.pivot) q.pivot.w *= 0.55; // a solid in the way: he tips toward it and rocks back
        yield* untilGrounded(q, ctx, 3);
        q.eyeHold = 0.12;
      }
      q.sp.tilt.to(q.M.tilt || 0);
      q.sp.lean.to(q.M.lean || 0);
      q.look = { x: 0, y: 0 };
    },
    /** The power-up: grows in steps, flickering, like a certain plumber. */
    *grow(q, { scale = 1.6 } = {}, ctx) {
      const g = q.sp.grow;
      const steps = [1.25, 1.08, 1.4, 1.2, scale];
      q.emit('say', { text: 'Power up!' });
      for (const v of steps) {
        g.to(v);
        g.kick(3);
        yield* wait(q, 0.11, ctx);
      }
    },
    *shrink(q, {}, ctx) {
      const g = q.sp.grow;
      for (const v of [1.3, 1.45, 1.15, 1.25, 1]) {
        g.to(v);
        yield* wait(q, 0.1, ctx);
      }
    },
    *blink(q, { axis = 'auto' } = {}, ctx) {
      q.blink(axis);
      yield* wait(q, 0.2, ctx);
    },
    *doubleBlink(q, { axis = 'h' } = {}, ctx) {
      q.blink(axis);
      yield* wait(q, 0.22, ctx);
      q.blink(axis);
      yield* wait(q, 0.25, ctx);
    },
    /** Turn the eye upright (a rotation) and back. */
    *eyeTurn(q, { hold = 0.8 } = {}, ctx) {
      q.eyeHold = hold + 0.9;
      q.sp.er.to(90);
      yield* wait(q, 0.45 + hold, ctx);
      q.blink('v');
      yield* wait(q, 0.15, ctx);
      q.sp.er.to(0);
      yield* wait(q, 0.5, ctx);
      q.eyeHold = 0;
    },
    /** Reshape the eye upright without rotating it (width and height trade places), and back. */
    *eyeMorph(q, { hold = 0.8 } = {}, ctx) {
      const e = q.M.eye;
      q.eyeHold = hold + 1;
      q.sp.ew.to(e.h);
      q.sp.eh.to(e.w);
      yield* wait(q, 0.5 + hold, ctx);
      q.blink('v');
      yield* wait(q, 0.12, ctx);
      q.sp.ew.to(e.w);
      q.sp.eh.to(e.h);
      yield* wait(q, 0.5, ctx);
      q.eyeHold = 0;
    },
    *lookAround(q, {}, ctx) {
      for (const p of [{ x: -1, y: -0.2 }, { x: 1, y: -0.2 }, { x: 0, y: 0 }]) {
        q.look = p;
        yield* wait(q, 0.55, ctx);
      }
    },
    /** A tall stretch, then a settle. */
    *stretch(q, {}, ctx) {
      q.sp.stretch.to(1.14);
      q.look = { x: 0, y: -1 };
      q.sp.eh.to(3);
      yield* wait(q, 0.55, ctx);
      q.sp.stretch.to(0.9);
      yield* wait(q, 0.18, ctx);
      q.sp.stretch.to(1);
      eyeBack(q);
      q.look = { x: 0, y: 0 };
      yield* wait(q, 0.3, ctx);
    },
    /** Celebrate: his whole colour sweeps round the wheel, with two little hops. */
    *celebrate(q, {}, ctx) {
      const t0 = q.t;
      const [L0, C0] = q.M.color;
      q.colorOverride = (t) => (t - t0 < 1.5 ? [0.78, 0.2, q.M.color[2] + (t - t0) * 300] : null);
      q.sp.eh.to(5);
      q.sp.ew.to(36);
      q.emit('say', { text: pick(['Yes!', 'Stuck it!', 'Ta-da!']) });
      for (let i = 0; i < 2; i++) {
        yield* crouch(q, 0.84, 0.07);
        q.launch(0.38);
        yield* untilGrounded(q, ctx);
      }
      eyeBack(q);
      yield* wait(q, 0.4, ctx);
      void L0;
      void C0;
    },
    /** Yes: two quick squash nods. */
    *nod(q, {}, ctx) {
      for (let i = 0; i < 2; i++) {
        q.sp.stretch.to(0.88);
        q.look = { x: 0, y: 0.6 };
        yield* wait(q, 0.13, ctx);
        q.sp.stretch.to(1.03);
        q.look = { x: 0, y: -0.1 };
        yield* wait(q, 0.15, ctx);
      }
      q.look = { x: 0, y: 0 };
    },
    /** No: the eye glances side to side. */
    *shake(q, {}, ctx) {
      for (const x of [-1, 1, -1, 1, 0]) {
        q.look = { x, y: 0 };
        q.sp.tilt.to(x * 3);
        yield* wait(q, 0.12, ctx);
      }
      q.sp.tilt.to(q.M.tilt || 0);
    },
    /** A shiver: for errors. */
    *shiver(q, {}, ctx) {
      for (let i = 0; i < 8; i++) {
        q.vx = (i % 2 ? 1 : -1) * q.S * 1.6;
        yield* wait(q, 0.04, ctx);
      }
      q.vx = 0;
    },
    /** Waking up from sleep: the lid lifts (a slow vertical un-blink), a start, a little hop. */
    *wake(q, { to = 'listening' } = {}, ctx) {
      q.sp.lidH.snap(0.1);
      q.setMode('surprised');
      q.sp.lidH.to(1);
      yield* wait(q, 0.18, ctx);
      q.launch(0.25);
      yield* untilGrounded(q, ctx);
      q.setMode(to);
      yield* wait(q, 0.3, ctx);
    },
    /** Dozing off: heavy lid, a slow sink, then asleep. */
    *sleep(q, {}, ctx) {
      q.setMode('sleepy');
      yield* wait(q, 1.6, ctx);
      q.blink('h');
      yield* wait(q, 0.6, ctx);
      q.setMode('asleep');
    },
    /** A quick look at something (x, y in -1..1), held. */
    *glance(q, { x = 0, y = 0, hold = 0.8 } = {}, ctx) {
      q.look = { x, y };
      yield* wait(q, hold, ctx);
    },
    /** Notice: a little start, the eye pops tall and looks up to one side, then settles. */
    *wonder(q, {}, ctx) {
      q.sp.stretch.kick(1.4);
      q.sp.eh.to(q.M.eye.h * 1.9);
      q.sp.ew.to(q.M.eye.w * 0.75);
      q.sp.tilt.to((q.M.tilt || 0) + 4);
      q.look = { x: 0.7, y: -0.7 };
      yield* wait(q, 0.9, ctx);
      eyeBack(q);
      q.sp.tilt.to(q.M.tilt || 0);
      q.look = { x: 0, y: 0 };
      yield* wait(q, 0.2, ctx);
    },
    /** Just wait (useful in sequences). */
    *pause(q, { secs = 0.5 } = {}, ctx) {
      yield* wait(q, secs, ctx);
    },

    /**
     * Go to (x, y) in stage units by the best route (OrbitNav), with his own moves. style: 'amble',
     * 'brisk' (default) or 'bold'. mode: how (x, y) maps to a surface ('gravity': the surface under
     * the point, or the top of the solid it's inside; 'nearest'). Emits 'path' ({ path, target }) when
     * a route is planned (path null: unreachable) and 'arrive' when he gets there.
     */
    *goTo(q, { x, y, style = 'brisk', mode = 'gravity', surface } = {}, ctx) {
      if (q.air || q.pivot) yield* untilGrounded(q, ctx);
      if (ctx.cancelled) return;
      if (!q.nav && !q._syncNav()) {
        // No pathing module on the page: plain hops along the floor.
        const target = clamp(x, q.side / 2, q.W - q.side / 2);
        for (let i = 0; i < 40 && !ctx.cancelled && Math.abs(target - q.cx) > q.side * 0.12; i++) yield* ACTIONS.hop(q, { dir: Math.sign(target - q.cx), dist: Math.min(Math.abs(target - q.cx) / q.side, 0.75) });
        return;
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        if (ctx.cancelled) break;
        const path = q.plan(x, y, { mode, surface });
        if (!path) {
          q.emit('path', { path: null, target: { x, y } });
          ctx.failed = true; // the promise resolves false
          yield* noRoute(q, x, y, ctx);
          return;
        }
        q.route = path;
        q.emit('path', { path, target: path.goal, nav: q.nav });
        const res = yield* runPath(q, path, STYLES[style] || STYLES.brisk, ctx);
        if (res === 'done') {
          q.route = null;
          q.emit('arrive', { x: q.cx, y: q.ground - q.sy });
          break;
        }
        if (res === 'cancel') break;
        yield* wait(q, 0.08, ctx); // re-plan from wherever he is
      }
      q.route = null;
      if (!ctx.cancelled) q.look = { x: 0, y: 0 };
    },

    /** Idle life: one planned move, with settle beats before (the eye goes first) and after. */
    *_wanderMove(q, { intent }, ctx) {
      const tg = intent.target;
      q._gazeAt({ x: tg.x, y: tg.y - q.side * 0.5 });
      yield* wait(q, intent.settleBefore || 0.3, ctx);
      if (ctx.cancelled) return;
      yield* ACTIONS.goTo(q, { x: tg.x, y: tg.y, surface: tg.surface && tg.surface.id, style: intent.style }, ctx);
      if (ctx.cancelled) return;
      q.sp.stretch.kick(-0.6); // a little settle into the new spot
      yield* wait(q, intent.settleAfter || 0.4, ctx);
      if (intent.kind === 'perch' && !ctx.cancelled) yield* ACTIONS.lookAround(q, {}, ctx);
    },
  };

  // ---------------------------------------------------------------- route running
  // Gaits: hop length and height in body sides, crouch depth and time, the beat between hops.
  const STYLES = {
    amble: { dist: 0.5, h: 0.17, crouch: 0.88, crouchT: 0.1, gap: 0.08 },
    brisk: { dist: 0.72, h: 0.22, crouch: 0.84, crouchT: 0.09, gap: 0.04 },
    bold: { dist: 0.82, h: 0.27, crouch: 0.8, crouchT: 0.085, gap: 0.03 },
  };
  // What idle life may choose to do on the spot (weights; tricks scale with playfulness).
  const QUBIT_FIDGETS = [
    { name: 'lookAround', weight: 1.1 },
    { name: 'eyeMorph', weight: 0.8 },
    { name: 'eyeTurn', weight: 0.6 },
    { name: 'stretch', weight: 0.9 },
    { name: 'hopInPlace', weight: 0.8 },
    { name: 'doubleBlink', weight: 0.5 },
    { name: 'wonder', weight: 0.4 },
    { name: 'flip', weight: 0.42, trick: true, params: { outcome: 'auto' } },
    { name: 'roll', weight: 0.25, trick: true },
  ];
  function* runPath(q, path, st, ctx) {
    for (let i = 0; i < path.length; i++) {
      const m = path[i];
      if (ctx.cancelled) return 'cancel';
      if (q.nav.version !== path.version) return 'replan'; // the UI moved under him
      if (Math.abs(q.ground - q.sy - m.from.y) > 2 || Math.abs(q.cx - m.from.x) > q.side * 0.4) return 'replan';
      const dx = m.to.x - m.from.x;
      const dir = Math.abs(dx) > 0.5 ? Math.sign(dx) : 0;
      if (dir) yield* face(q, dir, m, ctx);
      if (ctx.cancelled) return 'cancel';
      if (m.type === 'walk') yield* walkTo(q, m.to.x, st, ctx);
      else yield* leap(q, m, st, ctx);
      if (ctx.cancelled) return 'cancel';
      if (Math.abs(q.ground - q.sy - m.to.y) > 2) return 'replan'; // landed somewhere else
    }
    const end = path[path.length - 1];
    return !end || Math.abs(q.cx - end.to.x) < q.side * 0.2 ? 'done' : 'replan';
  }
  /** Face the way he's going. Reversing is a beat: the eye swings across first, a small weight shift. */
  function* face(q, dir, m, ctx) {
    const up = m.to.y < m.from.y - 1 ? -0.55 : m.to.y > m.from.y + 1 ? 0.5 : 0;
    if (q.facing && q.facing !== dir) {
      q.look = { x: 0, y: up * 0.5 };
      q.sp.stretch.kick(-0.7);
      yield* wait(q, 0.09, ctx);
      q.look = { x: dir * 0.9, y: up };
      yield* wait(q, 0.16, ctx);
    } else q.look = { x: dir * 0.85, y: up };
    q.facing = dir;
  }
  /** Hop along the surface to x, in equal hops so the last one lands exactly. */
  function* walkTo(q, x, st, ctx) {
    const half = q.side / 2;
    const n = Math.max(1, Math.ceil(Math.abs(x - q.cx) / (st.dist * q.side) - 0.15));
    for (let k = 0; k < n; k++) {
      if (ctx.cancelled) return;
      const step = (x - q.cx) / (n - k);
      if (Math.abs(step) < 0.6) break;
      const tx = q.cx + step;
      // Low ceilings make for lower hops.
      const room = q._headroom(Math.min(q.cx, tx) - half, Math.max(q.cx, tx) + half);
      const h = Math.max(0.04, Math.min(st.h * rand(0.9, 1.1), (room - 2) / q.side));
      yield* crouch(q, room < q.side * 0.2 ? 0.94 : st.crouch, st.crouchT);
      eyeBack(q);
      q.launchTo(tx, q.sy, q.sy + h * q.side, Math.sign(step) * 8);
      yield* untilGrounded(q, ctx);
      q.av = 0;
      if (k < n - 1) yield* wait(q, st.gap, ctx);
    }
  }
  /** A hop, jump or drop onto another surface: crouch, a ballistic arc to the exact spot, land. */
  function* leap(q, m, st, ctx) {
    const level = q.ground - m.to.y;
    const apex = m.apex ? q.ground - m.apex.y : Math.max(q.sy, level) + q.side * 0.2;
    const dir = Math.sign(m.to.x - m.from.x);
    if (m.type === 'jump') {
      // Wind up: look where he's going, deep crouch, stretch off the ground.
      q.look = { x: dir * 0.8, y: level > q.sy ? -0.8 : 0.3 };
      yield* crouch(q, 0.7, 0.17);
      eyeBack(q);
      q.sp.stretch.kick(1.6);
    } else if (m.type === 'drop') {
      q.look = { x: dir * 0.7, y: 0.85 };
      yield* crouch(q, 0.9, 0.08);
      eyeBack(q);
    } else {
      yield* crouch(q, 0.85, 0.09);
      eyeBack(q);
    }
    if (ctx.cancelled) return;
    q.launchTo(m.to.x, level, apex, dir * (m.type === 'jump' ? 10 : 6));
    let t = 0;
    while (q.air && t < 4) {
      if (q.vy < 0 && m.type !== 'hop') q.look = { x: dir * 0.5, y: 0.8 }; // spotting the landing
      t += yield;
    }
    yield* untilGrounded(q, ctx);
    q.av = 0;
    q.look = { x: dir * 0.6, y: 0 };
  }
  /** No way there: he looks at it, then a small shake. */
  function* noRoute(q, x, y, ctx) {
    q._gazeAt({ x, y });
    q.sp.eh.to(q.M.eye.h * 1.4);
    yield* wait(q, 0.5, ctx);
    q.emit('noroute', { x, y });
    yield* ACTIONS.shake(q, {}, ctx);
    eyeBack(q);
  }

  // Remember the last landing (actions check it after a jump).
  Qubit.prototype._emitLand = Qubit.prototype.emit;
  Qubit.prototype.emit = function (type, data) {
    if (type === 'land') this.lastLand = data;
    return this._emitLand(type, data);
  };

  global.QubitEngine = {
    create: (opts) => new Qubit(opts),
    Qubit,
    Spring,
    HueSpring,
    MODES,
    ACTIONS: Object.keys(ACTIONS).filter((k) => k[0] !== '_'),
    STYLES,
    FIDGETS: QUBIT_FIDGETS,
    TUNING,
    PALETTE,
    ticker,
    color,
  };
})(typeof window !== 'undefined' ? window : globalThis);
