// Read side of Orbit Agents for the card view. It reads run ledgers straight from disk and tails
// them, so the view works whether the Supervisor lives in Orbit's own process or another one
// (a test script, a future background worker). Nothing here can change a run.

import fs from 'node:fs';
import path from 'node:path';
import { readEvents, replay, reduce, emptyRun, toCard, TERMINAL } from './ledger.js';

export const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SETTLED = new Set([...TERMINAL, 'blocked', 'idle', 'interrupted']);
const FEED_TYPES = new Set(['run_started', 'run_ended', 'agent_spawned', 'agent_state', 'agent_report', 'agent_needs', 'agent_over_budget', 'control']);
const FEED_LIMIT = 200;

const STATE_WORDS = {
  queued: 'is queued', starting: 'is starting', running: 'is running', needs_you: 'needs you', paused: 'paused',
  idle: 'stopped its turn', blocked: 'is blocked', done: 'finished', failed: 'failed', stopped: 'was stopped', interrupted: 'was interrupted',
};
const CONTROL_WORDS = {
  pause: 'You paused', pause_step: 'You asked to pause after this step:', resume: 'You resumed', redirect: 'You redirected',
  stop: 'You stopped', approve: 'You approved a request from', deny: 'You denied a request from', message: 'Asked',
};

/** One line for the activity feed, or null for events the feed skips. */
export function feedEntry(e, prevState) {
  if (!FEED_TYPES.has(e.type)) return null;
  const base = { seq: e.seq, t: e.t, id: e.id ?? null, type: e.type };
  switch (e.type) {
    case 'run_started': return { ...base, text: `Run started${e.goal ? `: ${e.goal}` : ''}` };
    case 'run_ended': return { ...base, text: 'Run ended' };
    case 'agent_spawned': return { ...base, text: `Spawned ${e.id}: ${e.task.split('\n')[0].slice(0, 120)}` };
    case 'agent_state':
      // Skip the noise: running after starting/needs_you, and repeated states.
      if (e.state === 'running' && ['starting', 'needs_you', 'running', 'queued'].includes(prevState)) return null;
      if (e.state === 'starting' || e.state === prevState) return null;
      if (e.state === 'done') return null; // the report line just before says it
      return { ...base, state: e.state, text: `${e.id} ${STATE_WORDS[e.state] ?? e.state}${e.reason ? `: ${String(e.reason).split('\n')[0].slice(0, 140)}` : ''}` };
    case 'agent_report': return { ...base, text: `${e.id} reported ${e.report.status}: ${e.report.summary.slice(0, 200)}` };
    case 'agent_needs': return null; // covered by the needs_you state line
    case 'agent_over_budget': return { ...base, text: `${e.id} hit its budget (${e.reason}); pausing after this step` };
    case 'control': {
      const words = CONTROL_WORDS[e.action] ?? e.action;
      if (e.action === 'message') return { ...base, text: `Asked ${e.id}: ${String(e.text ?? '').slice(0, 120)}` };
      if (e.action === 'redirect') return { ...base, you: true, text: `You redirected ${e.id}: “${String(e.text ?? '').slice(0, 160)}”` };
      return { ...base, you: true, text: `${words} ${e.id}` };
    }
    default: return null;
  }
}

function buildFeed(events) {
  const states = {};
  const feed = [];
  for (const e of events) {
    const f = feedEntry(e, e.id ? states[e.id] : undefined);
    if (e.type === 'agent_spawned') states[e.id] = 'queued';
    if (e.type === 'agent_state') states[e.id] = e.state;
    if (f) feed.push(f);
  }
  return feed.slice(-FEED_LIMIT);
}

export function cardOf(a, now = Date.now()) {
  return { ...toCard(a, now), ticking: !!a.runningSince, asOf: now };
}

function runSummary(id, state) {
  const agents = Object.values(state.agents);
  return {
    id,
    goal: state.run?.goal ?? '',
    startedAt: state.run?.startedAt ?? null,
    endedAt: state.run?.endedAt ?? null,
    agents: agents.length,
    active: agents.filter((a) => !SETTLED.has(a.state)).length,
    needsYou: agents.filter((a) => a.state === 'needs_you').length,
    cost: agents.reduce((s, a) => s + (a.usage.cost || 0), 0),
  };
}

