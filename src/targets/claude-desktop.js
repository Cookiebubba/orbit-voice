// Claude Code Desktop backend: wraps desktop.js (UI Automation / macOS AX), sessions.js
// (local session metadata and jsonl transcripts), and watcher.js behind the TargetBackend contract.
// All platform dependencies can be overridden via `deps` for OS-independent unit tests.

import path from 'node:path';
import {
  answerPrompt,
  claudeApp,
  clearDesktop,
  fillDesktop,
  getDesktopInfo,
  getPendingPrompt,
  listSidebarSessions,
  newSession as desktopNewSession,
  sendToDesktop,
  stopClaude,
  switchSession as desktopSwitchSession,
} from '../desktop.js';
import {
  findSessionByTitle,
  findTranscript,
  listDesktopSessions,
  readTranscriptTail,
  resolveSession,
} from '../sessions.js';
import { createSessionWatcher } from '../watcher.js';
import { assertTargetBackend, normalizeSession } from './interface.js';

const BACKEND_ID = 'claude-desktop';
const MAX_PROMPT_CHARS = 8000;

const clampInt = (v, def, max) => Math.max(1, Math.min(max, Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : def));

const DEFAULT_DEPS = Object.freeze({
  getDesktopInfo,
  listSidebarSessions,
  switchSession: desktopSwitchSession,
  newSession: desktopNewSession,
  fillDesktop,
  sendToDesktop,
  clearDesktop,
  stopClaude,
  getPendingPrompt,
  answerPrompt,
  claudeApp,
  listDesktopSessions,
  findSessionByTitle,
  resolveSession,
  findTranscript,
  readTranscriptTail,
  createSessionWatcher,
});

export const CLAUDE_DESKTOP_CAPABILITIES = Object.freeze({
  multiThread: false,
  nativeQueue: false,
  steer: false,
  worktrees: false,
  draftInBox: true,
});

/**
 * Create the Claude Code Desktop target backend.
 * Pass `deps` to override any desktop/session/watcher function in tests.
 */
