// A small MCP client ("Orbit anywhere", phase 9): enough to look at a server before and after the
// user approves it (initialize, list its tools, call one), over the two transports: HTTP
// (streamable HTTP: JSON or an event stream per request, a session id kept) and stdio (a process,
// one JSON-RPC message per line). Orbit itself never hands MCP tools to the voice model; helpers
// get them through Claude Code's own client. This is for discovery, fingerprints and tests.

import { spawn } from 'node:child_process';
import readline from 'node:readline';

export const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'orbit', version: '1.0.0' };

export class McpHttpError extends Error {
  constructor(status, wwwAuthenticate = '') {
    super(`HTTP ${status}`);
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

/** The JSON-RPC answer with `id` in a text/event-stream body. */
function fromEventStream(body, id) {
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const j = JSON.parse(data);
      if (j && j.id === id) return j;
    } catch {}
  }
  return null;
}

/** A client for an MCP server over HTTP. `headers()` may add an Authorization header. */
export function createHttpClient({ url, headers = () => ({}), fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  let sessionId = '';
  let nextId = 1;
  async function send(method, params, { notify = false } = {}) {
    const id = notify ? undefined : nextId++;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(await headers()) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, ...(params ? { params } : {}) }),
        signal: ctl.signal,
      });
      if (res.status === 401 || res.status === 403) throw new McpHttpError(res.status, res.headers.get('www-authenticate') || '');
      if (notify) return null;
      if (!res.ok) throw new McpHttpError(res.status);
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      const type = res.headers.get('content-type') || '';
      const body = await res.text();
      const msg = type.includes('text/event-stream') ? fromEventStream(body, id) : JSON.parse(body);
      if (!msg) throw new Error('No answer in the stream.');
      if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${String(msg.error.message || '').slice(0, 200)}`);
      return msg.result;
    } finally {
      clearTimeout(t);
    }
  }
  return {
    async initialize() {
      const r = await send('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
      await send('notifications/initialized', undefined, { notify: true }).catch(() => {});
      return r;
    },
    async listTools() {
      const tools = [];
      let cursor;
      for (let i = 0; i < 20; i++) {
        const r = await send('tools/list', cursor ? { cursor } : {});
        tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    callTool: (name, args = {}) => send('tools/call', { name, arguments: args }),
    close() {},
  };
}

/** A client for an MCP server run as a process (stdio). The process ends with close(). */
export function createStdioClient({ command, args = [], env = process.env, cwd, spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  const child = spawnImpl(command, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let dead = null;
  child.on('error', (e) => (dead = e));
  child.on('exit', () => {
    dead = dead || new Error('The server stopped.');
    for (const p of pending.values()) p.reject(dead);
    pending.clear();
  });
  child.stdin.on('error', () => {});
  child.stderr?.on?.('data', () => {});
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    const p = j && pending.get(j.id);
    if (!p) return;
    pending.delete(j.id);
    clearTimeout(p.timer);
    if (j.error) p.reject(new Error(`MCP error ${j.error.code}: ${String(j.error.message || '').slice(0, 200)}`));
    else p.resolve(j.result);
  });
  const send = (method, params, { notify = false } = {}) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const id = notify ? undefined : nextId++;
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, ...(params ? { params } : {}) })}\n`);
      } catch (e) {
        return reject(e);
      }
      if (notify) return resolve(null);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`No answer to ${method} in time.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  return {
    async initialize() {
      const r = await send('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
      await send('notifications/initialized', undefined, { notify: true });
      return r;
    },
    async listTools() {
      const tools = [];
      let cursor;
      for (let i = 0; i < 20; i++) {
        const r = await send('tools/list', cursor ? { cursor } : {});
        tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    callTool: (name, args = {}) => send('tools/call', { name, arguments: args }),
    close() {
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
    },
    get pid() {
      return child.pid;
    },
  };
}
