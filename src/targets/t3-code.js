// T3 Code Lead target backend: speaks directly to T3 Code's MCP tools either through an injected
// `callTool(name, args)` function or over HTTP JSON (`POST <endpoint>/mcp/call` with Bearer auth).
//
// Security:
//   - HTTP endpoints are restricted to loopback hosts (127.0.0.1, localhost, ::1) unless
//     `allowRemote: true` is explicitly passed.
//   - Bearer tokens, user prompts, and session text are never written to Orbit's logs.
//   - Every HTTP request carries an AbortController timeout (default 15 s).

import path from 'node:path';
import { logWarn } from '../log.js';
import { assertTargetBackend, normalizeSession } from './interface.js';

const BACKEND_ID = 't3-code';
const MAX_PROMPT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 20;
const MAX_RECENT_IDS = 30;
const SEND_MODES = new Set(['auto', 'queue', 'steer', 'restart']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const clampInt = (v, def, max, min = 1) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : def;
};

const normText = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const T3_CODE_CAPABILITIES = Object.freeze({
  multiThread: true,
  nativeQueue: true,
  steer: true,
  worktrees: true,
  draftInBox: false,
});

/**
 * Validate and normalize a T3 Code HTTP endpoint URL.
 * Rejects non-http(s) protocols and non-loopback hosts unless `allowRemote` is true.
 */
function parseEndpoint(rawEndpoint, allowRemote) {
  const trimmed = String(rawEndpoint || '').trim();
  if (!trimmed) return { ok: false, error: 'not_configured', message: 'No T3 endpoint configured.' };
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'invalid_endpoint', message: 'Invalid T3 endpoint URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'invalid_endpoint', message: 'T3 endpoint must use http or https.' };
  }
  const host = url.hostname.toLowerCase();
  if (!allowRemote && !LOOPBACK_HOSTS.has(host)) {
    return {
      ok: false,
      error: 'remote_endpoint_disallowed',
      message: 'T3 endpoint must be loopback unless allowRemote is true.',
    };
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  const callPath = basePath.endsWith('/mcp/call') ? basePath : `${basePath}/mcp/call`;
  url.pathname = callPath;
  url.search = '';
  url.hash = '';
  return { ok: true, callUrl: url.toString() };
}

