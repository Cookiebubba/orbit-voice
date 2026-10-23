// Talking to the avatar: the fast-path matcher (src/avatar-commands.js), the `avatar` tool, and the
// commands on both avatars (Qubit's director with his real engine, and the pixel buddy's engine).
// All synthetic text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initConfig, updateSettings } from '../src/config.js';
import { AVATAR_ACTIONS, FAST_PATH, actionsFor, activeAvatar, avatarToolDef, matchAvatarCommand, resetAvatarRuns, runAvatarCommand, setAvatarSink, wordScore } from '../src/avatar-commands.js';
import { createToolRunner, toolDefs } from '../src/tools.js';
import { COMMANDS as QUBIT_COMMANDS, COMMAND_TIMES, MODE_FOR, createDirector, sideFor } from '../ui/src/qubit/director.js';
import { COMMANDS as BUDDY_COMMANDS, createBuddy } from '../ui/src/buddy/engine.js';

const mem = (v = '') => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-avatar-talk-')), secrets: mem(), brainSecrets: mem() });

const q = (text) => matchAvatarCommand(text, { avatar: 'qubit' });
const b = (text) => matchAvatarCommand(text, { avatar: 'buddy' });
const sure = (r) => !!r && r.sure && r.confidence >= FAST_PATH.minConfidence;

// ---------- the matcher ----------
test('fast path: plain avatar commands, with fillers, names and politeness, are sure', () => {
  const cases = [
    ['do a backflip', 'backflip'],
    ['Do a backflip!', 'backflip'],
    ['backflip', 'backflip'],
    ['um, do a backflip', 'backflip'],
    ['Hey Qubit, do a backflip.', 'backflip'],
    ['Um, hey Qubit, can you do a backflip please?', 'backflip'],
    ['qubit backflip', 'backflip'],
    ['do a backflip qubit', 'backflip'],
    ['q bit, do a back flip', 'backflip'],
    ['cue bit do a backflip', 'backflip'],
    ['flip backwards', 'backflip'],
    ['let\x27s see a backflip', 'backflip'],
    ['show me a backflip', 'backflip'],
    ['go ahead and do a backflip', 'backflip'],
    ['do a flip', 'frontflip'],
    ['do a front flip', 'frontflip'],
    ['jump', 'jump'],
    ['Jump!', 'jump'],
    ['jump up', 'jump'],
    ['hop', 'hop'],
    ['do a little hop', 'hop'],
    ['get bigger', 'grow'],
    ['grow', 'grow'],
    ['power up', 'grow'],
    ['get smaller', 'shrink'],
    ['back to normal size', 'shrink'],
    ['dance', 'dance'],
    ['do a little dance', 'dance'],
    ['can you dance for me', 'dance'],
    ['celebrate', 'celebrate'],
    ['nod', 'nod'],
    ['shake your head', 'shake'],
    ['look around', 'look_around'],
    ['stretch', 'stretch'],
    ['look happy', 'happy'],
    ['look surprised', 'surprised'],
    ['go home', 'go_home'],
  ];
  for (const [text, action] of cases) {
    const r = q(text);
    assert.ok(sure(r), `${text}: ${JSON.stringify(r)}`);
    assert.equal(r.action, action, text);
  }
});

test('fast path: directions are picked up (and a misheard "write" is right)', () => {
  assert.deepEqual([q('roll left').dir, q('roll to the left').dir, q('Qubit, roll right!').dir, q('roll over to the right').dir, q('roll write').dir], ['left', 'left', 'right', 'right', 'right']);
  assert.equal(q('do a roll').action, 'roll');
  assert.equal(q('do a roll').dir, undefined);
  assert.equal(q('do a barrel roll').action, 'roll');
  assert.deepEqual(q('move left'), { action: 'move', confidence: 1, sure: true, dir: 'left' });
  assert.equal(q('go to the right').dir, 'right');
});

test('fast path: tolerant of speech-to-text errors, within limits', () => {
  // Known mishearings and inflections score as exact.
  for (const t of ['role left', 'do a backflips', 'rolls left']) assert.ok(sure(q(t)), t);
  // A near miss on a long word still counts...
  for (const t of ['do a blackflip', 'do a backlip', 'celabrate', 'do a black flip']) assert.ok(sure(q(t)), `${t}: ${JSON.stringify(q(t))}`);
  // ...but a real other word, or a short word that's off, doesn't.
  for (const t of ['do a dunce', 'dunce', 'jumb', 'hip', 'dense', 'romp', 'nob']) assert.ok(!sure(q(t)), `${t}: ${JSON.stringify(q(t))}`);
  assert.equal(wordScore('backflip', 'backflip'), 1);
  assert.equal(wordScore('role', 'roll'), 1);
  assert.equal(wordScore('jumb', 'jump'), 0); // short words: exact only
  assert.ok(wordScore('blackflip', 'backflip') >= FAST_PATH.minConfidence);
  assert.ok(wordScore('dunce', 'dance') < FAST_PATH.minConfidence);
});