export function createClaudeDesktopTarget(deps = {}) {
  const d = { ...DEFAULT_DEPS, ...(deps && typeof deps === 'object' ? deps : {}) };
  let lastDraft = null; // { text, expectTitle, expectNew, expectFolder }

  const norm = (raw, extra = {}) => normalizeSession({ ...(raw || {}), ...extra, backend: BACKEND_ID });

  function extractQuery(idOrQuery) {
    if (typeof idOrQuery === 'string') return idOrQuery.trim().slice(0, 300);
    if (idOrQuery && typeof idOrQuery === 'object') {
      return String(idOrQuery.id ?? idOrQuery.sessionId ?? idOrQuery.title ?? idOrQuery.session ?? idOrQuery.query ?? '')
        .trim()
        .slice(0, 300);
    }
    return '';
  }

  function resolveRawSession(query, { windowTitle = '' } = {}) {
    const all = d.listDesktopSessions() || [];
    if (query) {
      const exactId = all.find((s) => s.id === query || s.cliSessionId === query);
      if (exactId) return exactId;
    }
    return d.resolveSession(query, { windowTitle }) || null;
  }

  const backend = {
    id: BACKEND_ID,
    label: 'Claude Code Desktop',
    capabilities: CLAUDE_DESKTOP_CAPABILITIES,

    async listSessions({ limit = 20, includeArchived = false } = {}) {
      const max = clampInt(limit, 20, 100);
      const local = d.listDesktopSessions({ includeArchived }) || [];
      if (local.length > 0) {
        return { ok: true, sessions: local.slice(0, max).map((s) => norm(s)) };
      }
      const sidebar = await Promise.resolve()
        .then(() => d.listSidebarSessions())
        .catch(() => null);
      if (sidebar?.ok && Array.isArray(sidebar.sessions)) {
        const sessions = sidebar.sessions.slice(0, max).map((row) =>
          norm({
            id: row.title || '',
            title: row.title || '',
            project: row.label && row.label !== row.title ? row.label.slice(row.title.length).trim() : '',
          }),
        );
        return { ok: true, sessions };
      }
      return { ok: true, sessions: [] };
    },

    async getActiveSession({ rects = false } = {}) {
      const info = await Promise.resolve()
        .then(() => d.getDesktopInfo({ rects }))
        .catch((e) => ({ ok: false, error: 'desktop_error', message: String(e?.message || e).slice(0, 200) }));

      if (info?.ok && info.newSession) {
        return {
          ok: true,
          session: null,
          newSession: true,
          folder: typeof info.folder === 'string' ? info.folder : null,
          promptText: typeof info.promptText === 'string' ? info.promptText : '',
          sendButtonRect: info.sendButtonRect || null,
        };
      }

      if (info?.ok && typeof info.sessionTitle === 'string' && info.sessionTitle.trim()) {
        const title = info.sessionTitle.trim();
        const found = d.findSessionByTitle(title) || resolveRawSession('', { windowTitle: title });
        if (found) {
          return {
            ok: true,
            session: norm(found),
            newSession: false,
            promptText: typeof info.promptText === 'string' ? info.promptText : '',
            sendButtonRect: info.sendButtonRect || null,
          };
        }
        return {
          ok: true,
          session: norm({ id: '', title }),
          newSession: false,
          pendingOnDisk: true,
          promptText: typeof info.promptText === 'string' ? info.promptText : '',
          sendButtonRect: info.sendButtonRect || null,
        };
      }

      const fallback = resolveRawSession('');
      if (fallback) {
        return {
          ok: true,
          session: norm(fallback),
          newSession: false,
          fromDisk: true,
          desktopError: info?.ok ? null : info?.error || 'no_window',
        };
      }

      return {
        ok: false,
        error: info?.error || 'no_session',
        message: info?.message || 'No active Claude Desktop session found.',
        session: null,
      };
    },

    async readSession(idOrQuery = '', { lastN = 8, includeTools = false, maxCharsPerMessage = 1500 } = {}) {
      const query = extractQuery(idOrQuery);
      let windowTitle = '';
      if (!query) {
        const info = await Promise.resolve()
          .then(() => d.getDesktopInfo())
          .catch(() => null);
        if (info?.ok && typeof info.sessionTitle === 'string') windowTitle = info.sessionTitle;
      }
      const raw = resolveRawSession(query, { windowTitle });
      if (!raw) return { ok: false, error: 'session_not_found' };

      const file = d.findTranscript(raw.cliSessionId, raw.cwd);
      if (!file) {
        return { ok: false, error: 'transcript_not_found', session: norm(raw) };
      }

      const tail = d.readTranscriptTail(file, {
        lastN: clampInt(lastN, 8, 50),
        includeTools: Boolean(includeTools),
        maxCharsPerMessage: clampInt(maxCharsPerMessage, 1500, 10000),
      });
      const working = tail.state === 'working';
      const session = norm(raw, { working, status: working ? 'running' : 'idle' });
      const messages = (tail.turns || []).map((t) => ({
        role: t.role === 'claude' ? 'assistant' : t.role,
        from: t.role,
        text: t.text,
        at: t.at || null,
      }));
      return {
        ok: true,
        session,
        state: tail.state,
        messages,
        lastKind: tail.lastKind || null,
        lastTool: tail.lastTool || null,
      };
    },

    async switchSession(idOrQuery) {
      const query = extractQuery(idOrQuery);
      if (!query) return { ok: false, error: 'empty_title' };
      const matched = resolveRawSession(query);
      const targetTitle = matched ? matched.title : query;
      const r = await d.switchSession(targetTitle);
      if (!r?.ok) {
        return { ok: false, error: r?.error || 'switch_failed', message: r?.message };
      }
      const finalTitle = typeof r.sessionTitle === 'string' && r.sessionTitle.trim() ? r.sessionTitle.trim() : targetTitle;
      const meta = d.findSessionByTitle(finalTitle) || matched;
      return {
        ok: true,
        session: meta ? norm(meta) : norm({ id: '', title: finalTitle }),
        sessionTitle: finalTitle,
      };
    },

    async newSession({ project = '' } = {}) {
      const cleanProject = String(project || '').trim().slice(0, 200);
      const r = await d.newSession({ project: cleanProject });
      if (!r?.ok) {
        return { ok: false, error: r?.error || 'new_session_failed', message: r?.message, folders: r?.folders };
      }
      lastDraft = null;
      return {
        ok: true,
        newSession: true,
        folder: typeof r.folder === 'string' ? r.folder : cleanProject || null,
        session: null,
      };
    },

    async draftPrompt(text, { expectTitle = null, expectNew = false, expectFolder = null, replace = null } = {}) {
      const clean = String(text || '').trim();
      if (!clean) return { ok: false, error: 'empty_text' };
      if (clean.length > MAX_PROMPT_CHARS) {
        return { ok: false, error: 'too_long', message: `Prompt is over ${MAX_PROMPT_CHARS} characters.` };
      }
      const r = await d.fillDesktop(clean, {
        expectTitle,
        expectNew: Boolean(expectNew),
        expectFolder,
        replace: replace ?? lastDraft?.text ?? null,
      });
      if (!r?.ok) {
        return { ok: false, error: r?.error || 'draft_failed', message: r?.message };
      }
      lastDraft = { text: clean, expectTitle, expectNew: Boolean(expectNew), expectFolder };
      return {
        ok: true,
        text: clean,
        draftedInBox: true,
        sessionTitle: r.sessionTitle || expectTitle || null,
      };
    },

    async sendPrompt(text = '', { dryRun = false, expectTitle = null, expectNew = false, expectFolder = null, filled = false } = {}) {
      const useStored = !String(text || '').trim() && Boolean(lastDraft?.text);
      const clean = (useStored ? lastDraft.text : String(text || '')).trim();
      if (!clean) return { ok: false, error: 'empty_text' };
      if (clean.length > MAX_PROMPT_CHARS) {
        return { ok: false, error: 'too_long', message: `Prompt is over ${MAX_PROMPT_CHARS} characters.` };
      }
      const r = await d.sendToDesktop(clean, {
        dryRun: Boolean(dryRun),
        expectTitle: expectTitle ?? (useStored ? lastDraft.expectTitle : null),
        expectNew: expectNew || (useStored ? lastDraft.expectNew : false),
        expectFolder: expectFolder ?? (useStored ? lastDraft.expectFolder : null),
        filled: Boolean(filled || useStored),
      });
      if (!r?.ok) {
        return { ok: false, error: r?.error || 'send_failed', message: r?.message };
      }
      lastDraft = null;
      return {
        ok: true,
        sent: true,
        dryRun: Boolean(dryRun),
        sessionTitle: r.sessionTitle || expectTitle || null,
      };
    },

    async clearDraft({ text = null, expectTitle = null, expectNew = false, expectFolder = null } = {}) {
      const target = String(text ?? lastDraft?.text ?? '').trim();
      if (!target) return { ok: true, cleared: false };
      const r = await d.clearDesktop(target, {
        expectTitle: expectTitle ?? lastDraft?.expectTitle ?? null,
        expectNew: expectNew || Boolean(lastDraft?.expectNew),
        expectFolder: expectFolder ?? lastDraft?.expectFolder ?? null,
      });
      if (!r?.ok) {
        return { ok: false, error: r?.error || 'clear_failed', message: r?.message };
      }
      lastDraft = null;
      return { ok: true, cleared: true };
    },

    async interruptSession(idOrOpts = {}) {
      const opts = typeof idOrOpts === 'string' ? { expectTitle: idOrOpts } : (idOrOpts || {});
      let expectTitle = opts.expectTitle || null;
      if (!expectTitle && (opts.id || opts.threadId)) {
        const found = resolveRawSession(String(opts.id || opts.threadId));
        if (found) expectTitle = found.title;
      }
      const r = await d.stopClaude({ expectTitle });
      if (!r?.ok) {
        return { ok: false, error: r?.error || 'stop_failed', message: r?.message };
      }
      return { ok: true, stopped: Boolean(r.stopped ?? true), confirmed: Boolean(r.confirmed) };
    },

    async getPendingRequest(idOrOpts = {}) {
      const opts = typeof idOrOpts === 'string' ? { expectTitle: idOrOpts } : (idOrOpts || {});
      let expectTitle = opts.expectTitle || null;
      if (!expectTitle && (opts.id || opts.threadId)) {
        const found = resolveRawSession(String(opts.id || opts.threadId));
        if (found) expectTitle = found.title;
      }
      const r = await d.getPendingPrompt({ expectTitle });
      if (!r?.ok) {
        return { ok: false, error: r?.error || 'pending_failed', message: r?.message, pending: null };
      }
      return {
        ok: true,
        sessionTitle: r.sessionTitle || expectTitle || null,
        pending: r.pending || null,
      };
    },

    async answerPendingRequest({ key, requestId, choice, option = 0, expectTitle = null } = {}) {
      const promptKey = String(key || requestId || '').trim();
      if (!promptKey) return { ok: false, error: 'missing_key' };
      if (!choice) return { ok: false, error: 'missing_choice' };
      const r = await d.answerPrompt({ key: promptKey, choice, option, expectTitle });
      if (!r?.ok) {
        return { ok: false, error: r?.error || 'answer_failed', message: r?.message };
      }
      return { ok: true, answered: true, choice, option: option || undefined };
    },

    async listProjects() {
      const byKey = new Map();
      const appRes = await Promise.resolve()
        .then(() => d.claudeApp('folders'))
        .catch(() => null);
      if (appRes?.ok && Array.isArray(appRes.folders)) {
        for (const f of appRes.folders) {
          const name = typeof f === 'string' ? f.trim() : String(f?.name || f?.title || '').trim();
          const cwd = typeof f === 'object' && f ? String(f.cwd || f.path || f.workspaceRoot || '').trim() : '';
          if (!name && !cwd) continue;
          const id = cwd || name;
          byKey.set(id.toLowerCase(), {
            id,
            name: name || path.basename(cwd),
            title: name || path.basename(cwd),
            cwd,
            workspaceRoot: cwd,
          });
        }
      }
      for (const s of d.listDesktopSessions() || []) {
        const cwd = typeof s.cwd === 'string' ? s.cwd.trim() : '';
        const name = typeof s.project === 'string' ? s.project.trim() : (cwd ? path.basename(cwd) : '');
        if (!name && !cwd) continue;
        const key = (cwd || name).toLowerCase();
        if (!byKey.has(key)) {
          byKey.set(key, {
            id: cwd || name,
            name: name || path.basename(cwd),
            title: name || path.basename(cwd),
            cwd,
            workspaceRoot: cwd,
          });
        }
      }
      return { ok: true, projects: [...byKey.values()] };
    },

    createWatcher() {
      return d.createSessionWatcher();
    },
  };

  return assertTargetBackend(backend);
}
