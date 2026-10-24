// src/desktop.ps1 against a real UI Automation tree: the stand-in Claude window
// (test/e2e/FakeClaude.cs --window, built here with .NET Framework's csc). desktop.ps1 runs with
// -OnlyPid, so it only ever sees the stand-in: nothing here touches the real Claude app.
// (One file, so its tests run one at a time: two stand-in windows driven at once time out.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { canRun, psWithPid, startFakeWindow } from './e2e/fake-window.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';

if (process.platform === 'win32') await lockDesktop(); // one real-desktop test file at a time

const skip = !canRun() && 'needs Windows with .NET Framework 4 (csc.exe)';

test('Stop: pressed only while Claude works, and never a background task\x27s "Stop this task"', { skip, timeout: 120_000 }, async () => {
  const w = await startFakeWindow('Fake session');
  try {
    let info = await w.ps('info');
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(info.sessionTitle, 'Fake session');
    assert.equal(info.claudeWorking, false);
    const idle = await w.ps('stop');
    assert.equal(idle.ok, false);
    assert.equal(idle.error, 'not_working', 'no Stop button: nothing pressed (the task\x27s own button is not it)');
    await w.send({ working: true });
    info = await w.ps('info');
    assert.equal(info.claudeWorking, true);
    const r = await w.ps('stop');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stopped, true);
    assert.equal(r.confirmed, true, 'Stop turned back into Send');
    assert.equal(r.sessionTitle, 'Fake session');
    assert.deepEqual(w.events.map((e) => e.event), ['stop'], 'Claude\x27s Stop, and nothing else, was pressed');
    // Only in the session it was meant for.
    await w.send({ working: true });
    const other = await w.ps('stop', ['-ExpectTitleB64', w.b64('Another session')]);
    assert.equal(other.ok, false);
    assert.equal(other.error, 'session_changed');
    assert.equal(w.events.length, 1);
    const mine = await w.ps('stop', ['-ExpectTitleB64', w.b64('Fake session')]);
    assert.equal(mine.stopped, true);
    assert.deepEqual(w.events.map((e) => e.event), ['stop', 'stop']);
  } finally {
    await w.close();
  }
});

test('a permission card: read (request, command, options), and answered only with its own buttons', { skip, timeout: 180_000 }, async () => {
  const w = await startFakeWindow('Fake session');
  try {
    assert.equal((await w.ps('pending')).pending, null, 'nothing waiting');
    await w.send({ permission: { heading: 'Allow Claude to run a command?', command: 'rm -rf build && npm test', always: true } });
    const r = await w.ps('pending');
    assert.equal(r.ok, true, JSON.stringify(r));
    const p = r.pending;
    assert.equal(p.kind, 'permission');
    assert.match(p.title, /Allow Claude to run a command\?/);
    assert.equal(p.detail, 'rm -rf build && npm test', 'the command, from its region');
    assert.deepEqual(p.options.map((o) => o.id), ['allow_once', 'allow_always', 'deny']);
    assert.match(p.key, /^[0-9a-f]{16}$/);
    // A stale key (the card changed since it was read) presses nothing.
    const stale = await w.ps('answer', ['-KeyB64', w.b64('0123456789abcdef'), '-Choice', 'allow_once']);
    assert.equal(stale.error, 'prompt_changed');
    assert.equal(w.events.length, 0);
    // An answer it doesn't offer.
    await w.send({ permission: { command: 'npm test' } });
    const plain = (await w.ps('pending')).pending;
    const nope = await w.ps('answer', ['-KeyB64', w.b64(plain.key), '-Choice', 'allow_always']);
    assert.equal(nope.error, 'choice_not_offered');
    assert.equal(w.events.length, 0);
    const deny = await w.ps('answer', ['-KeyB64', w.b64(plain.key), '-Choice', 'deny']);
    assert.equal(deny.ok, true, JSON.stringify(deny));
    assert.equal(deny.pressed, 'Deny');
    assert.equal(deny.confirmed, true);
    assert.deepEqual(w.events.at(-1), { event: 'permission', choice: 'Deny' });
    await w.send({ permission: { command: 'npm run build' } });
    const again = (await w.ps('pending')).pending;
    const allow = await w.ps('answer', ['-KeyB64', w.b64(again.key), '-Choice', 'allow_once']);
    assert.equal(allow.pressed, 'Allow once');
    assert.deepEqual(w.events.at(-1), { event: 'permission', choice: 'Allow once' });
    assert.equal(allow.next, null, 'nothing more waiting');
  } finally {
    await w.close();
  }
});

