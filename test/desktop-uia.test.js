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

test('-OnlyPid never reaches a process that is not a running stand-in', { skip, timeout: 60_000 }, async () => {
  const r = await psWithPid('stop', 999_999_999);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'test_window_refused');
});
