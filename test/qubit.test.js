// Qubit on the Claude window: the director (ui/src/qubit/director.js) driving his real engine
// (ui/src/vendor/avatars/qubit-engine.js, with orbit-nav.js), stepped frame by frame in node with a
// tiny stand-in for the DOM. Plus the strip geometry for his Send button.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LIFE, LIFE_FIDGETS, MODE_FOR, QUIET_TO_IDLE_S, baseState, createDirector, layout, sideFor } from '../ui/src/qubit/director.js';
import { rectInStrip, sendInStrip, boxInStrip } from '../electron/buddy-geometry.js';

// ---------- the engine in node ----------
const fakeEl = () => ({ style: {}, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, remove() {} });
globalThis.document ??= { createElementNS: () => fakeEl() };
globalThis.requestAnimationFrame ??= () => 0; // the test steps frames itself
globalThis.cancelAnimationFrame ??= () => {};
await import('../ui/src/vendor/avatars/orbit-nav.js');
await import('../ui/src/vendor/avatars/qubit-engine.js');
const E = globalThis.QubitEngine;

/** Math.random, seeded (the engine's blinks, glances and flips use it). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 1200;
const H = 240;
const BOX = { x: 300, y: 142, w: 624, h: 98 }; // a prompt box 95 px tall above the floor
const SEND = { x: 872, y: 196, w: 32, h: 32 };

// (Most tests keep him dozing while Orbit is off: his own life has tests of its own, below.)
const DOZE_ON = { dozeS: [600, 600] };
function scene({ seed = 7, box = BOX, send = SEND, scale = 2, voice = { phase: 'off' }, entrance = false, life = DOZE_ON, reduceMotion = false } = {}) {
  const realRandom = Math.random;
  Math.random = seeded(seed);
  const q = E.create({ mount: null, width: W, height: H, size: sideFor(scale), floor: 3, mode: 'asleep', keepAlive: true });
  q.brainT.play = q.brainT.stunt = Infinity;
  const dir = createDirector(q, { seed, life, reduceMotion });
  dir.setVoice(voice);
  dir.setGeometry({ W, H, box, send, side: sideFor(scale) });
  dir.place({ entrance });
  const lands = [];
  q.on('land', (d) => lands.push({ ...d, x: q.cx, sy: q.sy }));
  const problems = [];
  const s = {
    q,
    dir,
    lands,
    problems,
    v: { ...voice },
    set(patch) {
      Object.assign(s.v, patch);
      dir.setVoice({ ...s.v });
    },
    /** Step `secs` of frames at 60 fps, letting promise continuations run between frames. */
    async run(secs, each) {
      const dt = 1 / 60;
      for (let i = 0; i < Math.round(secs * 60); i++) {
        q.update(dt);
        dir.tick(dt);
        each?.(q);
        check();
        await null;
      }
    },
    done() {
      Math.random = realRandom;
      q.destroy();
    },
  };
  // Invariants every frame: inside the strip, never inside the prompt box, never under the floor.
  function check() {
    const g = dir.geometry;
    const half = q.side / 2;
    if (q.cx < half - 1 || q.cx > W - half + 1) problems.push(`out of the strip at x ${q.cx.toFixed(1)}`);
    if (q.cy < half * 0.5) problems.push(`under the floor (centre ${q.cy.toFixed(1)})`);
    if (g.box && !q.air && !q.pivot) {
      const top = g.ground - g.box.y;
      const overlaps = q.cx + half > g.box.x + 1 && q.cx - half < g.box.x + g.box.w - 1;
      if (overlaps && q.sy < top - 1) problems.push(`inside the prompt box at x ${q.cx.toFixed(1)}`);
    }
    if (problems.length > 20) problems.length = 20;
  }
  return s;
}
const onBox = (s) => Math.abs(s.q.sy - (s.dir.geometry.ground - BOX.y)) < 1.5 && !s.q.air;

// ---------- pure parts ----------
test('qubit: Orbit states map to his modes', () => {
  assert.equal(baseState({ phase: 'off' }), 'asleep');
  assert.equal(baseState({ phase: 'off', claudeWorking: true }), 'asleep');
  assert.equal(baseState({ phase: 'connecting' }), 'waking');
  assert.equal(baseState({ phase: 'listening' }), 'listening');
  assert.equal(baseState({ phase: 'listening' }, QUIET_TO_IDLE_S + 1), 'idle');
  assert.equal(baseState({ phase: 'listening', hearing: true, draft: true }), 'listening');
  assert.equal(baseState({ phase: 'listening', muted: true }), 'muted');
  assert.equal(baseState({ phase: 'listening', draft: true }), 'confirm');
  assert.equal(baseState({ phase: 'listening', draft: true, sending: true }), 'sending');
  assert.equal(baseState({ phase: 'listening', claudeWorking: true }), 'watching');
  assert.equal(baseState({ phase: 'listening', asleep: true }), 'sleepy');
  assert.equal(baseState({ phase: 'thinking', draft: true }), 'thinking');
  assert.equal(baseState({ phase: 'speaking', claudeWorking: true }), 'speaking');
  // Every state is one of his existing modes: no new art.
  for (const m of Object.values(MODE_FOR)) assert.ok(E.MODES[m], m);
});

