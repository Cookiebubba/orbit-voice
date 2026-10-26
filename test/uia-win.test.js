// "Orbit anywhere" phase 2, for real: src/platform/win/uia.ps1 (COM UI Automation, AutoSetFocus off)
// scanning test windows these tests start themselves (test/e2e/FakeApp.cs), and app profiles built
// from those scans. Read-only: nothing is clicked or typed, and the windows never come forward.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUiaHost } from '../src/platform/win/uia.js';
import { buildProfile, createProfileStore, ensureProfile, locate } from '../src/anywhere/profiles.js';
import { canRunApps, startFakeApp } from './e2e/fake-app.mjs';
import { lockDesktop } from './e2e/desktop-lock.mjs';
import { realDesktopSkip } from './e2e/real-desktop.mjs';

if (process.platform === 'win32' && !realDesktopSkip) await lockDesktop(); // one real-desktop test file at a time

const skip = realDesktopSkip || (!canRunApps() && 'needs Windows with .NET Framework 4 (csc.exe)');
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-uia-cache-'));

for (const kind of ['winforms', 'wpf']) {
  test(`${kind}: a scan sees the controls, never a password, and doesn't bring the window forward`, { skip, timeout: 120_000 }, async () => {
    const app = await startFakeApp(kind, `ORBIT-UIA-${kind}-${process.pid}`);
    const host = createUiaHost({ cacheDir });
    try {
      const s = await host.request('scan', { hwnd: app.hwnd, values: true });
      assert.equal(s.ok, true, JSON.stringify(s).slice(0, 300));
      assert.equal(s.fw, kind === 'wpf' ? 'WPF' : 'WinForm');
      const byName = (n, t) => s.nodes.find((x) => x.n === n && (!t || x.t === t));
      assert.equal(s.nodes[0].p, -1);
      assert.equal(s.nodes[0].t, 'Window');
      assert.ok(s.nodes.every((n, i) => n.i === i && n.p < i), 'parents come before children');
      assert.match(byName('Send', 'Button').pat, /I/);
      assert.match(byName('Agree', 'CheckBox').pat, /T/);
      assert.match(byName('Message', 'Edit').pat, /V/);
      assert.equal(byName('Notes', 'Edit').v.replace(/\r/g, ''), 'First line of notes\nSecond line', 'values when asked');
      const secret = byName('Secret');
      assert.ok(secret, 'the password box is there');
      assert.equal(secret.pw, 1);
      assert.equal(secret.v, undefined, 'its value is never read');
      assert.ok(!JSON.stringify(s).includes('hunter2'), 'not anywhere');
      assert.ok(s.ms < 5000, `${s.ms} ms`);
      // Without values: none at all.
      const bare = await host.request('scan', { hwnd: app.hwnd });
      assert.ok(bare.nodes.every((n) => n.v === undefined));
      // Bad requests and gone windows.
      assert.equal((await host.request('scan', { hwnd: 1 })).error, 'no_window');
      assert.equal((await host.request('fly', {})).ok, false);
      await app.send({ title: 'still here' });
      assert.ok(app.events.every((e) => e.event !== 'activated'), 'never activated');
      // Truncation.
      const small = await host.request('scan', { hwnd: app.hwnd, maxNodes: 3 });
      assert.equal(small.nodes.length, 3);
      assert.equal(small.truncated, true);
    } finally {
      host.stop();
      await app.close();
    }
  });
}

test('a profile from a real scan, saved, and its controls found again in a later scan', { skip, timeout: 120_000 }, async () => {
  const app = await startFakeApp('winforms', `ORBIT-PROFILE-${process.pid}`);
  const host = createUiaHost({ cacheDir });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-profiles-'));
  try {
    const store = createProfileStore({ dir });
    const win = { hwnd: app.hwnd, exe: 'OrbitFakeApp.exe' };
    const p = await ensureProfile(win, { store, scan: () => host.request('scan', { hwnd: app.hwnd }) });
    assert.equal(p.key, 'win-orbitfakeapp');
    assert.equal(p.framework, 'winforms');
    const keys = p.controls.map((c) => c.key);
    for (const k of ['message', 'notes', 'send', 'save', 'agree']) assert.ok(keys.includes(k), `${k} in ${keys}`);
    assert.ok(!keys.includes('secret'), 'no password fields');
    assert.deepEqual(p.outward, ['send'], 'Send asks first; Save is local');
    assert.ok(p.quirks.includes('classic-edit'));
    const file = fs.readFileSync(path.join(dir, 'win-orbitfakeapp.json'), 'utf8');
    for (const secret of ['hunter2', 'First line of notes', `ORBIT-PROFILE-${process.pid}`]) assert.ok(!file.includes(secret), `no "${secret}" in the saved profile`);
    // Later: the window moved and its title changed; every control is still found, by its id.
    await app.send({ title: 'renamed', set: { Message: 'typed by the test' } });
    const later = await host.request('scan', { hwnd: app.hwnd });
    for (const c of p.controls) {
      const f = locate(c, later);
      assert.ok(f, `found ${c.key}`);
      assert.equal(f.healed, false, `${c.key} by its first rung`);
    }
    assert.equal(buildProfile(win, later).controls.length, p.controls.length);
  } finally {
    host.stop();
    await app.close();
  }
});

test('the host: a request to a helper that hangs times out, and the next one starts a fresh helper', { timeout: 30_000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  let spawned = 0;
  const host = createUiaHost({
    requestMs: 200,
    spawnHelper: () => {
      spawned++;
      const c = new EventEmitter();
      c.stdin = new PassThrough();
      c.stdout = new PassThrough();
      c.kill = () => c.emit('exit', null);
      const n = spawned;
      c.stdin.on('data', (d) => {
        const req = JSON.parse(String(d));
        if (n > 1) c.stdout.write(`${JSON.stringify({ id: req.id, ok: true, pong: n })}\n`); // the first one hangs
      });
      return c;
    },
  });
  const r1 = await host.request('ping');
  assert.equal(r1.error, 'timeout');
  const r2 = await host.request('ping');
  assert.equal(r2.ok, true);
  assert.equal(r2.pong, 2);
  host.stop();
  assert.equal(host.running, false);
});
