// The Gemini CLI engine for background helpers ("Orbit anywhere"): one headless Gemini CLI
// process per helper, running in an isolated temp folder whose locked-down .gemini/settings.json
// registers ONLY Orbit's orbit-hands MCP server (with Bearer token) plus approved extra.servers.
//
// Events (onEvent): { type: 'started' } | { type: 'progress', line } | { type: 'text', text } |
// { type: 'done', ok, summary, cost, seconds } | { type: 'error', error }.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { speakable } from '../brain.js';
import { isGeminiSignInProblem } from '../gemini/brain.js';
import { childEnv, groupOptions, killTree as killProcessTree } from '../platform/system.js';
import { HELPER_SYSTEM, progressLine } from './claude-code.js';

export const GEMINI_HELPER_LIMITS = Object.freeze({
  maxMinutes: 20,
  model: 'gemini-2.5-flash',
});

const EXCLUDED_BUILTIN_TOOLS = Object.freeze([
  'run_shell_command',
  'read_file',
  'write_file',
  'replace',
  'edit',
  'list_directory',
  'glob',
  'grep',
  'search_file_content',
  'read_many_files',
  'web_fetch',
  'google_web_search',
  'save_memory',
]);

/**
 * Build the locked-down .gemini/settings.json object for one helper run:
 * registers ONLY Orbit's `orbit-hands` MCP server (with Bearer auth) and approved `extra.servers`,
 * while excluding all built-in file, shell, and web tools.
 */
export function geminiHelperSettings({ mcpUrl, token, tools = [], extra = null }) {
  const orbitEntry = {
    type: 'http',
    url: mcpUrl,
    httpUrl: mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
    trust: true,
    ...(Array.isArray(tools) && tools.length ? { includeTools: [...tools] } : {}),
  };

  const mcpServers = { 'orbit-hands': orbitEntry };

  if (extra?.servers && typeof extra.servers === 'object') {
    for (const [id, srv] of Object.entries(extra.servers)) {
      if (!id || id === 'orbit-hands' || !srv || typeof srv !== 'object') continue;
      if (srv.type === 'http' || srv.url || srv.httpUrl) {
        const u = srv.httpUrl || srv.url;
        mcpServers[id] = {
          type: 'http',
          url: u,
          httpUrl: u,
          ...(srv.headers && typeof srv.headers === 'object' ? { headers: { ...srv.headers } } : {}),
        };
      } else if (srv.command) {
        mcpServers[id] = {
          type: 'stdio',
          command: srv.command,
          ...(Array.isArray(srv.args) ? { args: [...srv.args] } : {}),
          ...(srv.env && typeof srv.env === 'object' ? { env: { ...srv.env } } : {}),
        };
      }
    }
  }

  return {
    mcpServers,
    mcp: { allowed: Object.keys(mcpServers) },
    tools: { exclude: [...EXCLUDED_BUILTIN_TOOLS] },
    excludeTools: [...EXCLUDED_BUILTIN_TOOLS],
    privacy: { usageStatisticsEnabled: false },
  };
}

/** Command-line arguments for one headless Gemini helper run (task goes on stdin). */
export function geminiHelperArgs({ model = GEMINI_HELPER_LIMITS.model, allowedServers = ['orbit-hands'] } = {}) {
  return [
    '-p', '',
    '--output-format', 'stream-json',
    '--model', model,
    ...(allowedServers.length ? ['--allowed-mcp-server-names', ...allowedServers] : []),
  ];
}

function normalizeOrbitToolName(name) {
  return String(name || '').replace(/^(?:mcp__?)?(?:orbit-hands|orbit)(?:__?)/i, '');
}