test('qubit: layout on the prompt box, the Send button, and without a box', () => {
  const g = layout({ W, H, box: BOX, send: SEND, side: 36 });
  assert.equal(g.ground, H - 3);
  assert.deepEqual(g.solids, [{ id: 'box', x: 300, y: 142, w: 624, h: H - 3 - 142 }]);
  assert.equal(g.sendAt.x, SEND.x + SEND.w / 2);
  assert.ok(g.confirm.x < g.sendAt.x && g.confirm.onBox);
  assert.ok(g.home.onBox && g.watch.onBox && g.onBox(0).onBox);
  for (const p of [g.home, g.onBox(0), g.onBox(5000), g.sendAt, g.confirm, g.watch]) assert.ok(p.x >= BOX.x + 18 && p.x <= BOX.x + BOX.w - 18, JSON.stringify(p));
  // No Send button found (the box is empty): the right end of its text row.
  assert.equal(layout({ W, H, box: BOX, send: null, side: 36 }).sendAt.x, BOX.x + BOX.w - 28);
  // No box (or one with no room above it): the floor.
  for (const box of [null, { x: 300, y: 20, w: 600, h: 200 }, { x: 300, y: 142, w: 40, h: 98 }]) {
    const f = layout({ W, H, box, send: SEND, side: 36 });
    assert.equal(f.box, null);
    assert.equal(f.home.y, f.ground);
    assert.equal(f.sendAt, null);
  }
  assert.deepEqual([sideFor(1), sideFor(2), sideFor(3), sideFor(9)], [26, 36, 50, 36]);
});

test('qubit: the Send button in strip px at any scaling (like the box)', () => {
  const claudeDip = { x: 100, y: 50, width: 1000, height: 600 };
  const strip = { x: 100, y: 410, width: 1000, height: 240 };
  // UI Automation at 150%: everything 1.5x, the same fractions.
  const win = { x: 150, y: 75, w: 1500, h: 900 };
  const send = { x: 150 + 1350, y: 75 + 810, w: 48, h: 48 };
  assert.deepEqual(sendInStrip(send, win, claudeDip, strip), { x: 900, y: 180, w: 32, h: 32 });
  assert.equal(sendInStrip(null, win, claudeDip, strip), null);
  assert.equal(sendInStrip({ x: 5000, y: 0, w: 10, h: 10 }, win, claudeDip, strip), null);
  // boxInStrip is rectInStrip plus the box's padding.
  const box = { x: 150 + 300, y: 75 + 780, w: 900, h: 36 };
  const r = rectInStrip(box, win, claudeDip, strip);
  assert.deepEqual(boxInStrip(box, win, claudeDip, strip), { x: Math.round(r.x - 12), y: Math.round(r.y - 14), w: Math.round(r.w + 24), h: Math.round(r.h + 14) });
});