test('a question card: options read in order; the chosen one is picked and submitted, page by page', { skip, timeout: 180_000 }, async () => {
  const w = await startFakeWindow('Fake session');
  try {
    await w.send({ question: { questions: [{ q: 'Which database?', options: [['Redis', 'fast, in memory'], ['Postgres', 'durable']] }, { q: 'Add tests?', options: [['Yes', ''], ['No', '']] }] } });
    const r = await w.ps('pending');
    const q = r.pending;
    assert.equal(q.kind, 'question', JSON.stringify(r));
    assert.equal(q.question, 'Which database?');
    assert.equal(q.page, '1 of 2');
    assert.deepEqual(q.choices.map((c) => [c.n, c.label, c.description, c.selected]), [[1, 'Redis', 'fast, in memory', true], [2, 'Postgres', 'durable', false]]);
    assert.equal(q.multiSelect, false);
    assert.equal(q.canSkip, true);
    const a = await w.ps('answer', ['-KeyB64', w.b64(q.key), '-Choice', 'option', '-Option', '2']);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.pressed, 'Postgres');
    assert.deepEqual(w.events.at(-1), { event: 'next', question: 1, picked: [2] }, 'the second option, then Next');
    assert.equal(a.next?.question, 'Add tests?', 'the next question is read back');
    const s = await w.ps('answer', ['-KeyB64', w.b64(a.next.key), '-Choice', 'skip']);
    assert.equal(s.ok, true);
    assert.deepEqual(w.events.at(-1), { event: 'skip', question: 2 });
    assert.equal((await w.ps('pending')).pending, null);
    // Out of range, or the wrong kind of answer: nothing pressed.
    await w.send({ question: { questions: [{ q: 'Pick one', options: [['A', ''], ['B', '']] }] } });
    const k = (await w.ps('pending')).pending.key;
    const n = w.events.length;
    assert.equal((await w.ps('answer', ['-KeyB64', w.b64(k), '-Choice', 'option', '-Option', '3'])).error, 'bad_option');
    assert.equal((await w.ps('answer', ['-KeyB64', w.b64(k), '-Choice', 'allow_once'])).error, 'bad_choice');
    assert.equal(w.events.length, n);
    const one = await w.ps('answer', ['-KeyB64', w.b64(k), '-Choice', 'option', '-Option', '1']);
    assert.deepEqual(w.events.at(-1), { event: 'submit', question: 1, picked: [1] }, 'already picked: just Submit');
    assert.equal(one.next, null);
  } finally {
    await w.close();
  }
});

test('cards are still found by their structure if Claude renames its classes', { skip, timeout: 180_000 }, async () => {
  const w = await startFakeWindow('Fake session');
  try {
    await w.send({ plain: true, permission: { command: 'git push' } });
    const p = (await w.ps('pending')).pending;
    assert.equal(p?.kind, 'permission', 'an Allow once button next to a Deny button');
    assert.equal(p.detail, 'git push');
    const a = await w.ps('answer', ['-KeyB64', w.b64(p.key), '-Choice', 'deny']);
    assert.equal(a.pressed, 'Deny');
    await w.send({ question: { questions: [{ q: 'Which one?', options: [['Left', ''], ['Right', '']] }] } });
    const q = (await w.ps('pending')).pending;
    assert.equal(q?.kind, 'question', 'toggle buttons above Skip and Submit');
    assert.deepEqual(q.choices.map((c) => c.label), ['Left', 'Right']);
    await w.ps('answer', ['-KeyB64', w.b64(q.key), '-Choice', 'option', '-Option', '2']);
    assert.deepEqual(w.events.at(-1), { event: 'submit', question: 1, picked: [2] });
  } finally {
    await w.close();
  }
});

