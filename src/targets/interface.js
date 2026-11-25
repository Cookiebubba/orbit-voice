// Target backend contract: one interface for every coding-agent host Orbit can talk to
// (Claude Code Desktop via UI Automation + local transcripts, or T3 Code via its MCP tools).
//
// Each backend normalizes its sessions into one canonical shape and exposes the same operations
// (list, read, switch, launch, draft, send, interrupt, pending requests, projects, watcher).

import path from 'node:path';

/** Supported backend selectors in Orbit's configuration. */
export const TARGET_BACKENDS = Object.freeze(['auto', 'claude-desktop', 't3-code']);

/** Methods every registered target backend must provide. */
export const REQUIRED_BACKEND_METHODS = Object.freeze([
  'listSessions',
  'getActiveSession',
  'readSession',
  'switchSession',
  'newSession',
  'draftPrompt',
  'sendPrompt',
  'clearDraft',
  'interruptSession',
  'getPendingRequest',
  'answerPendingRequest',
  'listProjects',
  'createWatcher',
]);

const WORKING_STATUSES = new Set(['working', 'running', 'starting', 'preparing', 'queued']);

const clampStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string' && v.trim()) {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return 0;
}

function normalizeRecentFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= 50) break;
    if (typeof item === 'string' && item.trim()) out.push(item.trim().slice(0, 500));
    else if (item && typeof item === 'object' && typeof item.path === 'string' && item.path.trim()) {
      out.push(item.path.trim().slice(0, 500));
    }
  }
  return out;
}

/**
 * Normalize a raw session/thread record from any backend into Orbit's canonical session shape.
 * All string fields and array sizes are defensively clamped.
 */
export function normalizeSession(raw, defaults = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const def = defaults && typeof defaults === 'object' ? defaults : {};

  const id = clampStr(src.id ?? src.threadId ?? src.sessionId, 200);
  const cwd = clampStr(src.cwd ?? src.worktreePath ?? src.workspacePath ?? src.workspaceRoot, 1000);
  const title = clampStr(src.title ?? src.name, 300) || '(untitled)';
  const fallbackProject = cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : '';
  const project = clampStr(src.project ?? src.projectName ?? fallbackProject, 200);
  const branchStr = clampStr(src.branch ?? src.gitBranch, 200);
  const branch = branchStr || null;

  const rawStatus = clampStr(src.status, 40).toLowerCase();
  const inferredWaiting = typeof src.waiting === 'boolean'
    ? src.waiting
    : rawStatus === 'waiting' || Boolean(src.pendingRequest || src.hasPendingRequest);
  const inferredWorking = typeof src.working === 'boolean'
    ? src.working
    : WORKING_STATUSES.has(rawStatus);
  const status = rawStatus || (inferredWaiting ? 'waiting' : inferredWorking ? 'running' : 'idle');

  const createdAt = toMs(src.createdAt);
  const lastActivityAt = toMs(src.lastActivityAt ?? src.updatedAt ?? src.lastTurnAt) || createdAt;
  const lastFocusedAt = toMs(src.lastFocusedAt ?? src.focusedAt) || lastActivityAt;
  const recentFiles = normalizeRecentFiles(src.recentFiles);
  const backend = clampStr(src.backend ?? def.backend, 60);

  return {
    id,
    title,
    project,
    cwd,
    branch,
    status,
    working: inferredWorking,
    waiting: inferredWaiting,
    lastActivityAt,
    lastFocusedAt,
    createdAt,
    recentFiles,
    backend,
  };
}

/**
 * Verify that `b` satisfies the TargetBackend contract. Throws a TypeError on the first missing
 * or mistyped property or method; returns `b` unchanged when valid.
 */
export function assertTargetBackend(b) {
  if (!b || typeof b !== 'object') {
    throw new TypeError('Target backend must be a non-null object.');
  }
  if (typeof b.id !== 'string' || !b.id.trim()) {
    throw new TypeError('Target backend requires a non-empty string "id".');
  }
  if (typeof b.label !== 'string' || !b.label.trim()) {
    throw new TypeError(`Target backend "${b.id}" requires a non-empty string "label".`);
  }
  if (!b.capabilities || typeof b.capabilities !== 'object' || Array.isArray(b.capabilities)) {
    throw new TypeError(`Target backend "${b.id}" requires a "capabilities" object.`);
  }
  for (const method of REQUIRED_BACKEND_METHODS) {
    if (typeof b[method] !== 'function') {
      throw new TypeError(`Target backend "${b.id}" is missing required method "${method}".`);
    }
  }
  return b;
}

/**
 * Registry for target backends. Supports registering validated backends and selecting one by
 * explicit id or 'auto' priority order.
 */
export function createTargetRegistry({ defaultOrder = ['t3-code', 'claude-desktop'] } = {}) {
  const backends = new Map();
  const order = Array.isArray(defaultOrder) ? defaultOrder.filter((id) => typeof id === 'string' && id) : ['t3-code', 'claude-desktop'];

  const available = (backend, predicate) => {
    if (!backend) return false;
    if (typeof predicate === 'function') {
      try {
        return Boolean(predicate(backend));
      } catch {
        return false;
      }
    }
    if (typeof backend.isAvailable === 'function') {
      try {
        return Boolean(backend.isAvailable());
      } catch {
        return false;
      }
    }
    return backend.available !== false;
  };

  return {
    register(backend) {
      assertTargetBackend(backend);
      backends.set(backend.id, backend);
      return backend;
    },
    unregister(id) {
      return backends.delete(String(id || ''));
    },
    get(id) {
      return backends.get(String(id || '')) || null;
    },
    has(id) {
      return backends.has(String(id || ''));
    },
    list() {
      return [...backends.values()];
    },
    ids() {
      return [...backends.keys()];
    },
    /**
     * Select a backend by explicit id ('claude-desktop', 't3-code', ...) or 'auto' (picks the
     * first available backend in `defaultOrder`, then any other registered backend).
     */
    select(preferred = 'auto', { isAvailable = null } = {}) {
      const key = typeof preferred === 'string' ? preferred.trim() : '';
      if (key && key !== 'auto') {
        const direct = backends.get(key) || null;
        if (!direct) return null;
        return isAvailable ? (available(direct, isAvailable) ? direct : null) : direct;
      }
      const seen = new Set();
      for (const id of order) {
        seen.add(id);
        const candidate = backends.get(id);
        if (candidate && available(candidate, isAvailable)) return candidate;
      }
      for (const [id, candidate] of backends) {
        if (seen.has(id)) continue;
        if (available(candidate, isAvailable)) return candidate;
      }
      return null;
    },
  };
}