// ---------- a whole session ----------
test('qubit: a full session on the Claude window, state by state', async () => {
  const s = scene();
  const { q, dir } = s;
  const g = dir.geometry;
  // Asleep at home on the prompt box.
  await s.run(1);
  assert.equal(q.mode, 'asleep');
  assert.ok(onBox(s), 'starts on the prompt box');
  assert.ok(Math.abs(q.cx - g.home.x) < 2);
  assert.ok(dir.lowPower(), 'asleep and still: low power');

  // Wake word / hotkey: connecting, then listening.
  s.set({ phase: 'connecting' });
  await s.run(0.1);
  assert.equal(q.taskName, 'wake');
  assert.ok(!dir.lowPower());
  s.set({ phase: 'listening' });
  await s.run(1.2);
  assert.equal(q.mode, 'listening');

  // Your voice: his eye stretches with the mic level.
  s.set({ hearing: true, input: 0 });
  await s.run(0.5);
  const quiet = q.sp.eh.v;
  s.set({ input: 0.9 });
  await s.run(0.5);
  assert.ok(q.sp.eh.v > quiet + 6, `eye ${quiet.toFixed(1)} -> ${q.sp.eh.v.toFixed(1)} with the mic level`);
  assert.equal(q.levels.input, 0.9);

  // Grok thinks, then speaks: his eye opens with the voice.
  s.set({ hearing: false, input: 0, phase: 'thinking' });
  await s.run(0.6);
  assert.equal(q.mode, 'thinking');
  s.set({ phase: 'speaking', output: 0 });
  await s.run(0.4);
  const shut = q.sp.eh.v;
  s.set({ output: 1 });
  await s.run(0.4);
  assert.equal(q.mode, 'speaking');
  assert.ok(q.sp.eh.v > shut + 8, `eye ${shut.toFixed(1)} -> ${q.sp.eh.v.toFixed(1)} with the voice`);

  // A draft goes into Claude's box: he goes to the text and follows it.
  dir.event('draft');
  s.set({ phase: 'speaking', output: 0.4, draft: true });
  assert.equal(dir.reaction, 'draft');
  await s.run(1.2);
  assert.equal(q.mode, 'speaking', 'the voice still shows during the draft');
  await s.run(2.5);
  // "Send it?": waiting by the Send button for your yes.
  s.set({ phase: 'listening', output: 0 });
  await s.run(3);
  assert.equal(dir.state, 'confirm');
  assert.equal(q.mode, 'curious');
  assert.ok(onBox(s) && Math.abs(q.cx - g.confirm.x) < q.side * 0.35, `by Send (x ${q.cx.toFixed(0)}, want ${g.confirm.x.toFixed(0)}) ${JSON.stringify(dir.log.slice(-8))} ${q.taskName} ${q.queue.map(j=>j.name)}`);

  // Yes: sending (to the button), then sent (the stomp).
  s.set({ phase: 'thinking', hearing: false });
  await s.run(0.3);
  s.set({ phase: 'listening', sending: true });
  await s.run(1.5);
  assert.equal(q.mode, 'happy');
  assert.ok(Math.abs(q.cx - g.sendAt.x) < q.side * 0.35, 'on the Send button');
  const landsBefore = s.lands.length;
  dir.event('sent');
  s.set({ sending: false, draft: false });
  await s.run(0.15);
  assert.equal(q.taskName, 'jump', 'stomps');
  await s.run(2.5);
  const stomp = s.lands.slice(landsBefore).find((l) => Math.abs(l.x - g.sendAt.x) < q.side * 0.35);
  assert.ok(stomp && stomp.impact > 0 && onBox(s), 'landed on Send');

  // Claude works: Claude's orange, watching the messages.
  s.set({ claudeWorking: true });
  await s.run(3);
  assert.equal(dir.state, 'watching');
  assert.equal(q.mode, 'focused');
  assert.ok(Math.abs(q.cx - g.watch.x) < q.side * 0.35);

  // Claude finished: he celebrates, then listens again.
  s.set({ claudeWorking: false });
  dir.event('finished');
  await s.run(0.3);
  assert.equal(q.mode, 'happy');
  assert.equal(q.taskName, 'celebrate');
  await s.run(2.5);
  assert.equal(q.mode, 'listening');

  // An error (a failed send): red, a shiver, then back.
  dir.event('error');
  await s.run(0.2);
  assert.equal(q.mode, 'error');
  await s.run(2.5);
  assert.equal(q.mode, 'listening');

  // Mute: not listening (idle, still); unmute: a nod, listening again.
  s.set({ muted: true, input: 0.8 });
  await s.run(1);
  assert.equal(dir.state, 'muted');
  assert.equal(q.mode, 'idle');
  assert.equal(q.levels.input, 0, 'no mic level while muted');
  s.set({ muted: false });
  await s.run(1);
  assert.equal(q.mode, 'listening');

  // A quiet call: idle life (the seeded wander) takes over, and moves him about.
  const t0 = q.cx;
  let moved = 0;
  await s.run(QUIET_TO_IDLE_S + 14, () => (moved = Math.max(moved, Math.abs(q.cx - t0))));
  assert.equal(dir.state, 'idle');
  assert.ok(moved > q.side * 0.5, `wanders (moved ${moved.toFixed(0)} px)`);

  // Go to sleep: he walks home and dozes off; low power again.
  s.set({ phase: 'listening', asleep: true });
  await s.run(0.5);
  assert.equal(q.mode, 'sleepy');
  s.set({ phase: 'off', asleep: false });
  await s.run(14);
  assert.equal(q.mode, 'asleep');
  assert.ok(onBox(s) && Math.abs(q.cx - g.home.x) < q.side * 0.35, `home (x ${q.cx.toFixed(0)}, want ${g.home.x.toFixed(0)})`);
  assert.ok(dir.lowPower());

  // Claude finished while asleep: a start and a celebration, then back to sleep.
  dir.event('finished');
  await s.run(0.5);
  assert.notEqual(q.mode, 'asleep');
  await s.run(8);
  assert.equal(q.mode, 'asleep');

  assert.deepEqual(s.problems, []);
  s.done();
});

