// Orbit's mouse (a second, visual cursor of Orbit's own): its colours (Qubit's, for the same state),
// its shape and motion maths, where a control is on screen (UI Automation's rect, or the page's own
// through the pipe for an app under Orbit), when it may show (only where the user would see it), the
// point_at tool's gate (read-only, the user's own words), acts leading with it (bounded), and the
// overlay controller with stand-in windows. scripts/mouse-e2e.mjs drives the real overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSetting, initConfig, updateSettings } from '../src/config.js';
import { focus, setFocusBackend, setUiaHost } from '../src/platform/index.js';
import { createToolRunner } from '../src/tools.js';
import { perform } from '../src/anywhere/hands.js';
import { MOUSE, controlRect, leadIn, leadMs, pageRect, pointAt, rectOfNode, seenAt, setMouseSink, whereIn } from '../src/anywhere/mouse.js';
import { ARROW_PATH, PREVIEW, ease, glideAt, lchFor, mouseMode, pressAt, pulseScale } from '../ui/src/mouse/look.js';
import * as SHAPE from '../ui/src/mouse/shape.js';
import { MODE_FOR, baseState } from '../ui/src/qubit/director.js';
import { createOrbitMouse, glideMs } from '../electron/orbit-mouse.js';

const fakeEl = () => ({ style: {}, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, remove() {} });
globalThis.document ??= { createElementNS: () => fakeEl() };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
await import('../ui/src/vendor/avatars/orbit-nav.js');
await import('../ui/src/vendor/avatars/qubit-engine.js');
const E = globalThis.QubitEngine;

initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mouse-')) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the look ----------
test("colours: Qubit's own for the same moment (his director's mapping, his palette unchanged)", () => {
  const states = [
    [{ phase: 'listening', hearing: true }, 'listening', E.MODES.listening.color],
    [{ phase: 'thinking' }, 'thinking', E.MODES.thinking.color],
    [{ phase: 'speaking', output: 0.5 }, 'speaking', E.MODES.speaking.color],
    [{ phase: 'listening', claudeWorking: true }, 'focused', E.MODES.focused.color],
    [{ phase: 'listening', draft: true }, 'curious', E.MODES.curious.color],
    [{ phase: 'connecting' }, 'listening', E.MODES.listening.color],
  ];
  for (const [v, mode, lch] of states) {
    assert.equal(mouseMode(v), mode, JSON.stringify(v));
    assert.equal(mouseMode(v), MODE_FOR[baseState(v, 0)], 'the same mapping as Qubit');
    assert.deepEqual(lchFor(mode, E.MODES), lch);
  }
  assert.equal(E.MODES.listening.color, E.PALETTE.cyan);
  assert.equal(E.MODES.thinking.color, E.PALETTE.violet);
  assert.equal(E.MODES.speaking.color, E.PALETTE.amber);
  // Orbit off (a helper acting with no call on): Qubit's own indigo, not his sleeping night blue.
  assert.equal(mouseMode({ phase: 'off' }), 'idle');
  assert.equal(mouseMode(null), 'idle');
  assert.deepEqual(lchFor('idle', E.MODES), E.PALETTE.indigo);
  // The Settings preview's copies are the engine's own colours.
  for (const p of PREVIEW) assert.deepEqual(p.lch, E.MODES[p.mode].color, p.label);
});

test('shape: a plain arrow, tip at 0,0, about the size of Windows\x27 own; its fill is all there is', () => {
  const nums = ARROW_PATH.match(/-?\d+(\.\d+)?/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.min(...ys), 0);
  assert.ok(Math.max(...ys) >= 17 && Math.max(...ys) <= 22, 'about 19 px tall at 100%');
  assert.ok(Math.max(...xs) >= 10 && Math.max(...xs) <= 14);
  assert.ok(ARROW_PATH.startsWith('M0 0'), 'the tip is the point');
  assert.equal(SHAPE.OUTLINE, undefined, 'no outline (Qubit\x27s art rules)');
});

