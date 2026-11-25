// In-process + real 127.0.0.1:0 HTTP stand-in for T3 Code's MCP tool server.
// Exposes both `POST <url>/mcp/call` (with Bearer auth) and direct `.callTool(name, args)` so
// tests can exercise both transports against identical thread/queue/pending-request state.

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

const MAX_BODY = 256 * 1024;

function tokenEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let overflow = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        overflow = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (overflow) return resolve(null);
      try {
        const parsed = JSON.parse(raw || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function slug(text) {
  return String(text || 'thread')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'thread';
}

/**
 * Start a fake T3 Code server bound to `127.0.0.1:0`.
 * Returns `{ url, token, callTool, simulateFinish, simulatePendingQuestion, simulateFail, addThread, addProject, getThread, calls, close }`.
 */
export async function startFakeT3({
  token = 'fake-t3-token',
  projects = [
    { projectId: 'proj_orbit', title: 'orbit-voice', workspaceRoot: '/workspace/orbit-voice' },
    { projectId: 'proj_web', title: 'web-dashboard', workspaceRoot: '/workspace/web-dashboard' },
  ],
  threads = [],
} = {}) {
  let seq = 0;
  let runSeq = 0;
  let reqSeq = 0;
  let clock = Date.now();
  const tick = () => {
    clock = Math.max(clock + 1, Date.now());
    return clock;
  };

  const projectMap = new Map();
  for (const p of projects) {
    const id = String(p.projectId || p.id || `proj_${++seq}`);
    projectMap.set(id, {
      projectId: id,
      title: String(p.title || p.name || path.basename(p.workspaceRoot || id)),
      workspaceRoot: String(p.workspaceRoot || p.cwd || `/workspace/${id}`),
    });
  }

  const threadMap = new Map();
  const calls = [];

  function addThread(spec = {}) {
    const id = String(spec.threadId || spec.id || `thr_${++seq}`);
    const proj = spec.projectId ? projectMap.get(spec.projectId) : null;
    const ts = Number.isFinite(spec.updatedAt) ? spec.updatedAt : tick();
    const t = {
      threadId: id,
      title: String(spec.title || `Thread ${seq}`),
      projectId: spec.projectId || proj?.projectId || null,
      projectName: spec.projectName || spec.project || proj?.title || '',
      cwd: spec.cwd || spec.worktreePath || proj?.workspaceRoot || '',
      worktreePath: spec.worktreePath || null,
      branch: spec.branch || 'main',
      baseRef: spec.baseRef || null,
      startFromOrigin: spec.startFromOrigin ?? null,
      status: spec.status || 'idle',
      createdAt: Number.isFinite(spec.createdAt) ? spec.createdAt : ts,
      updatedAt: ts,
      recentFiles: Array.isArray(spec.recentFiles) ? [...spec.recentFiles] : [],
      messages: Array.isArray(spec.messages) ? spec.messages.map((m) => ({ ...m })) : [],
      queue: Array.isArray(spec.queue) ? spec.queue.map((q) => ({ ...q })) : [],
      pendingRequests: Array.isArray(spec.pendingRequests) ? spec.pendingRequests.map((r) => ({ ...r })) : [],
      answeredRequests: [],
      activeRunId: spec.activeRunId || (spec.status === 'running' ? `run_${++runSeq}` : null),
      error: spec.error || null,
      summary: spec.summary || '',
      link: `[${spec.title || `Thread ${seq}`}](t3://thread/${id})`,
    };
    threadMap.set(id, t);
    return t;
  }

  for (const seed of threads) addThread(seed);

  function addProject(spec = {}) {
    const id = String(spec.projectId || spec.id || `proj_${++seq}`);
    const p = {
      projectId: id,
      title: String(spec.title || spec.name || id),
      workspaceRoot: String(spec.workspaceRoot || spec.cwd || `/workspace/${id}`),
    };
    projectMap.set(id, p);
    return p;
  }

  function threadSummary(t) {
    return {
      threadId: t.threadId,
      id: t.threadId,
      title: t.title,
      projectId: t.projectId,
      projectName: t.projectName,
      cwd: t.cwd,
      worktreePath: t.worktreePath,
      branch: t.branch,
      status: t.status,
      working: ['running', 'starting', 'preparing', 'queued'].includes(t.status),
      waiting: t.status === 'waiting' || t.pendingRequests.length > 0,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      lastActivityAt: t.updatedAt,
      recentFiles: [...t.recentFiles],
      error: t.error,
      summary: t.summary,
      link: t.link,
    };
  }

  async function callTool(name, args = {}, meta = { via: 'direct' }) {
    const a = args && typeof args === 'object' ? args : {};
    calls.push({ name, args: structuredClone(a), via: meta.via || 'direct', at: Date.now() });

    switch (name) {
      case 't3_project_list': {
        const list = [...projectMap.values()];
        const limit = Number.isFinite(+a.limit) && +a.limit > 0 ? Math.floor(+a.limit) : 50;
        return { projects: list.slice(0, limit) };
      }

      case 't3_thread_list': {
        let list = [...threadMap.values()];
        if (a.projectId) list = list.filter((t) => t.projectId === a.projectId);
        if (Array.isArray(a.statuses) && a.statuses.length) {
          const wanted = new Set(a.statuses);
          list = list.filter((t) => wanted.has(t.status));
        }
        if (a.titleContains) {
          const needle = String(a.titleContains).toLowerCase();
          list = list.filter((t) => t.title.toLowerCase().includes(needle));
        }
        list.sort((x, y) => y.updatedAt - x.updatedAt);
        const limit = Number.isFinite(+a.limit) && +a.limit > 0 ? Math.floor(+a.limit) : 20;
        return { threads: list.slice(0, limit).map(threadSummary) };
      }

      case 't3_thread_search': {
        const q = String(a.query || '').toLowerCase().trim();
        let list = [...threadMap.values()];
        if (a.projectId) list = list.filter((t) => t.projectId === a.projectId);
        if (q) {
          list = list.filter((t) => {
            const hay = [
              t.threadId,
              t.title,
              t.branch || '',
              t.projectName || '',
              ...t.messages.map((m) => m.text || ''),
            ]
              .join(' ')
              .toLowerCase();
            return hay.includes(q);
          });
        }
        list.sort((x, y) => y.updatedAt - x.updatedAt);
        const limit = Number.isFinite(+a.limit) && +a.limit > 0 ? Math.floor(+a.limit) : 10;
        return { threads: list.slice(0, limit).map(threadSummary) };
      }

      case 't3_thread_read': {
        const t = threadMap.get(String(a.threadId || ''));
        if (!t) return { ok: false, error: 'thread_not_found', message: 'Thread not found.' };
        const limit = Number.isFinite(+a.limit) && +a.limit > 0 ? Math.floor(+a.limit) : 20;
        const view = a.view === 'activity' ? 'activity' : 'messages';
        const filtered = view === 'activity' ? t.messages : t.messages.filter((m) => m.role !== 'tool');
        return {
          ...threadSummary(t),
          messages: filtered.slice(-limit).map((m) => ({ ...m })),
        };
      }

      case 't3_thread_launch': {
        const title = String(a.title || 'New thread').trim() || 'New thread';
        const proj = a.projectId ? projectMap.get(a.projectId) : null;
        const ws = a.workspaceStrategy && typeof a.workspaceStrategy === 'object' ? a.workspaceStrategy : null;
        let branch = 'main';
        let cwd = proj?.workspaceRoot || (a.scratch ? `/tmp/scratch/${slug(title)}` : '');
        let worktreePath = null;
        let baseRef = null;
        let startFromOrigin = null;

        if (ws?.type === 'worktree') {
          branch = ws.branch ? String(ws.branch) : `feat/${slug(title)}`;
          baseRef = ws.baseRef ? String(ws.baseRef) : 'origin/main';
          startFromOrigin = typeof ws.startFromOrigin === 'boolean' ? ws.startFromOrigin : true;
          worktreePath = `${cwd || '/workspace/repo'}/.worktrees/${slug(branch)}`;
          cwd = worktreePath;
        } else if (ws?.type === 'existing_worktree' && ws.worktreePath) {
          worktreePath = String(ws.worktreePath);
          cwd = worktreePath;
        }

        const hasMessage = typeof a.message === 'string' && a.message.trim().length > 0;
        const runId = hasMessage ? `run_${++runSeq}` : null;
        const ts = tick();
        const t = addThread({
          title,
          projectId: proj?.projectId || a.projectId || null,
          projectName: proj?.title || (a.scratch ? 'scratch' : ''),
          cwd,
          worktreePath,
          branch,
          baseRef,
          startFromOrigin,
          status: hasMessage ? 'running' : 'idle',
          activeRunId: runId,
          createdAt: ts,
          updatedAt: ts,
          messages: hasMessage ? [{ id: `msg_${++seq}`, role: 'user', text: a.message.trim(), at: new Date(ts).toISOString() }] : [],
        });

        return {
          ...threadSummary(t),
          runId,
          baseRef: t.baseRef,
          startFromOrigin: t.startFromOrigin,
        };
      }

      case 't3_thread_send': {
        const t = threadMap.get(String(a.threadId || ''));
        if (!t) return { ok: false, error: 'thread_not_found', message: 'Thread not found.' };
        const message = String(a.message || '').trim();
        if (!message) return { ok: false, error: 'empty_message' };
        const mode = String(a.mode || 'auto');
        const ts = tick();
        t.updatedAt = ts;
        t.error = null;

        if (mode === 'queue') {
          const queuedRunId = `qrun_${++runSeq}`;
          t.queue.push({ queuedRunId, text: message, createdAt: ts });
          if (t.status === 'idle' || t.status === 'completed') t.status = 'queued';
          return { ok: true, threadId: t.threadId, queuedRunId, mode: 'queue', queued: true, link: t.link };
        }

        if (mode === 'steer') {
          const runId = t.activeRunId || `run_${++runSeq}`;
          t.activeRunId = runId;
          t.status = 'running';
          t.messages.push({ id: `msg_${++seq}`, role: 'user', text: message, steered: true, at: new Date(ts).toISOString() });
          return { ok: true, threadId: t.threadId, runId, mode: 'steer', queued: false, link: t.link };
        }

        if (mode === 'restart') {
          const runId = `run_${++runSeq}`;
          t.activeRunId = runId;
          t.status = 'running';
          t.pendingRequests = [];
          t.messages.push({ id: `msg_${++seq}`, role: 'user', text: message, restarted: true, at: new Date(ts).toISOString() });
          return { ok: true, threadId: t.threadId, runId, mode: 'restart', queued: false, link: t.link };
        }

        // mode === 'auto'
        const runId = t.status === 'running' && t.activeRunId ? t.activeRunId : `run_${++runSeq}`;
        const steered = t.status === 'running';
        t.activeRunId = runId;
        t.status = 'running';
        t.messages.push({ id: `msg_${++seq}`, role: 'user', text: message, steered, at: new Date(ts).toISOString() });
        return { ok: true, threadId: t.threadId, runId, mode: steered ? 'steer' : 'auto', queued: false, link: t.link };
      }

      case 't3_thread_interrupt': {
        const t = threadMap.get(String(a.threadId || ''));
        if (!t) return { ok: false, error: 'thread_not_found' };
        const wasActive = ['running', 'starting', 'preparing', 'queued', 'waiting'].includes(t.status);
        if (wasActive) {
          t.status = 'interrupted';
          t.activeRunId = null;
          t.pendingRequests = [];
          t.updatedAt = tick();
        }
        return { ok: true, threadId: t.threadId, interrupted: wasActive };
      }

      case 't3_queue': {
        const t = threadMap.get(String(a.threadId || ''));
        if (!t) return { ok: false, error: 'thread_not_found' };
        const action = String(a.action || 'list');

        if (action === 'list') {
          const limit = Number.isFinite(+a.limit) && +a.limit > 0 ? Math.floor(+a.limit) : 50;
          return { items: t.queue.slice(0, limit).map((q) => ({ ...q })), nextCursor: null };
        }
        if (action === 'read') {
          const item = t.queue.find((q) => q.queuedRunId === a.queuedRunId);
          if (!item) return { ok: false, error: 'queued_run_not_found' };
          return { ...item };
        }
        if (action === 'edit') {
          const item = t.queue.find((q) => q.queuedRunId === a.queuedRunId);
          if (!item) return { ok: false, error: 'queued_run_not_found' };
          item.text = String(a.text || '');
          return { ok: true, ...item };
        }
        if (action === 'cancel') {
          const idx = t.queue.findIndex((q) => q.queuedRunId === a.queuedRunId);
          if (idx < 0) return { ok: false, error: 'queued_run_not_found' };
          t.queue.splice(idx, 1);
          if (t.status === 'queued' && t.queue.length === 0) t.status = 'idle';
          t.updatedAt = tick();
          return { ok: true, cancelled: true, queuedRunId: a.queuedRunId };
        }
        if (action === 'promote_to_steer') {
          const idx = t.queue.findIndex((q) => q.queuedRunId === a.queuedRunId);
          if (idx < 0) return { ok: false, error: 'queued_run_not_found' };
          const [item] = t.queue.splice(idx, 1);
          const ts = tick();
          t.status = 'running';
          t.activeRunId = a.targetRunId || t.activeRunId || `run_${++runSeq}`;
          t.messages.push({ id: `msg_${++seq}`, role: 'user', text: item.text, steered: true, promotedFrom: item.queuedRunId, at: new Date(ts).toISOString() });
          t.updatedAt = ts;
          return { ok: true, promoted: true, queuedRunId: item.queuedRunId, targetRunId: t.activeRunId };
        }
        return { ok: false, error: 'unsupported_queue_action' };
      }

      case 't3_pending_request': {
        const action = String(a.action || 'list');
        const t = a.threadId ? threadMap.get(String(a.threadId)) : null;

        if (action === 'list') {
          const source = t ? [t] : [...threadMap.values()];
          const requests = source.flatMap((thr) =>
            thr.pendingRequests.map((r) => ({
              requestId: r.requestId,
              threadId: thr.threadId,
              kind: r.kind,
              question: r.question,
            })),
          );
          return { requests };
        }

        if (action === 'read') {
          const reqId = String(a.requestId || '');
          const source = t ? [t] : [...threadMap.values()];
          for (const thr of source) {
            const hit = thr.pendingRequests.find((r) => r.requestId === reqId);
            if (hit) return { ...hit, threadId: thr.threadId };
          }
          return { ok: false, error: 'request_not_found' };
        }

        if (action === 'respond') {
          const reqId = String(a.requestId || '');
          const source = t ? [t] : [...threadMap.values()];
          for (const thr of source) {
            const idx = thr.pendingRequests.findIndex((r) => r.requestId === reqId);
            if (idx >= 0) {
              const [answered] = thr.pendingRequests.splice(idx, 1);
              thr.answeredRequests.push({ ...answered, answers: a.answers || {}, answeredAt: tick() });
              if (thr.pendingRequests.length === 0 && thr.status === 'waiting') {
                thr.status = 'running';
              }
              thr.updatedAt = tick();
              return { ok: true, answered: true, requestId: reqId, threadId: thr.threadId };
            }
          }
          return { ok: false, error: 'request_not_found' };
        }

        return { ok: false, error: 'unsupported_pending_action' };
      }

      default:
        return { ok: false, error: 'unknown_tool', message: `Unknown tool "${name}".` };
    }
  }

  // ---- Simulation helpers for deterministic tests ----

  function simulateFinish(threadId, { text = 'Done.', summary = '' } = {}) {
    const t = threadMap.get(String(threadId || ''));
    if (!t) throw new Error(`Unknown threadId: ${threadId}`);
    const ts = tick();
    const reply = String(text || summary || 'Done.');
    t.messages.push({ id: `msg_${++seq}`, role: 'assistant', text: reply, at: new Date(ts).toISOString() });
    t.summary = String(summary || reply);
    t.status = 'completed';
    t.activeRunId = null;
    t.pendingRequests = [];
    t.updatedAt = ts;
    return threadSummary(t);
  }

  function simulatePendingQuestion(
    threadId,
    {
      requestId = '',
      kind = 'question',
      question = 'Which option should I use?',
      choices = [
        { n: 1, label: 'Option A', description: 'First choice' },
        { n: 2, label: 'Option B', description: 'Second choice' },
      ],
      multiSelect = false,
      canSkip = false,
    } = {},
  ) {
    const t = threadMap.get(String(threadId || ''));
    if (!t) throw new Error(`Unknown threadId: ${threadId}`);
    const id = String(requestId || `req_${++reqSeq}`);
    const req = {
      requestId: id,
      threadId: t.threadId,
      kind,
      question,
      title: question,
      choices: choices.map((c, i) => (typeof c === 'string' ? { n: i + 1, label: c, description: '' } : { n: i + 1, ...c })),
      multiSelect: Boolean(multiSelect),
      canSkip: Boolean(canSkip),
    };
    t.pendingRequests.push(req);
    t.status = 'waiting';
    t.updatedAt = tick();
    return { ...req };
  }

  function simulateFail(threadId, { error = 'Run failed unexpectedly.' } = {}) {
    const t = threadMap.get(String(threadId || ''));
    if (!t) throw new Error(`Unknown threadId: ${threadId}`);
    t.status = 'failed';
    t.error = String(error || 'Run failed unexpectedly.');
    t.activeRunId = null;
    t.pendingRequests = [];
    t.updatedAt = tick();
    return threadSummary(t);
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    if (urlObj.pathname !== '/mcp/call') {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    if (token) {
      const auth = String(req.headers.authorization || '');
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match || !tokenEqual(match[1].trim(), token)) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
    }
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    const toolName = String(body.name || body.tool || '').trim();
    const toolArgs = body.arguments ?? body.args ?? {};
    if (!toolName) return sendJson(res, 400, { ok: false, error: 'missing_tool_name' });

    const result = await callTool(toolName, toolArgs, { via: 'http' });
    if (result && result.ok === false) {
      return sendJson(res, 200, result);
    }
    return sendJson(res, 200, { ok: true, result });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    token,
    callTool: (name, args) => callTool(name, args, { via: 'direct' }),
    simulateFinish,
    simulatePendingQuestion,
    simulateFail,
    addThread,
    addProject,
    getThread: (id) => {
      const t = threadMap.get(String(id || ''));
      return t ? threadSummary(t) : null;
    },
    calls,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export const createFakeT3Server = startFakeT3;