test('qubit: explicit states win at once, mid-move and mid-air', async () => {
  const s = scene({ voice: { phase: 'listening' } });
  const { q, dir } = s;
  await s.run(1);
  s.set({ draft: true });
  await s.run(0.4); // on his way to Send
  s.set({ hearing: true, input: 0.5 });
  await s.run(1 / 60 * 2);
  assert.equal(q.mode, 'listening', 'you talking wins over waiting by Send');
  s.set({ hearing: false, phase: 'speaking', output: 0.5 });
  await s.run(2 / 60);
  assert.equal(q.mode, 'speaking');
  // Mid-jump (the stomp): a new state's mode applies straight away; he still lands properly.
  s.set({ phase: 'listening', output: 0, sending: true });
  await s.run(2);
  dir.event('sent');
  await s.run(0.35);
  assert.ok(q.air, 'in the air');
  s.set({ phase: 'thinking', sending: false, draft: false });
  await s.run(1 / 60);
  assert.equal(q.mode, 'happy', 'the stomp reaction keeps its mood until it lands');
  await s.run(3);
  assert.equal(q.mode, 'thinking');
  assert.ok(!q.air && onBox(s));
  assert.deepEqual(s.problems, []);
  s.done();
});

test('qubit: rides the prompt box as it grows and shrinks, falls back to the floor without it', async () => {
  const s = scene({ voice: { phase: 'listening' } });
  const { q, dir } = s;
  await s.run(1);
  assert.ok(onBox(s));
  // A long draft: Claude's box grows 60 px taller. He rides its top up.
  dir.setGeometry({ W, H, box: { ...BOX, y: BOX.y - 60, h: BOX.h + 60 }, send: SEND, side: 36 });
  await s.run(0.5);
  assert.ok(Math.abs(q.sy - (dir.geometry.ground - (BOX.y - 60))) < 1.5 && !q.air, 'on the taller box');
  // Sent: the box shrinks back. He drops onto it.
  dir.setGeometry({ W, H, box: BOX, send: SEND, side: 36 });
  await s.run(1.5);
  assert.ok(onBox(s), 'back on the box');
  // The box is gone (a page without one): he falls to the floor and lives there.
  dir.setGeometry({ W, H, box: null, send: null, side: 36 });
  await s.run(2);
  assert.ok(q.sy < 0.5 && !q.air, 'on the floor');
  // A narrower window, and a bigger Qubit (he grows into it).
  dir.setGeometry({ W: 700, H, box: null, send: null, side: 50 });
  await s.run(2);
  assert.ok(Math.abs(q.side - 50) < 1 && q.cx <= 700 - 25 + 1);
  assert.deepEqual(s.problems.filter((p) => !/out of the strip/.test(p) || false), []);
  s.done();
});

test('qubit: entrance (a live switch) drops him in; random seeds stay in bounds', async () => {
  const s = scene({ entrance: true });
  const { q } = s;
  assert.ok(q.air);
  await s.run(1.2);
  assert.ok(!q.air && onBox(s), 'landed on the box');
  await s.run(5);
  assert.equal(q.mode, 'asleep', 'and dozed off (Orbit is asleep)');
  s.done();
  // Five seeds of a long quiet call, with Claude finishing and errors now and then.
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = scene({ seed, voice: { phase: 'listening' } });
    for (let i = 0; i < 6; i++) {
      await r.run(9);
      r.dir.event(i % 2 ? 'finished' : 'error');
    }
    assert.deepEqual(r.problems, [], `seed ${seed}`);
    r.done();
  }
});