/** Unwrap common T3 / MCP JSON response shapes into a plain payload object. */
function unwrapToolPayload(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object') return { value: raw };
  if (raw.result !== undefined && raw.result !== null && typeof raw.result === 'object') {
    return unwrapToolPayload(raw.result);
  }
  if (Array.isArray(raw.content)) {
    const textPart = raw.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    if (textPart) {
      try {
        const parsed = JSON.parse(textPart.text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
      return { text: textPart.text };
    }
  }
  return raw;
}

function normalizeProject(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const id = String(p.projectId ?? p.id ?? '').trim().slice(0, 200);
  const workspaceRoot = String(p.workspaceRoot ?? p.cwd ?? p.path ?? '').trim().slice(0, 1000);
  const title = String(p.title ?? p.name ?? (workspaceRoot ? path.basename(workspaceRoot.replace(/[\\/]+$/, '')) : '')).trim().slice(0, 200);
  return {
    id,
    name: title,
    title,
    workspaceRoot,
    cwd: workspaceRoot,
  };
}

function normalizePendingRequest(raw, fallbackThreadId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.requestId ?? raw.id ?? raw.key ?? '').trim().slice(0, 200);
  if (!id) return null;
  const rawChoices = Array.isArray(raw.choices)
    ? raw.choices
    : Array.isArray(raw.options)
      ? raw.options
      : Array.isArray(raw.questions?.[0]?.options)
        ? raw.questions[0].options
        : [];
  const choices = rawChoices.slice(0, 20).map((c, idx) => {
    if (typeof c === 'string') return { n: idx + 1, label: c.slice(0, 200), description: '' };
    return {
      n: Number.isInteger(c?.n) ? c.n : idx + 1,
      id: typeof c?.id === 'string' ? c.id.slice(0, 100) : undefined,
      label: String(c?.label ?? c?.text ?? c?.value ?? '').slice(0, 200),
      description: String(c?.description ?? '').slice(0, 300),
      selected: Boolean(c?.selected),
    };
  });
  const question = String(raw.question ?? raw.questions?.[0]?.question ?? raw.title ?? '').trim().slice(0, 1000);
  return {
    id,
    key: id,
    requestId: id,
    kind: String(raw.kind || 'question').trim().toLowerCase().slice(0, 40),
    question,
    title: String(raw.title ?? question).trim().slice(0, 300),
    detail: String(raw.detail ?? '').trim().slice(0, 1000),
    choices,
    options: choices,
    questions: Array.isArray(raw.questions) ? raw.questions : undefined,
    multiSelect: Boolean(raw.multiSelect ?? raw.questions?.[0]?.is_multi_select),
    canSkip: Boolean(raw.canSkip),
    threadId: String(raw.threadId ?? fallbackThreadId ?? '').trim() || null,
  };
}

function normalizeMessages(res, maxCharsPerMessage) {
  const list = Array.isArray(res?.messages)
    ? res.messages
    : Array.isArray(res?.items)
      ? res.items
      : [];
  return list
    .filter((m) => m && typeof m === 'object')
    .map((m) => {
      const role = String(m.role ?? m.from ?? m.author ?? m.type ?? 'assistant').toLowerCase();
      const rawText = typeof m.text === 'string'
        ? m.text
        : typeof m.content === 'string'
          ? m.content
          : typeof m.summary === 'string'
            ? m.summary
            : '';
      const text = rawText.length > maxCharsPerMessage
        ? `${rawText.slice(0, maxCharsPerMessage)}… [${rawText.length - maxCharsPerMessage} more chars]`
        : rawText;
      return {
        id: typeof m.id === 'string' ? m.id.slice(0, 100) : undefined,
        role,
        from: role === 'assistant' ? 'claude' : role,
        text,
        at: m.at ?? m.createdAt ?? m.timestamp ?? null,
      };
    });
}

function matchBestByQuery(items, query, getFields) {
  const raw = String(query || '').trim();
  const q = normText(raw);
  if (!raw || !q) return null;

  const exactId = items.find((item) => item.id === raw || item.id.toLowerCase() === raw.toLowerCase());
  if (exactId) return exactId;

  const exactName = items.find((item) => getFields(item).some((f) => normText(f) === q));
  if (exactName) return exactName;

  const words = q.split(' ').filter((w) => w.length > 1);
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const hay = getFields(item).map(normText).join(' ');
    if (hay.includes(q)) {
      const score = words.length + 2;
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
      continue;
    }
    const score = words.filter((w) => hay.includes(w)).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Create the T3 Code Lead target backend.
 */
export function createT3Target({
  endpoint = '',
  token = '',
  callTool = null,
  fetchImpl = fetch,
  pollMs = DEFAULT_POLL_MS,
  allowRemote = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const defaultPollMs = clampInt(pollMs, DEFAULT_POLL_MS, 60_000, MIN_POLL_MS);
  const httpTimeoutMs = clampInt(timeoutMs, DEFAULT_TIMEOUT_MS, 60_000, 500);
  const hasDirect = typeof callTool === 'function';
  const parsedEndpoint = hasDirect ? null : parseEndpoint(endpoint, Boolean(allowRemote));

  let activeThreadId = null;
  let lastSpokenThreadId = null;
  let lastSpokenAt = 0;
  const recentInteractedIds = []; // MRU: index 0 is most recent
  const sessionCache = new Map(); // threadId -> NormalizedSession
  const drafts = new Map(); // threadId | '__default__' -> { text, threadId, at }

  function touchRecent(threadId) {
    const id = String(threadId || '').trim().slice(0, 200);
    if (!id) return;
    const idx = recentInteractedIds.indexOf(id);
    if (idx >= 0) recentInteractedIds.splice(idx, 1);
    recentInteractedIds.unshift(id);
    if (recentInteractedIds.length > MAX_RECENT_IDS) recentInteractedIds.length = MAX_RECENT_IDS;
  }

  function rememberSession(raw) {
    const s = normalizeSession(raw, { backend: BACKEND_ID });
    if (s.id) sessionCache.set(s.id, s);
    return s;
  }

  async function invoke(name, args = {}) {
    const cleanArgs = args && typeof args === 'object' ? args : {};
    if (hasDirect) {
      try {
        const res = await callTool(name, cleanArgs);
        if (res && typeof res === 'object' && res.ok === false) {
          return {
            ok: false,
            error: String(res.error || 'tool_error').slice(0, 120),
            message: typeof res.message === 'string' ? res.message.slice(0, 300) : undefined,
          };
        }
        return { ok: true, data: unwrapToolPayload(res) };
      } catch (e) {
        logWarn('t3-target', `Direct tool call failed (${name})`);
        return { ok: false, error: 'tool_exception', message: String(e?.message || e).slice(0, 200) };
      }
    }

    if (!parsedEndpoint || !parsedEndpoint.ok) {
      return {
        ok: false,
        error: parsedEndpoint?.error || 'not_configured',
        message: parsedEndpoint?.message || 'T3 backend requires callTool or a valid endpoint.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
    timer.unref?.();
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    const authToken = String(token || '').trim();
    if (authToken) headers.authorization = `Bearer ${authToken}`;

    try {
      const res = await fetchImpl(parsedEndpoint.callUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, arguments: cleanArgs }),
        signal: controller.signal,
      });

      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (res.status === 401 || res.status === 403) {
        logWarn('t3-target', `HTTP ${res.status} on ${name}`);
        return { ok: false, error: 'unauthorized', status: res.status, message: 'T3 endpoint rejected authorization.' };
      }
      if (!res.ok) {
        logWarn('t3-target', `HTTP ${res.status} on ${name}`);
        return {
          ok: false,
          error: typeof body?.error === 'string' ? body.error.slice(0, 120) : 'http_error',
          status: res.status,
          message: typeof body?.message === 'string' ? body.message.slice(0, 200) : `T3 HTTP ${res.status}`,
        };
      }
      if (body && typeof body === 'object' && body.ok === false) {
        return {
          ok: false,
          error: String(body.error || 'tool_error').slice(0, 120),
          message: typeof body.message === 'string' ? body.message.slice(0, 200) : undefined,
        };
      }
      return { ok: true, data: unwrapToolPayload(body) };
    } catch (e) {
      const timedOut = e?.name === 'AbortError';
      logWarn('t3-target', timedOut ? `Timeout on ${name}` : `Request failed on ${name}`);
      return {
        ok: false,
        error: timedOut ? 'timeout' : 'network_error',
        message: timedOut ? `T3 request timed out after ${httpTimeoutMs}ms.` : String(e?.message || e).slice(0, 200),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function extractQuery(idOrQuery) {
    if (typeof idOrQuery === 'string') return idOrQuery.trim().slice(0, 300);
    if (idOrQuery && typeof idOrQuery === 'object') {
      return String(idOrQuery.threadId ?? idOrQuery.id ?? idOrQuery.title ?? idOrQuery.session ?? idOrQuery.query ?? '')
        .trim()
        .slice(0, 300);
    }
    return '';
  }

  async function resolveThread(idOrQuery) {
    const query = extractQuery(idOrQuery);
    if (!query) {
      if (activeThreadId) {
        const listed = await backend.listSessions({ limit: 50 });
        if (listed.ok) {
          const hit = listed.sessions.find((s) => s.id === activeThreadId);
          if (hit) return { ok: true, session: hit };
        }
        const cached = sessionCache.get(activeThreadId);
        if (cached) return { ok: true, session: cached };
        return { ok: true, session: normalizeSession({ id: activeThreadId }, { backend: BACKEND_ID }) };
      }
      const listed = await backend.listSessions({ limit: 10 });
      if (!listed.ok) return listed;
      if (!listed.sessions.length) return { ok: false, error: 'session_not_found' };
      return { ok: true, session: listed.sessions[0] };
    }

    const listed = await backend.listSessions({ limit: 50 });
    if (listed.ok) {
      const hit = matchBestByQuery(listed.sessions, query, (s) => [s.title, s.project, s.branch || '']);
      if (hit) return { ok: true, session: hit };
    }

    const searched = await backend.searchSessions(query, { limit: 5 });
    if (searched.ok && searched.sessions.length) {
      const hit = matchBestByQuery(searched.sessions, query, (s) => [s.title, s.project, s.branch || '']) || searched.sessions[0];
      if (hit) return { ok: true, session: hit };
    }

    if (sessionCache.has(query)) {
      return { ok: true, session: sessionCache.get(query) };
    }
    return { ok: false, error: 'session_not_found' };
  }

  const backend = {
    id: BACKEND_ID,
    label: 'T3 Code',
    capabilities: T3_CODE_CAPABILITIES,

    get activeThreadId() {
      return activeThreadId;
    },
    get lastSpokenThreadId() {
      return lastSpokenThreadId;
    },
    get lastSpokenAt() {
      return lastSpokenAt;
    },
    get recentInteractedIds() {
      return [...recentInteractedIds];
    },

    noteSpoken(threadId) {
      const id = String(threadId || '').trim().slice(0, 200);
      if (!id) return null;
      lastSpokenThreadId = id;
      lastSpokenAt = Number(now()) || Date.now();
      touchRecent(id);
      return { threadId: id, at: lastSpokenAt };
    },

    async listSessions({ limit = 20, projectId = null, statuses = null, allProjects = true, includeSubagents = false } = {}) {
      const args = {
        limit: clampInt(limit, 20, 100),
        allProjects: Boolean(allProjects),
        includeSubagents: Boolean(includeSubagents),
      };
      if (projectId) args.projectId = String(projectId).trim().slice(0, 200);
      if (Array.isArray(statuses) && statuses.length) args.statuses = statuses.slice(0, 20);

      const res = await invoke('t3_thread_list', args);
      if (!res.ok) return { ...res, sessions: [] };
      const rawThreads = Array.isArray(res.data.threads)
        ? res.data.threads
        : Array.isArray(res.data.items)
          ? res.data.items
          : [];
      const sessions = rawThreads.map(rememberSession);
      return { ok: true, sessions, nextCursor: res.data.nextCursor ?? null };
    },

    async searchSessions(query, { limit = 10, projectId = null } = {}) {
      const clean = String(query || '').trim().slice(0, 200);
      const max = clampInt(limit, 10, 50);
      if (!clean) return backend.listSessions({ limit: max, projectId });

      const args = { query: clean, limit: max };
      if (projectId) args.projectId = String(projectId).trim().slice(0, 200);
      const res = await invoke('t3_thread_search', args);
      if (!res.ok) return { ...res, sessions: [] };
      const rawThreads = Array.isArray(res.data.threads)
        ? res.data.threads
        : Array.isArray(res.data.results)
          ? res.data.results
          : [];
      const sessions = rawThreads.map(rememberSession);
      return { ok: true, sessions };
    },

    async getActiveSession() {
      const listed = await backend.listSessions({ limit: 50 });
      if (!listed.ok) return { ...listed, session: null, activeThreadId };

      if (activeThreadId) {
        const hit = listed.sessions.find((s) => s.id === activeThreadId);
        if (hit) return { ok: true, session: hit, activeThreadId };
        const readRes = await invoke('t3_thread_read', { threadId: activeThreadId, view: 'messages', limit: 1 });
        if (readRes.ok) {
          const session = rememberSession({ ...readRes.data, id: readRes.data.threadId || activeThreadId });
          return { ok: true, session, activeThreadId };
        }
      }

      const top = listed.sessions[0] || null;
      return { ok: true, session: top, activeThreadId: top?.id || activeThreadId };
    },

    async readSession(idOrQuery = '', { lastN = 8, includeTools = false, maxCharsPerMessage = 1500 } = {}) {
      const resolved = await resolveThread(idOrQuery);
      if (!resolved.ok) return resolved;
      const threadId = resolved.session.id;
      const maxChars = clampInt(maxCharsPerMessage, 1500, 20_000);
      const res = await invoke('t3_thread_read', {
        threadId,
        view: includeTools ? 'activity' : 'messages',
        limit: clampInt(lastN, 8, 100),
        maxCharsPerItem: maxChars,
      });
      if (!res.ok) return res;

      const merged = rememberSession({
        ...resolved.session,
        ...res.data,
        id: res.data.threadId || threadId,
      });
      touchRecent(threadId);
      const messages = normalizeMessages(res.data, maxChars);
      return {
        ok: true,
        session: merged,
        state: merged.working ? 'working' : merged.waiting ? 'waiting' : merged.status,
        messages,
        link: typeof res.data.link === 'string' ? res.data.link : null,
      };
    },

    async switchSession(idOrQuery) {
      const query = extractQuery(idOrQuery);
      if (!query) return { ok: false, error: 'empty_query' };
      const resolved = await resolveThread(query);
      if (!resolved.ok) return resolved;

      activeThreadId = resolved.session.id;
      touchRecent(activeThreadId);
      return {
        ok: true,
        session: resolved.session,
        threadId: activeThreadId,
        sessionTitle: resolved.session.title,
      };
    },

    async newSession({
      title = '',
      message = '',
      prompt = '',
      project = '',
      projectId = '',
      worktree = false,
      branch = '',
      baseRef = '',
      startFromOrigin,
      worktreePath = '',
      scratch = false,
      interactionMode,
      runtimeMode,
      modelSelection,
    } = {}) {
      let resolvedProjectId = String(projectId || '').trim().slice(0, 200);
      const projectQuery = String(project || '').trim().slice(0, 200);

      if (!resolvedProjectId && projectQuery && !scratch) {
        const projList = await backend.listProjects();
        if (!projList.ok) return projList;
        const hit = matchBestByQuery(projList.projects, projectQuery, (p) => [
          p.name,
          p.title,
          p.workspaceRoot,
          p.workspaceRoot ? path.basename(p.workspaceRoot.replace(/[\\/]+$/, '')) : '',
        ]);
        if (!hit) {
          return { ok: false, error: 'project_not_found', projects: projList.projects };
        }
        resolvedProjectId = hit.id;
      }

      const cleanTitle = String(title || '').trim().slice(0, 200) || 'New thread';
      const cleanMessage = String(message || prompt || '').trim();
      if (cleanMessage.length > MAX_PROMPT_CHARS) {
        return { ok: false, error: 'too_long', message: `Prompt is over ${MAX_PROMPT_CHARS} characters.` };
      }

      const args = { title: cleanTitle };
      if (cleanMessage) args.message = cleanMessage;
      if (resolvedProjectId) args.projectId = resolvedProjectId;
      else if (scratch) args.scratch = true;

      const cleanWorktreePath = String(worktreePath || '').trim().slice(0, 1000);
      const cleanBranch = String(branch || '').trim().slice(0, 200);
      const cleanBaseRef = String(baseRef || '').trim().slice(0, 200);

      if (!args.scratch) {
        if (cleanWorktreePath) {
          args.workspaceStrategy = { type: 'existing_worktree', worktreePath: cleanWorktreePath };
        } else if (worktree || cleanBranch || cleanBaseRef) {
          const strategy = { type: 'worktree' };
          if (cleanBranch) strategy.branch = cleanBranch;
          if (cleanBaseRef) strategy.baseRef = cleanBaseRef;
          if (typeof startFromOrigin === 'boolean') strategy.startFromOrigin = startFromOrigin;
          else if (cleanBaseRef && cleanBaseRef.includes('/')) strategy.startFromOrigin = true;
          args.workspaceStrategy = strategy;
        } else if (resolvedProjectId) {
          args.workspaceStrategy = { type: 'root' };
        }
      }

      if (interactionMode) args.interactionMode = interactionMode;
      if (runtimeMode) args.runtimeMode = runtimeMode;
      if (modelSelection && typeof modelSelection === 'object') args.modelSelection = modelSelection;

      const res = await invoke('t3_thread_launch', args);
      if (!res.ok) return res;

      const session = rememberSession({
        ...res.data,
        id: res.data.threadId || res.data.id || '',
        title: res.data.title || cleanTitle,
        branch: res.data.branch || cleanBranch || null,
        project: res.data.projectName || res.data.project || projectQuery || '',
      });

      if (session.id) {
        activeThreadId = session.id;
        touchRecent(session.id);
      }

      return {
        ok: true,
        session,
        threadId: session.id,
        title: session.title,
        projectId: resolvedProjectId || res.data.projectId || null,
        branch: session.branch,
        worktreePath: res.data.worktreePath || session.cwd || null,
        link: typeof res.data.link === 'string' ? res.data.link : null,
      };
    },

    async draftPrompt(text, { threadId = null } = {}) {
      const clean = String(text || '').trim();
      if (!clean) return { ok: false, error: 'empty_text' };
      if (clean.length > MAX_PROMPT_CHARS) {
        return { ok: false, error: 'too_long', message: `Prompt is over ${MAX_PROMPT_CHARS} characters.` };
      }
      const targetId = String(threadId || activeThreadId || '').trim() || null;
      const key = targetId || '__default__';
      drafts.set(key, { text: clean, threadId: targetId, at: Number(now()) || Date.now() });
      if (targetId) touchRecent(targetId);
      return { ok: true, text: clean, threadId: targetId, draftedInBox: false };
    },

    async sendPrompt(text = '', { threadId = null, mode = 'auto', freshContext = false, clientRequestId = null } = {}) {
      const cleanMode = String(mode || 'auto').trim().toLowerCase();
      if (!SEND_MODES.has(cleanMode)) {
        return { ok: false, error: 'invalid_mode', message: `Unsupported send mode "${cleanMode}".` };
      }

      let targetId = String(threadId || activeThreadId || '').trim();
      if (!targetId) {
        const active = await backend.getActiveSession();
        if (!active.ok) return active;
        targetId = active.session?.id || '';
      }
      if (!targetId) return { ok: false, error: 'no_active_thread' };

      const stored = drafts.get(targetId) || drafts.get('__default__') || null;
      const clean = (String(text || '').trim() || stored?.text || '').trim();
      if (!clean) return { ok: false, error: 'empty_text' };
      if (clean.length > MAX_PROMPT_CHARS) {
        return { ok: false, error: 'too_long', message: `Prompt is over ${MAX_PROMPT_CHARS} characters.` };
      }

      const args = { threadId: targetId, message: clean, mode: cleanMode };
      if (freshContext) args.freshContext = true;
      if (clientRequestId) args.clientRequestId = String(clientRequestId).slice(0, 120);

      const res = await invoke('t3_thread_send', args);
      if (!res.ok) return res;

      drafts.delete(targetId);
      if (stored && stored === drafts.get('__default__')) drafts.delete('__default__');
      activeThreadId = targetId;
      touchRecent(targetId);

      return {
        ok: true,
        sent: true,
        threadId: targetId,
        mode: res.data.mode || cleanMode,
        runId: res.data.runId || null,
        queuedRunId: res.data.queuedRunId || null,
        queued: Boolean(res.data.queued || cleanMode === 'queue'),
        link: typeof res.data.link === 'string' ? res.data.link : null,
      };
    },

    async clearDraft({ threadId = null } = {}) {
      const targetId = String(threadId || activeThreadId || '').trim();
      let cleared = false;
      if (targetId && drafts.delete(targetId)) cleared = true;
      if (!targetId && drafts.delete('__default__')) cleared = true;
      return { ok: true, cleared };
    },

    async interruptSession(idOrOpts = {}) {
      const opts = typeof idOrOpts === 'string' ? { threadId: idOrOpts } : (idOrOpts || {});
      const targetId = String(opts.threadId || opts.id || activeThreadId || '').trim();
      if (!targetId) return { ok: false, error: 'no_active_thread' };

      const args = { threadId: targetId };
      if (opts.runId) args.runId = String(opts.runId).slice(0, 120);
      if (opts.reason) args.reason = String(opts.reason).slice(0, 200);
      if (typeof opts.stop === 'boolean') args.stop = opts.stop;

      const res = await invoke('t3_thread_interrupt', args);
      if (!res.ok) return res;
      touchRecent(targetId);
      return {
        ok: true,
        stopped: res.data.interrupted !== false,
        threadId: targetId,
      };
    },

    async getPendingRequest(idOrOpts = {}) {
      const opts = typeof idOrOpts === 'string' ? { threadId: idOrOpts } : (idOrOpts || {});
      const targetId = String(opts.threadId || opts.id || activeThreadId || '').trim();
      const listArgs = { action: 'list' };
      if (targetId) listArgs.threadId = targetId;

      const listRes = await invoke('t3_pending_request', listArgs);
      if (!listRes.ok) return { ...listRes, pending: null, requests: [] };

      const rawList = Array.isArray(listRes.data.requests)
        ? listRes.data.requests
        : Array.isArray(listRes.data.requestIds)
          ? listRes.data.requestIds.map((requestId) => ({ requestId }))
          : [];

      if (!rawList.length) {
        return { ok: true, threadId: targetId || null, pending: null, requests: [] };
      }

      const desiredId = String(opts.requestId || '').trim();
      const chosen = desiredId
        ? rawList.find((r) => (typeof r === 'string' ? r : r.requestId || r.id) === desiredId) || rawList[0]
        : rawList[0];
      const reqId = typeof chosen === 'string' ? chosen : String(chosen.requestId ?? chosen.id ?? '').trim();

      let detail = typeof chosen === 'object' ? chosen : { requestId: reqId };
      if (reqId) {
        const readArgs = { action: 'read', requestId: reqId };
        if (targetId) readArgs.threadId = targetId;
        const readRes = await invoke('t3_pending_request', readArgs);
        if (readRes.ok && readRes.data) detail = { ...detail, ...readRes.data, requestId: reqId };
      }

      const pending = normalizePendingRequest(detail, targetId || null);
      return {
        ok: true,
        threadId: pending?.threadId || targetId || null,
        pending,
        requests: rawList,
      };
    },

    async answerPendingRequest({ threadId = null, requestId = null, key = null, answers = null, choice = null, option = 0 } = {}) {
      const targetId = String(threadId || activeThreadId || '').trim();
      let reqId = String(requestId || key || '').trim();

      if (!reqId) {
        const current = await backend.getPendingRequest({ threadId: targetId || null });
        if (!current.ok) return current;
        if (!current.pending) return { ok: false, error: 'no_pending_request' };
        reqId = current.pending.id;
      }

      let payload = null;
      if (answers && typeof answers === 'object') {
        payload = answers;
      } else if (choice !== null && choice !== undefined && String(choice).trim()) {
        payload = { choice: String(choice).trim() };
        if (option) payload.option = Math.max(0, Math.floor(Number(option) || 0));
      } else {
        return { ok: false, error: 'missing_answers' };
      }

      const args = { action: 'respond', requestId: reqId, answers: payload };
      if (targetId) args.threadId = targetId;

      const res = await invoke('t3_pending_request', args);
      if (!res.ok) return res;
      if (targetId) touchRecent(targetId);
      return {
        ok: true,
        answered: true,
        requestId: reqId,
        threadId: targetId || null,
      };
    },

    async listQueue(idOrOpts = {}) {
      const opts = typeof idOrOpts === 'string' ? { threadId: idOrOpts } : (idOrOpts || {});
      const targetId = String(opts.threadId || opts.id || activeThreadId || '').trim();
      if (!targetId) return { ok: false, error: 'no_active_thread', items: [] };

      const args = { action: 'list', threadId: targetId };
      if (opts.cursor !== undefined) args.cursor = opts.cursor;
      if (opts.limit !== undefined) args.limit = clampInt(opts.limit, 20, 100);

      const res = await invoke('t3_queue', args);
      if (!res.ok) return { ...res, items: [] };
      const items = Array.isArray(res.data.items)
        ? res.data.items
        : Array.isArray(res.data.queued)
          ? res.data.queued
          : Array.isArray(res.data.runs)
            ? res.data.runs
            : [];
      return {
        ok: true,
        threadId: targetId,
        items,
        nextCursor: res.data.nextCursor ?? null,
      };
    },

    async cancelQueued(idOrOpts = {}) {
      const opts = typeof idOrOpts === 'string' ? { queuedRunId: idOrOpts } : (idOrOpts || {});
      const queuedRunId = String(opts.queuedRunId || opts.runId || '').trim();
      if (!queuedRunId) return { ok: false, error: 'missing_queued_run_id' };
      const targetId = String(opts.threadId || activeThreadId || '').trim();

      const args = { action: 'cancel', queuedRunId };
      if (targetId) args.threadId = targetId;

      const res = await invoke('t3_queue', args);
      if (!res.ok) return res;
      if (targetId) touchRecent(targetId);
      return { ok: true, cancelled: true, queuedRunId, threadId: targetId || null };
    },

    async promoteQueued(idOrOpts = {}) {
      const opts = typeof idOrOpts === 'string' ? { queuedRunId: idOrOpts } : (idOrOpts || {});
      const queuedRunId = String(opts.queuedRunId || opts.runId || '').trim();
      if (!queuedRunId) return { ok: false, error: 'missing_queued_run_id' };
      const targetId = String(opts.threadId || activeThreadId || '').trim();

      const args = { action: 'promote_to_steer', queuedRunId };
      if (targetId) args.threadId = targetId;
      if (opts.targetRunId) args.targetRunId = String(opts.targetRunId).trim().slice(0, 120);

      const res = await invoke('t3_queue', args);
      if (!res.ok) return res;
      if (targetId) touchRecent(targetId);
      return { ok: true, promoted: true, queuedRunId, threadId: targetId || null };
    },

    async listProjects({ limit = 50, cursor } = {}) {
      const args = { limit: clampInt(limit, 50, 200) };
      if (cursor !== undefined) args.cursor = cursor;

      const res = await invoke('t3_project_list', args);
      if (!res.ok) return { ...res, projects: [] };
      const rawProjects = Array.isArray(res.data.projects) ? res.data.projects : [];
      return {
        ok: true,
        projects: rawProjects.map(normalizeProject),
        nextCursor: res.data.nextCursor ?? null,
      };
    },

    createWatcher({ pollMs: overridePollMs } = {}) {
      const intervalMs = clampInt(overridePollMs ?? defaultPollMs, defaultPollMs, 60_000, MIN_POLL_MS);
      const listeners = new Set();
      const tracked = new Map(); // threadId -> { status, working, waiting, title, lastWaitingKey }
      let timer = null;
      let stopped = true;
      let polling = false;
      let first = true;
      let lastStatusKey = '';
      let currentWorking = [];

      const emit = (evt) => {
        if (stopped) return;
        for (const fn of listeners) {
          try {
            fn(evt);
          } catch {}
        }
      };

      async function readSummary(threadId) {
        const r = await invoke('t3_thread_read', { threadId, view: 'messages', limit: 4, maxCharsPerItem: 600 });
        if (!r.ok) return '';
        const msgs = normalizeMessages(r.data, 600);
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' || m.from === 'claude');
        return lastAssistant?.text || (typeof r.data.summary === 'string' ? r.data.summary.slice(0, 600) : '');
      }

      async function poll() {
        if (stopped || polling) return;
        polling = true;
        try {
          const listRes = await invoke('t3_thread_list', { limit: 50, allProjects: true, includeSubagents: false });
          if (!listRes.ok || stopped) return;
          const rawThreads = Array.isArray(listRes.data.threads) ? listRes.data.threads : [];

          const nextWorking = [];
          for (const raw of rawThreads) {
            const s = rememberSession(raw);
            if (!s.id) continue;
            const prev = tracked.get(s.id);
            const isWorking = s.working;
            const isWaiting = s.waiting || s.status === 'waiting';
            const isFailed = s.status === 'failed';
            const isFinished = !isWorking && !isWaiting && !isFailed && (s.status === 'completed' || s.status === 'idle');

            if (isWorking) nextWorking.push({ id: s.id, title: s.title });

            if (!first && prev) {
              // Transitioned from active/waiting to finished
              if ((prev.working || prev.waiting) && isFinished) {
                const summary = typeof raw.summary === 'string' && raw.summary.trim()
                  ? raw.summary.trim().slice(0, 600)
                  : await readSummary(s.id);
                if (!stopped) {
                  emit({
                    type: 'claude.finished',
                    id: s.id,
                    title: s.title,
                    summary,
                    backend: BACKEND_ID,
                  });
                }
              }

              // Transitioned into failed
              if (prev.status !== 'failed' && isFailed) {
                const errMsg = typeof raw.error === 'string'
                  ? raw.error.slice(0, 300)
                  : typeof raw.failureReason === 'string'
                    ? raw.failureReason.slice(0, 300)
                    : 'Thread failed';
                emit({
                  type: 't3.failed',
                  id: s.id,
                  title: s.title,
                  error: errMsg,
                  status: 'failed',
                  backend: BACKEND_ID,
                });
              }
            } else if (!first && !prev && isFailed) {
              const errMsg = typeof raw.error === 'string'
                ? raw.error.slice(0, 300)
                : typeof raw.failureReason === 'string'
                  ? raw.failureReason.slice(0, 300)
                  : 'Thread failed';
              emit({
                type: 't3.failed',
                id: s.id,
                title: s.title,
                error: errMsg,
                status: 'failed',
                backend: BACKEND_ID,
              });
            }

            // Waiting on the user (emit on initial sight or on a fresh pending request)
            let lastWaitingKey = prev?.lastWaitingKey || '';
            if (isWaiting) {
              const pendingRes = await backend.getPendingRequest({ threadId: s.id }).catch(() => null);
              const pending = pendingRes?.ok ? pendingRes.pending : null;
              const waitKey = pending?.id ? `req:${pending.id}` : `status:${s.id}`;
              if (!prev?.waiting || waitKey !== lastWaitingKey) {
                lastWaitingKey = waitKey;
                emit({
                  type: 'claude.waiting',
                  id: s.id,
                  title: s.title,
                  kind: pending?.kind || 'question',
                  tool: 't3_pending_request',
                  toolId: pending?.id || waitKey,
                  requestId: pending?.id || null,
                  check: 1,
                  backend: BACKEND_ID,
                });
              }
            } else {
              lastWaitingKey = '';
            }

            tracked.set(s.id, {
              status: s.status,
              working: isWorking,
              waiting: isWaiting,
              title: s.title,
              lastWaitingKey,
            });
          }

          first = false;
          currentWorking = nextWorking;
          const statusKey = nextWorking.map((w) => w.id).join(',');
          if (statusKey !== lastStatusKey) {
            lastStatusKey = statusKey;
            emit({ type: 'claude.status', working: nextWorking.map((w) => ({ ...w })) });
          }
        } catch (e) {
          logWarn('t3-watcher', 'Poll failed', String(e?.message || e).slice(0, 200));
        } finally {
          polling = false;
        }
      }

      return {
        start() {
          if (!stopped) return;
          stopped = false;
          void poll();
          timer = setInterval(() => {
            void poll();
          }, intervalMs);
          timer.unref?.();
        },
        stop() {
          stopped = true;
          clearInterval(timer);
          timer = null;
        },
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        working() {
          return currentWorking.map((w) => ({ ...w }));
        },
        poll,
      };
    },
  };

  return assertTargetBackend(backend);
}
