// Finding MCP servers ("Orbit anywhere", phase 9). Automatic and read-only: searching the official
// MCP Registry, ranking what it returns (official first, remote before local code), and listing
// what's already set up on this PC (names and transports only, never a secret). Nothing is
// installed or connected here: that always asks (see manager.js).
//
// What a registry or a server says about itself (names, descriptions) is data, never instructions:
// it's trimmed, stripped of anything that looks like Orbit's own labels, and only ever read out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowText } from '../anywhere/policy.js';

export const REGISTRY = 'https://registry.modelcontextprotocol.io';
const KNOWN_PACKAGES = new Set(['npm', 'pypi', 'oci', 'mcpb', 'nuget']);

const words = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

/** Who publishes it, from its reverse-DNS name: "com.notion/mcp" -> "notion", "io.github.makenotion/x" -> "makenotion". */
export function vendorOf(name) {
  const ns = String(name || '').split('/')[0].toLowerCase();
  const parts = ns.split('.');
  if (parts[0] === 'io' && parts[1] === 'github') return parts[2] || '';
  return parts.length >= 2 ? parts[1] : parts[0];
}

/** One registry entry, checked and trimmed: { id, name, title, description, version, vendor, remote, package, repository, active }. */
export function readEntry(raw) {
  const s = raw?.server && typeof raw.server === 'object' ? raw.server : raw;
  if (!s || typeof s.name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(s.name)) return null;
  const meta = raw?._meta?.['io.modelcontextprotocol.registry/official'] || s?._meta?.['io.modelcontextprotocol.registry/official'] || {};
  const remote = (Array.isArray(s.remotes) ? s.remotes : []).find((r) => r && /^https:\/\//.test(String(r.url || '')) && ['streamable-http', 'sse', 'http'].includes(String(r.type || r.transport_type || '').toLowerCase()));
  const pkg = (Array.isArray(s.packages) ? s.packages : []).find((p) => p && KNOWN_PACKAGES.has(String(p.registryType || p.registry_type || '').toLowerCase()) && typeof p.identifier === 'string');
  return {
    id: s.name,
    name: s.name,
    title: windowText(s.title || '', 80),
    description: windowText(s.description || '', 300),
    version: windowText(s.version || '', 40),
    vendor: vendorOf(s.name),
    remote: remote ? { type: String(remote.type || 'streamable-http').toLowerCase(), url: String(remote.url) } : null,
    package: pkg
      ? {
          registryType: String(pkg.registryType || pkg.registry_type).toLowerCase(),
          identifier: String(pkg.identifier).slice(0, 200),
          version: String(pkg.version || s.version || '').slice(0, 60),
          sha256: typeof pkg.fileSha256 === 'string' && /^[0-9a-f]{64}$/i.test(pkg.fileSha256) ? pkg.fileSha256.toLowerCase() : null,
        }
      : null,
    repository: typeof s.repository?.url === 'string' && /^https:\/\//.test(s.repository.url) ? s.repository.url : null,
    active: meta.status ? meta.status === 'active' : true,
    latest: meta.isLatest !== false,
  };
}

/**
 * Rank candidates for what the user asked: official (published by the product itself, by its name
 * in the registry's verified namespace) first, then remote ones (no code runs here), then ones with
 * a source repository. Each gets a short plain `why`.
 */
export function rank(entries, query) {
  const q = words(query);
  return entries
    .filter((e) => e && e.active && e.latest && (e.remote || e.package))
    .map((e) => {
      const official = q.some((w) => e.vendor.includes(w) || w.includes(e.vendor)) && e.vendor.length >= 3;
      const matches = q.filter((w) => `${e.name} ${e.title} ${e.description}`.toLowerCase().includes(w)).length;
      let score = matches * 2;
      if (official) score += 6;
      if (e.remote) score += 3;
      if (e.repository) score += 1;
      if (e.package?.sha256) score += 1;
      const why = [official ? `published by ${e.vendor} itself` : `published by ${e.vendor || 'someone else'} (not the product's maker)`, e.remote ? 'runs on their servers (nothing installed here)' : `a ${e.package.registryType} package that would run on this PC, sandboxed`];
      return { ...e, official, score, why: why.join('; ') };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Search the official MCP Registry. Resolves ranked candidates (data), or [] on any failure. */
export async function searchRegistry(query, { fetchImpl = globalThis.fetch, limit = 30, timeoutMs = 10_000, base = REGISTRY } = {}) {
  const q = String(query || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/v0.1/servers?search=${encodeURIComponent(q)}&limit=${limit}`, { headers: { accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return [];
    const j = await res.json();
    const list = Array.isArray(j?.servers) ? j.servers : [];
    return rank(list.slice(0, 100).map(readEntry).filter(Boolean), q).slice(0, 5);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- already on this PC

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
/** A server entry as names and transport only (never env values, args, headers or keys). */
const summarize = (name, cfg, where) => {
  if (!cfg || typeof cfg !== 'object') return null;
  const transport = cfg.url || cfg.type === 'http' || cfg.type === 'sse' ? 'http' : 'stdio';
  let runs = '';
  if (transport === 'stdio' && typeof cfg.command === 'string') runs = path.basename(cfg.command).replace(/\.(exe|cmd|bat)$/i, '');
  if (transport === 'http' && typeof cfg.url === 'string') {
    try {
      runs = new URL(cfg.url).hostname;
    } catch {}
  }
  return { name: windowText(name, 60), where, transport, runs: windowText(runs, 60) };
};

/**
 * The MCP servers already set up here, read-only: Claude Code's user config (~/.claude.json and
 * ~/.claude/settings.json) and Claude Desktop's (claude_desktop_config.json). Nothing is started.
 */
export function inventory({ home = os.homedir(), appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming') } = {}) {
  const out = [];
  const add = (servers, where) => {
    for (const [name, cfg] of Object.entries(servers && typeof servers === 'object' ? servers : {}).slice(0, 50)) {
      const s = summarize(name, cfg, where);
      if (s) out.push(s);
    }
  };
  add(readJson(path.join(home, '.claude.json'))?.mcpServers, 'Claude Code');
  add(readJson(path.join(home, '.claude', 'settings.json'))?.mcpServers, 'Claude Code settings');
  add(readJson(path.join(appData, 'Claude', 'claude_desktop_config.json'))?.mcpServers, 'Claude Desktop');
  return out;
}
