// The launcher's hero (ui/src/hero/hero.js) driving Qubit's real engine in node: he stays in the
// middle (no walking, no pathing), shows off his emotes every few seconds, never the same twice in a
// row, and wears Orbit's state while it's live. Plus the avatar carousel and the two new avatar
// settings' sanitising (src/config.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HERO_EMOTES, HERO_TIMING, createHero, heroMode } from '../ui/src/hero/hero.js';
import { CAROUSEL, carouselCan, carouselIndex, carouselStep } from '../ui/src/hero/carousel.js';
import { DEFAULTS, getSettings, initConfig, updateSettings } from '../src/config.js';

const fakeEl = () => ({ style: {}, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, remove() {} });
globalThis.document ??= { createElementNS: () => fakeEl() };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
await import('../ui/src/vendor/avatars/orbit-nav.js');
await import('../ui/src/vendor/avatars/qubit-engine.js');
const E = globalThis.QubitEngine;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 320;
const H = 230;
async function stage(seed, secs, { voice, each } = {}) {
  const real = Math.random;
  Math.random = seeded(seed);
  try {
    const q = E.create({ mount: null, width: W, height: H, size: 64, floor: 18, x: W / 2, mode: 'idle', keepAlive: true });
    const hero = createHero(q, { seed, home: W / 2 });
    if (voice) hero.setVoice(voice);
    const acts = [];
    q.on('action', (a) => acts.push(a.name));
    let maxOff = 0;
    let wanderSeen = false;
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(secs * 60); i++) {
      q.update(dt);
      hero.tick(dt);
      maxOff = Math.max(maxOff, Math.abs((q._rx ?? q.cx) - W / 2));
      if (q.wander) wanderSeen = true;
      each?.(q, hero, i * dt);
      await null;
    }
    q.destroy();
    return { q, hero, acts, maxOff, wanderSeen };
  } finally {
    Math.random = real;
  }
}

test('hero: he stays in the middle (no wander, no pathing, no rolls), whatever he shows off', async () => {
  for (const seed of [1, 7, 42, 99]) {
    const { acts, maxOff, wanderSeen, hero } = await stage(seed, 90);
    assert.equal(wanderSeen, false, 'no idle wander');
    for (const banned of ['goTo', '_wanderMove', 'roll', 'moveTo', 'move']) assert.ok(!acts.includes(banned), `never ${banned} (seed ${seed}: ${acts.join(',')})`);
    // A flip's landing or a squash can shift his drawn centre a little; he hops back. Never across the stage.
    assert.ok(maxOff < 64 * 0.9, `stays within his own width of the middle (seed ${seed}: ${maxOff.toFixed(1)} px)`);
    assert.ok(hero.shown.length >= 12, `emotes often (seed ${seed}: ${hero.shown.length} in 90 s)`);
  }
});

test('hero: an emote every few seconds, varied, never the same one twice in a row', async () => {
  const times = [];
  let lastLen = 0;
  const { hero } = await stage(5, 120, {
    each: (_q, h, t) => {
      if (h.shown.length !== lastLen) {
        lastLen = h.shown.length;
        times.push(t);
      }
    },
  });
  const s = hero.shown;
  assert.ok(new Set(s).size >= 8, `varied: ${new Set(s).size} kinds`);
  for (let i = 1; i < s.length; i++) assert.notEqual(s[i], s[i - 1], 'never twice in a row');
  assert.ok(times[0] <= HERO_TIMING.firstS + 0.5, 'the first comes quickly');
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(Math.max(...gaps) < 8, `never a long quiet spell (longest ${Math.max(...gaps).toFixed(1)} s)`);
  assert.ok(Math.min(...gaps) > 1.5, `never jittery (shortest ${Math.min(...gaps).toFixed(1)} s)`);
});

test('hero: every emote is one of his own moods and moves (nothing new is drawn)', () => {
  const modes = new Set(['happy', 'curious', 'surprised', 'music', 'sad', 'embarrassed']);
  for (const e of HERO_EMOTES) {
    if (e.mode) assert.ok(modes.has(e.mode), e.name);
    if (e.act) assert.ok(E.ACTIONS.includes(e.act), `${e.name}: ${e.act} is an engine action`);
    assert.ok(!['roll', 'goTo', 'move', 'moveTo', 'hop'].includes(e.act), `${e.name} stays in place`);
  }
});