test('motion: eased glides (no jumps), the pulse follows the voice, the press dips and comes back', () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const v = ease(i / 20);
    assert.ok(v >= prev, 'never goes back');
    prev = v;
  }
  assert.ok(ease(0.05) < 0.01 && ease(0.95) > 0.99, 'soft start and finish');
  const m = { from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, t0: 1000, ms: 300 };
  assert.deepEqual(glideAt(m, 1000), { x: 0, y: 0, done: false });
  assert.deepEqual(glideAt(m, 1300), { x: 100, y: 50, done: true });
  assert.deepEqual(glideAt(m, 5000), { x: 100, y: 50, done: true });
  assert.equal(pulseScale(0), 1);
  assert.ok(pulseScale(1) > 1.1 && pulseScale(1) <= 1.14 + 1e-9, 'gentle');
  assert.ok(pulseScale(0.5) > pulseScale(0.1));
  assert.equal(pulseScale(1, { reduced: true }), 1, 'no pulse with reduced motion');
  assert.equal(pulseScale(1, { speaking: false }), 1);
  assert.ok(pressAt(90) < 0.86, 'pressed in: the arrow dips');
  assert.equal(pressAt(0), 1);
  assert.equal(pressAt(400), 1, 'and back');
  for (let ms = 100; ms <= 270; ms += 10) assert.ok(pressAt(ms) >= pressAt(ms - 10), 'coming back smoothly');
  assert.equal(pressAt(50, { reduced: true }), 0.9, 'reduced motion: one still step, no animation');
  assert.equal(pressAt(200, { reduced: true }), 1);
  assert.ok(glideMs(0) >= 200 && glideMs(5000) <= 700, 'glides take a moment, never long');
});

// ---------- where a control is ----------
const WIN = { hwnd: 77, pid: 4077, exe: 'FakeApp.exe', title: 'Settings - FakeApp', cls: 'WindowsForms10', kind: 'app', min: false, cloaked: false, rect: { x: 100, y: 100, w: 800, h: 600 } };

test('rect sources: UI Automation\x27s rect; the page through the pipe for an app under Orbit (UIA if it is slow)', async () => {
  assert.deepEqual(rectOfNode({ r: [10, 20, 30, 40] }), { x: 10, y: 20, w: 30, h: 40 });
  assert.equal(rectOfNode({ r: [10, 20, 0, 40] }), null, 'nothing to point at');
  assert.equal(rectOfNode({}), null);
  const scan = { nodes: [{ i: 0, t: 'Window', r: [100, 100, 800, 600] }, { i: 1, t: 'Document', r: [100, 140, 800, 560] }, { i: 2, t: 'Document', r: [110, 150, 20, 20] }, { i: 3, t: 'Button', n: 'Save', r: [700, 120, 80, 30] }] };
  assert.deepEqual(pageRect(scan), { x: 100, y: 140, w: 800, h: 560 }, 'the biggest page area');
  const node = scan.nodes[3];
  // Not under Orbit: UI Automation.
  let asked = null;
  const cdp = async (win, o) => ((asked = o), { ok: true, inView: true, rect: { x: 702, y: 121, w: 78, h: 29 } });
  assert.deepEqual(await controlRect({ win: WIN, node, scan }, { cdp, underOrbit: () => false }), { rect: { x: 700, y: 120, w: 80, h: 30 }, via: 'uia', inView: true });
  assert.equal(asked, null, 'the pipe is only for apps under Orbit');
  // Under Orbit: the page's own geometry, placed by the page area, without scrolling the page.
  const r = await controlRect({ win: WIN, node, scan }, { cdp, underOrbit: () => true });
  assert.equal(r.via, 'pipe');
  assert.deepEqual(r.rect, { x: 702, y: 121, w: 78, h: 29 });
  assert.deepEqual(asked, { name: 'Save', contentRect: { x: 100, y: 140, w: 800, h: 560 }, scroll: false });
  // The pipe too slow (or failing): UI Automation's rect.
  const slow = () => new Promise((res) => setTimeout(() => res({ ok: true, rect: { x: 1, y: 1, w: 1, h: 1 } }), 500));
  const t0 = Date.now();
  assert.equal((await controlRect({ win: WIN, node, scan }, { cdp: slow, underOrbit: () => true, cdpMs: 60 })).via, 'uia');
  assert.ok(Date.now() - t0 < 300);
  assert.equal((await controlRect({ win: WIN, node, scan }, { cdp: async () => ({ ok: false }), underOrbit: () => true })).via, 'uia');
  // Scrolled out of view.
  assert.equal((await controlRect({ win: WIN, node: { ...node, off: 1 }, scan }, { underOrbit: () => false })).inView, false);
  // Where, in words.
  assert.equal(whereIn({ x: 700, y: 120, w: 80, h: 30 }, WIN.rect), 'top right');
  assert.equal(whereIn({ x: 480, y: 380, w: 40, h: 40 }, WIN.rect), 'middle');
  assert.equal(whereIn({ x: 110, y: 650, w: 40, h: 20 }, WIN.rect), 'bottom left');
});