test('typing a draft, Send, Stop and answering cards never pull the window forward', { skip, timeout: 240_000 }, async () => {
  // The stand-in sits off screen, never active. Orbit acts through UI Automation with AutoSetFocus
  // off, so none of these may activate it (with it on, each act focused the control first).
  const w = await startFakeWindow('Fake session');
  try {
    const text = 'Run the tests, then tell me what failed.';
    const fill = await w.ps('send', ['-TextB64', w.b64(text), '-Fill']);
    assert.equal(fill.ok, true, JSON.stringify(fill));
    assert.equal(fill.filled, true);
    assert.equal((await w.ps('info')).promptText, text, 'the draft is in the box');
    const revised = 'Run the unit tests only.';
    const again = await w.ps('send', ['-TextB64', w.b64(revised), '-Fill', '-PrevB64', w.b64(text)]);
    assert.equal(again.ok, true, JSON.stringify(again));
    const sent = await w.ps('send', ['-TextB64', w.b64(revised), '-Filled']);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.confirmed, true);
    assert.deepEqual(w.events.at(-1), { event: 'send', chars: revised.length });
    const stop = await w.ps('stop');
    assert.equal(stop.confirmed, true, JSON.stringify(stop));
    await w.send({ permission: { command: 'npm test' } });
    const p = (await w.ps('pending')).pending;
    const allow = await w.ps('answer', ['-KeyB64', w.b64(p.key), '-Choice', 'allow_once']);
    assert.equal(allow.confirmed, true, JSON.stringify(allow));
    await w.send({ question: { questions: [{ q: 'Which one?', options: [['Left', ''], ['Right', '']] }] } });
    const q = (await w.ps('pending')).pending;
    const pick = await w.ps('answer', ['-KeyB64', w.b64(q.key), '-Choice', 'option', '-Option', '2']);
    assert.equal(pick.ok, true, JSON.stringify(pick));
    assert.deepEqual(w.events.map((e) => e.event), ['send', 'stop', 'permission', 'submit']);
    await new Promise((r) => setTimeout(r, 300)); // (a late activation would show up by now)
    assert.equal(w.activations.length, 0, 'the stand-in window was never activated');
  } finally {
    await w.close();
  }
});

test('-OnlyPid never reaches a process that is not a running stand-in', { skip, timeout: 60_000 }, async () => {
  const r = await psWithPid('stop', 999_999_999);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'test_window_refused');
});

// ---- -Mode app, and new sessions' folders: the stand-in with its whole app shown ({"app": ...}:
// sidebar, header, pickers, menus), modelled on what UI Automation shows of the real window.
const APP = {
  folders: [['alpha', 'Alpha'], ['beta', '']],
  sessions: [['Parser fixes', 'alpha'], ['Auth work', 'alpha'], ['Old spike', 'beta']],
  open: 'Parser fixes',
};

