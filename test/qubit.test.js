// Qubit on the Claude window: the director (ui/src/qubit/director.js) driving his real engine
// (ui/src/vendor/avatars/qubit-engine.js, with orbit-nav.js), stepped frame by frame in node with a
// tiny stand-in for the DOM. Plus the strip geometry for his Send button.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MODE_FOR, QUIET_TO_IDLE_S, baseState, createDirector, layout, sideFor } from '../ui/src/qubit/director.js';
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

function scene({ seed = 7, box = BOX, send = SEND, scale = 2, voice = { phase: 'off' }, entrance = false } = {}) {
  const realRandom = Math.random;
  Math.random = seeded(seed);
  const q = E.create({ mount: null, width: W, height: H, size: sideFor(scale), floor: 3, mode: 'asleep', keepAlive: true });
  q.brainT.play = q.brainT.stunt = Infinity;
  const dir = createDirector(q, { seed });
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