test('it shows only where the user would see it: not minimized, not covered, on screen', async () => {
  const rect = { x: 700, y: 120, w: 80, h: 30 };
  const on = (v) => async () => ({ ok: true, hits: [v] });
  const deps = { onScreen: () => true, selfPid: 999 };
  assert.deepEqual(await seenAt(WIN, rect, { ...deps, hit: on({ on: true, pid: 4077 }) }), { ok: true });
  assert.equal((await seenAt({ ...WIN, min: true }, rect, deps)).why, 'minimized');
  assert.equal((await seenAt({ ...WIN, cloaked: true }, rect, deps)).why, 'hidden');
  assert.equal((await seenAt(WIN, rect, { ...deps, hit: on({ on: false, pid: 1234 }) })).why, 'covered');
  assert.deepEqual(await seenAt(WIN, rect, { ...deps, hit: on({ on: false, pid: 999 }) }), { ok: true }, "one of Orbit's own windows there (the orb) doesn't count");
  assert.equal((await seenAt(WIN, rect, { ...deps, onScreen: () => false })).why, 'off_screen');
  assert.equal((await seenAt(WIN, { x: 950, y: 120, w: 20, h: 20 }, deps)).why, 'scrolled_away', 'outside its window');
  assert.deepEqual(await seenAt(WIN, rect, { ...deps, hit: async () => ({ ok: false, error: 'failed' }) }), { ok: true }, 'no answer: the window state decides');
});

/** A stand-in for the overlay: records glides and presses. */
function fakeSink() {
  const s = {
    glides: [],
    presses: 0,
    glide(o) {
      s.glides.push(o);
      return { shown: true, ms: o.ms ?? 300, arrived: sleep(o.ms ?? 300) };
    },
    press() {
      s.presses++;
      return true;
    },
    hide() {},
    onScreen: () => true,
  };
  return s;
}

test('pointAt: glides to the middle of the control and rests there; nothing when off or covered', async () => {
  const sink = fakeSink();
  setMouseSink(sink);
  const node = { i: 3, t: 'Button', n: 'Save', r: [700, 120, 80, 30] };
  const deps = { underOrbit: () => false, hit: async () => ({ ok: true, hits: [{ on: true, pid: 1 }] }) };
  const r = await pointAt({ win: WIN, node, scan: { nodes: [node] } }, deps);
  assert.equal(r.shown, true, JSON.stringify(r));
  assert.equal(r.where, 'top right');
  assert.deepEqual(sink.glides[0], { x: 740, y: 135, holdMs: MOUSE.pointMs }, 'only where the arrow goes (no ring)');
  assert.equal(sink.presses, 0, 'pointing never presses');
  const covered = await pointAt({ win: WIN, node, scan: { nodes: [node] } }, { ...deps, hit: async () => ({ ok: true, hits: [{ on: false, pid: 5 }] }) });
  assert.deepEqual([covered.shown, covered.why, covered.where], [false, 'covered', 'top right']);
  assert.equal(sink.glides.length, 1);
  updateSettings({ anywhereMouse: false });
  assert.equal((await pointAt({ win: WIN, node, scan: { nodes: [node] } }, deps)).why, 'off');
  updateSettings({ anywhereMouse: true });
  setMouseSink(null);
  assert.equal((await pointAt({ win: WIN, node, scan: { nodes: [node] } }, deps)).why, 'off', 'no overlay (tests, the web build)');
});