test('Claude\x27s own controls: status, sidebar, Code / chat, panels, scrolling', { skip, timeout: 240_000 }, async () => {
  const w = await startFakeWindow('Parser fixes');
  const app = (action, value, more = []) => w.ps('app', ['-Action', action, ...(value !== undefined ? ['-ValueB64', w.b64(value)] : []), ...more]);
  try {
    await w.send({ app: APP });
    const st = await app('status');
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.equal(st.sessionTitle, 'Parser fixes');
    assert.equal(st.sidebar, true);
    assert.equal(st.tab, 'code');
    assert.equal(st.model, 'Opus 5.5 High');
    assert.equal(st.permission, 'Ask permissions');
    assert.deepEqual(st.panels, { terminal: false, changes: false, browser: false, files: false, rail: false });
    assert.equal(st.canScroll, true);
    assert.equal(st.canLoadEarlier, true);
    assert.equal(w.events.length, 0, 'reading presses nothing');

    assert.equal((await app('sidebar', 'hide')).ok, true);
    assert.deepEqual(w.events.at(-1), { event: 'sidebar', visible: false });
    assert.equal((await app('sidebar', 'hide')).changed, false, 'already hidden: nothing pressed');
    assert.equal(w.events.length, 1);
    assert.equal((await app('sidebar', 'show')).ok, true);
    assert.deepEqual(w.events.at(-1), { event: 'sidebar', visible: true });

    assert.equal((await app('tab', 'chat')).ok, true);
    assert.deepEqual(w.events.at(-1), { event: 'tab', value: 'chat' });
    assert.equal((await app('status')).tab, 'chat');
    await app('tab', 'code');
    assert.deepEqual(w.events.at(-1), { event: 'tab', value: 'code' });

    const term = await app('panel', 'terminal:on');
    assert.equal(term.ok, true, JSON.stringify(term));
    assert.deepEqual(w.events.at(-1), { event: 'panel', name: 'Terminal', on: true });
    assert.equal((await app('panel', 'terminal:on')).changed, false);
    await app('panel', 'terminal:off');
    assert.deepEqual(w.events.at(-1), { event: 'panel', name: 'Terminal', on: false });
    assert.equal((await app('panel', 'nonsense')).ok, false);

    const down = await app('scroll', 'bottom');
    assert.equal(down.ok, true, JSON.stringify(down));
    assert.equal(down.atBottom, true);
    const up = await app('scroll', 'up');
    assert.ok(up.after < up.before, JSON.stringify(up));
    const top = await app('scroll', 'top');
    assert.equal(top.atTop, true);
    assert.ok(w.events.some((e) => e.event === 'scroll'), 'the conversation itself scrolled');
    assert.equal((await app('load_earlier')).ok, true);
    assert.deepEqual(w.events.at(-1), { event: 'load_earlier' });

    // Switching sessions in the sidebar of the same window.
    const sw = await w.ps('switch', ['-TitleB64', w.b64('Auth work')]);
    assert.equal(sw.ok, true, JSON.stringify(sw));
    assert.equal(sw.sessionTitle, 'Auth work');
    assert.deepEqual(w.events.at(-1), { event: 'open', title: 'Auth work' });
    assert.equal(w.activations.length, 0, 'none of it activated the window');
  } finally {
    await w.close();
  }
});