test('the listening lean is a moment, and curious never tilts him: he always settles back level', () => {
  const q = E.create({ mount: null, width: W, height: H, size: 40, floor: 3, mode: 'idle', keepAlive: true });
  q.brainT.play = q.brainT.stunt = Infinity;
  for (const [mode, spring, sign] of [['listening', 'lean', 1]]) {
    q.setMode('idle');
    for (let i = 0; i < 120; i++) q.update(1 / 60);
    q.setMode(mode);
    let peak = 0;
    for (let i = 0; i < 30; i++) (q.update(1 / 60), (peak = Math.max(peak, sign * q.sp[spring].v)));
    assert.ok(peak > 1.5, `${mode}: he tips (${peak.toFixed(2)}°)`);
    for (let i = 0; i < 150; i++) q.update(1 / 60);
    assert.ok(Math.abs(q.sp.lean.v + q.sp.tilt.v) < 0.3, `${mode}: back level after 3 s (${(q.sp.lean.v + q.sp.tilt.v).toFixed(2)}°)`);
  }
  // Curious: the eye tilts, the body never does.
  q.setMode('curious');
  let most = 0;
  for (let i = 0; i < 180; i++) (q.update(1 / 60), (most = Math.max(most, Math.abs(q.sp.lean.v + q.sp.tilt.v))));
  assert.ok(most < 0.3, `curious: body stays level (${most.toFixed(2)}°)`);
});

// ---------- his own life (Orbit off or asleep) ----------
const TRICKS = new Set(['flip', 'roll', 'jump']);
/** Watch his own life for `secs`: the actions he starts (idle or not), where he is, and when. */
async function watchLife(s, secs) {
  const { q, dir } = s;
  const acts = [];
  q.on('action', (a) => s.watching === acts && acts.push({ name: a.name, t: q.t, idle: !!q.task?.idle, mode: q.mode }));
  s.watching = acts;
  let floor = 0;
  let box = 0;
  let low = 0;
  let maxStep = 0;
  let px = q._rx;
  const xs = new Set();
  await s.run(secs, () => {
    if (!q.air && !q.pivot) {
      if (q.sy < 1) floor++;
      else box++;
    }
    if (dir.lowPower()) low++;
    xs.add(Math.round(q.cx / 20));
    if (px != null) maxStep = Math.max(maxStep, Math.abs(q._rx - px));
    px = q._rx;
  });
  s.watching = null;
  return { acts, floor: floor / 60, box: box / 60, low: low / 60, places: xs.size, maxStep };
}

test('his own life: he dozes, gets up after a few seconds and lives (seeded, varied, on the box and the floor)', async () => {
  const runs = [];
  for (const seed of [1, 2, 3, 4]) {
    const s = scene({ seed, life: {} }); // the real timing (LIFE)
    const { q, dir } = s;
    assert.equal(q.mode, 'asleep', 'Orbit is off: he starts asleep');
    const w = await watchLife(s, 200);
    const log = dir.log.map((l) => l.what);
    const upAt = dir.log.find((l) => l.what === 'life up')?.t;
    assert.ok(upAt >= LIFE.dozeS[0] && upAt <= LIFE.dozeS[1] + 3, `seed ${seed}: up after his doze (${upAt}s)`);
    const did = w.acts.filter((a) => a.t > upAt);
    const names = new Set(did.map((a) => (a.name === '_wanderMove' ? 'move' : a.name)));
    const moves = did.filter((a) => a.name === '_wanderMove').length;
    const tricks = did.filter((a) => TRICKS.has(a.name)).length;
    assert.ok(moves >= 12, `seed ${seed}: wanders (${moves} moves)`);
    assert.ok(tricks >= 3, `seed ${seed}: tricks (${tricks}: ${[...names]})`);
    assert.ok(names.size >= 7, `seed ${seed}: varied (${[...names].join(', ')})`);
    assert.ok(w.places >= 15, `seed ${seed}: all over (${w.places} spots of 20 px)`);
    assert.ok(w.floor > 3 && w.box > 30, `seed ${seed}: on the floor (${w.floor.toFixed(0)}s) and the box (${w.box.toFixed(0)}s)`);
    assert.ok(log.includes('life nap'), `seed ${seed}: a nap in his day`);
    assert.ok(w.low > 4, `seed ${seed}: his naps are low power (${w.low.toFixed(1)}s)`);
    // Everything he does is his engine's own (no new art): his fidgets, moves, naps and wakes.
    const allowed = new Set([...LIFE_FIDGETS.map((f) => f.name), '_wanderMove', 'goTo', 'sleep', 'doubleBlink', 'stretch', 'celebrate']);
    for (const a of did) assert.ok(allowed.has(a.name), `seed ${seed}: ${a.name}`);
    assert.ok(w.maxStep < q.side * 0.5, `seed ${seed}: no jumps on screen (largest step ${w.maxStep.toFixed(1)} px)`);
    assert.deepEqual(s.problems, [], `seed ${seed}`);
    runs.push(did.slice(0, 12).map((a) => a.name).join(' '));
    s.done();
  }
  // Seeds diverge: no two of them start their day the same way.
  assert.equal(new Set(runs).size, runs.length, runs.join('\n'));
});