test('leadIn: an act waits about the lead time, never on anything slow; then presses', async () => {
  const sink = fakeSink();
  setMouseSink(sink);
  const node = { i: 3, t: 'Button', n: 'Save', r: [700, 120, 80, 30] };
  const deps = { underOrbit: () => false, hit: async () => ({ ok: true, hits: [{ on: true, pid: 1 }] }) };
  assert.equal(leadMs(), 220);
  let t0 = Date.now();
  let r = await leadIn({ win: WIN, node }, deps);
  let took = Date.now() - t0;
  assert.equal(r.shown, true);
  assert.ok(took >= 200 && took < 330, `about the lead time (${took} ms)`);
  assert.equal(sink.glides[0].ms, 220);
  assert.equal(sink.presses, 1, 'pressed where it acts');
  // A slow hit test: given up on, the act goes on.
  t0 = Date.now();
  r = await leadIn({ win: WIN, node }, { ...deps, hit: () => sleep(5000) });
  took = Date.now() - t0;
  assert.ok(took < MOUSE.lookupMs + MOUSE.leadMs + 150, `bounded (${took} ms)`);
  // Configurable, and 0 means no lead at all.
  updateSettings({ anywhereMouseLeadMs: 150 });
  t0 = Date.now();
  await leadIn({ win: WIN, node }, deps);
  assert.ok(Date.now() - t0 < 260);
  assert.equal(sink.glides.at(-1).ms, 150);
  updateSettings({ anywhereMouseLeadMs: 0 });
  const n = sink.glides.length;
  assert.equal((await leadIn({ win: WIN, node }, deps)).shown, false);
  assert.equal(sink.glides.length, n);
  updateSettings({ anywhereMouseLeadMs: 5000 });
  assert.equal(getSetting('anywhereMouseLeadMs'), 600, 'never longer than 600 ms');
  updateSettings({ anywhereMouseLeadMs: 220 });
  // Not visible (minimized): no glide, no press, and the act isn't held up.
  t0 = Date.now();
  assert.equal((await leadIn({ win: { ...WIN, min: true }, node }, deps)).why, 'minimized');
  assert.ok(Date.now() - t0 < 50);
  setMouseSink(null);
});

// ---------- the tool and acts, with a stand-in UI Automation helper ----------
const APP = { hwnd: 88, owner: 0, pid: 4088, exe: 'FakeApp.exe', title: 'Notes - FakeApp', cls: 'WindowsForms10', kind: 'app', min: false, max: false, cloaked: false, elevated: false, x: 100, y: 100, w: 800, h: 600, dpi: 96 };
const NODES = [
  { i: 0, p: -1, t: 'Window', n: 'Notes - FakeApp', en: 1, r: [100, 100, 800, 600] },
  { i: 1, p: 0, t: 'Button', n: 'Save', en: 1, pat: 'I', rid: 'r1', r: [700, 120, 80, 30] },
  { i: 2, p: 0, t: 'Edit', n: 'Message', en: 1, pat: 'V', rid: 'r2', r: [120, 120, 400, 24] },
  { i: 3, p: 0, t: 'Button', n: 'Theme', en: 1, pat: 'I', rid: 'r3', r: [120, 300, 80, 30] },
];
const calls = [];
setUiaHost({
  request: async (op, args) => {
    calls.push({ op, args, at: Date.now() });
    if (op === 'scan') return { ok: true, fw: 'Win32', nodes: NODES };
    if (op === 'hit') return { ok: true, hits: [{ on: true, pid: 4088 }] };
    if (op === 'act') return { ok: true, via: 'uia-invoke', verified: true };
    return { ok: false, error: 'failed' };
  },
});
setFocusBackend({ describe: async (h) => (h === 88 ? APP : null), list: async () => [APP] });
focus.reset();
focus.update(APP);

function runner() {
  const said = [];
  const latest = () => said.at(-1) || null;
  const r = createToolRunner({ notify: () => {}, recentUtterance: latest, utteranceSince: async (ts) => (latest() && latest().at > ts ? latest() : null), userWords: () => said.map((u) => u.text).join(' ') });
  return {
    say: async (text) => (await sleep(3), said.push({ text, at: Date.now() })),
    run: (name, args = {}) => r.run(name, JSON.stringify(args)),
    note: () => r.noteNotification(),
  };
}

