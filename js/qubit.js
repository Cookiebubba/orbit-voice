/* ===========================================================================
   Qubit on the website: he lives along the bottom of every page.

   His engine and pathing are Orbit's own (qubit-engine.js and orbit-nav.js, copied as is from
   ui/src/vendor/avatars/). This file only directs him: the bottom of the screen is his floor, the
   engine's seeded idle life fills quiet time (hops, wandering, looks, tricks), and now and then a
   moment of his own takes over, as in the Qubit demo:
     - talking: speaking mode, his eye is his mouth, with a feeling or two timed into the words
       (the same feelings, moods and moves the app's voice cues use);
     - a chat: he listens (cyan, eye stretching with your "voice"), thinks, then answers;
     - a trick, a mood, a short nap, a look at the download button.
   He notices the cursor coming near him. No sound and no speech bubbles.

   Everything runs on the engine's clock, so it all pauses with the tab hidden (no frames, no
   timers). While he's still, the engine drops to 30 fps. Reduced motion: he rests quietly.
   ?seed=N in the address replays the same life.
=========================================================================== */

// Feelings while he talks: the app's emote cues (ui/src/qubit/director.js EMOTES), each one of his
// own moods for a moment (`mode`, `hold` seconds; his eye stays his mouth) and/or a move in place.
const EMOTES = {
  happy: { mode: "happy", act: "hopInPlace", hold: 1.3 },
  excited: { act: "celebrate", hold: 1.6 },
  curious: { mode: "curious", hold: 1.4 },
  surprised: { mode: "surprised", hold: 0.9 },
  proud: { mode: "happy", act: "stretch", hold: 1.3 },
  sad: { mode: "sad", hold: 1.6 },
  embarrassed: { mode: "embarrassed", hold: 1.4 },
  nod: { act: "nod", hold: 0.6 },
  shake: { act: "shake", hold: 0.7 },
  wonder: { act: "wonder", hold: 1.1 },
  hop: { act: "hopInPlace", hold: 0.6 },
};
// How often each one comes up on the site (sad and embarrassed rarely: it's a welcome).
const EMOTE_WEIGHTS = { happy: 3, excited: 1.4, curious: 2, surprised: 1.2, proud: 1.4, sad: 0.25, embarrassed: 0.35, nod: 2.4, shake: 0.6, wonder: 1.4, hop: 1.6 };
const EMOTE_ACTS = new Set(Object.values(EMOTES).map(e => e.act).filter(Boolean));

// Seeded randomness (mulberry32), so ?seed=N replays the same life.
function rng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.pick = list => list[Math.floor(r() * list.length)];
  r.weighted = weights => {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    let x = r() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) if ((x -= w) <= 0) return k;
    return entries[entries.length - 1][0];
  };
  return r;
}

const CANCEL = Symbol("cancel");

