// "Orbit anywhere" phase 3, for real: reading a window's text and selection through
// src/platform/win/uia.ps1, and looking at it (src/platform/win/capture.ps1: PrintWindow plus
// Windows' own OCR), against test windows these tests start themselves (test/e2e/FakeApp.cs).
// Read-only: the windows never come forward, and the clipboard is never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUiaHost } from '../src/platform/win/uia.js';
import { captureWindow } from '../src/platform/index.js';
import { canRunApps, startFakeApp } from './e2e/fake-app.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';

if (process.platform === 'win32') await lockDesktop(); // one real-desktop test file at a time

const skip = !canRunApps() && 'needs Windows with .NET Framework 4 (csc.exe)';
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-uia-cache-'));

for (const kind of ['winforms', 'wpf']) {
  test(`${kind}: read the window's text and the selection; never the password, never forward`, { skip, timeout: 120_000 }, async () => {
    const app = await startFakeApp(kind, `ORBIT-READ-${kind}-${process.pid}`);
    const host = createUiaHost({ cacheDir });
    try {
      await app.send({ set: { Message: 'Lunch at noon?' } });
      const r = await host.request('read', { hwnd: app.hwnd });
      assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
      assert.equal(r.title, `ORBIT-READ-${kind}-${process.pid}`);
      const text = r.lines.join('\n').replace(/\r/g, '');
      assert.match(text, /Message: Lunch at noon\?/);
      assert.match(text, /Notes: First line of notes\nSecond line/);
      assert.match(text, /general\nrandom\nhelp/);
      assert.ok(!text.includes('hunter2'), 'never the password');
      assert.ok(!/^(Send|Save|System)$/m.test(text), 'button captions and the title bar are controls, not content');
      const small = await host.request('read', { hwnd: app.hwnd, maxChars: 200 });
      assert.ok(small.lines.join('\n').length <= 260);
      // Selected text (a text pattern in WPF; a classic edit box asked read-only in WinForms).
      await app.send({ selectText: { name: 'Notes', start: 0, length: 10 } });
      const sel = await host.request('selection', { hwnd: app.hwnd });
      assert.equal(sel.kind, 'text', JSON.stringify(sel));
      assert.equal(sel.text, 'First line');
      assert.equal(sel.from.n, 'Notes');
      assert.equal((await host.request('read', { hwnd: 1 })).error, 'no_window');
      assert.ok(app.events.every((e) => e.event !== 'activated'), 'never activated');
    } finally {
      host.stop();
      await app.close();
    }
  });
}

test('look: a picture of one window (even off screen, behind others) with its text read on this PC', { skip, timeout: 120_000 }, async () => {
  const app = await startFakeApp('winforms', `ORBIT-LOOK-${process.pid}`);
  try {
    await app.send({ set: { Message: 'Quarterly report draft ready' } });
    // (Under load the off-screen window may not have painted the new text yet: look again.)
    let shot = null;
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (shot?.path) fs.rmSync(shot.path, { force: true });
      shot = await captureWindow(app.hwnd);
      if (/Quarterly report draft ready/.test(shot.ocr || '')) break;
    }
    assert.equal(shot.ok, true, JSON.stringify(shot));
    assert.ok(fs.existsSync(shot.path));
    assert.ok(shot.w >= 600 && shot.w <= 1600, `width ${shot.w}`);
    assert.ok(shot.lit > 0.5, `lit ${shot.lit}`);
    assert.match(shot.ocr, /Quarterly report draft ready/);
    fs.rmSync(shot.path, { force: true });
    // Minimized: nothing to see (and said so).
    await app.send({ minimize: true });
    for (let i = 0; i < 40 && !(await app.state()).min; i++) await new Promise((r) => setTimeout(r, 50));
    const min = await captureWindow(app.hwnd);
    assert.equal(min.ok, false);
    assert.equal(min.error, 'minimized', JSON.stringify(min));
    assert.equal((await captureWindow(1)).error, 'no_window');
    assert.ok(app.events.every((e) => e.event !== 'activated'), 'never activated');
  } finally {
    await app.close();
  }
});
