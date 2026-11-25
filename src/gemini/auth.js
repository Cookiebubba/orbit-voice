// Gemini CLI discovery, model/voice catalogs, and sign-in checks for Orbit's Gemini engines.
//
// Follows Orbit's security posture: never logs API keys, OAuth tokens, or user words; never runs
// through a shell; checks only plain `gemini` executables on local absolute paths.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, groupOptions, killTree, searchDirs } from '../platform/system.js';

export const GEMINI_VOICE_MODELS = Object.freeze({
  'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', speed: 'fast, balanced' },
  'gemini-2.5-pro': { label: 'Gemini 2.5 Pro', speed: 'slower, deeper reasoning' },
  'gemini-2.5-flash-lite': { label: 'Gemini 2.5 Flash Lite', speed: 'fastest, lightweight' },
});

export const GEMINI_LIVE_MODELS = Object.freeze({
  'gemini-2.5-flash-native-audio-preview-12-2025': { label: 'Gemini 2.5 Flash Native Audio', speed: 'native audio, lowest latency' },
  'gemini-2.0-flash-live-001': { label: 'Gemini 2.0 Flash Live', speed: 'fast multimodal live' },
});

export const GEMINI_LIVE_VOICES = Object.freeze([
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr',
]);

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** An absolute path on this machine (not a UNC network share). */
function isLocalAbsolute(p, platform = process.platform) {
  const s = String(p || '');
  return pathFor(platform).isAbsolute(s) && !/^[\\/]{2}/.test(s);
}

/**
 * Only ever run something that is plainly the Gemini CLI. On Windows, npm installs a `gemini.cmd`
 * shim and native bundles use `gemini.exe` (reject bare `gemini` or other names).
 */
export function isGeminiFile(p, platform = process.platform) {
  const base = pathFor(platform).basename(String(p || ''));
  return (platform === 'win32' ? /^gemini\.(exe|cmd)$/i : /^gemini(\.exe)?$/i).test(base);
}

const geminiNames = (platform = process.platform) => (platform === 'win32' ? ['gemini.exe', 'gemini.cmd'] : ['gemini']);

/**
 * Finds the Gemini CLI executable: a configured local absolute path first, then PATH (plus
 * login-shell PATH and well-known install folders via searchDirs, and npm's global folder on
 * Windows). Returns { path, source } or null.
 * `opts` ({ platform, homedir, shellPath, exists }) is for tests.
 */
export function findGemini(configured = '', env = process.env, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const homedir = opts.homedir ?? os.homedir();
  const exists = opts.exists ?? fs.existsSync;
  const p = pathFor(platform);
  if (configured) {
    return isGeminiFile(configured, platform) && isLocalAbsolute(configured, platform) && exists(configured)
      ? { path: configured, source: 'settings' }
      : null;
  }
  const names = geminiNames(platform);
  const dirs = [...searchDirs({ platform, env, homedir, shellPath: opts.shellPath })];
  if (platform === 'win32') {
    const npmBin = p.join(env.APPDATA || p.join(homedir, 'AppData', 'Roaming'), 'npm');
    if (!dirs.includes(npmBin)) dirs.push(npmBin);
  }
  for (const dir of dirs) {
    for (const name of names) {
      const file = p.join(dir, name);
      if (exists(file)) return { path: file, source: 'path' };
    }
  }
  return null;
}

/** Gemini CLI or Google API sign-in is missing or expired (as opposed to a rate limit or crash). */
export function isGeminiSignInProblem(text) {
  return /session expired|could not be refreshed|token.*expired|invalid_grant|not logged in|not authenticated|unauthenticated|please (?:log ?in|sign ?in|authenticate)|run [`'"]?gemini[`'"]? to sign in|auth(?:entication)? (?:failed|required|error)|invalid (?:api ?key|credentials)|api[ _]?key.*(?:not valid|invalid|missing)|unauthori[sz]ed|\b401\b/i.test(
    String(text || ''),
  );
}

/** Environment for running Gemini CLI on the user's own Google sign-in (no API keys). */
function loginEnv(base = process.env) {
  const env = childEnv(base);
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Inspects ~/.gemini/oauth_creds.json (or $GEMINI_CLI_HOME/.gemini) without touching the network. */
function readCachedOAuth(homedir, env) {
  const root = env?.GEMINI_CLI_HOME ? env.GEMINI_CLI_HOME : homedir;
  if (!root) return { found: false, valid: false, expired: false };
  const file = path.join(root, '.gemini', 'oauth_creds.json');
  if (!fs.existsSync(file)) return { found: false, valid: false, expired: false };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return { found: true, valid: false, expired: false };
    const hasRefresh = typeof j.refresh_token === 'string' && j.refresh_token.trim().length > 0;
    const hasAccess = typeof j.access_token === 'string' && j.access_token.trim().length > 0;
    if (hasRefresh) return { found: true, valid: true, expired: false };
    if (hasAccess) {
      const expiry = Number(j.expiry_date);
      if (Number.isFinite(expiry) && expiry > 0 && expiry <= Date.now()) {
        return { found: true, valid: false, expired: true };
      }
      return { found: true, valid: true, expired: false };
    }
    return { found: true, valid: false, expired: false };
  } catch {
    return { found: true, valid: false, expired: false };
  }
}