function removeDirSync(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

const live = new Set();
const killTree = (child, sync = false) => killProcessTree(child, { sync });
process.on('exit', () => {
  for (const item of live) {
    killTree(item.child, true);
    removeDirSync(item.dir);
  }
});

/**
 * Start one Gemini CLI background helper.
 * Returns { send(text), stop(), pid } or throws. `spawnImpl` is for tests.
 */
export function startGeminiHelper({
  task,
  mcpUrl,
  token,
  tools = [],
  extra = null,
  geminiPath,
  apiKey = '',
  model = GEMINI_HELPER_LIMITS.model,
  onEvent = () => {},
  spawnImpl = spawn,
  maxMs = GEMINI_HELPER_LIMITS.maxMinutes * 60_000,
} = {}) {
  if (!geminiPath) throw new Error('Gemini CLI was not found.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-gemini-helper-'));
  const cfgDir = path.join(dir, '.gemini');
  const settings = geminiHelperSettings({ mcpUrl, token, tools, extra });
  try {
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  } catch (e) {
    removeDirSync(dir);
    throw e;
  }

  const env = childEnv(process.env);
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  if (apiKey) env.GEMINI_API_KEY = apiKey;

  const started = Date.now();
  const allowedServers = Object.keys(settings.mcpServers);
  let child;
  try {
    child = spawnImpl(geminiPath, geminiHelperArgs({ model, allowedServers }), {
      cwd: dir,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...groupOptions(),
    });
  } catch (e) {
    removeDirSync(dir);
    throw e;
  }

  const entry = { child, dir };
  live.add(entry);

  let ended = false;
  let lastText = '';
  let err = '';

  const end = (evt) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    live.delete(entry);
    try {
      child.stdin.end();
    } catch { /* ignore */ }
    killTree(child);
    removeDirSync(dir);
    onEvent(evt);
  };

  const timer = setTimeout(
    () => end({ type: 'done', ok: false, summary: `It ran out of time (${GEMINI_HELPER_LIMITS.maxMinutes} minutes) and was stopped.` }),
    maxMs,
  );
  timer.unref?.();

  child.stdin.on('error', () => {});
  child.stderr?.on('data', (d) => {
    if (err.length < 20_000) err += d;
  });
  child.on('error', (e) => end({ type: 'error', error: `Couldn't start Gemini CLI: ${String(e?.message || e).slice(0, 120)}` }));
  child.on('exit', (code) => {
    if (ended) return;
    end({ type: 'done', ok: false, summary: describeExit(err, code), needsSignIn: isGeminiSignInProblem(err) });
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (!j || typeof j !== 'object') return;

    // Gemini CLI stream-json init event (or Claude-compatible system/init)
    if (j.type === 'init' || (j.type === 'system' && j.subtype === 'init')) {
      return onEvent({ type: 'started' });
    }

    // Gemini CLI stream-json tool_use / tool_call event
    if (j.type === 'tool_use' || j.type === 'tool_call') {
      const rawName = j.tool_name || j.name || '';
      const input = (j.parameters && typeof j.parameters === 'object' ? j.parameters : (j.input && typeof j.input === 'object' ? j.input : (j.args && typeof j.args === 'object' ? j.args : {})));
      onEvent({ type: 'progress', line: progressLine(normalizeOrbitToolName(rawName), input) });
      return;
    }

    // Gemini CLI stream-json assistant message chunk
    if (j.type === 'message' && j.role === 'assistant') {
      const text = typeof j.content === 'string' ? j.content : '';
      if (text.trim()) {
        lastText = j.delta ? `${lastText}${text}` : text;
        onEvent({ type: 'text', text });
      }
      return;
    }

    // Structured assistant message with content blocks
    if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
      for (const c of j.message.content) {
        if (c?.type === 'tool_use') {
          onEvent({ type: 'progress', line: progressLine(normalizeOrbitToolName(c.name), c.input || {}) });
        } else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          lastText = c.text;
          onEvent({ type: 'text', text: c.text });
        }
      }
      return;
    }

    // Final result event
    if (j.type === 'result') {
      const raw = (typeof j.response === 'string' && j.response.trim())
        ? j.response
        : ((typeof j.result === 'string' && j.result.trim()) ? j.result : lastText);
      const ok = !j.is_error && !j.error && (j.status === 'success' || j.subtype === 'success' || (j.status === undefined && j.subtype === undefined));
      const errMsg = typeof j.error === 'string' ? j.error : (typeof j.error?.message === 'string' ? j.error.message : raw);
      end({
        type: 'done',
        ok,
        summary: speakable(ok ? raw : errMsg).slice(0, 400) || (ok ? 'Done.' : 'It stopped.'),
        cost: null,
        seconds: Math.round((Date.now() - started) / 1000),
        needsSignIn: !ok && isGeminiSignInProblem(errMsg || err),
      });
      return;
    }

    if (j.type === 'error') {
      const raw = typeof j.message === 'string' ? j.message : (typeof j.error === 'string' ? j.error : err);
      end({
        type: 'done',
        ok: false,
        summary: speakable(raw).slice(0, 400) || 'It stopped.',
        cost: null,
        seconds: Math.round((Date.now() - started) / 1000),
        needsSignIn: isGeminiSignInProblem(raw),
      });
    }
  });

  const send = (text) => {
    if (ended) return false;
    try {
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text).slice(0, 4000) }] } })}\n`);
      return true;
    } catch {
      return false;
    }
  };

  send(`${HELPER_SYSTEM}\n\nTask (the user's words): ${task}`);

  return {
    send,
    stop: () => end({ type: 'done', ok: false, cancelled: true, summary: 'Stopped.' }),
    get pid() {
      return child.pid;
    },
  };
}

function describeExit(err, code) {
  if (isGeminiSignInProblem(err)) return 'Gemini CLI needs the user to sign in again.';
  return `It stopped unexpectedly (exit ${code ?? '?'}).`;
}

/** The Gemini helper engine, matching Orbit's engine interface. */
export const geminiEngine = Object.freeze({
  id: 'gemini',
  label: 'Gemini',
  available: true,
  start: startGeminiHelper,
});
