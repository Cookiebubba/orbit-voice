// The runner's view of an app's bridge (src/server.js): sign in with the app's per-launch link, then
// HTTP and WebSocket calls with that session, exactly as Orbit's own pages make them.
import { createRequire } from 'node:module';
import path from 'node:path';

export async function signIn(authUrl) {
  const r = await fetch(authUrl, { redirect: 'manual' });
  const set = r.headers.get('set-cookie') || '';
  const cookie = set.split(';')[0];
  if (r.status !== 302 || !cookie) throw new Error(`sign-in failed (HTTP ${r.status})`);
  return cookie;
}

export function bridgeClient(base, cookie, repo) {
  const host = new URL(base).host;
  async function http({ method = 'GET', path: p, body, auth = true, origin, host: hostHeader, headers = {}, raw = false, timeoutMs = 15000 }) {
    const h = { ...headers };
    if (auth && cookie) h.cookie = cookie;
    if (method !== 'GET' && origin === undefined) h.origin = base; // the page's own origin, as a browser sends it
    if (origin) h.origin = origin;
    if (hostHeader) h.host = hostHeader;
    if (body !== undefined) h['content-type'] = 'application/json';
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // Node's fetch won't let us set Host; use the http module when a case overrides it.
      if (hostHeader) return await viaHttpModule(base, method, p, h, body);
      const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: ac.signal });
      const ct = r.headers.get('content-type') || '';
      let out;
      if (raw || !ct.includes('json')) {
        const buf = Buffer.from(await r.arrayBuffer());
        out = ct.includes('json') || ct.startsWith('text/') ? buf.toString('utf8') : { bytes: buf.length };
      } else out = await r.json();
      return { status: r.status, headers: Object.fromEntries(r.headers), body: out };
    } finally {
      clearTimeout(t);
    }
  }

  /** Opens /voice and runs an exchange: send messages, collect until `done(messages)` or the timeout. */
  async function ws({ query = '', send = [], timeoutMs = 8000, done = () => false, origin = base, auth = true }) {
    const require = createRequire(path.join(repo, 'package.json'));
    const WebSocket = require('ws');
    const url = base.replace(/^http/, 'ws') + '/voice' + (query ? `?${query}` : '');
    const headers = {};
    if (auth && cookie) headers.cookie = cookie;
    return new Promise((resolve) => {
      const msgs = [];
      let opened = false;
      const sock = new WebSocket(url, { headers, origin });
      const finish = (why) => {
        clearTimeout(timer);
        try {
          sock.close();
        } catch {}
        resolve({ opened, closed: why, messages: msgs });
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      sock.on('open', () => {
        opened = true;
        for (const m of send) sock.send(JSON.stringify(m));
      });
      sock.on('message', (d) => {
        try {
          msgs.push(JSON.parse(String(d)));
        } catch {}
        if (done(msgs)) finish('done');
      });
      sock.on('unexpected-response', (_req, res) => {
        msgs.push({ type: 'http', status: res.statusCode });
        finish('refused');
      });
      sock.on('close', () => finish('closed'));
      sock.on('error', () => finish('error'));
    });
  }

  return { base, host, cookie, http, ws };
}

async function viaHttpModule(base, method, p, headers, body) {
  const { request } = await import('node:http');
  const u = new URL(base + p);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let b = data;
        try {
          b = JSON.parse(data);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: b });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
