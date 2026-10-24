// The MCP manager ("Orbit anywhere", phase 9): finds tool servers for what the user wants done,
// connects one only on their yes, pins it, re-checks it every time, and hands helpers just the
// servers (and tools) their task needs.
//
// The autonomy rule:
//   automatic         searching the registry, ranking, reading what a server says about itself,
//                     using an approved server's read-only tools inside a task the user gave,
//                     re-connecting an approved server whose tools haven't changed
//   asks (spoken yes) installing or running a new server, signing in (OAuth), any tool that
//                     writes, sends, deletes, pays or posts (a helper's call to one comes back to
//                     the user through Orbit, each time), any change in a server's tools since it
//                     was approved (then it's not used until the user says yes again)
//
// Local servers run boxed (sandbox.js); remote ones run nothing here and are preferred.
// Tool text is data: never the user's words or consent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createHttpClient, createStdioClient, McpHttpError } from './client.js';
import { inventory, searchRegistry } from './discover.js';
import { isReadOnlyTool, serverId } from './pins.js';
import { boxedCommand } from './sandbox.js';
import { windowText } from '../anywhere/policy.js';

export function createMcpManager({ pins, oauth = null, cacheDir, search = searchRegistry, local = inventory, openHttp = createHttpClient, openStdio = createStdioClient, box = boxedCommand } = {}) {
  const found = new Map(); // candidate id -> registry entry (from the last searches)

  /** A client for a source, signed in if we have a token. */
  function clientFor(source, id) {
    if (source.kind === 'remote') return openHttp({ url: source.url, headers: async () => (oauth ? oauth.headersFor(source.url) : {}) });
    const c = box(source, { id, cacheDir });
    return openStdio({ command: c.command, args: c.args, env: c.env });
  }

  /** Its tools now (signing in first if the server asks and `signIn` is allowed). */
  async function toolsOf(source, id, { signIn = false } = {}) {
    let client = clientFor(source, id);
    try {
      await client.initialize();
      return await client.listTools();
    } catch (e) {
      if (e instanceof McpHttpError && e.status === 401 && signIn && oauth) {
        client.close();
        await oauth.authorize(source.url, e.wwwAuthenticate);
        client = clientFor(source, id);
        await client.initialize();
        return await client.listTools();
      }
      throw e;
    } finally {
      client.close();
    }
  }

  const describe = (e) => ({
    candidate: e.id,
    name: e.title || e.name,
    by: e.vendor,
    official: e.official,
    runs: e.remote ? 'on their servers (nothing installed here)' : `here, boxed (${e.package?.registryType} package)`,
    about: e.description,
    why: e.why,
  });

  const api = {
    /** Search for tools for `need`: ranked candidates (data), what's already connected, what's on this PC. */
    async find(need) {
      const list = await search(need);
      for (const e of list) found.set(e.id, e);
      const q = String(need || '').toLowerCase();
      const pinned = pins.list().filter((p) => q.split(/\W+/).some((w) => w.length >= 3 && `${p.name} ${p.title}`.toLowerCase().includes(w)));
      const here = local().filter((s) => q.split(/\W+/).some((w) => w.length >= 3 && s.name.toLowerCase().includes(w)));
      return { candidates: list.slice(0, 3).map(describe), connected: pinned.map((p) => p.title || p.name), already_on_this_pc: here.length ? here : undefined };
    },
    /** The question Orbit asks before connecting a candidate (what it is, what it can do, where it runs). */
    question(candidateId) {
      const e = found.get(candidateId);
      if (!e) return null;
      const who = e.official ? `the official ${e.title || e.vendor} connector` : `a ${e.title || e.name} connector made by ${e.vendor || 'someone else'} (not ${e.title || 'the product'}'s own)`;
      const where = e.remote ? 'It runs on their servers and you sign in in your browser.' : `It's a ${e.package.registryType} package that would run on this PC, boxed in.`;
      return `There's ${who}. ${where} Want me to connect it? Anything it does that writes, posts or deletes still asks you first.`;
    },
    /**
     * Connect a candidate (the caller has the user's yes): sign in if it's remote and asks, list its
     * tools, pin them. Resolves { ok, id, name, readTools, writeTools } or { ok: false, error }.
     */
    async connect(candidateId) {
      const e = found.get(candidateId);
      if (!e) return { ok: false, error: 'Find it first (find_tool).' };
      const id = serverId(e.vendor && e.title ? `${e.vendor}-${e.title}` : e.name.split('/').pop());
      const source = e.remote ? { kind: 'remote', url: e.remote.url } : { kind: 'package', registryType: e.package.registryType, identifier: e.package.identifier, version: e.package.version || e.version, sha256: e.package.sha256 || null };
      let tools;
      try {
        tools = await toolsOf(source, id, { signIn: true });
      } catch (err) {
        return { ok: false, error: `Couldn't connect: ${windowText(String(err?.message || err), 160)}` };
      }
      const writes = tools.filter((t) => !isReadOnlyTool(t)).map((t) => t.name);
      // The user's yes covered "it can read and write, and every write still asks": write tools are
      // allowed to be asked about (each call comes back to them), never used silently.
      const pin = pins.pin({ id, name: e.name, title: e.title || e.name.split('/').pop(), source, tools, allowWrite: writes, auth: e.remote && oauth?.signedIn(e.remote.url) ? { kind: 'oauth' } : null });
      return { ok: true, id: pin.id, name: pin.title || pin.name, readTools: tools.filter(isReadOnlyTool).length, writeTools: writes.length };
    },
    /** Re-check a pinned server now: { ok } or { ok: false, changed: { added, removed, changed } } (ask again). */
    async check(id) {
      const p = pins.get(id);
      if (!p) return { ok: false, error: 'Not connected.' };
      try {
        const tools = await toolsOf(p.source, id);
        const r = pins.check(id, tools);
        return r.ok ? { ok: true } : { ok: false, changed: r.diff };
      } catch (err) {
        return { ok: false, error: windowText(String(err?.message || err), 160) };
      }
    },
    /** Approve a changed server again (the user said yes to the change): re-pin with today's tools. */
    async reapprove(id) {
      const p = pins.get(id);
      if (!p) return { ok: false, error: 'Not connected.' };
      const tools = await toolsOf(p.source, id);
      pins.pin({ id, name: p.name, title: p.title, source: p.source, tools, allowWrite: tools.filter((t) => !isReadOnlyTool(t)).map((t) => t.name), auth: p.auth });
      return { ok: true };
    },
    disconnect(id) {
      const p = pins.get(id);
      if (!p) return { ok: false, error: 'Not connected.' };
      pins.remove(id);
      if (p.source.kind === 'remote' && oauth) oauth.signOut(p.source.url);
      return { ok: true };
    },
    connected: () => pins.list().map((p) => ({ id: p.id, name: p.title || p.name, runs: p.source.kind === 'remote' ? 'remote' : 'here, boxed', tools: p.tools.length })),
    /**
     * What a helper gets for these servers (only ones whose tools still match their pin):
     * { servers: { id: config }, readTools: [mcp__id__tool], writeTools: [...], skipped: [{ id, why }] }.
     * Read-only tools are allowed outright; write tools go through Orbit's permission prompt.
     */
    async forHelper(ids = []) {
      const out = { servers: {}, readTools: [], writeTools: [], skipped: [] };
      for (const id of [...new Set(ids)].slice(0, 5)) {
        const p = pins.get(id);
        if (!p) {
          out.skipped.push({ id, why: 'not connected' });
          continue;
        }
        const c = await api.check(id);
        if (!c.ok) {
          out.skipped.push({ id, why: c.changed ? 'its tools changed since you approved it' : c.error || 'not reachable' });
          continue;
        }
        if (p.source.kind === 'remote') out.servers[id] = { type: 'http', url: p.source.url, headers: oauth ? await oauth.headersFor(p.source.url) : {} };
        else {
          const b = box(p.source, { id, cacheDir });
          out.servers[id] = { type: 'stdio', command: b.command, args: b.args, env: Object.fromEntries(Object.entries(b.env).filter(([k]) => /^(TEMP|TMP|npm_config_|UV_|ORBIT_MCP_HOME|PATH|Path|SystemRoot|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)/.test(k))) };
        }
        for (const t of p.tools) {
          if (!p.allowed.includes(t.name)) continue;
          (t.readOnly ? out.readTools : out.writeTools).push(`mcp__${id}__${t.name}`);
        }
      }
      return out;
    },
  };
  return api;
}

/** Write a helper's extra MCP config to a file only it reads (deleted with its folder). */
export function writeConfigFile(dir, servers) {
  const file = path.join(dir, `mcp-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return file;
}
