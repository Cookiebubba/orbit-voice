// The pipe keeper (src/anywhere/keeper-core.js, keeper.js): only Orbit's token gets in, only protocol
// commands pass, the keeper outlives a disconnect and ends with its app, and the app's command line
// and pages are read the right way. Uses a stand-in app (test/fixtures/fake-pipe-app.cjs), no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanArgs, pipePathFor } from '../src/anywhere/keeper-core.js';
import { argsAfterProgram, pickPage } from '../src/anywhere/keeper.js';
import { inputOrder } from '../src/anywhere/hands.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startKeeper() {
  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-keeper-test-'));
  const k = spawn(process.execPath, [path.join(ROOT, 'src/anywhere/keeper-node.mjs')], { stdio: ['pipe', 'ignore', 'ignore'] });
  // The "app" is Node running the stand-in; ELECTRON_RUN_AS_NODE isn't needed for plain Node.
  k.stdin.end(`${JSON.stringify({ id, token, exe: process.execPath, args: [path.join(ROOT, 'test/fixtures/fake-pipe-app.cjs')], stateDir, app: 'fake' })}\n`);
  return { id, token, stateDir, k, file: path.join(stateDir, `${id}.json`) };
}
async function waitState(file) {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    await sleep(50);
  }
  throw new Error('no keeper state');
}
/** Connect, send `first` as the first line; resolves { sock, lines[], closed }. */
function client(pipe, first) {
  return new Promise((resolve) => {
    const sock = net.connect(pipe);
    const c = { sock, lines: [], closed: false };
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) (c.lines.push(JSON.parse(buf.slice(0, i))), (buf = buf.slice(i + 1)));
    });
    sock.on('close', () => (c.closed = true));
    sock.on('error', () => {});
    sock.on('connect', () => (sock.write(`${first}\n`), resolve(c)));
  });
}

test('the keeper: only the token gets in, only protocol commands pass, and it ends with its app', async () => {
  const kp = startKeeper();
  const state = await waitState(kp.file);
  assert.equal(state.pipe, pipePathFor(kp.id));
  assert.ok(state.appPid > 0 && state.keeperPid > 0);
  assert.ok(!JSON.stringify(state).includes(kp.token), 'the token is never in the state file');
  // Wrong token, or no JSON at all: dropped, nothing said.
  const bad = await client(state.pipe, JSON.stringify({ token: 'nope'.repeat(16) }));
  await sleep(300);
  assert.ok(bad.closed && bad.lines.length === 0);
  const junk = await client(state.pipe, 'hello');
  await sleep(300);
  assert.ok(junk.closed && junk.lines.length === 0);
  // The token: in, and commands go to the app and back.
  const c = await client(state.pipe, JSON.stringify({ token: kp.token }));
  await sleep(200);
  assert.equal(c.lines[0]?.keeper, 'ok');
  c.sock.write(`${JSON.stringify({ id: 5, method: 'Page.navigate', params: { url: 'x' }, sessionId: 'S1' })}\n`);
  c.sock.write(`${JSON.stringify({ id: 6, method: 'not a method' })}\n`); // dropped
  c.sock.write(`${JSON.stringify({ method: 'DOM.focus' })}\n`); // no id: dropped
  c.sock.write(`${JSON.stringify({ id: 7, method: 'DOM.focus', extra: 'stripped' })}\n`);
  await sleep(300);
  const answers = c.lines.slice(1);
  assert.deepEqual(answers.map((a) => a.id), [5, 7]);
  assert.equal(answers[0].result.sessionId, 'S1');
  // A second client with the token replaces the first; the keeper keeps going without either.
  const c2 = await client(state.pipe, JSON.stringify({ token: kp.token }));
  await sleep(200);
  assert.ok(c.closed, 'the old client was replaced');
  c2.sock.destroy();
  await sleep(200);
  const c3 = await client(state.pipe, JSON.stringify({ token: kp.token }));
  await sleep(200);
  assert.equal(c3.lines[0]?.keeper, 'ok', 'reconnects after Orbit went away');
  // The app quits: the keeper exits and its state file goes.
  c3.sock.write(`${JSON.stringify({ id: 9, method: 'App.quit' })}\n`);
  await new Promise((r) => kp.k.once('exit', r));
  assert.ok(!fs.existsSync(kp.file));
});

test('an app\x27s command line is read back to its arguments, without debugging switches', () => {
  assert.deepEqual(argsAfterProgram('"C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0\\Discord.exe"'), []);
  assert.deepEqual(argsAfterProgram('"C:\\A B\\app.exe" --foo "bar baz" --x=1'), ['--foo', 'bar baz', '--x=1']);
  assert.deepEqual(argsAfterProgram('C:\\app.exe --a'), ['--a']);
  assert.deepEqual(cleanArgs(['--a', '--remote-debugging-port=9222', '--remote-debugging-pipe', '--inspect=1', '--b']), ['--a', '--b']);
});

test('the page that is the window: same title, a title it starts with, or the only page', () => {
  const t = [
    { type: 'page', title: 'Discord', targetId: 'A' },
    { type: 'service_worker', title: 'sw', targetId: 'B' },
    { type: 'page', title: 'Settings', targetId: 'C' },
  ];
  assert.equal(pickPage(t, 'Discord').targetId, 'A');
  assert.equal(pickPage(t, 'Settings - Discord').targetId, 'C');
  assert.equal(pickPage([{ type: 'page', title: 'x', targetId: 'Z' }], 'whatever').targetId, 'Z');
});

test('under Orbit, the pipe comes first; otherwise the old order', () => {
  assert.deepEqual(inputOrder(null, { pipeOn: true }), ['pipe', 'value']);
  assert.deepEqual(inputOrder({ inputMethod: 'cdp' }, { pipeOn: true, cdpOn: true }), ['pipe', 'value', 'cdp']);
  assert.deepEqual(inputOrder({ inputMethod: 'pipe' }), ['value'], 'a remembered pipe without a keeper is no pipe');
});

test('macOS: an app goes back to normal through Launch Services (open -a), with its own arguments', async () => {
  const { launchNormally } = await import('../src/anywhere/keeper.js');
  const calls = [];
  const spawnImpl = (cmd, args, opts) => (calls.push({ cmd, args, opts }), { unref() {} });
  assert.equal(launchNormally('/Applications/Discord.app/Contents/MacOS/Discord', ['--start-minimized'], { spawnImpl, platform: 'darwin' }), true);
  assert.deepEqual(calls[0].cmd, '/usr/bin/open');
  assert.deepEqual(calls[0].args, ['-n', '-a', '/Applications/Discord.app', '--args', '--start-minimized']);
  launchNormally('/Applications/OpenCode.app/Contents/MacOS/opencode', [], { spawnImpl, platform: 'darwin' });
  assert.deepEqual(calls[1].args, ['-n', '-a', '/Applications/OpenCode.app'], 'no --args without arguments');
  launchNormally('/usr/local/bin/tool', ['x'], { spawnImpl, platform: 'darwin' });
  assert.equal(calls[2].cmd, '/usr/local/bin/tool', 'a plain program (not in an .app) starts directly');
  launchNormally('C:\Apps\Discord.exe', ['--x'], { spawnImpl, platform: 'win32' });
  assert.equal(calls[3].cmd, 'C:\Apps\Discord.exe', 'Windows starts the program itself, as before');
  assert.equal(pipePathFor('a1b2c3d4e5f6a7b8', 'darwin').endsWith('orbit-keeper-a1b2c3d4e5f6a7b8.sock'), true);
});
