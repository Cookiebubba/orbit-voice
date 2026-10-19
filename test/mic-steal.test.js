// "Mute my mic in other apps": the helper starts, reads the mic streams, and recovers cleanly.
// These checks never mute anything. Muting itself was verified by hand against a throwaway
// capture app (its level went to exactly 0 while stolen and came back on release), and so
// were unmute-on-exit and recovery after a hard kill.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../electron/mic-steal.ps1', import.meta.url));
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NOBODY = 'C:\\nothing\\nobody.exe'; // OnlyExe that matches no process: nothing can be touched

function run(args, input) {
  return new Promise((resolve) => {
    const p = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    readline.createInterface({ input: p.stdout }).on('line', (l) => lines.push(l));
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => resolve({ code, lines, err }));
    if (input) {
      let i = 0;
      const next = () => (i < input.length ? (p.stdin.write(`${input[i++]}\n`), setTimeout(next, 1200)) : p.stdin.end());
      setTimeout(next, 2500); // let it compile
    } else p.stdin.end();
  });
}

test('the helper lists mic streams as JSON without changing anything', { skip: process.platform !== 'win32' }, async () => {
  const r = await run(['-OnlyExe', NOBODY], ['list', 'steal', 'release']);
  assert.equal(r.code, 0, r.err);
  const list = JSON.parse(r.lines.find((l) => l.startsWith('{"sessions"')));
  assert.ok(Array.isArray(list.sessions));
  for (const s of list.sessions) assert.deepEqual(Object.keys(s).sort(), ['active', 'exe', 'muted', 'name', 'pid']);
  assert.ok(r.lines.includes('{"stealing":true,"muted":0}'), 'nothing matched, so nothing was muted');
  assert.ok(r.lines.includes('{"stealing":false,"unmuted":0}'));
});

test('the helper accepts well-formed rules (even with nothing to leave alone) and rejects others', { skip: process.platform !== 'win32' }, async () => {
  const r = await run(['-OnlyExe', NOBODY], ['rules\tleave\tdiscord.exe\t', 'rules\tmute\t\tobs64.exe|krisp.exe', 'rules\tsometimes\t\t', 'list']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines.slice(0, 3), ['{"rules":true,"stealing":false}', '{"rules":true,"stealing":false}', '{"error":"bad rules"}']);
  const list = JSON.parse(r.lines.find((l) => l.startsWith('{"sessions"')));
  for (const s of list.sessions) assert.ok('name' in s, 'each stream has a friendly name');
});

test('recovery with nothing recorded is a no-op', { skip: process.platform !== 'win32' }, async () => {
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mic-')), 'mic-steal.state');
  const r = await run(['-OnlyExe', NOBODY, '-StateFile', state, '-Recover']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines, ['{"recovered":0}']);
  assert.equal(fs.existsSync(state), false);
});