export function startQubit(mount) {
  const QE = window.QubitEngine;
  if (!mount || !QE || !window.OrbitNav) return null;

  const fromUrl = Number(new URLSearchParams(location.search).get("seed"));
  const seed = fromUrl > 0 ? Math.floor(fromUrl) : Math.floor(Math.random() * 0xffffff) + 1;
  const R = rng(seed);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- geometry: the strip's size and his, from the page's own CSS (they scale with rem)
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const cssLen = name => {
    const v = getComputedStyle(mount).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return v.endsWith("rem") ? n * rem() : n;
  };
  const geo = () => ({ W: Math.round(mount.clientWidth), H: Math.round(mount.clientHeight), side: Math.round(cssLen("--q-side") || 56), floor: Math.round(cssLen("--q-floor") || 20) });

  let q = null;
  let g = geo();
  const margin = () => Math.max(12, Math.round(g.side * 0.3));

  // Places worth a look: the main download button, seen from his floor.
  function interests() {
    const btn = document.getElementById("download");
    if (!btn || !q) return [];
    const r = btn.getBoundingClientRect(), m = mount.getBoundingClientRect();
    if (!r.width) return [];
    return [{ x: r.left + r.width / 2 - m.left, y: q.ground, kind: "download", weight: 0.7 }];
  }
  function fit() {
    q.bounds = [margin(), g.W - margin()];
    q.setEnvironment({ solids: [] }); // the bottom of the screen is his floor; nothing else to stand on
    q.cx = Math.min(Math.max(q.cx, q.bounds[0] + q.side / 2), q.bounds[1] - q.side / 2);
    if (q.wander) {
      q.wander.planner.setHome({ x: g.W / 2, y: q.ground });
      q.wander.planner.setInterests(interests());
    }
  }
  function make(x, entrance) {
    q?.destroy();
    q = QE.create({ mount, width: g.W, height: g.H, size: g.side, floor: g.floor, x, mode: "idle" });
    window.__qubit = { q, seed }; // for poking at him in the console (and the preview captures)
    fit();
    if (entrance) {
      // He drops in from the top of his strip and lands.
      q.air = true;
      q.vy = 0;
      q.cy = g.H - g.floor - q.side * 0.6;
    }
    applyMotion();
  }

  // ---------- reduced motion: he rests quietly (breathes and blinks; no wandering, tricks or moments)
  function applyMotion() {
    if (reduce.matches) {
      cancelMoment();
      q.setWander(false);
      q.brainT.play = q.brainT.stunt = Infinity;
      if (q.mode !== "idle") q.setMode("idle");
      QE.ticker.lowPower = true;
    } else if (!q.wander) {
      q.brainT.play = R.range(14, 24);
      q.brainT.stunt = R.range(40, 70);
      q.setWander(true, { seed, home: { x: g.W / 2, y: q.ground }, interests: interests(), quiet: 2.5, delay: 2.2 });
    }
  }
  reduce.addEventListener?.("change", applyMotion);

  // ---------- his clock: waits on the engine's time, so a hidden tab pauses everything
  const timers = [];
  let gen = 0; // bumps to cancel the running moment
  const step = (secs, my) =>
    new Promise((resolve, reject) => timers.push({ at: q.t + secs, resolve: () => (my === gen ? resolve() : reject(CANCEL)) }));
  async function grounded(my) {
    while (q.air || q.pivot) await step(0.05, my);
  }
  async function act(name, params, my) {
    const done = await q.do(name, params);
    if (my !== gen) throw CANCEL;
    return done;
  }

  // ---------- a voice for his eye (no sound): words and pauses, as the demo's simulated levels
  const voice = { in: 0, out: 0, inUntil: 0, words: [] }; // words: [start, end] in engine time
  function speech(secs) {
    // Words of varied length, short gaps, a breath every few words.
    voice.words = [];
    let t = q.t + 0.06, n = 0;
    while (t < q.t + secs) {
      const w = R.range(0.14, 0.38);
      voice.words.push([t, Math.min(t + w, q.t + secs)]);
      t += w + (++n % (3 + Math.floor(R() * 4)) === 0 ? R.range(0.22, 0.42) : R.range(0.04, 0.11));
    }
  }
  const speaking = () => voice.words.length && q.t < voice.words[voice.words.length - 1][1];

  // ---------- moments: what he does between stretches of his own idle life
  let busy = false;
  let nextAt = 0;
  let last = "";
  let feel = null; // a feeling while he talks: { mode, until }

  function cancelMoment() {
    gen++;
    busy = false;
    feel = null;
    voice.words = [];
    voice.inUntil = 0;
    if (q) q.talking = false;
  }

  function emote(name) {
    const e = EMOTES[name];
    if (e.mode) q.setMode(e.mode);
    if (e.act && (!q.busy || EMOTE_ACTS.has(q.taskName))) q.do(e.act, {}, { interrupt: q.busy });
    feel = { mode: e.mode || null, until: q.t + e.hold };
  }

  async function talk(my, secs = R.range(2.4, 5)) {
    q.look = { x: 0, y: 0 };
    q.setMode("speaking");
    q.talking = true;
    speech(secs);
    // An emote or two, timed into the words (each at the start of a word, like a voice cue).
    const n = R() < 0.7 ? 1 : 2;
    const cues = [];
    for (let i = 0; i < n; i++) {
      const word = voice.words[Math.floor(R.range(0.15, 0.75) * voice.words.length)];
      if (word && !cues.some(c => Math.abs(c.at - word[0]) < 1.2)) cues.push({ at: word[0], name: R.weighted(EMOTE_WEIGHTS) });
    }
    cues.sort((a, b) => a.at - b.at);
    for (const c of cues) {
      await step(Math.max(0, c.at - q.t), my);
      emote(c.name);
    }
    while (speaking() || q.busy) await step(0.05, my);
    q.talking = false;
    feel = null;
    q.setMode("idle");
  }

  async function chat(my) {
    // You speak to him: he listens, his eye stretching with your voice...
    q.setMode("listening");
    voice.inUntil = q.t + R.range(1.4, 2.6);
    await step(voice.inUntil - q.t + 0.35, my);
    // ...thinks it over...
    q.setMode("thinking");
    await step(R.range(0.8, 1.6), my);
    // ...and answers.
    await talk(my);
  }

  async function trick(my) {
    const room = dir => {
      const x = q.cx + dir * q.side * 1.6;
      return x - q.side / 2 > q.bounds[0] && x + q.side / 2 < q.bounds[1];
    };
    const name = R.weighted({ flip: 3, roll: 1.4, jump: 1.2, celebrate: 1, hops: 1, grow: 0.6 });
    if (name === "flip") await act("flip", { outcome: "auto", dir: R() < 0.5 ? 1 : -1 }, my);
    else if (name === "roll") {
      let dir = q.cx < g.W / 2 ? 1 : -1;
      if (R() < 0.35 && room(-dir)) dir = -dir;
      if (room(dir)) await act("roll", { dir, n: 1 }, my);
      else await act("hopInPlace", {}, my);
    } else if (name === "jump") await act("jump", { height: R.range(1, 1.4) }, my);
    else if (name === "celebrate") {
      q.setMode("happy");
      await act("celebrate", {}, my);
      await step(0.4, my);
      q.setMode("idle");
    } else if (name === "hops") {
      await act("hopInPlace", {}, my);
      await act("hopInPlace", {}, my);
    } else {
      await act("grow", { scale: 1.45 }, my);
      await step(R.range(1.2, 2), my);
      await act("shrink", {}, my);
    }
  }

  async function mood(my) {
    const name = R.weighted({ happy: 2, curious: 1.6, surprised: 1, music: 1.2 });
    if (name === "music") {
      q.setMode("music");
      await step(R.range(4, 7), my);
    } else {
      q.setMode(name);
      if (name === "curious") q.look = { x: R.range(-0.8, 0.8), y: -0.7 };
      await step(name === "surprised" ? 0.9 : R.range(1.4, 2.4), my);
      q.look = { x: 0, y: 0 };
    }
    q.setMode("idle");
  }

  async function nap(my) {
    await act("sleep", {}, my);
    await step(R.range(3.5, 6.5), my);
    await act("wake", { to: "idle" }, my);
  }

  async function visit(my) {
    // Under the download button, a look up at it, a happy hop.
    const spot = interests()[0];
    if (!spot) return trick(my);
    await act("goTo", { x: spot.x + R.range(-0.4, 0.4) * q.side, y: q.ground, style: "brisk" }, my);
    q.look = { x: 0, y: -1 };
    await step(0.8, my);
    q.setMode("happy");
    await act("hopInPlace", {}, my);
    await step(0.6, my);
    q.look = { x: 0, y: 0 };
    q.setMode("idle");
  }

  const MOMENTS = { talk, chat, trick, mood, nap, visit };
  async function moment() {
    const my = ++gen;
    busy = true;
    try {
      const w = { talk: 3, chat: 2, trick: 2.4, mood: 1.3, nap: 0.6, visit: interests().length ? 0.8 : 0 };
      if (last) w[last] *= 0.25; // rarely the same thing twice in a row
      const kind = R.weighted(w);
      last = kind;
      await act("pause", { secs: 0.15 }, my); // idle life steps aside
      await grounded(my);
      await MOMENTS[kind](my);
    } catch (e) {
      if (e !== CANCEL) console.error(e);
    } finally {
      if (my === gen) {
        busy = false;
        q.talking = false;
        nextAt = q.t + R.range(5, 11);
      }
    }
  }

  // ---------- the cursor
  let pointer = null;
  let reactAt = 0;
  const local = e => {
    const m = mount.getBoundingClientRect();
    return { x: e.clientX - m.left, y: e.clientY - m.top };
  };
  addEventListener("pointermove", e => (pointer = local(e)), { passive: true });
  document.documentElement.addEventListener("pointerleave", () => (pointer = null));
  addEventListener("blur", () => (pointer = null));
  const centre = () => ({ x: q.cx, y: q.ground - q.cy - q.sp.hover.v });
  const near = (p, k) => p && Math.abs(p.x - q.cx) < q.side * k && Math.abs(p.y - centre().y) < q.side * k;
  function react() {
    // The cursor came close: a start, a hop, a wondering look, or a hop out of its way.
    const away = Math.sign(q.cx - pointer.x) || 1;
    const x = q.cx + away * q.side * 0.8;
    const name = R.weighted({ surprised: 1.2, hop: 1, wonder: 1, blink: 0.8, dodge: x > q.bounds[0] + q.side / 2 && x < q.bounds[1] - q.side / 2 ? 1.2 : 0 });
    if (name === "surprised") {
      q.setMode("surprised");
      const my = gen;
      step(0.9, my).then(() => q.mode === "surprised" && !busy && q.setMode("idle"), () => {});
    } else if (name === "hop") q.do("hopInPlace");
    else if (name === "wonder") q.do("wonder");
    else if (name === "blink") q.do("doubleBlink", { axis: "v" });
    else q.do("hop", { dir: away, dist: 0.8 });
  }
  // A click on him (the page underneath still gets it: his strip never takes clicks).
  addEventListener("pointerdown", e => {
    if (!q || reduce.matches) return;
    const p = local(e);
    if (!near(p, 0.62)) return;
    reactAt = q.t + 1.5;
    if (q.mode === "asleep" || q.mode === "sleepy") {
      cancelMoment();
      nextAt = q.t + R.range(6, 10);
      q.do("wake", { to: "idle" }, { interrupt: true });
    } else if (!busy) q.do(R.pick(["flip", "hopInPlace", "wonder"]), { outcome: "auto", dir: R() < 0.5 ? 1 : -1 }, { interrupt: true });
  });

  // ---------- one frame (after the engine's own update, on its shared loop)
  let stillFor = 0;
  QE.ticker.hooks.add(dt => {
    if (!q) return;
    const t = q.t;
    // Timers on his clock.
    for (let i = timers.length - 1; i >= 0; i--) if (t >= timers[i].at) timers.splice(i, 1)[0].resolve();
    // His voice and yours (the demo's levels, shaped into words).
    const wave = a => 0.3 + 0.62 * Math.abs(Math.sin(t * a + Math.sin(t * 2.3 + a) * 2));
    const inWord = voice.words.some(([a, b]) => t >= a && t < b);
    voice.out = inWord ? voice.out + (wave(10.7) - voice.out) * 0.45 : voice.out * 0.82;
    voice.in = t < voice.inUntil ? voice.in + (wave(8.3) - voice.in) * 0.35 : voice.in * 0.86;
    q.setLevels(voice.in, voice.out);
    // A feeling while he talks lasts its moment, then he's back to speaking.
    if (feel && t >= feel.until) {
      if (feel.mode && q.mode === feel.mode && q.talking) q.setMode("speaking");
      feel = null;
    }
    q.setPointer(pointer);
    if (reduce.matches) return;
    if (!busy && near(pointer, 1.7) && t > reactAt && q.mode === "idle" && !q.busy && !q.air && !q.pivot) {
      reactAt = t + R.range(3.5, 6.5);
      react();
    }
    if (!busy && t >= nextAt && !q.air && !q.pivot && q.mode === "idle") moment();
    // Still (resting between moves): 30 fps is plenty. Anything moving: full rate again.
    const still = !busy && !q.task && !q.queue.length && !q.air && !q.pivot && !q.talking;
    stillFor = still ? stillFor + dt : 0;
    QE.ticker.lowPower = stillFor > 1;
  });

  // ---------- start, and keep to the bottom edge as the window changes
  make(g.W * R.range(0.3, 0.7), !reduce.matches);
  nextAt = q.t + R.range(3, 5);
  new ResizeObserver(() => {
    const next = geo();
    if (!next.W || !next.H) return;
    const resized = Math.abs(next.side - g.side) / g.side > 0.12;
    const fx = q.cx / Math.max(1, g.W);
    g = next;
    if (resized) {
      // A big change of scale (a phone turned, a window dragged to another screen): a fresh Qubit at his size.
      cancelMoment();
      make(fx * g.W, false);
      nextAt = q.t + R.range(4, 7);
    } else {
      q.resize(g.W, g.H, g.floor);
      fit();
    }
  }).observe(mount);
  // The download button only exists on the home page: refresh what he can visit when the page changes.
  addEventListener("hashchange", () => setTimeout(() => q?.wander?.planner.setInterests(interests()), 400));
  return { get q() { return q; }, seed };
}
