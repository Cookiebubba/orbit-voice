// Approved MCP servers ("Orbit anywhere", phase 9: the MCP manager). A pin is what the user said
// yes to: a server's exact source (a remote URL, or a package at an exact version and hash), and a
// fingerprint of every tool's name, description and input schema at that moment. On every later
// start Orbit lists the tools again and compares: any change (a new tool, a reworded description,
// a changed schema, a new version) means "ask again", never silent use. This is the defence
// against tool poisoning, shadowing and rug pulls (definitions that change after approval).
//
// Which tools a pin allows: read-only ones (by the server's own annotations, else by name) are
// usable inside a task the user gave; tools that write, send, delete, pay or post are allowed only
// one by one, each on the user's yes.
//
// Stored in <settings folder>/mcp/pins.json (no secrets: OAuth tokens live in the encrypted store,
// see oauth.js).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Canonical JSON (sorted keys), so the same definition always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** One tool's fingerprint: its name, description, input schema and annotations. */
export const toolPrint = (t) => crypto.createHash('sha256').update(canonical({ n: t?.name ?? '', d: t?.description ?? '', s: t?.inputSchema ?? null, a: t?.annotations ?? null })).digest('hex');

/** The whole tool list's fingerprint (order doesn't matter), and each tool's. */
export function fingerprint(tools = []) {
  const each = Object.fromEntries((Array.isArray(tools) ? tools : []).map((t) => [String(t?.name ?? ''), toolPrint(t)]));
  const all = crypto.createHash('sha256').update(canonical(each)).digest('hex');
  return { all, each };
}

/** What changed between a pin's fingerprint and now: { added, removed, changed } tool names. */
export function diffPrints(before, now) {
  const a = before?.each || {};
  const b = now?.each || {};
  return {
    added: Object.keys(b).filter((k) => !(k in a)),
    removed: Object.keys(a).filter((k) => !(k in b)),
    changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]),
  };
}

const READ_NAME = /^(get|list|search|find|read|fetch|query|describe|show|lookup|view|count|check|status|info|whoami|ping)(_|-|[A-Z]|$)/i;
/** Is this tool read-only? The server's own annotation first (readOnlyHint), else its name. */
export function isReadOnlyTool(t) {
  const a = t?.annotations;
  if (a && typeof a.readOnlyHint === 'boolean') return a.readOnlyHint && a.destructiveHint !== true;
  return READ_NAME.test(String(t?.name || ''));
}

/** A server id safe for file names and Claude Code's mcp__<id>__<tool> names. */
export const serverId = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'server';

export function createPinStore({ dir }) {
  const file = path.join(dir, 'pins.json');
  const load = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j && typeof j === 'object' && j.version === 1 && j.pins && typeof j.pins === 'object' ? j.pins : {};
    } catch {
      return {};
    }
  };
  const save = (pins) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, pins }, null, 1));
    fs.renameSync(tmp, file);
  };
  return {
    list: () => Object.values(load()),
    get: (id) => load()[id] || null,
    /**
     * Pin (or re-pin) a server the user approved: `source` ({ kind: 'remote', url } |
     * { kind: 'package', registryType, identifier, version, sha256? }), `tools` (its tool list now).
     * Read-only tools are allowed; others only if named in `allowWrite`.
     */
    pin({ id, name, title = '', source, tools, allowWrite = [], auth = null, now = Date.now() }) {
      const pins = load();
      const sid = serverId(id || name);
      const print = fingerprint(tools);
      const readOnly = tools.filter(isReadOnlyTool).map((t) => t.name);
      pins[sid] = {
        id: sid,
        name: String(name || sid).slice(0, 120),
        title: String(title || '').slice(0, 120),
        source,
        auth, // e.g. { kind: 'oauth', issuer } (the tokens are in the encrypted store)
        print,
        tools: tools.map((t) => ({ name: t.name, readOnly: isReadOnlyTool(t) })),
        allowed: [...new Set([...readOnly, ...allowWrite.filter((w) => tools.some((t) => t.name === w))])],
        approvedAt: now,
      };
      save(pins);
      return pins[sid];
    },
    /** Allow one more (write) tool on the user's yes. */
    allow(id, tool) {
      const pins = load();
      const p = pins[id];
      if (!p || !p.tools.some((t) => t.name === tool)) return false;
      if (!p.allowed.includes(tool)) p.allowed.push(tool);
      save(pins);
      return true;
    },
    remove(id) {
      const pins = load();
      delete pins[id];
      save(pins);
    },
    /** Check a pin against the tools listed now: { ok } or { ok: false, diff } (ask again). */
    check(id, tools) {
      const p = load()[id];
      if (!p) return { ok: false, unknown: true };
      const now = fingerprint(tools);
      if (now.all === p.print.all) return { ok: true };
      return { ok: false, diff: diffPrints(p.print, now) };
    },
  };
}
