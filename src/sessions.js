// Reads Claude Code Desktop sessions from local disk (read-only).
//
// Desktop keeps one metadata file per session (title, folder, last focus time) under
//   <Claude app data>\claude-code-sessions\<account>\<org>\local_<id>.json
// and the transcript itself is the regular Claude Code log under
//   ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl
//
// <Claude app data> is %APPDATA%\Claude for the regular installer, but the Microsoft Store
// version keeps it in %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude.
// Only processes started by Claude itself see that redirected; everything else (like this
// app) has to look there explicitly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Every claude-code-sessions folder that exists on this machine. */
export function desktopSessionRoots() {
  const roots = [path.join(APPDATA, 'Claude', 'claude-code-sessions')];
  const packages = path.join(LOCALAPPDATA, 'Packages');
  for (const d of listDir(packages)) {
    if (d.isDirectory() && /^Claude_/i.test(d.name)) {
      roots.push(path.join(packages, d.name, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'));
    }
  }
  return roots.filter((r) => fs.existsSync(r));
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** All desktop session metadata files, newest focus first. */
export function listDesktopSessions({ includeArchived = false } = {}) {
  const byId = new Map();
  for (const root of desktopSessionRoots()) {
    for (const s of readSessionRoot(root, includeArchived)) {
      const prev = byId.get(s.id);
      if (!prev || s.lastActivityAt > prev.lastActivityAt || s.lastFocusedAt > prev.lastFocusedAt) byId.set(s.id, s);
    }
  }
  const sessions = [...byId.values()];
  sessions.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.lastActivityAt - a.lastActivityAt);
  return sessions;
}

function readSessionRoot(root, includeArchived) {
  const sessions = [];
  for (const account of listDir(root)) {
    if (!account.isDirectory()) continue;
    const accountDir = path.join(root, account.name);
    for (const org of listDir(accountDir)) {
      if (!org.isDirectory()) continue;
      const orgDir = path.join(accountDir, org.name);
      for (const f of listDir(orgDir)) {
        if (!f.isFile() || !/^local_.*\.json$/.test(f.name)) continue;
        const meta = safeReadJson(path.join(orgDir, f.name));
        if (!meta || !meta.cliSessionId) continue;
        if (meta.isArchived && !includeArchived) continue;
        sessions.push({
          id: meta.sessionId,
          cliSessionId: meta.cliSessionId,
          title: meta.title || '(untitled)',
          cwd: meta.cwd || '',
          project: path.basename(meta.originCwd || meta.cwd || '') || '(no folder)',
          branch: meta.branch || null,
          model: meta.model || null,
          lastFocusedAt: meta.lastFocusedAt || 0,
          lastActivityAt: meta.lastActivityAt || meta.createdAt || 0,
          isArchived: !!meta.isArchived,
        });
      }
    }
  }
  return sessions;
}

/** Locate the .jsonl transcript for a CLI session id. */
export function findTranscript(cliSessionId, cwd) {
  if (cwd) {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const guess = path.join(PROJECTS_DIR, encoded, `${cliSessionId}.jsonl`);
    if (fs.existsSync(guess)) return guess;
  }
  for (const dir of listDir(PROJECTS_DIR)) {
    if (!dir.isDirectory()) continue;
    const p = path.join(PROJECTS_DIR, dir.name, `${cliSessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Resolve a session from a loose spoken query: a title fragment, an id fragment,
 * or nothing (the session currently open in the desktop window).
 */
export function resolveSession(query, { windowTitle } = {}) {
  const all = listDesktopSessions();
  if (!all.length) return null;

  const q = normalize(query);
  if (!q || ['current', 'this', 'this one', 'latest', 'active', 'open'].includes(q)) {
    if (windowTitle) {
      const t = normalize(windowTitle);
      const hit = all.find((s) => normalize(s.title) === t);
      if (hit) return hit;
    }
    return all[0];
  }

  const byId = all.find((s) => s.id.includes(query) || s.cliSessionId.startsWith(query));
  if (byId) return byId;

  const exact = all.find((s) => normalize(s.title) === q);
  if (exact) return exact;

  // Score by how many query words appear in the title / project name.
  const words = q.split(' ').filter((w) => w.length > 1);
  let best = null;
  let bestScore = 0;
  for (const s of all) {
    const hay = `${normalize(s.title)} ${normalize(s.project)}`;
    const score = words.filter((w) => hay.includes(w)).length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

function stripNoise(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, '$1')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, '')
    .replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g, '')
    .trim();
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

/**
 * Turn the tail of a transcript into a compact list of turns that a voice model can summarize.
 * Tool calls are collapsed to one line each; tool output is dropped.
 */
export function readTranscriptTail(file, { lastN = 8, includeTools = false, maxCharsPerMessage = 1500, maxBytes = 4 * 1024 * 1024 } = {}) {
  // Only read the tail: transcripts can get very large.
  const stat = fs.statSync(file);
  const readBytes = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(readBytes);
  fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (readBytes < stat.size) lines.shift(); // first line is probably partial

  const turns = [];
  let lastKind = null;
  let lastAt = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.isSidechain) continue;
    // Claude Code writes this when a turn ends (when Stop hooks are configured).
    if (rec.type === 'system' && rec.subtype === 'stop_hook_summary') {
      lastKind = 'stopped';
      lastAt = rec.timestamp || lastAt;
      continue;
    }
    const msg = rec.message;
    if (!msg) continue;
    if (rec.type === 'user' || rec.type === 'assistant') lastAt = rec.timestamp || lastAt;
    const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];

    if (rec.type === 'user') {
      if (content.some((c) => c.type === 'tool_result')) {
        lastKind = 'tool_result';
        continue;
      }
      const text = stripNoise(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
      if (!text) continue;
      turns.push({ role: 'user', text: clip(text, maxCharsPerMessage), at: rec.timestamp });
      lastKind = 'user';
    } else if (rec.type === 'assistant') {
      for (const c of content) {
        if (c.type === 'text' && c.text.trim()) {
          turns.push({ role: 'claude', text: clip(c.text.trim(), maxCharsPerMessage), at: rec.timestamp });
          lastKind = 'assistant_text';
        } else if (c.type === 'tool_use') {
          if (includeTools) turns.push({ role: 'tool', text: describeToolUse(c), at: rec.timestamp });
          lastKind = 'tool_use';
        }
      }
    }
  }

  // Is Claude still mid-turn? An explicit stop marker or Claude's own text at the end means no;
  // a tool call, tool result or fresh user prompt at the end means it's probably still going.
  const ageMs = lastAt ? Date.now() - Date.parse(lastAt) : Infinity;
  const looksBusy = lastKind && lastKind !== 'assistant_text' && lastKind !== 'stopped';
  const state = looksBusy ? (ageMs < 10 * 60 * 1000 ? 'working' : 'stopped mid-task or waiting') : 'idle (finished its last reply)';

  return { state, turns: turns.slice(-lastN), lastKind, ageMs };
}

function describeToolUse(c) {
  const i = c.input || {};
  const detail = i.description || i.command || i.file_path || i.pattern || i.url || i.query || i.prompt || '';
  return `${c.name}${detail ? `: ${clip(String(detail), 140)}` : ''}`;
}

export function ago(ms) {
  if (!ms) return 'unknown';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
