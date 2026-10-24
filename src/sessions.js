// Reads Claude Code Desktop sessions from local disk (read-only).
//
// Desktop keeps one metadata file per session (title, folder, last focus time) under
//   <Claude app data>\claude-code-sessions\<account>\<org>\local_<id>.json
// and the transcript itself is the regular Claude Code log under
//   ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl
//
// <Claude app data> is %APPDATA%\Claude for the regular installer on Windows, but the Microsoft
// Store version keeps it in %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude (only
// processes started by Claude itself see that redirected; everything else, like this app, has to
// look there explicitly). On macOS it is ~/Library/Application Support/Claude. See src/platform/system.js.

import fs from 'node:fs';
import path from 'node:path';
import { projectsDir, sessionRootCandidates } from './platform/system.js';

const PROJECTS_DIR = projectsDir();

/**
 * Every claude-code-sessions folder that exists on this machine. `opts` ({ platform, env,
 * homedir }) is for tests; it defaults to this machine.
 */
export function desktopSessionRoots(opts) {
  return sessionRootCandidates(opts).filter((r) => fs.existsSync(r));
}

const CLI_ID = /^[A-Za-z0-9_-]{1,100}$/;
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (Number.isFinite(v) ? v : 0);

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
        // A damaged or unexpected file is skipped, never trusted: the CLI id becomes part of a
        // file path (findTranscript), so it must be a plain id.
        if (!meta || typeof meta !== 'object' || typeof meta.cliSessionId !== 'string' || !CLI_ID.test(meta.cliSessionId)) continue;
        if (meta.isArchived && !includeArchived) continue;
        const cwd = str(meta.cwd);
        sessions.push({
          id: str(meta.sessionId) || f.name.replace(/\.json$/, ''),
          cliSessionId: meta.cliSessionId,
          title: str(meta.title).slice(0, 300) || '(untitled)',
          cwd,
          project: path.basename(str(meta.originCwd) || cwd) || '(no folder)',
          branch: str(meta.branch) || null,
          model: str(meta.model) || null,
          // 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' ...: bypass never asks permission.
          permissionMode: str(meta.permissionMode) || null,
          lastFocusedAt: num(meta.lastFocusedAt),
          lastActivityAt: num(meta.lastActivityAt) || num(meta.createdAt),
          createdAt: num(meta.createdAt),
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
 * The session whose title is exactly this window title (ignoring case and punctuation), or null.
 * Titles can repeat: the most recently focused one wins, among those `accept` allows.
 */
export function findSessionByTitle(title, accept = () => true) {
  const t = normalize(title);
  return t ? listDesktopSessions().find((s) => normalize(s.title) === t && accept(s)) || null : null;
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

// Wrapper tags Claude Code puts around text that isn't the user's own words. A linear scan, not
// lazy regexes: those take quadratic time on text full of unclosed tags, and transcripts can hold
// anything the user pasted.
const NOISE = [
  { open: '<system-reminder>', close: '</system-reminder>', keepInner: false },
  { open: '<pasted_content', close: '</pasted_content', keepInner: true },
  { open: '<command-', close: '</command-', keepInner: false },
  { open: '<local-command-', close: '</local-command-', keepInner: false },
];

function cutBlocks(text, { open, close, keepInner }) {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = text.indexOf(open, pos);
    if (start < 0) break;
    // Where the opening tag ends: right away for a complete tag, else at its next '>'.
    const openEnd = open.endsWith('>') ? start + open.length - 1 : text.indexOf('>', start + open.length);
    const end = openEnd < 0 ? -1 : text.indexOf(close, openEnd);
    const closeEnd = end < 0 ? -1 : close.endsWith('>') ? end + close.length - 1 : text.indexOf('>', end + close.length);
    if (closeEnd < 0) break; // unclosed: no later block can close either, keep the rest as is
    out += text.slice(pos, start) + (keepInner ? text.slice(openEnd + 1, end) : '');
    pos = closeEnd + 1;
  }
  return out + text.slice(pos);
}

function stripNoise(text) {
  let t = String(text);
  for (const tag of NOISE) t = cutBlocks(t, tag);
  return t.trim();
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
  let lastTool = null; // { name, id, at } of the latest tool call
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object' || rec.isSidechain) continue;
    // Claude Code writes this when a turn ends (when Stop hooks are configured).
    if (rec.type === 'system' && rec.subtype === 'stop_hook_summary') {
      lastKind = 'stopped';
      lastAt = rec.timestamp || lastAt;
      continue;
    }
    const msg = rec.message;
    if (!msg || typeof msg !== 'object') continue;
    if (rec.type === 'user' || rec.type === 'assistant') lastAt = (typeof rec.timestamp === 'string' && rec.timestamp) || lastAt;
    // Only well-formed parts: text parts with string text, tool parts as objects.
    const content = (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : []).filter(
      (c) => c && typeof c === 'object' && (c.type !== 'text' || typeof c.text === 'string'),
    );

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
          lastTool = { name: String(c.name ?? '').slice(0, 120), id: typeof c.id === 'string' ? c.id.slice(0, 100) : '', at: typeof rec.timestamp === 'string' ? rec.timestamp : null };
        }
      }
    }
  }

  // Is Claude still mid-turn? An explicit stop marker or Claude's own text at the end means no;
  // a tool call, tool result or fresh user prompt at the end means it's probably still going.
  const ageMs = lastAt ? Date.now() - Date.parse(lastAt) : Infinity;
  const looksBusy = lastKind && lastKind !== 'assistant_text' && lastKind !== 'stopped';
  const state = looksBusy ? (ageMs < 10 * 60 * 1000 ? 'working' : 'stopped mid-task or waiting') : 'idle (finished its last reply)';

  // lastTool: only while that call is the last thing (Claude may be waiting on the user for it).
  return { state, turns: turns.slice(-lastN), lastKind, ageMs, lastTool: lastKind === 'tool_use' ? lastTool : null };
}

function describeToolUse(c) {
  const i = c.input && typeof c.input === 'object' ? c.input : {};
  const detail = i.description || i.command || i.file_path || i.pattern || i.url || i.query || i.prompt || '';
  return `${String(c.name ?? 'tool').slice(0, 120)}${detail ? `: ${clip(String(detail), 140)}` : ''}`;
}

export function ago(ms) {
  if (!ms) return 'unknown';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