test('his own life never runs while Orbit listens: the wake word wins at once, from wherever he is', async () => {
  for (const seed of [5, 6, 7]) {
    const s = scene({ seed, life: { dozeS: [1, 1] } });
    const { q, dir } = s;
    // Up and about, then caught mid-air (a hop, a jump or a flip of his own).
    await s.run(4);
    let caught = false;
    for (let i = 0; i < 60 * 40 && !caught; i++) {
      await s.run(1 / 60);
      caught = q.air && !!q.task?.idle && dir.state === 'asleep';
    }
    assert.ok(caught, `seed ${seed}: caught him mid-air in his own life`);
    const x0 = q.cx;
    s.set({ phase: 'connecting' });
    await s.run(2 / 60);
    assert.equal(q.mode, 'listening', `seed ${seed}: listening at once (mid-air)`);
    assert.ok(!q.task || !q.task.idle || q.task.cancelled, `seed ${seed}: his own move is cut short`);
    s.set({ phase: 'listening', hearing: true, input: 0.4 });
    const w = await watchLife(s, 12);
    assert.equal(w.acts.filter((a) => a.idle).length, 0, `seed ${seed}: no idle life while listening (${w.acts.map((a) => a.name)})`);
    assert.ok(!q.air && !q.pivot, `seed ${seed}: he landed`);
    assert.ok(Math.abs(q.cx - x0) < q.side * 3, `seed ${seed}: from where he was (moved ${(q.cx - x0).toFixed(0)} px)`);
    assert.ok(w.maxStep < q.side * 0.5, `seed ${seed}: a smooth hand-off (largest step ${w.maxStep.toFixed(1)} px)`);
    assert.equal(q.mode, 'listening');
    // Thinking and speaking: still nothing of his own.
    s.set({ hearing: false, phase: 'thinking' });
    const w2 = await watchLife(s, 3);
    s.set({ phase: 'speaking', output: 0.5 });
    const w3 = await watchLife(s, 4);
    assert.equal([...w2.acts, ...w3.acts].filter((a) => a.idle).length, 0, `seed ${seed}: none while thinking or speaking`);
    // Hung up: he dozes off at home, and is up again a moment later.
    s.set({ phase: 'off', output: 0 });
    await s.run(1);
    assert.ok(q.mode === 'sleepy' || q.mode === 'asleep', `seed ${seed}: dozing off (${q.mode})`);
    await s.run(16);
    assert.ok(dir.log.filter((l) => l.what === 'life up').length >= 2, `seed ${seed}: up again`);
    assert.deepEqual(s.problems, [], `seed ${seed}`);
    s.done();
  }
});

test('his own life: Orbit asleep in a call counts too; Claude finishing while he is up: a celebration, then he carries on', async () => {
  const s = scene({ seed: 9, voice: { phase: 'listening', asleep: true }, life: { dozeS: [2, 2] } });
  const { q, dir } = s;
  await s.run(8);
  assert.equal(dir.state, 'sleepy');
  assert.equal(q.mode, 'idle', 'Orbit asleep in a call: he gets up too');
  await s.run(0.5);
  dir.event('finished');
  await s.run(0.3);
  assert.equal(q.mode, 'happy');
  assert.equal(q.taskName, 'celebrate');
  await s.run(3);
  assert.equal(q.mode, 'idle', 'and carries on with his day (no going back to sleep)');
  const w = await watchLife(s, 10);
  assert.ok(w.acts.some((a) => a.idle), 'his own life again');
  assert.deepEqual(s.problems, []);
  s.done();
});

test('his own life: he tires (longer naps), sleeps for the night, and wakes when something happens; reduced motion stays asleep', async () => {
  const s = scene({ seed: 4, life: { dozeS: [1, 1], awakeS: [8, 8], napS: [3, 3], tiredS: 40, tiredNapS: [20, 20], nightS: 80 } });
  const { q, dir } = s;
  await s.run(150);
  const naps = dir.log.filter((l) => /^life nap \d+s$/.test(l.what)).map((l) => Number(l.what.match(/(\d+)s/)[1]));
  assert.ok(naps.includes(3) && naps.includes(20), `short naps, then long ones (${naps})`);
  assert.ok(dir.log.some((l) => l.what === 'life nap for the night'), 'asleep for the night');
  await s.run(30);
  assert.equal(q.mode, 'asleep', 'still asleep');
  assert.ok(dir.lowPower());
  dir.event('finished'); // Claude finished: it wakes him
  await s.run(12);
  assert.ok(dir.log.slice(-6).some((l) => l.what === 'life up') || q.mode === 'idle', `up again (${dir.log.slice(-4).map((l) => l.what)})`);
  s.done();
  const r = scene({ seed: 4, life: { dozeS: [1, 1] }, reduceMotion: true });
  await r.run(20);
  assert.equal(r.q.mode, 'asleep', 'reduced motion: he stays asleep');
  assert.ok(!r.dir.log.some((l) => l.what === 'life up'));
  r.done();
});

