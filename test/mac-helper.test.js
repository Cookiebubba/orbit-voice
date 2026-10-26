// Orbit's macOS helper (native/mac/OrbitHelper): finding it, and its JSON protocol. The protocol
// tests run the real binary on a Mac (built by `npm run mac:helper`) and skip elsewhere; none of
// them needs a permission or touches another app's window.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { helperPath } from '../src/platform/mac/helper.js';

const bin = process.platform === 'darwin' ? helperPath() : '';
const skip = bin ? false : 'needs macOS and the built helper (npm run mac:helper)';

test('the helper is found in the installed app first, else in the repo, never inside app.asar', () => {
  const seen = [];
  const exists = (p) => (seen.push(p), p.includes('Resources'));
  const p = helperPath({ resourcesPath: '/Applications/Orbit.app/Contents/Resources', exists });
  assert.equal(p, path.join('/Applications/Orbit.app/Contents/Resources', 'mac', 'orbit-helper'));
  assert.equal(helperPath({ resourcesPath: '/x/app.asar/inner', exists: () => true }).includes('app.asar'), false);
  assert.equal(helperPath({ resourcesPath: '', exists: () => false }), '');
});

test('selftest: role mapping, names, flags and request parsing', { skip }, () => {
  const out = JSON.parse(execFileSync(bin, ['selftest'], { encoding: 'utf8' }).trim());
  assert.equal(out.ok, true, JSON.stringify(out.failures));
  assert.ok(out.checks >= 20);
});

test('version and perms answer one JSON line', { skip }, () => {
  const v = JSON.parse(execFileSync(bin, ['version'], { encoding: 'utf8' }));
  assert.match(v.version, /^\d+\.\d+\.\d+$/);
  const p = JSON.parse(execFileSync(bin, ['perms'], { encoding: 'utf8' }));
  assert.equal(typeof p.ax, 'boolean');
  assert.equal(typeof p.screen, 'boolean');
});

/** The "ax" server: send lines, read answers by id. */
function server() {
  const child = spawn(bin, ['ax', '--parent-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const j = JSON.parse(l);
    waiting.get(j.id)?.(j);
    waiting.delete(j.id);
  });
  return {
    child,
    ask(obj) {
      return new Promise((resolve) => {
        waiting.set(obj.id, resolve);
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      });
    },
    raw: (line) => child.stdin.write(`${line}\n`),
  };
}

test('ax: answers by id, ignores broken lines, refuses unknown requests and missing windows', { skip, timeout: 20_000 }, async () => {
  const s = server();
  try {
    s.raw('this is not json');
    const ping = await s.ask({ op: 'ping', id: 1 });
    assert.equal(ping.ok, true);
    assert.equal(typeof ping.ax, 'boolean');
    if (!ping.ax) {
      // Without Accessibility everything else is refused plainly.
      const r = await s.ask({ op: 'scan', hwnd: 1, id: 2 });
      assert.equal(r.error, 'access_denied');
      return;
    }
    assert.equal((await s.ask({ op: 'nope', id: 3 })).error, 'bad_request');
    assert.equal((await s.ask({ op: 'scan', hwnd: 999999999, id: 4 })).error, 'no_window');
    assert.equal((await s.ask({ op: 'act', hwnd: 999999999, i: 0, action: 'press', id: 5 })).error, 'no_window');
    const w = await s.ask({ op: 'windows', bundle: 'dev.orbit.no-such-app', id: 6 });
    assert.deepEqual([w.ok, w.running, w.windows.length], [true, false, 0]);
    const f = await s.ask({ op: 'front', id: 7 });
    assert.equal(f.ok, true);
    assert.equal(typeof f.win.hwnd, 'number');
  } finally {
    s.child.kill();
  }
});

test('ax: exits when its input closes (Orbit quit)', { skip, timeout: 10_000 }, async () => {
  const s = server();
  const exited = new Promise((r) => s.child.on('exit', r));
  s.child.stdin.end();
  assert.equal(await exited, 0);
});

test('capture: plain errors for a missing window or arguments', { skip }, () => {
  const run = (args) => {
    try {
      return JSON.parse(execFileSync(bin, ['capture', ...args], { encoding: 'utf8' }));
    } catch (e) {
      return JSON.parse(String(e.stdout));
    }
  };
  assert.equal(run([]).error, 'bad_request');
  assert.equal(run(['--window', '999999999', '--out', '/tmp/orbit-none.png']).error, 'no_window');
});