export function createAgentsHub({ runsDir, pollMs = 250 }) {
  const watchers = new Map(); // runId -> { file, offset, partial, state, feedStates, subs, timer }

  const ledgerFile = (id) => {
    if (typeof id !== 'string' || !RUN_ID.test(id)) return null;
    const file = path.join(runsDir, id, 'ledger.jsonl');
    return path.resolve(file).startsWith(path.resolve(runsDir) + path.sep) && fs.existsSync(file) ? file : null;
  };

  function listRuns() {
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && RUN_ID.test(d.name) && fs.existsSync(path.join(runsDir, d.name, 'ledger.jsonl')))
      .map((d) => runSummary(d.name, replay(readEvents(path.join(runsDir, d.name, 'ledger.jsonl')))))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  function snapshot(id) {
    const file = ledgerFile(id);
    if (!file) return null;
    const events = readEvents(file);
    const state = replay(events);
    const now = Date.now();
    return { type: 'snapshot', run: runSummary(id, state), cards: state.order.map((aid) => cardOf(state.agents[aid], now)), feed: buildFeed(events) };
  }

  function poll(id, w) {
    let size;
    try { size = fs.statSync(w.file).size; } catch { return; }
    if (size < w.offset) { // rewritten: start over
      Object.assign(w, { offset: 0, partial: '', state: emptyRun(), feedStates: {} });
      const snap = snapshot(id);
      w.offset = size;
      w.state = replay(readEvents(w.file));
      for (const s of w.subs) s(snap);
      return;
    }
    if (size === w.offset) return;
    const fd = fs.openSync(w.file, 'r');
    const buf = Buffer.alloc(size - w.offset);
    fs.readSync(fd, buf, 0, buf.length, w.offset);
    fs.closeSync(fd);
    w.offset = size;
    const lines = (w.partial + buf.toString('utf8')).split('\n');
    w.partial = lines.pop(); // an incomplete last line waits for the next poll
    const changed = new Set();
    const feed = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const f = feedEntry(e, e.id ? w.feedStates[e.id] : undefined);
      if (e.type === 'agent_spawned') w.feedStates[e.id] = 'queued';
      if (e.type === 'agent_state') w.feedStates[e.id] = e.state;
      if (f) feed.push(f);
      reduce(w.state, e);
      if (e.id) changed.add(e.id);
    }
    if (!changed.size && !feed.length) return;
    const now = Date.now();
    const msg = { type: 'update', run: runSummary(id, w.state), cards: [...changed].filter((a) => w.state.agents[a]).map((a) => cardOf(w.state.agents[a], now)), order: w.state.order, feed };
    for (const s of w.subs) s(msg);
  }

  /** Streams a snapshot, then updates as the ledger grows. Returns an unsubscribe function. */
  function subscribe(id, send) {
    const file = ledgerFile(id);
    if (!file) return null;
    let w = watchers.get(id);
    if (!w) {
      const events = readEvents(file);
      const feedStates = {};
      for (const e of events) {
        if (e.type === 'agent_spawned') feedStates[e.id] = 'queued';
        if (e.type === 'agent_state') feedStates[e.id] = e.state;
      }
      w = { file, offset: fs.statSync(file).size, partial: '', state: replay(events), feedStates, subs: new Set() };
      w.timer = setInterval(() => poll(id, w), pollMs);
      w.timer.unref?.();
      watchers.set(id, w);
    }
    send(snapshot(id));
    w.subs.add(send);
    return () => {
      w.subs.delete(send);
      if (!w.subs.size) { clearInterval(w.timer); watchers.delete(id); }
    };
  }

  function close() {
    for (const w of watchers.values()) clearInterval(w.timer);
    watchers.clear();
  }

  return { runsDir, listRuns, snapshot, subscribe, close };
}