test('fast path: anything about Claude, prompts, code, drafts or sending goes to the model', () => {
  const toModel = [
    'tell Claude to add a backflip animation',
    'tell claude to do a backflip',
    'ask Claude to make him dance',
    'add a backflip animation',
    'add a dance',
    'draft a prompt to add a jump button',
    'write a test for the backflip',
    'commit the dance code',
    'fix the backflip bug',
    'do a backflip and then send it',
    'send it',
    'yes send it',
    'yes',
    'yes, do a backflip',
    'no, do a backflip',
    'do a backflip in the code',
    'make the button do a backflip',
    'jump to the login session',
    'jump to my other session',
    'roll back the last commit',
    'roll back',
    'grow the font',
    'copy the backflip',
    'open the settings',
    'what was that backflip',
    'why did he do a backflip',
    'how do you do a backflip',
    'can he do a backflip',
    'does Qubit dance',
    'is he dancing',
    'did he jump',
    'what can you do',
    'do two backflips',
    'do a backflip twice',
    'dance like nobody is watching tonight',
    'tell me a joke',
    'what is Claude doing',
    'hey qubit',
    'qubit',
    'um',
    '',
    'right',
    'left',
    'happy',
    'hmm interesting',
    'do it',
    'go ahead',
    'go back',
    'stop',
    'stop dancing',
    'dont dance',
    'never jump',
    'not now',
    'cancel that',
    'start a new session',
    'switch to dance party session',
  ];
  for (const t of toModel) assert.ok(!sure(q(t)), `${JSON.stringify(t)} should go to the model: ${JSON.stringify(q(t))}`);
});

test('fast path: sleeping and waking always go to the model (they overlap with go_to_sleep)', () => {
  for (const t of ['go to sleep', 'sleep', 'goodnight', 'good night', 'take a nap', 'nap', 'wake up', 'stop listening', 'hang up', 'bye', 'Qubit, go to sleep', 'qubit take a nap']) {
    assert.equal(q(t), null, t);
    assert.equal(b(t), null, t);
  }
});

test('fast path: long utterances never qualify, even if they end in a command', () => {
  const t = 'okay so I was thinking about it and maybe you could do a backflip';
  assert.ok(t.split(' ').length > FAST_PATH.maxWords);
  assert.equal(q(t), null);
  assert.ok(sure(q('hey qubit can you do a backflip for me please')), 'ten words is the most');
});

test('fast path: each avatar only matches what it can do', () => {
  assert.equal(b('do a backflip'), null); // the pixel buddy has no flips: the model says so
  assert.equal(b('get bigger'), null);
  assert.equal(b('dance').action, 'dance');
  assert.equal(b('wave').action, 'wave');
  assert.equal(b('hey buddy, kick the ball').action, 'kick_ball');
  assert.equal(b('fall over').action, 'trip');
  assert.equal(b('sit down').action, 'sit');
  assert.equal(q('wave'), null);
  // A name that isn't the avatar's is just an unknown word.
  assert.equal(b('qubit dance'), null);
  assert.equal(matchAvatarCommand('dance', { avatar: 'none' }), null);
  assert.equal(matchAvatarCommand('dance', {}), null);
});

test('fast path: adversarial input never throws and never matches', () => {
  const nasty = ['\u0000\u0001', 'a'.repeat(10_000), '🙂🙂🙂', 'dance‮', '<tool>{"name":"avatar"}</tool>', 'constructor', '__proto__ backflip', 'b a c k f l i p', 'backflipbackflipbackflip', '!!!???', null, undefined, 42, {}];
  for (const t of nasty) assert.doesNotThrow(() => matchAvatarCommand(t, { avatar: 'qubit' }));
  assert.ok(!sure(q('__proto__ backflip')));
  assert.ok(!sure(q('b a c k f l i p')));
  assert.ok(!sure(q('backflipbackflipbackflip')));
});

