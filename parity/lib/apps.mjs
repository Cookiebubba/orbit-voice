// Starting and stopping the apps under test (and the stand-in Claude window) for the parity runner.
// Everything is launched with `open -n -g` so it runs in the logged-in GUI session as the user's own
// apps do, with a throwaway profile, its own ports and the test switches from parity/PROTOCOL.md.
import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const token = () => crypto.randomBytes(16).toString('hex');

/** `open -n -g` an app bundle with env and args; output to files in `logDir`. */
export function openApp(bundle, { env = {}, args = [], logDir, name }) {
  const a = ['-n', '-g'];
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== null) a.push('--env', `${k}=${v}`);
  if (logDir) a.push('--stdout', path.join(logDir, `${name}.out.log`), '--stderr', path.join(logDir, `${name}.err.log`));
  a.push(bundle);
  if (args.length) a.push('--args', ...args);
  return new Promise((resolve, reject) => execFile('open', a, (err) => (err ? reject(err) : resolve())));
}

export const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits for a process to end; then TERM, then KILL. */
export async function ensureGone(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await sleep(100);
  if (!alive(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  await sleep(1500);
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  return !alive(pid);
}

/** Our own processes whose environment names `needle` (ps shows the environment of one's own processes). */
export function pidsWithEnv(needle) {
  try {
    return execFileSync('ps', ['-Aeww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 })
      .split('\n')
      .filter((l) => l.includes(needle))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((p) => p > 0 && p !== process.pid);
  } catch {
    return [];
  }
}

/** Whoever listens on a loopback port (lsof), if it's one of the apps this suite launches. */
function testAppOnPort(port) {
  try {
    const pid = Number(execFileSync('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]);
    if (!pid) return 0;
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return /Orbit Native\.app|Electron\.app\/Contents\/MacOS\/Electron/.test(cmd) ? pid : 0;
  } catch {
    return 0;
  }
}

/** A port held by a test app left over from an earlier case: end it (never anything else). */
export async function freePort(port) {
  const pid = testAppOnPort(port);
  if (pid) await ensureGone(pid, 0);
}

/** A JSON client for an app's parity driver. */
export function driverClient(port, tok) {
  const call = async (method, p, body, timeoutMs = 15000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-parity-token': tok, 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: r.status, body: json ?? text };
    } finally {
      clearTimeout(t);
    }
  };
  return {
    hello: () => call('GET', '/parity/hello'),
    state: () => call('GET', '/parity/state'),
    act: (action, args = {}, timeoutMs) => call('POST', '/parity/act', { action, args }, timeoutMs),
  };
}

/** Polls `fn` until it returns a truthy value or the time is up. */
export async function until(fn, ms, every = 100) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await sleep(every);
  }
  return last;
}

/**
 * Starts one app under test. `which`: 'swift' | 'electron'. Resolves { which, pid, hello, driver,
 * stop() } once its driver answers, or throws with what its logs said.
 */
export async function startApp(which, { paths, profileDir, logDir, bridgePort, driverPort, env = {} }) {
  const tok = token();
  await freePort(driverPort);
  await freePort(bridgePort);
  const common = {
    ORBIT_PARITY_PORT: driverPort,
    ORBIT_PARITY_TOKEN: tok,
    ORBIT_PROFILE_DIR: profileDir,
    PORT: bridgePort,
    ORBIT_MUTE_OUTPUT: '1',
    ...env,
  };
  if (which === 'swift') {
    if (!fs.existsSync(paths.swiftApp)) throw new Error(`no Swift build at ${paths.swiftApp} (mac-swift/scripts/build-app.sh --test)`);
    await openApp(paths.swiftApp, { env: common, logDir, name: 'swift' });
  } else if (which === 'electron') {
    const bundle = path.join(paths.electronRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
    if (!fs.existsSync(bundle)) throw new Error(`no Electron at ${bundle} (node node_modules/electron/install.js)`);
    await openApp(bundle, { env: common, args: [paths.electronRoot], logDir, name: 'electron' });
  } else throw new Error(`unknown app ${which}`);
  const driver = driverClient(driverPort, tok);
  const hello = await until(async () => {
    const r = await driver.hello();
    return r.status === 200 && r.body?.bridge?.base && r.body.ready !== false ? r.body : null;
  }, which === 'electron' ? 45_000 : 30_000);
  if (!hello?.bridge?.base) {
    // Never leave it running: it would hold the ports for every case after this one.
    for (const pid of pidsWithEnv(`ORBIT_PROFILE_DIR=${profileDir}`)) await ensureGone(pid, 0);
    const tail = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').slice(-8).join(' | ') : '');
    throw new Error(`${which} did not come up: ${tail(path.join(logDir, `${which}.err.log`)) || '(no output)'}`.slice(0, 600));
  }
  return {
    which,
    pid: hello.pid,
    hello,
    driver,
    async stop() {
      try {
        await driver.act('quit', {}, 3000);
      } catch {}
      const gone = await ensureGone(hello.pid, 6000);
      // A copy that relaunched itself (Orbit Native's core recovery) has another pid, same profile.
      for (const pid of pidsWithEnv(`ORBIT_PROFILE_DIR=${profileDir}`)) await ensureGone(pid, 3000);
      return gone;
    },
  };
}

/** The stand-in Claude window (parity/fixtures/standin), with its control port. */
export async function startStandIn({ paths, port, logDir, frame }) {
  const tok = token();
  const bundle = path.join(paths.electronRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
  await freePort(port);
  await openApp(bundle, { env: { PARITY_STANDIN_PORT: port, PARITY_STANDIN_TOKEN: tok, PARITY_STANDIN_FRAME: frame ? JSON.stringify(frame) : undefined }, args: [path.join(paths.repo, 'parity', 'fixtures', 'standin')], logDir, name: 'standin' });
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-standin-token': tok, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json();
  };
  const st = await until(() => call('GET', '/state').then((j) => (j?.pid ? j : null)), 30_000);
  if (!st?.pid) {
    for (const pid of pidsWithEnv(`PARITY_STANDIN_TOKEN=${tok}`)) await ensureGone(pid, 0);
    throw new Error('the stand-in Claude window did not come up');
  }
  return {
    pid: st.pid,
    state: () => call('GET', '/state'),
    set: (patch) => call('POST', '/set', { patch }),
    type: (text) => call('POST', '/type', { text }),
    move: (r) => call('POST', '/move', r),
    async stop() {
      try {
        await call('POST', '/quit');
      } catch {}
      return ensureGone(st.pid, 5000);
    },
  };
}

/** The stand-in Grok (test/e2e/fake-grok.mjs) in a child process, so the runner stays responsive. */
export async function startFakeGrok({ paths, port, recordDir, seed = 1 }) {
  const child = spawn(process.execPath, [path.join(paths.repo, 'parity', 'fixtures', 'fake-grok-server.mjs'), String(port), String(seed), recordDir || ''], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fake Grok did not start')), 10_000);
    child.stdout.on('data', (d) => String(d).includes('ready') && (clearTimeout(t), resolve()));
    child.on('exit', (c) => reject(new Error(`fake Grok exited ${c}`)));
  });
  return { url: `ws://127.0.0.1:${port}`, stop: () => child.kill() };
}
