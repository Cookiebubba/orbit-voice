// Running local MCP servers boxed in ("Orbit anywhere", phase 9). A local (stdio) server is code
// from someone else running on this PC, so it never runs plain:
//   - Docker images (OCI packages), when Docker is installed: `docker run` with no host folders,
//     1 CPU, 2 GB, a process cap and no new privileges;
//   - everything else (npm, PyPI): orbit-jail (src/platform/win/jail.cs): a Job Object (killed with
//     Orbit, 2 GB per process, 64 processes) at low integrity, with its own writable folder under
//     LocalLow (npm's and uv's caches and temp files go there). A server that can't run that way
//     isn't run (the user can choose Docker).
// Remote (HTTP) servers run nothing here: preferred when there's a choice.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const JAIL_SOURCE = path.join(HERE, '..', 'platform', 'win', 'jail.cs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const WIN = process.env.SystemRoot || 'C:\\Windows';
const CSC = path.join(WIN, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

/** Build orbit-jail.exe once per source version into `cacheDir`. Returns its path (or throws). */
export function buildJail(cacheDir, { spawnSyncImpl = spawnSync } = {}) {
  const src = fs.readFileSync(JAIL_SOURCE, 'utf8');
  const exe = path.join(cacheDir, `orbit-jail-${crypto.createHash('sha256').update(src).digest('hex').slice(0, 12)}.exe`);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${exe}.${process.pid}.tmp.exe`;
  const r = spawnSyncImpl(CSC, ['/nologo', '/optimize', '/target:exe', `/out:${tmp}`, JAIL_SOURCE], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`could not build the sandbox launcher: ${String(r.stdout || r.stderr).slice(0, 300)}`);
  try {
    fs.renameSync(tmp, exe);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
  return exe;
}

/** The server's own folder at low integrity (LocalLow is the one place low processes may write). */
export function lowFolder(id, { home = os.homedir() } = {}) {
  const dir = path.join(home, 'AppData', 'LocalLow', 'Orbit', 'mcp', String(id).replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  return dir;
}

/** A program on PATH (Windows: with .exe), or ''. */
export function onPath(name, { env = process.env } = {}) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, name + e);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return '';
}

/**
 * npx as node + npx-cli.js (a .cmd shim can't be started at low integrity without cmd.exe in
 * between, and cmd's quoting is its own language).
 */
function npxCommand(env) {
  const node = onPath('node', { env });
  const cli = node ? path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npx-cli.js') : '';
  if (!node || !fs.existsSync(cli)) throw new Error('This server needs Node.js (npx), which is not installed here.');
  return { command: node, pre: [cli] };
}

/** The plain command that runs a registry package (before boxing). */
export function packageCommand(pkg, { env = process.env } = {}) {
  const v = pkg.version ? String(pkg.version) : '';
  switch (pkg.registryType) {
    case 'npm': {
      const npx = npxCommand(env);
      return { command: npx.command, args: [...npx.pre, '-y', v ? `${pkg.identifier}@${v}` : pkg.identifier] };
    }
    case 'pypi': {
      const uvx = onPath('uvx', { env });
      if (!uvx) throw new Error('This server needs uv (uvx), which is not installed here.');
      return { command: uvx, args: [v ? `${pkg.identifier}==${v}` : pkg.identifier] };
    }
    case 'oci':
      return { docker: true, image: v && !pkg.identifier.includes(':') && !pkg.identifier.includes('@') ? `${pkg.identifier}:${v}` : pkg.identifier };
    default:
      throw new Error(`${pkg.registryType} servers can't be run by Orbit (only npm, PyPI and Docker ones).`);
  }
}

let dockerCache = null;
export function dockerAvailable({ spawnSyncImpl = spawnSync } = {}) {
  if (dockerCache !== null) return dockerCache;
  try {
    const r = spawnSyncImpl('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    dockerCache = r.status === 0 && /\d/.test(String(r.stdout));
  } catch {
    dockerCache = false;
  }
  return dockerCache;
}

/**
 * How to run a local server boxed: { command, args, env } for spawn (or for Claude Code's
 * --mcp-config). `source`: { kind: 'package', registryType, identifier, version } or
 * { kind: 'command', command, args } (tests, local tools the user pointed at).
 */
export function boxedCommand(source, { id, cacheDir, env = process.env, medium = false, docker = dockerAvailable, home } = {}) {
  const plain = source.kind === 'package' ? packageCommand(source, { env }) : { command: source.command, args: source.args || [] };
  if (plain.docker) {
    if (!docker()) throw new Error('This server comes as a Docker image, and Docker is not running here.');
    return { command: 'docker', args: ['run', '-i', '--rm', '--cpus', '1', '--memory', '2g', '--pids-limit', '256', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp', plain.image], env: { ...env } };
  }
  if (process.platform !== 'win32') throw new Error('Local servers are boxed only on Windows for now.');
  const jail = buildJail(cacheDir);
  const dir = lowFolder(id, home ? { home } : undefined);
  const tmp = path.join(dir, 'tmp');
  return {
    command: jail,
    args: [...(medium ? ['--medium'] : []), '--mem-mb', '2048', '--', plain.command, ...plain.args],
    env: { ...env, TEMP: tmp, TMP: tmp, npm_config_cache: path.join(dir, 'npm-cache'), npm_config_update_notifier: 'false', UV_CACHE_DIR: path.join(dir, 'uv-cache'), UV_TOOL_DIR: path.join(dir, 'uv-tools'), ORBIT_MCP_HOME: dir },
  };
}

/** Start a boxed server process (stdio). */
export function spawnBoxed(source, opts = {}) {
  const c = boxedCommand(source, opts);
  return spawn(c.command, c.args, { env: c.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
