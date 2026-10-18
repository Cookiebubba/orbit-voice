// The run ledger: an append-only JSONL file per run, and the one reducer that turns its events
// into card state. The Supervisor never keeps agent state anywhere else: it appends an event and
// re-derives the cards from it, so the live view, a replay after a crash and the tests all go
// through the same code.

import fs from 'node:fs';
import path from 'node:path';

export const TERMINAL = new Set(['done', 'failed', 'stopped']);
/** States in which the agent's process is (or should be) alive. */
export const LIVE = new Set(['starting', 'running', 'needs_you', 'paused', 'idle', 'blocked']);

export class Ledger {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.seq = 0;
    if (fs.existsSync(file)) this.seq = readEvents(file).reduce((m, e) => Math.max(m, e.seq || 0), 0);
  }

  /** Appends synchronously so the file order is the event order, even if Orbit dies right after. */
  append(type, data = {}) {
    const event = { seq: ++this.seq, t: Date.now(), type, ...data };
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n');
    return event;
  }
}

/** Reads a ledger, skipping a torn last line (Orbit died mid-write) or any corrupt line. */
export function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn or corrupt line */ }
  }
  return out;
}

export function emptyRun() {
  return { run: null, agents: {}, order: [] };
}

/** Pure reducer: (state, event) -> state. Mutates and returns `state` for speed. */
export function reduce(state, e) {
  if (e.type === 'run_started') {
    state.run = { id: e.runId, goal: e.goal ?? '', startedAt: e.t, endedAt: null };
    return state;
  }
  if (e.type === 'run_ended') {
    if (state.run) state.run.endedAt = e.t;
    return state;
  }
  if (e.type === 'agent_spawned') {
    state.agents[e.id] = {
      id: e.id, name: e.name, role: e.role ?? '', task: e.task, cwd: e.cwd ?? null, model: e.model ?? null,
      writes: !!e.writes, budget: e.budget ?? {},
      state: 'queued', reason: null, sessionId: null,
      progress: { done: 0, total: 0, step: '' }, activity: '',
      usage: { used: 0, size: 0, cost: 0, model: null },
      needs: null, overBudget: false, report: null,
      createdAt: e.t, startedAt: null, endedAt: null, activeMs: 0, runningSince: null,
    };
    state.order.push(e.id);
    return state;
  }
  const a = state.agents[e.id];
  if (!a) return state;
  switch (e.type) {
    case 'agent_session':
      a.sessionId = e.sessionId;
      break;
    case 'agent_state': {
      // Only time spent working counts: waiting on the user (needs_you) doesn't use the agent's time budget.
      const wasRunning = a.state === 'running';
      const isRunning = e.state === 'running';
      if (wasRunning && !isRunning && a.runningSince) { a.activeMs += e.t - a.runningSince; a.runningSince = null; }
      if (!wasRunning && isRunning) a.runningSince = e.t;
      if (e.state === 'starting' && !a.startedAt) a.startedAt = e.t;
      a.state = e.state;
      a.reason = e.reason ?? null;
      if (e.state !== 'needs_you') a.needs = null;
      if (TERMINAL.has(e.state)) a.endedAt = e.t;
      else a.endedAt = null;
      break;
    }
    case 'agent_progress':
      a.progress = { done: e.done, total: e.total, step: e.step ?? '' };
      break;
    case 'agent_activity':
      a.activity = e.activity;
      break;
    case 'agent_usage':
      a.usage = { used: e.used ?? a.usage.used, size: e.size ?? a.usage.size, cost: e.cost ?? a.usage.cost, model: e.model ?? a.usage.model };
      break;
    case 'agent_needs':
      a.needs = { kind: e.kind, title: e.title, path: e.path ?? null };
      break;
    case 'agent_over_budget':
      a.overBudget = true;
      a.reason = e.reason;
      break;
    case 'agent_report':
      a.report = e.report;
      break;
    default:
      break;
  }
  return state;
}

export function replay(events) {
  return events.reduce(reduce, emptyRun());
}

/** Card view model: what the UI shows for one agent. */
export function toCard(a, now = Date.now()) {
  return {
    id: a.id, name: a.name, role: a.role, task: a.task, state: a.state, reason: a.reason,
    progress: a.progress, activity: a.activity, needs: a.needs, overBudget: a.overBudget,
    cost: a.usage.cost, context: a.usage.size ? { used: a.usage.used, size: a.usage.size } : null,
    model: a.usage.model || a.model,
    elapsedMs: a.activeMs + (a.runningSince ? now - a.runningSince : 0),
    report: a.report,
  };
}