test('after a celebration (its colour sweep) he glides back to his mood\x27s own colour', () => {
  const q = E.create({ mount: null, width: W, height: H, size: 36, floor: 3, mode: 'idle', keepAlive: true });
  q.brainT.play = q.brainT.stunt = Infinity;
  q.do('celebrate');
  for (let i = 0; i < 60 * 5; i++) q.update(1 / 60);
  const [L, C, Hh] = E.MODES.idle.color;
  const hue = ((q.sp.H.v % 360) + 360) % 360;
  assert.ok(Math.abs(q.sp.L.v - L) < 0.01 && Math.abs(q.sp.C.v - C) < 0.01 && Math.abs(hue - Hh) < 2, `indigo again (${q.sp.L.v.toFixed(2)} ${q.sp.C.v.toFixed(2)} ${hue.toFixed(0)})`);
  q.destroy();
});

// ---------- feelings while he talks (emote cues) ----------
test('emotes while he speaks: a mood or a move in place, his eye still his mouth, then back to speaking', async () => {
  const s = scene({ voice: { phase: 'speaking', output: 0.6 } });
  const { q, dir } = s;
  await s.run(1.5);
  assert.equal(q.mode, 'speaking');
  const x0 = q.cx;
  assert.equal(dir.emote('happy'), true);
  await s.run(0.1);
  assert.equal(q.mode, 'happy');
  assert.equal(q.taskName, 'hopInPlace');
  await s.run(0.6);
  // His eye keeps opening with his voice in the happy squint.
  s.set({ output: 0 });
  await s.run(0.3);
  const shut = q.sp.eh.v;
  s.set({ output: 1 });
  await s.run(0.3);
  assert.ok(q.sp.eh.v > shut + 4, `still talking with his eye (${shut.toFixed(1)} -> ${q.sp.eh.v.toFixed(1)})`);
  await s.run(1);
  assert.equal(q.mode, 'speaking', 'back to speaking after the moment');
  assert.ok(Math.abs(q.cx - x0) < 1, 'in place');
  for (const name of ['excited', 'curious', 'surprised', 'proud', 'sad', 'embarrassed', 'nod', 'shake', 'wonder', 'hop']) {
    assert.equal(dir.emote(name), true, name);
    await s.run(2.2);
    assert.equal(q.mode, 'speaking', `${name}: back to speaking`);
  }
  assert.ok(Math.abs(q.cx - x0) < 2 && !q.air, 'all in place, landed');
  assert.equal(dir.emote('dance'), false, 'not a feeling');
  assert.deepEqual(s.problems, []);
  s.done();
});

test('emotes: only while he talks; you talking, asleep, or something you asked him to do win', async () => {
  const s = scene({ voice: { phase: 'listening' } });
  const { q, dir } = s;
  await s.run(1);
  assert.equal(dir.emote('happy'), false, 'listening');
  s.set({ hearing: true });
  await s.run(0.2);
  assert.equal(dir.emote('happy'), false, 'you talking');
  // The first words' feeling arrives a frame before Orbit says it's speaking: it keeps its moment.
  s.set({ hearing: false, phase: 'thinking' });
  await s.run(0.5);
  assert.equal(dir.emote('surprised'), true, 'about to speak');
  s.set({ phase: 'speaking', output: 0.5 });
  await s.run(0.3);
  assert.equal(q.mode, 'surprised', 'kept through the switch to speaking');
  await s.run(1);
  assert.equal(q.mode, 'speaking');
  // A trick you asked for wins over a feeling.
  dir.command({ action: 'backflip' });
  await s.run(0.1);
  assert.equal(dir.emote('nod'), false);
  await s.run(4);
  // Barge-in mid-feeling: listening at once.
  assert.equal(dir.emote('sad'), true);
  await s.run(0.2);
  s.set({ phase: 'listening', hearing: true, output: 0 });
  await s.run(2 / 60);
  assert.equal(q.mode, 'listening');
  s.set({ phase: 'off', hearing: false });
  await s.run(3);
  assert.equal(dir.emote('happy'), false, 'asleep');
  assert.deepEqual(s.problems, []);
  s.done();
});

