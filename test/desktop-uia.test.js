// src/desktop.ps1 against a real UI Automation tree: the stand-in Claude window
// (test/e2e/FakeClaude.cs --window, built here with .NET Framework's csc). desktop.ps1 runs with
// -OnlyPid, so it only ever sees the stand-in: nothing here touches the real Claude app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canRun, psWithPid, startFakeWindow } from './e2e/fake-window.mjs';

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

test('-OnlyPid never reaches a process that is not a running stand-in', { skip, timeout: 60_000 }, async () => {
  const r = await psWithPid('stop', 999_999_999);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'test_window_refused');
});