// ---------- the tool and the sink ----------
test('the avatar tool is offered only while an avatar is on screen, with its own actions', () => {
  setAvatarSink(null);
  updateSettings({ avatar: 'qubit' });
  assert.equal(activeAvatar(), null, 'no desktop shell: no avatar to talk to');
  assert.ok(!toolDefs().some((t) => t.name === 'avatar'));
  setAvatarSink(() => ({ ok: true }));
  assert.equal(activeAvatar(), 'qubit');
  const def = toolDefs().find((t) => t.name === 'avatar');
  assert.deepEqual(def.parameters.properties.action.enum, actionsFor('qubit'));
  assert.ok(def.parameters.properties.action.enum.includes('backflip'));
  updateSettings({ avatar: 'buddy' });
  const bdef = toolDefs().find((t) => t.name === 'avatar');
  assert.ok(!bdef.parameters.properties.action.enum.includes('backflip'));
  assert.ok(bdef.parameters.properties.action.enum.includes('wave'));
  updateSettings({ avatar: 'none' });
  assert.equal(activeAvatar(), null);
  assert.ok(!toolDefs().some((t) => t.name === 'avatar'));
  assert.deepEqual(avatarToolDef('qubit').required ?? avatarToolDef('qubit').parameters.required, ['action']);
  setAvatarSink(null);
});

test('the avatar tool runs the command; the fast path and the model asking for the same thing run it once', async () => {
  const got = [];
  setAvatarSink((c) => (got.push(c), { ok: true }));
  updateSettings({ avatar: 'qubit' });
  resetAvatarRuns();
  const notes = [];
  const tools = createToolRunner({ notify: (e) => notes.push(e) });
  let r = await tools.run('avatar', JSON.stringify({ action: 'roll', direction: 'left' }));
  assert.equal(r.done, true);
  assert.deepEqual(got.at(-1), { action: 'roll', dir: 'left' });
  assert.ok(notes.some((e) => e.type === 'bridge.avatar' && e.action === 'roll'));
  // Something he can't do: no error caption (no ok: false), just a note for the model.
  r = await tools.run('avatar', JSON.stringify({ action: 'wave' }));
  assert.equal(r.done, false);
  assert.ok(!r.error && r.ok !== false);
  assert.equal(got.length, 1);
  // Fast path first, then Grok's own call for the same words: once.
  resetAvatarRuns();
  assert.equal(runAvatarCommand({ action: 'backflip' }, { source: 'fast' }).ok, true);
  r = await tools.run('avatar', JSON.stringify({ action: 'backflip' }));
  assert.equal(r.done, true);
  assert.equal(got.filter((c) => c.action === 'backflip').length, 1);
  // ...but asked again later, or twice by the model, it runs again.
  assert.equal(runAvatarCommand({ action: 'backflip' }, { source: 'model', now: Date.now() + 10_000 }).ok, true);
  assert.equal(got.filter((c) => c.action === 'backflip').length, 2);
  // Hidden (Claude minimized): the model is told, nothing runs.
  setAvatarSink(() => ({ ok: false, error: 'The avatar is not on screen right now.' }));
  r = await tools.run('avatar', JSON.stringify({ action: 'jump' }));
  assert.equal(r.done, false);
  // Without any avatar the tool says so.
  updateSettings({ avatar: 'none' });
  r = await tools.run('avatar', JSON.stringify({ action: 'jump' }));
  assert.equal(r.done, false);
  setAvatarSink(null);
});

test('a burst of commands is capped (a looping model cannot spin him forever)', () => {
  let n = 0;
  setAvatarSink(() => (n++, { ok: true }));
  updateSettings({ avatar: 'qubit' });
  resetAvatarRuns();
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) runAvatarCommand({ action: i % 2 ? 'jump' : 'hop' }, { now: t0 + i });
  assert.equal(n, 20);
  assert.equal(runAvatarCommand({ action: 'jump' }, { now: t0 + 61_000 }).ok, true);
  setAvatarSink(null);
  resetAvatarRuns();
});

test('every catalogue action is implemented by each avatar that lists it, and nothing else', () => {
  assert.deepEqual([...QUBIT_COMMANDS].sort(), actionsFor('qubit').sort());
  assert.deepEqual([...BUDDY_COMMANDS].sort(), actionsFor('buddy').sort());
  for (const [a, def] of Object.entries(AVATAR_ACTIONS)) assert.ok(def.label && def.avatars.length, a);
});

