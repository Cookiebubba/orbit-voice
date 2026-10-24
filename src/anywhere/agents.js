// The agent manager ("Orbit anywhere", phase 8): background helpers, one per window with work.
// Orbit stays in the conversation; a helper (Claude Code, headless, see src/engines/) does the
// computer-use work in its window through orbit-hands (hands-mcp.js), which only reaches that
// window and holds every outward act for the user's yes.
//
//   start(win, task)    a helper for that window (its context made; Qubit pops in there)
//   status / list       plain progress lines from the helper's stream, a step count
//   redirect(id, words) the user's words go in as a new message
//   cancel(id) / stopAll()
//   approvals           a held act waits for the user's yes, asked through Orbit (by voice, and it
//                       may wake Orbit). One question at a time: others wait in line (oldest
//                       first). Re-asked once after 2 minutes, then held quietly; after 30 minutes
//                       the act is dropped and the helper told.
//
// Caps: 3 helpers at once (more are refused with a reason; the user decides). Every voice goes
// through Orbit: helpers never speak; they raise events and Orbit says them.

import crypto from 'node:crypto';
import { label } from './windows.js';
import { windowText } from './policy.js';

export const AGENT_LIMITS = Object.freeze({ running: 3, reaskMs: 2 * 60_000, dropMs: 30 * 60_000, progressLines: 20, tickMs: 5000 });
const RUNNING = new Set(['starting', 'working', 'waiting']);

// (No imports from hands.js or index.js: index.js makes Orbit's one manager, so this stays a leaf.)
const plainAct = (p) => `${p?.action || 'act'} ${p?.node?.n || p?.node?.a || 'a control'}`;

