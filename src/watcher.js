// Watches recently active Claude Code sessions and notices when Claude finishes a turn.
//
// Cheap by design: every couple of seconds it only stat()s the transcript files of sessions
// that were active in the last few hours, and reads a small tail only when one changed.

import fs from 'node:fs';
import { findTranscript, listDesktopSessions, readTranscriptTail } from './sessions.js';
import { logWarn } from './log.js';

const TICK_MS = 2000;
const RELIST_MS = 15_000;
const HOT_WINDOW_MS = 3 * 60 * 60 * 1000; // only watch sessions active in the last 3 hours
const MAX_WATCHED = 12;
const SETTLE_MS = 6000; // without a stop marker, wait this long after Claude's last text before calling it done
// Claude waiting on the user: its last word is a tool call that hasn't run. A question
// (AskUserQuestion) or a plan to approve (ExitPlanMode) always waits; any other tool may be waiting
// for permission, or just running (a build): those are checked in the Claude window at these ages.
const QUESTION_TOOLS = new Set(['AskUserQuestion']);
const PLAN_TOOLS = new Set(['ExitPlanMode']);
const WAIT_CHECKS_MS = [2500, 12_000];

export function createSessionWatcher() {
  const listeners = new Set();
  const tracked = new Map(); // session id -> state
  let sessions = [];
  let listedAt = 0;
  let lastStatusKey = '';
  let timer = null;

  const emit = (evt) => {
    for (const fn of listeners) {
      try {
        fn(evt);
      } catch {}
    }
  };

  function refreshList(now) {
    if (now - listedAt < RELIST_MS) return;
    listedAt = now;
    sessions = listDesktopSessions()
      .filter((s) => now - s.lastActivityAt < HOT_WINDOW_MS || tracked.get(s.id)?.working)
      .slice(0, MAX_WATCHED);
  }

  function inspect(s, now) {
    let t = tracked.get(s.id);
    if (!t) {
      const file = findTranscript(s.cliSessionId, s.cwd);
      if (!file) return;
      t = { file, mtime: 0, size: 0, working: false, kind: null, changedAt: 0, lastText: '', first: true, lastTool: null, waitChecks: 0 };
      tracked.set(s.id, t);
    }
    t.title = s.title;
    let st;
    try {
      st = fs.statSync(t.file);
    } catch {
      return;
    }
    if (st.mtimeMs !== t.mtime || st.size !== t.size) {
      t.mtime = st.mtimeMs;
      t.size = st.size;
      t.changedAt = now;
      try {
        const tail = readTranscriptTail(t.file, { lastN: 4, maxBytes: 256 * 1024, maxCharsPerMessage: 600 });
        t.kind = tail.lastKind;
        const tool = tail.lastTool;
        if (!tool || tool.id !== t.lastTool?.id) t.waitChecks = 0; // a new call (or none): check it afresh
        t.lastTool = tool;
        const lastClaude = [...tail.turns].reverse().find((x) => x.role === 'claude');
        if (lastClaude) t.lastText = lastClaude.text;
        const busy = tail.state === 'working';
        // On first sight, only count it as working if it was active very recently.
        if (busy && (!t.first || tail.ageMs < 2 * 60 * 1000)) t.working = true;
      } catch {}
      t.first = false;
    }
    if (!t.working) return;
    // Blocked on the user? Reported once for a question or a plan, twice at most for any other tool.
    if (t.kind === 'tool_use' && t.lastTool) {
      const name = t.lastTool.name;
      const kind = QUESTION_TOOLS.has(name) ? 'question' : PLAN_TOOLS.has(name) ? 'plan' : 'tool';
      const checks = kind === 'tool' ? WAIT_CHECKS_MS : WAIT_CHECKS_MS.slice(0, 1);
      // A session that never asks permission (bypass mode) only waits on questions and plans.
      const asks = kind !== 'tool' || s.permissionMode !== 'bypassPermissions';
      if (asks && t.waitChecks < checks.length && now - t.changedAt >= checks[t.waitChecks]) {
        t.waitChecks++;
        emit({ type: 'claude.waiting', id: s.id, title: s.title, kind, tool: name, toolId: t.lastTool.id, check: t.waitChecks });
      }
    }
    const finished = t.kind === 'stopped' || (t.kind === 'assistant_text' && now - t.changedAt >= SETTLE_MS);
    if (finished) {
      t.working = false;
      emit({ type: 'claude.finished', id: s.id, title: s.title, summary: t.lastText });
    }
  }

  function tick() {
    const now = Date.now();
    try {
      refreshList(now);
      for (const s of sessions) inspect(s, now);
    } catch (e) {
      logWarn('watcher', 'Session check failed', e?.message);
    }
    const working = sessions.filter((s) => tracked.get(s.id)?.working).map((s) => ({ id: s.id, title: s.title }));
    const key = working.map((w) => w.id).join(',');
    if (key !== lastStatusKey) {
      lastStatusKey = key;
      emit({ type: 'claude.status', working });
    }
  }

  return {
    start() {
      if (!timer) {
        tick();
        timer = setInterval(tick, TICK_MS);
      }
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Sessions Claude is currently working in. */
    working: () => sessions.filter((s) => tracked.get(s.id)?.working).map((s) => ({ id: s.id, title: s.title })),
  };
}