/**
 * Checks whether Gemini CLI is ready and signed in (no model call, nothing billed).
 * Inspects cached OAuth credentials in `homedir/.gemini/oauth_creds.json`, explicit API key /
 * Vertex env configuration, and falls back to verifying the CLI executable via `gemini --version`.
 * Resolves { ok: true, signedIn, method } or { ok: false, error }.
 */
export function geminiAuthStatus({ geminiPath, homedir = os.homedir(), env = process.env, spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    if (!geminiPath) return resolve({ ok: false, error: 'Gemini CLI was not found.' });

    const oauth = readCachedOAuth(homedir, env);
    if (oauth.valid) return resolve({ ok: true, signedIn: true, method: 'oauth' });

    const apiKey = typeof env?.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim()
      ? env.GEMINI_API_KEY.trim()
      : typeof env?.GOOGLE_API_KEY === 'string' && env.GOOGLE_API_KEY.trim()
        ? env.GOOGLE_API_KEY.trim()
        : '';
    if (apiKey) return resolve({ ok: true, signedIn: true, method: 'api-key' });

    if (String(env?.GOOGLE_GENAI_USE_VERTEXAI || '').toLowerCase() === 'true' && env?.GOOGLE_CLOUD_PROJECT) {
      return resolve({ ok: true, signedIn: true, method: 'vertex-ai' });
    }

    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawnImpl(geminiPath, ['--version'], {
        cwd: os.tmpdir(),
        env: loginEnv(env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...groupOptions(),
      });
    } catch (e) {
      return finish({ ok: false, error: `Couldn't start Gemini CLI: ${String(e?.message || e).slice(0, 160)}` });
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, error: 'Gemini CLI took too long to respond.' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (out.length < 20_000) out += d; });
    child.stderr?.on('data', (d) => { if (err.length < 20_000) err += d; });
    child.on('error', (e) => finish({ ok: false, error: `Couldn't start Gemini CLI: ${String(e?.message || e).slice(0, 160)}` }));
    child.on('close', (code) => {
      if (code === 0 && out.trim()) {
        return finish({ ok: true, signedIn: false, method: oauth.expired ? 'oauth-expired' : null });
      }
      const raw = err || out;
      if (isGeminiSignInProblem(raw)) return finish({ ok: true, signedIn: false, method: null });
      finish({ ok: false, error: `Gemini CLI could not be verified${code ? ` (exit ${code})` : ''}.` });
    });
  });
}

/** One argument for /bin/sh, single-quoted. */
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The Mac sign-in's .command file: removes itself, then launches Gemini CLI interactively in Terminal. */
export const geminiSignInScript = (file, geminiPath) =>
  `#!/bin/sh\nrm -f ${shellQuote(file)}\nexec ${shellQuote(geminiPath)}\n`;

/**
 * Opens Gemini CLI in its own console window so the user can complete Google OAuth sign-in in
 * their browser. No shell is involved on Windows; on macOS a self-removing .command opens in
 * Terminal. Resolves { ok } once started.
 */
export function openGeminiSignIn({ geminiPath, spawnImpl = spawn, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    if (!geminiPath) return resolve({ ok: false, error: 'Gemini CLI was not found.' });
    let child;
    try {
      if (platform === 'darwin') {
        const file = path.join(os.tmpdir(), `orbit-gemini-sign-in-${crypto.randomBytes(6).toString('hex')}.command`);
        fs.writeFileSync(file, geminiSignInScript(file, geminiPath), { mode: 0o700 });
        child = spawnImpl('/usr/bin/open', [file], { stdio: 'ignore' });
      } else {
        child = spawnImpl(geminiPath, [], {
          cwd: os.homedir(),
          env: loginEnv(),
          detached: true,
          windowsHide: false,
          stdio: 'ignore',
        });
      }
    } catch (e) {
      return resolve({ ok: false, error: `Couldn't open the Gemini CLI sign-in: ${String(e?.message || e).slice(0, 160)}` });
    }
    child.on?.('error', (e) => resolve({ ok: false, error: `Couldn't open the Gemini CLI sign-in: ${String(e?.message || e).slice(0, 160)}` }));
    child.on?.('spawn', () => resolve({ ok: true }));
    child.unref?.();
  });
}
