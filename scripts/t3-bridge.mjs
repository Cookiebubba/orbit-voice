#!/usr/bin/env node
// Local loopback HTTP bridge connecting Orbit's T3 Code backend (src/targets/t3-code.js)
// to the live T3 Code desktop app via T3's documented `acp-mcp-call` CLI.
//
// Listens on 127.0.0.1 only, requires a Bearer token (T3_BRIDGE_TOKEN or random per-launch),
// and permits only the exact allowlisted T3 thread/project/queue/pending-request tools.

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readDotEnvToken() {
  try {
    const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
    if (!fs.existsSync(envFile)) return '';
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(T3_BRIDGE_TOKEN|T3_API_TOKEN)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) return m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    }
  } catch {}
  return '';
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.T3_BRIDGE_PORT || 4318);
const TOKEN = (process.env.T3_BRIDGE_TOKEN || process.env.T3_API_TOKEN || readDotEnvToken() || crypto.randomBytes(24).toString('hex')).trim();
const NODE_BIN = process.env.T3_ACP_MCP_NODE || '';
const ENTRYPOINT = process.env.T3_ACP_MCP_ENTRYPOINT || '';

const ALLOWED_TOOLS = new Set([
  't3_thread_list',
  't3_thread_read',
  't3_thread_send',
  't3_thread_launch',
  't3_thread_interrupt',
  't3_thread_search',
  't3_queue',
  't3_pending_request',
  't3_project_list',
]);

function tokenMatches(actual) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function runAcpCall(tool, args) {
  return new Promise((resolve) => {
    if (!NODE_BIN) return resolve({ ok: false, error: 'T3_ACP_MCP_NODE is not set in this environment.' });
    const argv = [...(ENTRYPOINT ? [ENTRYPOINT] : []), 'acp-mcp-call', tool, JSON.stringify(args || {})];
    execFile(
      NODE_BIN,
      argv,
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 25_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (err) {
          const msg = String(stderr || out || err.message || 'acp-mcp-call failed').trim().slice(0, 400);
          return resolve({ ok: false, error: msg });
        }
        try {
          const parsed = JSON.parse(out);
          if (parsed && parsed.isError === true) {
            const errText =
              (Array.isArray(parsed.content) && parsed.content.find((c) => c?.type === 'text')?.text) ||
              parsed.error ||
              parsed.message ||
              'T3 tool returned an error';
            return resolve({ ok: false, error: String(errText).slice(0, 400) });
          }
          // Modern MCP structuredContent envelope (returned by T3 Code's acp-mcp-call)
          if (parsed && parsed.structuredContent && typeof parsed.structuredContent === 'object') {
            return resolve({ ok: true, result: parsed.structuredContent });
          }
          // Legacy MCP text content envelope ({ content: [{ type: 'text', text: '{...}' }] })
          if (parsed && Array.isArray(parsed.content) && parsed.content[0]?.type === 'text') {
            try {
              return resolve({ ok: true, result: JSON.parse(parsed.content[0].text) });
            } catch {
              return resolve({ ok: true, result: { text: parsed.content[0].text } });
            }
          }
          return resolve({ ok: true, result: parsed });
        } catch {
          return resolve({ ok: true, result: { text: out } });
        }
      },
    );
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      if (raw.length < 256 * 1024) raw += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, connected: !!NODE_BIN });
  }
  if (req.method !== 'POST' || req.url !== '/mcp/call') {
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  }
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tokenMatches(auth)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name : typeof body.tool === 'string' ? body.tool : '';
  const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : body.args && typeof body.args === 'object' ? body.args : {};
  if (!ALLOWED_TOOLS.has(name)) return sendJson(res, 403, { ok: false, error: `Tool not allowed: ${name}` });

  const r = await runAcpCall(name, args);
  return sendJson(res, r.ok ? 200 : 502, r);
});

server.listen(PORT, HOST, () => {
  console.log(`T3 local bridge listening on http://${HOST}:${PORT}`);
});