test('Claude\x27s model and permission pickers: only a choice it offers, and the result checked', { skip, timeout: 240_000 }, async () => {
  const w = await startFakeWindow('Parser fixes');
  const app = (action, value) => w.ps('app', ['-Action', action, '-ValueB64', w.b64(value)]);
  try {
    await w.send({ app: APP });
    const m = await app('model', 'sonnet');
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.equal(m.picked, 'Sonnet 5.5');
    assert.deepEqual(w.events.at(-1), { event: 'model', value: 'Sonnet 5.5' });
    assert.equal((await app('model', 'sonnet')).changed, false, 'already on it: nothing opened');
    const none = await app('model', 'gpt-9');
    assert.equal(none.error, 'not_offered');
    assert.deepEqual(none.options, ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1'], 'what it does offer');
    assert.equal(w.events.filter((e) => e.event === 'model').length, 1, 'nothing picked');
    const st = await w.ps('app', ['-Action', 'status']);
    assert.equal(st.model, 'Sonnet 5.5 High');

    const p = await app('permission', 'plan');
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.deepEqual(w.events.at(-1), { event: 'permission_mode', value: 'Plan mode' });
    await app('permission', 'accept_edits');
    assert.deepEqual(w.events.at(-1), { event: 'permission_mode', value: 'Accept edits' });
    assert.equal((await app('permission', 'accept_edits')).changed, false);
    assert.equal((await app('permission', 'everything')).error, 'bad_value');
    assert.equal(w.activations.length, 0, 'opening menus and picking never activated the window');
  } finally {
    await w.close();
  }
});

test('rename, archive and delete a session (delete through Claude\x27s own confirmation)', { skip, timeout: 240_000 }, async () => {
  const w = await startFakeWindow('Parser fixes');
  const app = (action, value, title) => w.ps('app', ['-Action', action, ...(value ? ['-ValueB64', w.b64(value)] : []), ...(title ? ['-TitleB64', w.b64(title)] : [])]);
  try {
    await w.send({ app: APP });
    const r = await app('rename', 'Regex parser fixes');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(w.events.at(-1), { event: 'rename', from: 'Parser fixes', to: 'Regex parser fixes' });
    assert.equal((await w.ps('info')).sessionTitle, 'Regex parser fixes');
    const r2 = await app('rename', 'Old spike, renamed', 'Old spike');
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal((await app('rename', '', 'Auth work')).error, 'no_name');

    const a = await app('archive', null, 'Auth work');
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.deepEqual(w.events.at(-1), { event: 'archive', title: 'Auth work' });
    assert.ok(!(await w.ps('list')).sessions.some((s) => s.title === 'Auth work'));
    assert.equal((await app('archive', null, 'No such session')).error, 'session_not_in_sidebar');

    const d = await app('delete', null, 'Old spike, renamed');
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.deepEqual(w.events.slice(-1), [{ event: 'delete', title: 'Old spike, renamed' }], 'the menu, then Claude\x27s own Delete in its confirmation');
    assert.deepEqual((await w.ps('list')).sessions.map((s) => s.title), ['Regex parser fixes']);
    assert.equal(w.activations.length, 0, 'typing a new name, the menus and the confirmation never activated the window');
  } finally {
    await w.close();
  }
});

test('a new session with no folder chosen: seen as one, never sent from, and a folder can be picked', { skip, timeout: 240_000 }, async () => {
  const w = await startFakeWindow('Parser fixes');
  try {
    await w.send({ app: APP });
    const n = await w.ps('new');
    assert.equal(n.ok, true, JSON.stringify(n));
    assert.equal(n.newSession, true);
    assert.equal(n.folder, null, 'Claude\x27s New started it with no folder');
    assert.deepEqual(w.events.at(-1), { event: 'new', folder: '' });
    const info = await w.ps('info');
    assert.equal(info.newSession, true);
    assert.equal(info.folder, null);
    // Nothing can be sent into it (Claude couldn't start it), so Orbit refuses before pressing Send.
    const s = await w.ps('send', ['-TextB64', w.b64('Run the tests.'), '-ExpectNew']);
    assert.equal(s.ok, false);
    assert.equal(s.error, 'session_changed');
    assert.ok(!w.events.some((e) => e.event === 'send'));
    const f = await w.ps('app', ['-Action', 'folders']);
    assert.deepEqual(f.folders, [{ folder: 'alpha', group: 'Alpha' }, { folder: 'beta', group: '' }]);
    // Picking a folder: Claude's own "New session in <folder>".
    const p = await w.ps('new', ['-ProjectB64', w.b64('beta')]);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(p.folder, 'beta');
    assert.deepEqual(w.events.at(-1), { event: 'new', folder: 'beta' });
    const sent = await w.ps('send', ['-TextB64', w.b64('Run the tests.'), '-ExpectNew', '-ExpectFolderB64', w.b64('beta')]);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.deepEqual(w.events.at(-1), { event: 'send', chars: 14, folder: 'beta' });
    assert.equal(w.activations.length, 0, 'New, the folder button and Send never activated the window');
  } finally {
    await w.close();
  }
});