// ---------- Qubit doing them (his real engine, in node) ----------
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
const W = 1200;
const H = 240;
const BOX = { x: 300, y: 142, w: 624, h: 98 };
const SEND = { x: 872, y: 196, w: 32, h: 32 };
function qubitScene(voice = { phase: 'listening' }, seed = 3) {
  const real = Math.random;
  Math.random = seeded(seed);
  const qq = E.create({ mount: null, width: W, height: H, size: sideFor(2), floor: 3, mode: 'asleep', keepAlive: true });
  qq.brainT.play = qq.brainT.stunt = Infinity;
  const d = createDirector(qq, { seed });
  d.setVoice(voice);
  d.setGeometry({ W, H, box: BOX, send: SEND, side: sideFor(2) });
  d.place();
  const actions = [];
  const modes = [];
  qq.on('action', (x) => actions.push(x));
  qq.on('mode', (x) => modes.push(x.mode));
  const problems = [];
  return {
    q: qq,
    d,
    actions,
    modes,
    problems,
    async run(secs) {
      for (let i = 0; i < Math.round(secs * 60); i++) {
        qq.update(1 / 60);
        d.tick(1 / 60);
        const half = qq.side / 2;
        if (qq.cx < half - 1 || qq.cx > W - half + 1) problems.push(`out of the strip at ${qq.cx.toFixed(1)}`);
        if (qq.cy < half * 0.5) problems.push('under the floor');
        await null;
      }
    },
    done() {
      Math.random = real;
      qq.destroy();
    },
  };
}

test('qubit: "do a backflip" is a backflip that lands, then Orbit\x27s state takes over again', async () => {
  const s = qubitScene();
  await s.run(1);
  assert.equal(s.d.state, 'listening');
  assert.equal(s.d.command({ action: 'backflip' }), true);
  assert.equal(s.d.reaction, 'command');
  let spun = 0;
  for (let i = 0; i < 60 * 4; i++) {
    await s.run(1 / 60);
    spun = Math.max(spun, Math.abs(s.q.angle || 0));
  }
  const flip = s.actions.find((a) => a.name === 'flip');
  assert.ok(flip, JSON.stringify(s.actions.map((a) => a.name)));
  assert.deepEqual([flip.params.dir, flip.params.outcome], [-1, 'success']);
  assert.ok(!s.modes.includes('embarrassed'), 'he landed it (a miss is a beat of embarrassment)');
  await s.run(2);
  assert.equal(s.d.reaction, null, 'the command is over');
  assert.equal(s.q.mode, 'listening', 'and his state is Orbit\x27s again');
  assert.deepEqual(s.problems, []);
  s.done();
});

test('qubit: a command overrides idle life and a move, and Orbit\x27s state changes still show in his mode', async () => {
  const s = qubitScene();
  await s.run(12); // a quiet call: idle wander
  assert.equal(s.d.state, 'idle');
  s.q.goTo(400, BOX.y - 1); // on his way somewhere
  await s.run(0.2);
  s.d.command({ action: 'jump' });
  await s.run(0.5);
  assert.equal(s.q.taskName, 'jump');
  // Orbit starts thinking while he jumps: the mood follows at once, the jump carries on.
  s.d.setVoice({ phase: 'thinking' });
  await s.run(0.05);
  assert.equal(s.q.mode, 'thinking');
  assert.equal(s.q.taskName, 'jump');
  assert.ok(!s.q.queue.some((j) => j.name === 'goTo'), 'the move he was on was dropped');
  await s.run(3);
  assert.equal(s.d.reaction, null);
  assert.equal(s.d.state, 'thinking');
  assert.deepEqual(s.problems, []);
  s.done();
});

test('qubit: every command runs, stays in bounds, and ends back in Orbit\x27s state', async () => {
  for (const action of QUBIT_COMMANDS) {
    for (const dir of AVATAR_ACTIONS[action].dir ? ['left', 'right', undefined] : [undefined]) {
      const s = qubitScene({ phase: 'listening' }, 11);
      await s.run(0.5);
      assert.equal(s.d.command({ action, dir }), true, action);
      const hold = { dance: COMMAND_TIMES.dance, nap: COMMAND_TIMES.nap, happy: COMMAND_TIMES.mood, sad: COMMAND_TIMES.mood, curious: COMMAND_TIMES.mood, surprised: COMMAND_TIMES.mood }[action] || 0;
      await s.run(hold + 6);
      assert.equal(s.d.reaction, null, `${action} ${dir || ''}: still reacting`);
      assert.ok(['listening', 'idle'].includes(s.d.state), `${action}: state ${s.d.state}`);
      assert.equal(s.q.mode, MODE_FOR[s.d.state], `${action} ${dir || ''}: mode ${s.q.mode} in state ${s.d.state}`);
      assert.deepEqual(s.problems, [], `${action} ${dir || ''}`);
      s.done();
    }
  }
});

