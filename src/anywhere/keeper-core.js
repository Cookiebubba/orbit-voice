// The pipe keeper ("Orbit anywhere"): holds an app the user approved under Orbit's control.
//
// Web and Electron apps (Discord, OpenCode...) only take text that arrives as real input events, and
// the one way to make those without the user's mouse, keyboard or focus is the app's own DevTools
// protocol. The keeper starts the app's real program with --remote-debugging-pipe: the protocol then
// runs over two private pipes between the keeper and the app (fd 3 into the app, fd 4 out, each
// message JSON ended by a NUL). There is no network port at all, so nothing else on the PC can
// connect to the app the way it could to a --remote-debugging-port.
//
// The app closes when its pipe closes, so the pipe can't live in Orbit itself (restarting Orbit
// would close the app). The keeper is a tiny process of its own, started detached: it outlives
// Orbit, and Orbit reconnects to it after a restart. It exits when the app exits (and the app closes
// if the keeper ever dies: that is the trade).
//
// Orbit reaches the keeper over a local pipe (a Windows named pipe; a user-only Unix socket on macOS)
// whose name is random, and every connection must first send the per-launch token (only Orbit has
// it, kept encrypted in its settings folder). Until then the keeper says nothing and drops the
// connection after a few seconds. One client at a time: a newer authenticated one replaces the old.
// Only well-formed protocol messages are passed on; nothing from the app is ever logged.
//
// Used by electron/keeper.mjs (the packaged app, as "Orbit.exe --orbit-keeper") and by
// src/anywhere/keeper-node.mjs (tests, under plain Node).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const KEEPER_LIMITS = Object.freeze({ authMs: 3000, lineMax: 8 * 1024 * 1024 });

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const ID_OK = /^[a-f0-9]{8,64}$/;

/** The keeper's local pipe for this launch id. */
export function pipePathFor(id, platform = process.platform) {
  if (!ID_OK.test(String(id))) throw new Error('bad keeper id');
  return platform === 'win32' ? `\\\\.\\pipe\\orbit-keeper-${id}` : path.join(os.tmpdir(), `orbit-keeper-${id}.sock`);
}

/** The app's command line, minus any debugging switches it had (the keeper adds its own pipe). */
export function cleanArgs(args) {
  return (Array.isArray(args) ? args : []).map(String).filter((a) => !/^--remote-debugging-(port|pipe|address|io-pipes)\b/i.test(a) && !/^--(inspect|inspect-brk)\b/i.test(a));
}

/**
 * Run the keeper: start `exe` (with `args`) under a DevTools pipe and serve it to Orbit until the
 * app exits. Resolves the exit code for the keeper process. `stateDir`: where it writes
 * <id>.json ({ id, keeperPid, appPid, exe, app, pipe, startedAt }), removed when the app exits.
 */
export async function runKeeper({ id, token, exe, args = [], cwd = '', stateDir, app = '' }, { spawnImpl = spawn, log = () => {} } = {}) {
  if (!ID_OK.test(String(id || ''))) throw new Error('bad keeper id');
  if (typeof token !== 'string' || token.length < 32) throw new Error('bad keeper token');
  if (typeof exe !== 'string' || !path.isAbsolute(exe)) throw new Error('the app must be an absolute path');
  if (!stateDir) throw new Error('no state folder');
  const want = sha(token);
  const pipe = pipePathFor(id);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // the app is an app, not Node
  const child = spawnImpl(exe, [...cleanArgs(args), '--remote-debugging-pipe'], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : path.dirname(exe),
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env,
    windowsHide: false,
  });
  const toApp = child.stdio[3];
  const fromApp = child.stdio[4];
  toApp?.on?.('error', () => {});
  fromApp?.on?.('error', () => {});

  let client = null;
  let appBuf = '';
  fromApp?.setEncoding?.('utf8');
  fromApp?.on?.('data', (chunk) => {
    appBuf += chunk;
    let i;
    while ((i = appBuf.indexOf('\0')) >= 0) {
      const msg = appBuf.slice(0, i);
      appBuf = appBuf.slice(i + 1);
      if (client && !client.destroyed) client.write(`${msg}\n`);
    }
    if (appBuf.length > KEEPER_LIMITS.lineMax) appBuf = '';
  });

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let authed = false;
    let buf = '';
    const drop = setTimeout(() => !authed && sock.destroy(), KEEPER_LIMITS.authMs);
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(drop);
      if (client === sock) client = null;
    });
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > KEEPER_LIMITS.lineMax) return sock.destroy();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          if (!authed) return sock.destroy();
          continue;
        }
        if (!authed) {
          const got = typeof m?.token === 'string' ? sha(m.token) : null;
          if (!got || !crypto.timingSafeEqual(got, want)) return sock.destroy();
          authed = true;
          clearTimeout(drop);
          if (client && client !== sock) client.destroy();
          client = sock;
          sock.write(`${JSON.stringify({ keeper: 'ok', appPid: child.pid })}\n`);
          continue;
        }
        // Only protocol commands go to the app: { id, method, params?, sessionId? }.
        if (!m || !Number.isInteger(m.id) || typeof m.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(m.method)) continue;
        const out = { id: m.id, method: m.method, params: m.params && typeof m.params === 'object' ? m.params : {} };
        if (typeof m.sessionId === 'string') out.sessionId = m.sessionId;
        try {
          toApp.write(`${JSON.stringify(out)}\0`);
        } catch {}
      }
    });
  });
  server.on('error', (e) => log(`keeper pipe: ${e.code || e.message}`));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => (server.off('error', reject), resolve()));
  });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(pipe, 0o600);
    } catch {}
  }

  const stateFile = path.join(stateDir, `${id}.json`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ id, keeperPid: process.pid, appPid: child.pid, exe, args: cleanArgs(args), app: app || path.basename(exe), pipe, startedAt: Date.now() }));

  const done = () => {
    try {
      fs.rmSync(stateFile, { force: true });
    } catch {}
    try {
      server.close();
    } catch {}
    try {
      client?.destroy();
    } catch {}
  };
  return new Promise((resolve) => {
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      done();
      resolve(code);
    };
    child.on('exit', () => end(0));
    child.on('error', (e) => {
      log(`app failed to start: ${e.code || e.message}`);
      end(1);
    });
  });
}

/**
 * The keeper's settings: from the file named by --orbit-keeper-config=<path> (Orbit writes it in its
 * own settings folder; read once and deleted at once: the Windows app process gets no stdin), else
 * one line on stdin (plain Node).
 */
export async function readKeeperConfig(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--orbit-keeper-config='));
  if (arg) {
    const file = arg.slice('--orbit-keeper-config='.length);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } finally {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  }
  return readConfigLine();
}

/** Reads the keeper's one line of settings from stdin (what Orbit writes when it starts one). */
export function readConfigLine(stdin = process.stdin, ms = 10_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('no keeper settings')), ms);
    stdin.setEncoding('utf8');
    stdin.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(t);
      try {
        resolve(JSON.parse(buf.slice(0, i)));
      } catch (e) {
        reject(e);
      }
      try {
        stdin.pause();
        stdin.destroy?.();
      } catch {}
    });
    stdin.on('error', reject);
  });
}