test('point_at: only on the user\x27s own words, read-only, and says where when it can\x27t show', async () => {
  const sink = fakeSink();
  setMouseSink(sink);
  const v = runner();
  // No words from the user yet: nothing.
  let r = await v.run('point_at', { control: 'Save' });
  assert.match(r.error, /own words/);
  assert.equal(sink.glides.length, 0);
  await v.say('how do I save this');
  calls.length = 0;
  r = await v.run('point_at', { control: 'Save' });
  assert.equal(r.pointed, true, JSON.stringify(r));
  assert.equal(r.control, 'Save');
  assert.equal(r.where, 'top right');
  assert.deepEqual([sink.glides[0].x, sink.glides[0].y], [740, 135]);
  assert.ok(calls.every((c) => c.op !== 'act'), 'never acts');
  assert.equal(sink.presses, 0, 'never presses');
  // A notification since the user spoke: not on its say-so.
  v.note();
  r = await v.run('point_at', { control: 'Save' });
  assert.match(r.error, /own words/);
  await v.say('where is theme');
  assert.match((await v.run('point_at', { control: 'Nothing like it' })).error, /no "Nothing like it"/);
  assert.match((await v.run('point_at', { control: '' })).error, /which control/);
  // Off-limits windows stay off-limits.
  const bank = { ...APP, hwnd: 89, title: 'Online Banking - FakeApp' };
  setFocusBackend({ describe: async (h) => (h === 88 ? APP : h === 89 ? bank : null), list: async () => [APP, bank] });
  assert.match((await v.run('point_at', { window: 'online banking', control: 'Save' })).error, /banking/);
  // The window minimized: it says where, in words.
  setFocusBackend({ describe: async () => ({ ...APP, min: true }), list: async () => [{ ...APP, min: true }] });
  r = await v.run('point_at', { control: 'Theme' });
  assert.equal(r.pointed, false);
  assert.match(r.why, /minimized/);
  assert.equal(r.where, 'left');
  setFocusBackend({ describe: async (h) => (h === 88 ? APP : null), list: async () => [APP] });
  setMouseSink(null);
});