// ---------- the engine: flips from the top of a solid ----------
test('a flip from the top of the prompt box lands back on it: his spinning take-off is never a hit on its side', () => {
  const ground = H - 3;
  const top = ground - BOX.y;
  const make = (side, x, sy) => {
    const q = E.create({ mount: null, width: W, height: H, size: side, floor: 3, mode: 'idle', keepAlive: true });
    q.brainT.play = q.brainT.stunt = Infinity;
    q.bounds = [6, W - 6];
    q.setEnvironment({ solids: [{ id: 'box', x: BOX.x, y: BOX.y, w: BOX.w, h: ground - BOX.y }] });
    q.cx = x;
    q.sy = sy;
    q.cy = sy + side / 2;
    for (let i = 0; i < 30; i++) q.update(1 / 60);
    return q;
  };
  const realRandom = Math.random;
  Math.random = seeded(3);
  try {
    for (const side of [26, 36, 50]) {
      for (const dir of [1, -1]) {
        for (const outcome of ['success', 'side', 'corner']) {
          for (const x of [BOX.x + 30, BOX.x + 200, BOX.x + BOX.w - 34]) {
            const q = make(side, x, top);
            let bumps = 0;
            let lowest = Infinity;
            q.on('bump', () => bumps++);
            q.do('flip', { dir, outcome });
            for (let i = 0; i < 60 * 5; i++) {
              q.update(1 / 60);
              if (!q.air && !q.pivot) lowest = Math.min(lowest, q.sy);
            }
            const what = `side ${side}, ${dir > 0 ? 'front' : 'back'}flip (${outcome}) from x ${x}`;
            assert.equal(bumps, 0, `${what}: no hit on the box's side`);
            assert.ok(Math.abs(q.sy - top) < 1 && lowest > top - 1, `${what}: back on the box (support ${q.sy.toFixed(0)})`);
            assert.ok(Math.abs(q.cx - x) < side * 1.3, `${what}: about where he took off (moved ${(q.cx - x).toFixed(0)} px)`);
            q.destroy();
          }
        }
      }
    }
    // On the floor beside the box, a flip that lands on a corner and topples toward it: the turning
    // square knocks against its side and rocks back, never into it, and is never left leaning on it.
    for (const side of [26, 36, 50]) {
      for (const gap of [0.2, 0.5, 0.9]) {
        for (const [x, d] of [[BOX.x + BOX.w + side * (0.5 + gap), -1], [BOX.x - side * (0.5 + gap), 1]]) {
          const q = make(side, x, 0);
          q.do('flip', { dir: d, outcome: 'corner' });
          let inside = 0;
          for (let i = 0; i < 60 * 6; i++) {
            q.update(1 / 60);
            if (q.cx + side / 2 > BOX.x + 1 && q.cx - side / 2 < BOX.x + BOX.w - 1 && q.sy < 1 && !q.air) inside++;
          }
          assert.equal(inside, 0, `side ${side}, ${gap} from the box: never into its side`);
          assert.ok(!q.air && !q.pivot && Math.abs(q.angle) < 1, `side ${side}, ${gap} from the box: settled flat (angle ${q.angle.toFixed(1)})`);
          q.destroy();
        }
      }
    }
    // The box's sides still stop him: a hop from the floor into its side is a bump, and he stays out.
    const q = make(36, BOX.x - 30, 0);
    let bumps = 0;
    q.on('bump', () => bumps++);
    q.do('hop', { dir: 1, dist: 1.5 });
    for (let i = 0; i < 60 * 2; i++) q.update(1 / 60);
    assert.ok(bumps > 0 && q.sy < 1 && q.cx <= BOX.x - 17, `stopped by its side (x ${q.cx.toFixed(0)}, bumps ${bumps})`);
    q.destroy();
  } finally {
    Math.random = realRandom;
  }
});

test('flips asked for on the box (no workaround in the director): he lands them on the box, many in a row', async () => {
  const s = scene({ voice: { phase: 'listening' } });
  const { q, dir } = s;
  await s.run(1);
  const top = dir.geometry.ground - BOX.y;
  for (let i = 0; i < 6; i++) {
    dir.command({ action: i % 2 ? 'frontflip' : 'backflip' });
    await s.run(3.5);
    assert.ok(Math.abs(q.sy - top) < 1 && !q.air, `flip ${i + 1}: on the box`);
  }
  assert.ok(!q.solids.some((o) => o.oneWay), 'the box is never turned into a ledge');
  assert.deepEqual(s.problems, []);
  s.done();
});