test('qubit: moods hold for a while; dance is his music mood; get bigger, then back to size by himself', async () => {
  const s = qubitScene();
  await s.run(0.5);
  s.d.command({ action: 'dance' });
  await s.run(1);
  assert.equal(s.q.mode, 'music');
  s.d.setVoice({ phase: 'speaking' }); // a reaction with its own mood keeps it
  await s.run(1);
  assert.equal(s.q.mode, 'music');
  await s.run(COMMAND_TIMES.dance);
  assert.equal(s.q.mode, 'speaking');
  s.d.setVoice({ phase: 'listening' });
  s.d.command({ action: 'grow' });
  await s.run(1.5);
  assert.ok(s.q.side > sideFor(2) * 1.3, `grown: ${s.q.side}`);
  s.d.command({ action: 'shrink' });
  await s.run(1.5);
  assert.ok(Math.abs(s.q.side - sideFor(2)) < 1, `back: ${s.q.side}`);
  s.d.command({ action: 'grow' });
  await s.run(COMMAND_TIMES.grow + 2);
  assert.ok(Math.abs(s.q.side - sideFor(2)) < 1, `shrank by himself: ${s.q.side}`);
  assert.deepEqual(s.problems, []);
  s.done();
});

test('qubit: rolling never rolls him out of the strip; at a wall he rolls the other way', async () => {
  const s = qubitScene({ phase: 'listening' }, 5);
  await s.run(0.5);
  for (let i = 0; i < 6; i++) {
    s.d.command({ action: 'roll', dir: 'right' });
    await s.run(4);
  }
  assert.deepEqual(s.problems, []);
  assert.ok(s.q.cx < W - s.q.side / 2);
  s.done();
});

test('qubit: an Orbit event during a command wins (a send stomps Send)', async () => {
  const s = qubitScene({ phase: 'listening', draft: true });
  await s.run(3);
  s.d.command({ action: 'dance' });
  await s.run(0.3);
  s.d.setVoice({ phase: 'listening', sending: true });
  s.d.event('sent');
  assert.equal(s.d.reaction, 'sent');
  s.done();
});

test('qubit: not a command, or before he is placed: refused', () => {
  const qq = E.create({ mount: null, width: W, height: H, size: 36, floor: 3, mode: 'asleep', keepAlive: true });
  const d = createDirector(qq, { seed: 1 });
  assert.equal(d.command({ action: 'backflip' }), false, 'not placed yet');
  d.setGeometry({ W, H, box: BOX, send: SEND, side: 36 });
  d.place();
  for (const bad of [null, {}, { action: 'constructor' }, { action: 'wave' }, { action: 'flip' }]) assert.equal(d.command(bad), false, JSON.stringify(bad));
  qq.destroy();
});

// ---------- the pixel buddy doing them ----------
const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function buddyRun(bd, secs, voice = { phase: 'listening' }, box = { id: 'box', x0: 60, x1: 160, y: 40, bottom: 5 }) {
  const frames = [];
  for (let i = 0; i < Math.round(secs * 60); i++) frames.push(bd.step({ dt: 1 / 60, world: { w: 300, h: 110, platforms: [box] }, voice }));
  return frames;
}

test('pixel buddy: commands run (in order), then it carries on with Orbit\x27s state', () => {
  const bd = createBuddy({ rng: rng(9), x: 100 });
  buddyRun(bd, 3);
  assert.equal(bd.command({ action: 'dance' }), true);
  let f = buddyRun(bd, 0.2);
  assert.equal(f.at(-1).task, 'cmd:dance');
  // Orbit's state changes mid-dance (the transcript: thinking, then listening): it keeps dancing.
  f = buddyRun(bd, 0.5, { phase: 'thinking' });
  assert.equal(f.at(-1).task, 'cmd:dance');
  f = buddyRun(bd, 6, { phase: 'listening' });
  assert.notEqual(f.at(-1).task, 'cmd:dance');
  assert.equal(f.at(-1).mode, 'listen');
  // Each command, in bounds.
  for (const action of BUDDY_COMMANDS) {
    assert.equal(bd.command({ action, dir: 'left' }), true, action);
    const frames = buddyRun(bd, 0.1);
    assert.equal(frames.at(-1).task, `cmd:${action}`, action);
    for (const fr of buddyRun(bd, action === 'nap' ? 14 : 6)) assert.ok(fr.x >= 0 && fr.x <= 300 && fr.y >= 0, `${action}: ${fr.x},${fr.y}`);
  }
  // The call ending interrupts a command.
  bd.command({ action: 'dance' });
  buddyRun(bd, 0.2);
  f = buddyRun(bd, 0.2, { phase: 'off' });
  assert.equal(f.at(-1).mode, 'sleep');
  assert.notEqual(f.at(-1).task, 'cmd:dance');
  assert.equal(bd.command({ action: 'backflip' }), false);
  assert.equal(bd.command({ action: '__proto__' }), false);
});