export function createAgents({ engine, engineOptions = () => ({}), mcpUrl = (id) => `/mcp/hands/${id}`, tools = [], contexts = null, describe = plainAct, now = () => Date.now(), limits = AGENT_LIMITS } = {}) {
  const helpers = new Map(); // id -> helper
  const approvals = []; // held acts, oldest first: { id, helperId, plan, ask, at, askedAt, reasked, state, result, waiters }
  const listeners = new Set();
  const emit = (evt) => {
    for (const fn of [...listeners]) {
      try {
        fn(evt);
      } catch { /* a listener's own problem */ }
    }
  };
  const pub = (h) =>
    h && {
      id: h.id,
      hwnd: h.hwnd,
      window: h.label,
      app: h.app,
      task: h.task,
      status: h.status,
      progress: h.progress.slice(-5),
      steps: h.steps,
      started: h.startedAt,
      ended: h.endedAt || undefined,
      summary: h.summary || undefined,
      waiting_on_you: approvals.find((a) => a.helperId === h.id && a.state === 'pending')?.ask,
    };
  const setStatus = (h, status) => {
    h.status = status;
    if (contexts && h.ctxId) contexts.setStatus(h.ctxId, status === 'working' || status === 'starting' ? 'working' : status === 'waiting' ? 'waiting' : status === 'done' ? 'done' : 'idle');
  };
  const running = () => [...helpers.values()].filter((h) => RUNNING.has(h.status));

  function finish(h, evt) {
    if (!RUNNING.has(h.status)) return;
    h.endedAt = now();
    h.summary = windowText(evt.summary || '', 400);
    for (const a of approvals.filter((x) => x.helperId === h.id && x.state === 'pending')) settle(a, 'dropped');
    setStatus(h, evt.cancelled ? 'cancelled' : evt.ok ? 'done' : 'failed');
    if (!evt.cancelled) emit({ type: evt.ok ? 'done' : 'failed', helper: pub(h), needsSignIn: !!evt.needsSignIn });
  }

  function settle(a, state, result) {
    if (a.state !== 'pending') return;
    a.state = state;
    a.result = result;
    for (const w of a.waiters.splice(0)) w();
    const h = helpers.get(a.helperId);
    if (h && h.status === 'waiting' && !approvals.some((x) => x.helperId === h.id && x.state === 'pending')) setStatus(h, 'working');
    askNext();
  }

  /** The oldest pending approval is the one asked; the next is asked once it's answered. */
  function askNext() {
    const head = approvals.find((a) => a.state === 'pending');
    if (!head || head.askedAt) return;
    head.askedAt = now();
    const waiting = approvals.filter((a) => a.state === 'pending').length;
    emit({ type: 'approval', helper: pub(helpers.get(head.helperId)), ask: head.ask, approvalId: head.id, others: waiting - 1 });
  }

  // Re-ask once after 2 minutes; drop after 30.
  const tick = setInterval(() => {
    const t = now();
    for (const a of approvals) {
      if (a.state !== 'pending' || !a.askedAt) continue;
      if (t - a.at > limits.dropMs) settle(a, 'dropped');
      else if (!a.reasked && t - a.askedAt > limits.reaskMs) {
        a.reasked = true;
        emit({ type: 'approval', helper: pub(helpers.get(a.helperId)), ask: a.ask, approvalId: a.id, again: true, others: 0 });
      }
    }
    while (approvals.length > 50 && approvals[0].state !== 'pending') approvals.shift();
  }, limits.tickMs || 5000);
  tick.unref?.();

  const api = {
    /** Start a helper on `task` (the user's words) in window `win`. { ok, helper } or { ok: false, error }. */
    start(win, task, { engineId, extra = null } = {}) {
      if (!win?.hwnd) return { ok: false, error: 'There is no window to work in.' };
      const busy = [...helpers.values()].find((h) => h.hwnd === win.hwnd && RUNNING.has(h.status));
      if (busy) return { ok: false, error: `A helper is already working in ${busy.label}. Redirect it, or cancel it first.` };
      if (running().length >= limits.running) return { ok: false, error: `${limits.running} helpers are already working, which is the most at once. Wait for one to finish, or cancel one.` };
      const id = crypto.randomBytes(8).toString('hex');
      const token = crypto.randomBytes(24).toString('hex');
      // extra: connected MCP servers this task was given ({ servers, readTools, writeTools }, see src/mcp).
      const h = { id, token, hwnd: win.hwnd, win, label: label(win), app: win.exe || '', task: String(task).slice(0, 2000), status: 'starting', progress: [], steps: 0, startedAt: now(), endedAt: 0, summary: '', run: null, ctxId: null, lastTyped: '', extra };
      helpers.set(id, h);
      if (contexts) h.ctxId = contexts.attach?.(win)?.id || null;
      setStatus(h, 'starting');
      try {
        h.run = engine.start({
          task: h.task,
          mcpUrl: mcpUrl(id),
          token,
          tools: typeof tools === 'function' ? tools() : tools,
          extra,
          ...engineOptions({ engineId }),
          onEvent: (evt) => {
            if (evt.type === 'started') setStatus(h, 'working');
            else if (evt.type === 'progress') {
              h.steps++;
              h.progress.push(evt.line);
              if (h.progress.length > limits.progressLines) h.progress.shift();
              if (h.status === 'starting') setStatus(h, 'working');
              emit({ type: 'progress', helper: pub(h) });
            } else if (evt.type === 'done' || evt.type === 'error') finish(h, evt.type === 'error' ? { ok: false, summary: evt.error } : evt);
          },
        });
      } catch (e) {
        finish(h, { ok: false, summary: String(e?.message || e).slice(0, 200) });
        return { ok: false, error: h.summary };
      }
      emit({ type: 'started', helper: pub(h) });
      return { ok: true, helper: pub(h) };
    },
    /** The helper behind a token (the hands endpoint asks; constant-time). */
    byToken(id, token) {
      const h = helpers.get(String(id));
      if (!h || !RUNNING.has(h.status) || typeof token !== 'string' || token.length !== h.token.length) return null;
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(h.token)) ? h : null;
    },
    /** An outward act a helper wants: held until the user answers. Returns { id }. */
    requestApproval(helperId, plan) {
      const h = helpers.get(helperId);
      const typed = h?.lastTyped && plan?.kind !== 'tool' ? ` (the box says "${windowText(h.lastTyped, 160)}")` : '';
      const a = { id: crypto.randomBytes(6).toString('hex'), helperId, plan, ask: `The helper in ${h?.label || 'a window'} wants to ${describe(plan)}${typed}. OK?`, at: now(), askedAt: 0, reasked: false, state: 'pending', result: null, waiters: [] };
      approvals.push(a);
      if (h) setStatus(h, 'waiting');
      askNext();
      return { id: a.id };
    },
    /** Wait (up to `ms`) for an approval's answer: { state: 'approved' | 'denied' | 'dropped' | 'still_waiting', result? }. */
    async waitApproval(helperId, approvalId, ms = 55_000, perform = async () => ({ ok: false })) {
      const a = approvals.find((x) => x.id === approvalId && x.helperId === helperId);
      if (!a) return { state: 'unknown', error: 'No such approval.' };
      if (a.state === 'pending') await new Promise((r) => {
        const t = setTimeout(r, ms);
        a.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
      if (a.state === 'pending') return { state: 'still_waiting' };
      if (a.state === 'approved' && !a.done) {
        a.done = true;
        a.result = await perform(a.plan);
      }
      return { state: a.state, result: a.result || undefined, note: a.state === 'dropped' ? 'Nobody answered in time (or the helper stopped), so it was not done.' : undefined };
    },
    /** The question being asked now (or null). */
    get asking() {
      const a = approvals.find((x) => x.state === 'pending' && x.askedAt);
      return a ? { approvalId: a.id, helper: pub(helpers.get(a.helperId)), ask: a.ask, askedAt: a.askedAt, toldAt: a.toldAt || 0 } : null;
    },
    /** Orbit told the user this question (now): their answer must come after it. */
    markTold(approvalId, at = now()) {
      const a = approvals.find((x) => x.id === approvalId);
      if (a) a.toldAt = at;
    },
    /** The user's answer (gated by the caller): approve or deny the held act of this helper. */
    decide(helperId, approve) {
      const a = approvals.find((x) => x.helperId === helperId && x.state === 'pending' && x.askedAt);
      if (!a) return { ok: false, error: 'That helper is not waiting on anything.' };
      settle(a, approve ? 'approved' : 'denied');
      return { ok: true, approved: !!approve };
    },
    noteTyped(helperId, text) {
      const h = helpers.get(helperId);
      if (h) h.lastTyped = String(text || '').slice(0, 400);
    },
    progress(helperId, line) {
      const h = helpers.get(helperId);
      if (!h) return;
      h.progress.push(line);
      if (h.progress.length > limits.progressLines) h.progress.shift();
    },
    redirect(id, words) {
      const h = helpers.get(id);
      if (!h || !RUNNING.has(h.status)) return { ok: false, error: 'That helper is not working.' };
      return h.run?.send(`The user adds (their words): ${String(words).slice(0, 2000)}`) ? { ok: true } : { ok: false, error: 'The helper did not take it.' };
    },
    cancel(id) {
      const h = helpers.get(id);
      if (!h || !RUNNING.has(h.status)) return { ok: false, error: 'That helper is not working.' };
      h.run?.stop();
      finish(h, { ok: false, cancelled: true, summary: 'Cancelled.' });
      return { ok: true };
    },
    /** "Stop everything": every helper stops and every held act is dropped. Returns how many stopped. */
    stopAll() {
      let n = 0;
      for (const h of helpers.values()) if (RUNNING.has(h.status) && api.cancel(h.id).ok) n++;
      for (const a of approvals) if (a.state === 'pending') settle(a, 'dropped');
      return n;
    },
    forWindow(hwnd) {
      const all = [...helpers.values()].filter((h) => h.hwnd === hwnd).sort((a, b) => b.startedAt - a.startedAt);
      return pub(all[0]) || null;
    },
    get(id) {
      return pub(helpers.get(id));
    },
    list() {
      return [...helpers.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 12).map(pub);
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      clearInterval(tick);
      api.stopAll();
    },
  };
  return api;
}
