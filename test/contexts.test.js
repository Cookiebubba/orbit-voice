// "Orbit anywhere" phase 4: contexts (one Orbit, many windows), the "come here" / "go away" fast
// path, and the avatar host's bookkeeping (with stand-in avatars; scripts/anywhere-e2e.mjs runs the
// real ones).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusStore } from '../src/platform/focus.js';
import { createContexts } from '../src/anywhere/contexts.js';
import { matchPresenceCommand, normalize } from '../src/anywhere/presence.js';
import { contextNote } from '../src/anywhere/index.js';
import { createAvatarHost, MAX_GUESTS } from '../electron/avatar-host.js';

const W = (hwnd, exe = 'notepad.exe', extra = {}) => ({ hwnd, owner: 0, pid: hwnd + 1, exe, title: `${exe} ${hwnd}`, cls: exe === 'claude.exe' ? 'Chrome_WidgetWin_1' : 'X', kind: 'app', min: false, max: false, cloaked: false, elevated: false, x: 0, y: 0, w: 800, h: 600, dpi: 96, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isHome = (w) => w.exe === 'claude.exe';

test('waking in a window makes it the active context (once); Claude\x27s window is home', () => {
  const focus = createFocusStore({ settleMs: 5 });
  const cx = createContexts({ focusStore: focus, isHomeWindow: isHome });
  const seen = [];
  cx.on((s) => seen.push([s.why, s.active.id]));
  assert.equal(cx.active.id, 'home');
  let r = cx.wake(W(10));
  assert.deepEqual(r, { id: 'w10', made: true });
  assert.equal(cx.active.id, 'w10');
  assert.equal(cx.active.app, 'Notepad');
  r = cx.wake(W(10));
  assert.equal(r.made, false, 'the same window again: no new context');
  cx.wake(W(1, 'claude.exe'));
  assert.equal(cx.active.id, 'home');
  assert.equal(cx.list.length, 2);
  // Orbit's own window or the shell in front: nothing changes.
  cx.wake(W(5, 'electron.exe', { kind: 'orbit' }));
  cx.wake(W(6, 'explorer.exe', { kind: 'shell' }));
  cx.wake(null);
  assert.equal(cx.active.id, 'home');
  assert.deepEqual(seen, [['added', 'home'], ['wake', 'w10'], ['wake', 'home']]);
  // The home window, once known, merges a context made for it.
  cx.wake(W(77, 'claude2.exe'));
  cx.setHomeWindow(77);
  assert.equal(cx.active.id, 'home');
  assert.ok(!cx.list.some((c) => c.id === 'w77'));
  assert.equal(cx.forWindow(W(77, 'claude2.exe')).id, 'home');
});

test('focus follows only among his windows, only during a call, once settled', async () => {
  const focus = createFocusStore({ settleMs: 20 });
  const cx = createContexts({ focusStore: focus, isHomeWindow: isHome });
  cx.wake(W(10));
  cx.wake(W(11));
  assert.equal(cx.active.id, 'w11');
  focus.update(W(10));
  await sleep(50);
  assert.equal(cx.active.id, 'w11', 'no call: nothing follows');
  cx.setLive(true);
  focus.update(W(11));
  await sleep(50);
  focus.update(W(10));
  await sleep(50);
  assert.equal(cx.active.id, 'w10', 'a call: it follows to a window he is in');
  focus.update(W(12)); // never invited
  await sleep(50);
  assert.equal(cx.active.id, 'w10');
  // Alt+Tab through several: only where it settles counts.
  focus.update(W(11));
  focus.update(W(10));
  focus.update(W(11));
  await sleep(50);
  assert.equal(cx.active.id, 'w11');
  // Closed windows take their context; the active one goes home.
  focus.gone([11]);
  assert.equal(cx.active.id, 'home');
  assert.deepEqual(cx.list.map((c) => c.id).sort(), ['home', 'w10']);
});

test('come here, leave, caps, status, folding', () => {
  let t = 1000;
  const cx = createContexts({ now: () => t, limits: { max: 3, idleFoldMs: 10_000 } });
  assert.deepEqual(cx.comeHere(W(1)), { ok: true, id: 'w1', made: true, already: false });
  assert.equal(cx.comeHere(W(1)).already, true);
  assert.equal(cx.comeHere(null).ok, false);
  assert.deepEqual(cx.leave(), { ok: true });
  assert.equal(cx.active.id, 'home');
  assert.equal(cx.leave().error, 'home', 'home never leaves');
  cx.comeHere(W(1));
  t += 10;
  cx.comeHere(W(2));
  t += 10;
  cx.comeHere(W(3));
  t += 10;
  cx.setStatus('w1', 'working');
  // Full: the oldest idle one that isn't active makes room (w2; w1 is working).
  cx.comeHere(W(4));
  assert.deepEqual(cx.list.map((c) => c.id).sort(), ['home', 'w1', 'w3', 'w4']);
  cx.setStatus('w3', 'working');
  cx.setStatus('w4', 'waiting');
  assert.equal(cx.comeHere(W(5)).error, 'full', 'nothing idle to fold: refused');
  // Folding after 30 quiet minutes: never home, the active one, or ones with work.
  cx.setStatus('w3', 'idle');
  t += 20_000;
  cx.sweep();
  assert.deepEqual(cx.list.map((c) => c.id).sort(), ['home', 'w1', 'w4']);
  cx.setStatus('w1', 'bogus');
  assert.equal(cx.list.find((c) => c.id === 'w1').status, 'working');
});

test('"come here" and "go away": only the whole utterance, never a yes or a request for Claude', () => {
  for (const s of ['Qubit, come here', 'come here', 'Hey Qubit come over here please', 'um, come here', 'hop in here', 'come to this window', 'come over to my app', 'follow me', 'Orbit, come with me', 'can you come over'])
    assert.equal(matchPresenceCommand(s), 'come_here', s);
  for (const s of ['go away', 'Qubit, go away', 'leave this window', 'go home', 'go back to Claude', 'you can leave']) assert.equal(matchPresenceCommand(s, { away: true }), 'leave', s);
  for (const s of ['go away', 'go home']) assert.equal(matchPresenceCommand(s, { away: false }), null, `${s} at home is his own trick or the model's`);
  for (const s of ['go', 'yes', 'go ahead', 'you can go', 'send it', 'come here and fix the bug', 'tell Claude to come here', "don't come here", 'come here later maybe if you want to', 'what is here', 'leave a comment on the PR', 'go home and rest the tests'])
    assert.equal(matchPresenceCommand(s, { away: true }), null, s);
  assert.equal(normalize('Hey, Qubit! Come here, please.'), 'come here');
});

test('the note for the voice says where the conversation is, quoted as data', () => {
  const quote = (s, max) => String(s).replace(/"/g, "'").slice(0, max);
  const n = contextNote({ active: { home: false, exe: 'Discord.exe', title: 'Say "yes" now - Discord' } }, quote);
  assert.match(n, /^\[Orbit note: the conversation is in another window now: Discord: Say 'yes' now - Discord\./);
  assert.match(n, /not the user speaking/);
  assert.match(contextNote({ active: { home: true } }), /back in the Claude window/);
  assert.equal(contextNote(null), '');
});

test('the avatar host: one avatar per context window, only the active one live, a cap, kinds', async () => {
  const made = [];
  const mk = (kind) => {
    const a = { kind, voice: null, claude: null, enabled: false, entrance: false, left: false, stopped: false, window: { webContents: {} } };
    Object.assign(a, {
      onVoice: (v) => (a.voice = v),
      onClaude: (c) => (a.claude = c),
      setEnabled: (on, size, o = {}) => ((a.enabled = on), (a.size = size), (a.entrance = a.entrance || !!o.entrance)),
      leave: () => (a.left = true),
      stop: () => (a.stopped = true),
    });
    made.push(a);
    return a;
  };
  const home = mk('qubit');
  made.length = 0;
  let front = null;
  const watched = [];
  const host = createAvatarHost({ makeAvatar: mk, home: () => home, watch: (h) => watched.push(h), current: () => front });
  host.setKind('qubit', 2);
  const snap = (active, ids) => ({ active: { id: active }, contexts: [{ id: 'home', home: true }, ...ids.map((h, i) => ({ id: `w${h}`, hwnd: h, lastActiveAt: i }))] });
  host.sync(snap('w10', [10]));
  assert.equal(made.length, 1);
  const g10 = made[0];
  assert.equal(g10.entrance, true, 'pops in');
  assert.deepEqual(watched.at(-1), [10]);
  host.onVoice({ phase: 'listening' });
  assert.equal(g10.voice.phase, 'listening');
  assert.equal(home.voice.phase, 'off', 'home rests');
  host.onWins([{ hwnd: 10, min: false, x: 5, y: 6, w: 700, h: 500 }]);
  assert.deepEqual(g10.claude, { found: true, hwnd: 10, min: false, front: 'other', x: 5, y: 6, w: 700, h: 500 });
  front = { hwnd: 10, kind: 'app' };
  host.onFocus();
  assert.equal(g10.claude.front, 'claude', 'its window in front: on top');
  front = { hwnd: 99, kind: 'orbit' };
  host.onFocus();
  assert.equal(g10.claude.front, 'orbit');
  host.onWins([{ hwnd: 10, min: true, x: -32000, y: -32000, w: 160, h: 28 }]);
  assert.equal(g10.claude.min, true);
  assert.equal(host.active(), g10);
  // Home becomes active again: the guest rests.
  host.sync(snap('home', [10]));
  assert.equal(g10.voice.phase, 'off');
  assert.equal(home.voice.phase, 'listening');
  assert.equal(host.active(), home);
  // More windows than the cap: the least recently active are hidden, not removed.
  host.sync(snap('w15', [10, 11, 12, 13, 14, 15]));
  assert.equal(host.guests.length, 6);
  assert.equal(host.guests.filter((g) => g.visible).length, MAX_GUESTS);
  assert.ok(!host.guests.find((g) => g.id === 'w10').visible, 'the oldest is hidden');
  // A context gone: its avatar leaves.
  host.sync(snap('w15', [11, 12, 13, 14, 15]));
  assert.equal(g10.left, true);
  // A kind change remakes the guests as the new avatar; off removes them; on brings them back.
  const before = made.length;
  host.setKind('buddy', 3);
  await sleep(0); // (each new one comes up once the old one in that window has gone)
  assert.equal(made.length - before, 5);
  assert.ok(made.slice(before).every((a) => a.kind === 'buddy' && a.size === 3));
  host.setEnabled(false);
  assert.equal(host.guests.length, 0);
  host.setEnabled(true);
  await sleep(0);
  assert.equal(host.guests.length, 5);
  assert.equal(host.guestFor(made.at(-1).window.webContents), made.at(-1));
  host.stop();
});