test('hero: while Orbit is live he wears its state, and his show waits', async () => {
  assert.equal(heroMode({ phase: 'off' }), null);
  assert.equal(heroMode({ phase: 'listening', asleep: true }), null);
  assert.equal(heroMode({ phase: 'listening' }), 'listening');
  assert.equal(heroMode({ phase: 'thinking' }), 'thinking');
  assert.equal(heroMode({ phase: 'speaking' }), 'speaking');
  assert.equal(heroMode({ phase: 'connecting' }), 'listening');
  assert.equal(heroMode({ phase: 'listening', claudeWorking: true }), 'focused');
  const { q, hero } = await stage(3, 12, { voice: { phase: 'speaking', output: 0.6 } });
  assert.equal(q.mode, 'speaking');
  assert.equal(hero.shown.length, 0, 'no demo emotes while live');
  assert.equal(q.levels.output, 0.6, 'his eye follows the voice level');
});

test('hero: back from live, the show resumes in his own colour', async () => {
  let switched = false;
  const { q, hero } = await stage(11, 14, {
    voice: { phase: 'listening' },
    each: (_q, h, t) => {
      if (!switched && t > 3) {
        switched = true;
        h.setVoice({ phase: 'off' });
      }
    },
  });
  assert.equal(hero.live, null);
  assert.ok(hero.shown.length >= 2, 'emotes again');
  void q;
});

test('carousel: wired to the avatar setting; one entry, so its arrows do nothing', () => {
  assert.deepEqual(CAROUSEL.map((a) => a.id), ['qubit'], 'only Qubit is offered');
  assert.equal(carouselIndex('qubit'), 0);
  assert.equal(carouselIndex('buddy'), 0, 'an avatar it does not offer shows the first');
  assert.equal(carouselIndex(undefined), 0);
  assert.deepEqual(carouselCan(0), { prev: false, next: false, dots: 1 });
  assert.equal(carouselStep(0, 1), 0);
  assert.equal(carouselStep(0, -1), 0);
  // ...and ready for more.
  const more = [{ id: 'qubit', name: 'Qubit' }, { id: 'buddy', name: 'Pixel buddy' }, { id: 'none', name: 'None' }];
  assert.equal(carouselIndex('buddy', more), 1);
  assert.deepEqual(carouselCan(1, more), { prev: true, next: true, dots: 3 });
  assert.deepEqual(carouselCan(2, more), { prev: true, next: false, dots: 3 });
  assert.equal(carouselStep(1, 1, more), 2);
  assert.equal(carouselStep(2, 1, more), 2, 'no wrap past the end');
  assert.equal(carouselStep(0, -1, more), 0, 'no wrap past the start');
});

test('settings: click-to-talk and throwing are on by default, and only take a real yes or no', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-launcher-'));
  try {
    assert.equal(DEFAULTS.avatarClickTalk, true);
    assert.equal(DEFAULTS.avatarThrow, true);
    initConfig({ dir, secrets: { get: () => '', set() {}, kind: 'test' }, brainSecrets: { get: () => '', set() {}, kind: 'test' } });
    assert.equal(getSettings().avatarClickTalk, true);
    assert.equal(getSettings().avatarThrow, true);
    assert.deepEqual(updateSettings({ avatarClickTalk: false }), ['avatarClickTalk']);
    assert.equal(getSettings().avatarClickTalk, false);
    updateSettings({ avatarThrow: 'false' });
    assert.equal(getSettings().avatarThrow, false);
    updateSettings({ avatarThrow: 'true', avatarClickTalk: true });
    assert.equal(getSettings().avatarThrow, true);
    assert.equal(getSettings().avatarClickTalk, true);
    // Junk never flips them.
    for (const junk of [{}, [], 'yes', 1, 0, null, { toString: () => 'true' }]) {
      assert.deepEqual(updateSettings({ avatarClickTalk: junk, avatarThrow: junk }), [], `ignored: ${JSON.stringify(junk)}`);
    }
    assert.equal(getSettings().avatarClickTalk, true);
    assert.equal(getSettings().avatarThrow, true);
    // Saved off survives a restart; a hand-edited file with junk falls back to on.
    updateSettings({ avatarThrow: false });
    initConfig({ dir, secrets: { get: () => '', set() {}, kind: 'test' }, brainSecrets: { get: () => '', set() {}, kind: 'test' } });
    assert.equal(getSettings().avatarThrow, false);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ avatarThrow: 'maybe', avatarClickTalk: 7 }));
    initConfig({ dir, secrets: { get: () => '', set() {}, kind: 'test' }, brainSecrets: { get: () => '', set() {}, kind: 'test' } });
    assert.equal(getSettings().avatarThrow, true);
    assert.equal(getSettings().avatarClickTalk, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