test('acts: Orbit\x27s mouse glides to the control and presses first, then the act goes in', async () => {
  const sink = fakeSink();
  setMouseSink(sink);
  calls.length = 0;
  const t0 = Date.now();
  const r = await perform({ win: { ...APP, rect: { x: 100, y: 100, w: 800, h: 600 } }, node: NODES[1], action: 'press' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const act = calls.find((c) => c.op === 'act');
  assert.ok(act, 'the act went in through UI Automation');
  assert.equal(sink.glides.length, 1);
  assert.deepEqual([sink.glides[0].x, sink.glides[0].y], [740, 135]);
  assert.equal(sink.presses, 1);
  assert.ok(act.at - t0 >= 200, 'the act came after the lead-in');
  assert.ok(act.at - t0 < 400, `and not long after (${act.at - t0} ms)`);
  // Through the voice tool, too.
  const v = runner();
  await v.say('press save');
  const res = await v.run('act_in_window', { control: 'Save', action: 'press' });
  assert.equal(res.done, true, JSON.stringify(res));
  assert.equal(sink.glides.length, 2);
  // Off: acts go straight in.
  updateSettings({ anywhereMouse: false });
  const t1 = Date.now();
  await perform({ win: APP, node: NODES[1], action: 'press' });
  assert.ok(Date.now() - t1 < 150);
  assert.equal(sink.glides.length, 2);
  updateSettings({ anywhereMouse: true });
  setMouseSink(null);
});

// ---------- the overlay, with stand-in windows ----------
function fakeElectron() {
  const made = [];
  class Win {
    constructor(o) {
      this.o = o;
      this.visible = false;
      this.sent = [];
      this.destroyed = false;
      this.focused = 0;
      this.ignore = null;
      this.top = null;
      this.handlers = {};
      this.webContents = { on: (ev, fn) => (this.handlers[ev] = fn), send: (ch, m) => this.sent.push([ch, JSON.parse(JSON.stringify(m))]) };
      made.push(this);
    }
    loadURL(u) {
      this.url = u;
      setTimeout(() => this.handlers['did-finish-load']?.(), 1);
    }
    setIgnoreMouseEvents(v, o) {
      this.ignore = [v, o];
    }
    setAlwaysOnTop(v, level) {
      this.top = [v, level];
    }
    showInactive() {
      this.visible = true;
    }
    show() {
      this.visible = true;
      this.focused++;
    }
    focus() {
      this.focused++;
    }
    hide() {
      this.visible = false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    setBounds(b) {
      this.bounds = { ...b };
    }
    on() {}
  }
  const displays = [
    { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, scaleFactor: 1.5, workArea: { x: 1920, y: 0, width: 1280, height: 680 } }, // (DIPs; physical 2880 x 1020 at 1920)
  ];
  const screen = {
    getAllDisplays: () => displays,
    dipToScreenRect: (_w, r) => {
      const d = displays.find((x) => x.workArea.x === r.x);
      return d.id === 1 ? r : { x: 1920, y: 0, width: r.width * 1.5, height: r.height * 1.5 };
    },
    on() {},
  };
  return { BrowserWindow: Win, screen, made };
}

test('the overlay: per display, click-through, never focused; glides, presses, fades and hides', async () => {
  const fx = fakeElectron();
  let t = 10_000;
  const m = createOrbitMouse({ url: () => 'http://127.0.0.1/mouse.html', BrowserWindow: fx.BrowserWindow, screen: fx.screen, now: () => t });
  assert.equal(fx.made.length, 0, 'no windows until it is used');
  assert.equal(m.onScreen({ x: 500, y: 500 }), true);
  assert.equal(m.onScreen({ x: 500, y: 1070 }), false, 'the taskbar strip is not covered');
  assert.equal(m.glide({ x: -50, y: 10 }).why, 'off_screen');
  const g = m.glide({ x: 740, y: 135, holdMs: 120 });
  assert.equal(g.shown, true);
  assert.equal(fx.made.length, 1, 'only the display it is on');
  const w = fx.made[0];
  assert.deepEqual([w.o.focusable, w.o.transparent, w.o.skipTaskbar, w.o.frame, w.o.show], [false, true, true, false, false]);
  assert.deepEqual(w.ignore, [true, undefined], 'mouse events ignored: clicks go through');
  assert.deepEqual(w.top, [true, 'screen-saver']);
  assert.equal(w.visible, true);
  assert.equal(w.focused, 0, 'shown without activating, never focused');
  assert.ok(w.bounds.width < 700 && w.bounds.height < 600 && w.bounds.x >= 0 && w.bounds.y >= 0, 'sized to the glide, not the whole display');
  const b0 = { ...w.bounds };
  await sleep(5);
  const last = () => w.sent.at(-1)?.[1];
  assert.equal(last().visible, true);
  assert.equal(last().enter, true, 'a fresh appearance fades in near the target');
  assert.deepEqual(last().motion.to, { x: 740, y: 135 });
  assert.ok(last().motion.from.x < 740 && last().motion.from.y < 135, 'and glides in from up and left');
  assert.equal(last().ring, undefined, 'no ring: the arrow alone');
  // Mid-glide, a new target: it starts from where it is (no jump).
  t += g.ms / 2;
  const g2 = m.glide({ x: 1200, y: 600, ms: 220, holdMs: 100 });
  const from = last().motion.from;
  assert.ok(from.x > 690 && from.x < 740, `from where it was (${from.x})`);
  assert.equal(last().enter, false);
  assert.equal(g2.ms, 220);
  assert.ok(w.bounds.x <= b0.x && w.bounds.y <= b0.y && w.bounds.x + w.bounds.width >= b0.x + b0.width, 'while showing, it only grows');
  // The voice state reaches it (the colour, the pulse).
  m.onVoice({ phase: 'speaking', output: 0.7, hearing: false, extra: 'x' });
  assert.deepEqual(last().voice, { output: 0.7, phase: 'speaking', asleep: false, hearing: false, muted: false, draft: false, sending: false, claudeWorking: false });
  m.press();
  assert.equal(last().press.at, t);
  // Across to the second display (scaled 150%): both show while it crosses, its page gets its own scale.
  t += 300;
  m.glide({ x: 2400, y: 300, ms: 200, holdMs: 60 });
  assert.equal(fx.made.length, 2);
  const w2 = fx.made[1];
  assert.equal(w2.visible, true);
  assert.equal(w.visible, true, 'still crossing');
  await sleep(10);
  assert.equal(w2.sent.at(-1)[1].scale, 1.5);
  assert.deepEqual(w2.sent.at(-1)[1].area, { x: 1920, y: 0 }, 'its display, in physical pixels');
  assert.deepEqual(w2.sent.at(-1)[1].wa, { x: 1920, y: 0 });
  assert.ok(w2.bounds.width < 1280 && w2.bounds.x >= 1920, 'its window only as big as the glide needs, inside its display');
  await sleep(230);
  assert.equal(w.visible, false, 'the first display hides once it is across');
  // Idle: it fades out, then hides.
  await sleep(60 + 400);
  assert.equal(w2.sent.at(-1)[1].visible, false);
  assert.equal(w2.visible, false);
  assert.equal(m.press(), false, 'nothing to press while hidden');
  assert.ok(fx.made.every((x) => x.focused === 0));
  m.stop();
  assert.ok(fx.made.every((x) => x.destroyed));
});

test('the overlay: off in Settings means no glide at all', () => {
  const fx = fakeElectron();
  const m = createOrbitMouse({ url: () => 'x', BrowserWindow: fx.BrowserWindow, screen: fx.screen, enabled: () => false });
  assert.equal(m.glide({ x: 10, y: 10 }).why, 'off');
  m.prewarm();
  assert.equal(fx.made.length, 0);
});

// ---------- the page: what it draws ----------
test("the page draws only the arrow: one solid fill, no stroke, outline, ring, glow or gradient", async () => {
  // A small stand-in DOM, enough for ui/src/mouse/main.js.
  const made = [];
  const node = (tag) => {
    const e = {
      tagName: tag,
      attrs: {},
      children: [],
      style: {},
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      get attributes() {
        return Object.entries(this.attrs).map(([name, value]) => ({ name, value }));
      },
    };
    made.push(e);
    return e;
  };
  const body = node('body');
  const frames = [];
  let onState = null;
  const saved = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame, add: globalThis.addEventListener };
  globalThis.document = { createElementNS: (_ns, tag) => node(tag), documentElement: { style: {} }, body };
  globalThis.window = Object.assign(globalThis, { QubitEngine: E, desktop: { onMouseState: (cb) => (onState = cb) }, matchMedia: () => ({ matches: false }), screenX: 0, screenY: 0 });
  globalThis.requestAnimationFrame = (fn) => (frames.push(fn), frames.length);
  globalThis.addEventListener = () => {};
  try {
    await import('../ui/src/mouse/main.js');
    const now = Date.now();
    onState({ visible: true, enter: true, motion: { from: { x: 100, y: 100 }, to: { x: 300, y: 200 }, t0: now - 1000, ms: 300 }, press: { at: now - 50 }, voice: { phase: 'speaking', output: 0.6 }, area: { x: 0, y: 0 }, wa: { x: 0, y: 0 }, scale: 1 });
    let t = 0;
    for (let i = 0; i < 40 && frames.length; i++) frames.shift()((t += 17));
    const M = globalThis.__mouse;
    assert.deepEqual(M.pos, { x: 300, y: 200 }, 'at the end of its glide');
    const drawn = M.drawn;
    assert.deepEqual(drawn.map(([tag]) => tag), ['svg', 'g', 'g', 'path'], 'one svg, its groups, one path');
    for (const [tag, attrs] of drawn) {
      for (const k of Object.keys(attrs)) assert.ok(!/stroke|paint-order|filter|shadow|mask|clip/i.test(k), `${tag} has no ${k}`);
      assert.ok(!/url\(|gradient|blur|shadow/i.test(Object.values(attrs).join(' ')), `${tag}: no gradient, blur or shadow`);
    }
    assert.ok(!made.some((e) => ['rect', 'circle', 'ellipse', 'line', 'polyline', 'lineargradient', 'radialgradient', 'filter'].includes(String(e.tagName).toLowerCase())), 'no ring, no other shape, no gradient or filter');
    const path_ = drawn.find(([tag]) => tag === 'path')[1];
    assert.equal(path_.d, ARROW_PATH);
    assert.match(path_.fill, /^oklch\([\d.]+ [\d.]+ [\d.]+\)$/, 'one solid, fully opaque colour (no alpha)');
    assert.equal(drawn[2][1].opacity, undefined, 'the arrow itself is never translucent');
    assert.match(drawn[1][1].opacity, /^[\d.]+$/, 'only the whole cursor fades in and out');
  } finally {
    Object.assign(globalThis, { document: saved.document, requestAnimationFrame: saved.raf, addEventListener: saved.add });
    if (saved.window === undefined) delete globalThis.window;
  }
});
