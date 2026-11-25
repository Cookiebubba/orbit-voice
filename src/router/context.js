// Session context harvesting for smart routing and topic-drift detection.
// Normalizes both Claude Desktop sessions and T3 Code threads into a single shape,
// and safely extracts recent touched files and git commit subjects without throwing.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const str = (v) => (typeof v === 'string' ? v : '');
const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
};

function parseTimestamp(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return 0;
}

// OS-independent basename so Windows paths work on POSIX and vice versa.
function portableBasename(p) {
  const s = str(p).trim().replace(/[\\/]+$/, '');
  if (!s) return '';
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

const KNOWN_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'csv', 'sql', 'graphql', 'gql', 'prisma',
  'md', 'mdx', 'txt', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'vue', 'svelte', 'astro',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'dockerfile', 'makefile', 'lock', 'proto', 'tf',
]);

const SPECIAL_FILENAMES = new Set([
  'dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile', 'jenkinsfile',
  'cmakelists.txt', 'package.json', 'tsconfig.json', 'cargo.toml', 'go.mod', 'go.sum', 'pyproject.toml',
]);

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const VERSION_RE = /^v?\d+(?:\.\d+)+$/i;

function normalizeFileCandidate(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > 300) return null;

  // Strip surrounding quotes/backticks/brackets and trailing punctuation.
  s = s.replace(/^['"`(\[{<]+/, '').replace(/['"`)\]}>.,;!?]+$/, '');
  // Strip trailing :line or :line:col suffix (e.g. src/app.js:42:10).
  s = s.replace(/:\d+(?::\d+)?$/, '');
  if (!s || URL_RE.test(s) || VERSION_RE.test(s)) return null;
  if (s.startsWith('-')) return null;

  // Normalize Windows separators to POSIX for consistent matching.
  s = s.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s === '.' || s === '..' || s === '/') return null;

  // Ignore pure glob patterns without a concrete filename/segment.
  if (/[*?]/.test(s)) {
    const cleaned = s
      .split('/')
      .filter((seg) => seg && !/[*?[\]{}]/.test(seg))
      .join('/');
    if (!cleaned) return null;
    s = cleaned;
  }

  const base = portableBasename(s);
  if (!base || base === '.' || base === '..') return null;
  const lowerBase = base.toLowerCase();

  // Accept if it has a known file extension, is a known special filename, or is a multi-segment path with a dotfile/ext.
  const dot = lowerBase.lastIndexOf('.');
  const ext = dot > 0 ? lowerBase.slice(dot + 1) : '';
  if (SPECIAL_FILENAMES.has(lowerBase)) return s;
  if (ext && KNOWN_EXTENSIONS.has(ext)) return s;
  if (lowerBase.startsWith('.env') || lowerBase === '.gitignore' || lowerBase === '.npmrc') return s;
  // Multi-segment explicit path like "src/router/index" (must have a slash and non-trivial segment).
  if (s.includes('/') && !s.endsWith('/') && /^[A-Za-z0-9._-]+$/.test(base) && base.length >= 2) {
    // Avoid matching MIME types or flags like "application/json" or "text/plain" unless concrete extension.
    if (/^(text|application|image|audio|video|font|multipart)\//i.test(s)) return null;
    return s;
  }
  return null;
}

function extractPathsFromCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return [];
  const out = [];
  // Match quoted segments or whitespace-delimited tokens.
  const tokens = cmd.match(/"[^"\n]{1,260}"|'[^'\n]{1,260}'|\S+/g) || [];
  for (const tok of tokens) {
    const cleaned = tok.replace(/^['"]|['"]$/g, '');
    // Handle key=value args like --file=src/foo.js
    const eqIdx = cleaned.indexOf('=');
    const candidate = eqIdx > 0 && cleaned.startsWith('-') ? cleaned.slice(eqIdx + 1) : cleaned;
    const norm = normalizeFileCandidate(candidate);
    if (norm) out.push(norm);
  }
  return out;
}

function extractFilesFromToolInput(input) {
  if (!input || typeof input !== 'object') return [];
  const found = [];
  for (const key of ['file_path', 'path', 'target_file', 'notebook_path', 'pattern']) {
    if (typeof input[key] === 'string') {
      const norm = normalizeFileCandidate(input[key]);
      if (norm) found.push(norm);
    }
  }
  if (typeof input.command === 'string') {
    for (const p of extractPathsFromCommand(input.command)) found.push(p);
  }
  return found;
}

function readTailLines(file, maxBytes) {
  if (typeof file !== 'string' || !file.trim()) return [];
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0) return [];
    const readBytes = Math.min(stat.size, maxBytes);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (readBytes < stat.size) lines.shift(); // drop likely truncated first line
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Safely reads the tail of a `.jsonl` transcript and extracts up to `maxFiles`
 * unique recently touched file paths/basenames from `tool_use` inputs, newest first.
 */
export function extractRecentFiles(transcriptFile, { maxFiles = 8, maxBytes = 512 * 1024 } = {}) {
  const limit = clampInt(maxFiles, 0, 64, 8);
  if (limit <= 0) return [];
  const bytes = clampInt(maxBytes, 1024, 8 * 1024 * 1024, 512 * 1024);
  const lines = readTailLines(transcriptFile, bytes);
  if (!lines.length) return [];

  const seen = new Set();
  const recent = [];

  // Scan backwards so the newest tool_use calls come first.
  for (let i = lines.length - 1; i >= 0 && recent.length < limit; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object' || rec.isSidechain) continue;

    const blocks = [];
    if (rec.type === 'tool_use') {
      blocks.push(rec);
    } else if (rec.message && typeof rec.message === 'object' && Array.isArray(rec.message.content)) {
      for (const c of rec.message.content) {
        if (c && typeof c === 'object' && c.type === 'tool_use') blocks.push(c);
      }
    }

    // Iterate blocks in reverse within the same assistant message for newest-first order.
    for (let j = blocks.length - 1; j >= 0 && recent.length < limit; j--) {
      const files = extractFilesFromToolInput(blocks[j].input);
      for (let k = files.length - 1; k >= 0 && recent.length < limit; k--) {
        const f = files[k];
        const key = f.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        recent.push(f);
      }
    }
  }

  return recent;
}

/**
 * Safely runs `git log -n <limit> --pretty=%s` in `cwd` with a 1500ms timeout and no shell.
 * Returns `[]` on any error.
 */
export function readRecentCommits(cwd, { limit = 2, execImpl = execFileSync } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return [];
  const count = clampInt(limit, 0, 20, 2);
  if (count <= 0) return [];
  if (typeof execImpl !== 'function') return [];

  try {
    const out = execImpl('git', ['log', '-n', String(count), '--pretty=%s'], {
      cwd: cwd.trim(),
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (typeof out !== 'string' || !out.trim()) return [];
    return out
      .split(/\r?\n/)
      .map((line) => line.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, count);
  } catch {
    return [];
  }
}

// Linear tag stripper matching src/sessions.js so transcript noise doesn't pollute context.
const NOISE_TAGS = [
  { open: '<system-reminder>', close: '</system-reminder>', keepInner: false },
  { open: '<pasted_content', close: '</pasted_content', keepInner: true },
  { open: '<command-', close: '</command-', keepInner: false },
  { open: '<local-command-', close: '</local-command-', keepInner: false },
];

function stripTranscriptNoise(text) {
  let t = str(text);
  for (const { open, close, keepInner } of NOISE_TAGS) {
    let out = '';
    let pos = 0;
    for (;;) {
      const start = t.indexOf(open, pos);
      if (start < 0) break;
      const openEnd = open.endsWith('>') ? start + open.length - 1 : t.indexOf('>', start + open.length);
      const end = openEnd < 0 ? -1 : t.indexOf(close, openEnd);
      const closeEnd = end < 0 ? -1 : close.endsWith('>') ? end + close.length - 1 : t.indexOf('>', end + close.length);
      if (closeEnd < 0) break;
      out += t.slice(pos, start) + (keepInner ? t.slice(openEnd + 1, end) : '');
      pos = closeEnd + 1;
    }
    t = out + t.slice(pos);
  }
  return t.trim();
}

function extractMessagesFromTranscript(transcriptFile, { maxMessages = 6, maxChars = 400, maxBytes = 512 * 1024 } = {}) {
  const lines = readTailLines(transcriptFile, maxBytes);
  if (!lines.length) return [];
  const collected = [];

  for (let i = lines.length - 1; i >= 0 && collected.length < maxMessages; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object' || rec.isSidechain) continue;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const msg = rec.message;
    if (!msg || typeof msg !== 'object') continue;

    const parts = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : Array.isArray(msg.content)
        ? msg.content
        : [];
    if (rec.type === 'user' && parts.some((p) => p && p.type === 'tool_result')) continue;

    const text = stripTranscriptNoise(
      parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n'),
    );
    if (!text) continue;
    collected.push(text.slice(0, maxChars));
  }

  return collected.reverse();
}

function normalizeMessages(raw, maxMessages = 6, maxChars = 400) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    let text = '';
    if (typeof item === 'string') {
      text = item;
    } else if (item && typeof item === 'object') {
      if (typeof item.text === 'string') text = item.text;
      else if (typeof item.content === 'string') text = item.content;
      else if (typeof item.body === 'string') text = item.body;
    }
    text = text.trim();
    if (!text) continue;
    out.push(text.slice(0, maxChars));
  }
  return out.slice(-maxMessages);
}

function normalizeStatus(session) {
  const raw = str(session.status || session.state).trim().toLowerCase();
  const explicitWaiting =
    session.waiting === true ||
    session.hasPendingRequest === true ||
    Boolean(session.pendingRequest) ||
    raw === 'waiting' ||
    raw === 'approval_required' ||
    raw === 'needs_input' ||
    raw.includes('waiting');

  if (explicitWaiting) return { status: 'waiting', waiting: true };

  if (
    session.working === true ||
    raw === 'working' ||
    raw === 'running' ||
    raw === 'starting' ||
    raw === 'preparing' ||
    raw === 'queued' ||
    raw === 'in_progress'
  ) {
    return { status: 'working', waiting: false };
  }

  if (
    raw === 'idle' ||
    raw.startsWith('idle') ||
    raw === 'completed' ||
    raw === 'finished' ||
    raw === 'interrupted' ||
    raw === 'cancelled' ||
    raw === 'failed' ||
    raw === 'stopped' ||
    raw === 'rolled_back'
  ) {
    return { status: 'idle', waiting: false };
  }

  return { status: raw ? raw.slice(0, 40) : 'idle', waiting: false };
}

function normalizeProject(session, cwd) {
  if (typeof session.project === 'string' && session.project.trim() && session.project.trim() !== '(no folder)') {
    return session.project.trim().slice(0, 120);
  }
  if (session.project && typeof session.project === 'object') {
    const pName = str(session.project.title || session.project.name).trim();
    if (pName) return pName.slice(0, 120);
  }
  const alt = str(session.projectName || session.projectTitle).trim();
  if (alt) return alt.slice(0, 120);
  const base = portableBasename(str(session.originCwd) || cwd);
  return base ? base.slice(0, 120) : '';
}

function mergeUniqueStrings(arrays, limit) {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim().slice(0, 300);
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Normalizes a Claude Desktop session OR T3 Code thread into a unified routing context.
 */
export function harvestSessionContext(session, { includeGit = false, transcriptFile = null, execImpl } = {}) {
  const s = session && typeof session === 'object' ? session : {};

  const id = str(s.id || s.threadId || s.sessionId || s.cliSessionId).trim().slice(0, 160);
  const title = str(s.title || s.name).trim().slice(0, 300) || '(untitled)';
  const cwd = str(
    s.cwd ||
      s.worktreePath ||
      s.workspacePath ||
      s.workspaceRoot ||
      s.projectRoot ||
      (s.project && typeof s.project === 'object' ? s.project.workspaceRoot : ''),
  )
    .trim()
    .slice(0, 500);
  const project = normalizeProject(s, cwd);
  const branch = str(s.branch || s.gitBranch || s.worktreeBranch).trim().slice(0, 160) || null;
  const { status, waiting } = normalizeStatus(s);

  const lastFocusedAt = parseTimestamp(s.lastFocusedAt ?? s.focusedAt);
  const lastActivityAt =
    parseTimestamp(s.lastActivityAt ?? s.updatedAt ?? s.lastUpdatedAt) ||
    lastFocusedAt ||
    parseTimestamp(s.createdAt);

  const tf = typeof transcriptFile === 'string' && transcriptFile.trim()
    ? transcriptFile
    : typeof s.transcriptFile === 'string' && s.transcriptFile.trim()
      ? s.transcriptFile
      : null;

  const transcriptFiles = tf ? extractRecentFiles(tf) : [];
  const providedFiles = Array.isArray(s.recentFiles) ? s.recentFiles : Array.isArray(s.files) ? s.files : [];
  const recentFiles = mergeUniqueStrings([transcriptFiles, providedFiles], 12);

  let lastMessages = normalizeMessages(s.lastMessages ?? s.messages ?? s.turns);
  if (!lastMessages.length && tf) {
    lastMessages = extractMessagesFromTranscript(tf);
  }

  let recentCommits = [];
  if (Array.isArray(s.recentCommits) && s.recentCommits.length) {
    recentCommits = s.recentCommits
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => c.trim().slice(0, 200))
      .slice(0, 10);
  } else if (Array.isArray(s.commits) && s.commits.length) {
    recentCommits = s.commits
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => c.trim().slice(0, 200))
      .slice(0, 10);
  } else if (includeGit && cwd) {
    recentCommits = readRecentCommits(cwd, { execImpl });
  }

  return {
    id,
    title,
    project,
    cwd,
    branch,
    status,
    waiting,
    lastActivityAt,
    lastFocusedAt,
    recentFiles,
    lastMessages,
    recentCommits,
  };
}
