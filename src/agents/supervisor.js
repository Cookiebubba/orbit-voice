// The Supervisor: deterministic code that owns sub-agent processes for one run. Each sub-agent
// is a child process speaking ACP over stdio (Claude through its ACP adapter, or any ACP agent).
// The Supervisor starts them isolated from the user's Claude Code settings, reads progress from
// the injected orbit.report_progress tool, holds permission requests for the card's "Needs you",
// and implements pause / pause after this step / resume / redirect / stop per agent.
//
// All state lives in the run ledger (ledger.js): every change is an appended event, and the cards
// are re-derived from the events. Process handles are the only thing kept outside it.
// Design and spike results: docs/design/agent-orchestration.md.

import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { Ledger, readEvents, replay, reduce, toCard, TERMINAL } from './ledger.js';

export const PROGRESS_MCP = fileURLToPath(new URL('./progress-mcp.js', import.meta.url));

/** Don't load the user's settings (allow rules, connectors, plugins, bypass mode) into sub-agents. */
export const ISOLATION_META = { claudeCode: { options: { settingSources: [], strictMcpConfig: true, allowDangerouslySkipPermissions: false } } };

/** States that hold a concurrency slot (a turn is running or parked mid-turn). */
const BUSY = new Set(['starting', 'running', 'needs_you', 'paused']);
/** States in which an agent has stopped working and waits for the Conductor or the user. */
const SETTLED = new Set(['done', 'failed', 'stopped', 'blocked', 'idle', 'interrupted']);
const PROGRESS_TOOL = /report_progress/;
const PLACEHOLDER_TITLE = /(…|\.\.\.)$|^Terminal$/;
const MAX_TURN_TEXT = 200_000;
const STOP_GRACE_MS = 5000;

export const REPORT_REMINDER = 'Please end with the report JSON block described in your instructions (status, summary, changes, branch, questions).';

/** Command for the Claude ACP adapter, e.g. claudeAgentCommand(require.resolve(...)). */
export function claudeAgentCommand(adapterScript) {
  return { command: process.execPath, args: [adapterScript], env: {} };
}

export function buildTaskPrompt(a, note) {
  return [
    `You are the "${a.name}" agent${a.role ? ` (${a.role})` : ''} in a team coordinated by Orbit. Other agents handle other tasks and you never talk to them. Work only on your task.`,
    note ? `\n${note}` : '',
    `\nYour task:\n${a.task}`,
    `\nRules:`,
    `- Call the orbit report_progress tool before your first step and after each step: done = steps finished, total = steps planned (revise it if the plan changes), step = what you're doing next, or "finished".`,
    a.writes ? '' : `- This is a read-only task: don't create, edit or delete files.`,
    `- End your final message with one fenced \`\`\`json block:`,
    `{"status": "done | blocked | failed", "summary": "120 words or fewer", "changes": ["files you changed"], "branch": null, "questions": ["what you need answered"], "next": "optional suggestion"}`,
    `- Use "blocked" when you can't continue without an answer, and put the question in "questions".`,
  ].filter(Boolean).join('\n');
}

/** Finds the last valid report block in the agent's final message. */
export function parseReport(text) {
  const candidates = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const brace = text.lastIndexOf('{"status"');
  if (brace >= 0) candidates.push(text.slice(brace, text.lastIndexOf('}') + 1));
  for (const c of candidates.reverse()) {
    try {
      const r = JSON.parse(c);
      if (r && ['done', 'blocked', 'failed'].includes(r.status) && typeof r.summary === 'string') {
        return {
          status: r.status,
          summary: r.summary.slice(0, 2000),
          changes: Array.isArray(r.changes) ? r.changes.map(String).slice(0, 200) : [],
          branch: typeof r.branch === 'string' ? r.branch : null,
          questions: Array.isArray(r.questions) ? r.questions.map(String).slice(0, 20) : [],
          next: typeof r.next === 'string' ? r.next : null,
        };
      }
    } catch { /* not this one */ }
  }
  return null;
}

function slug(name) {
  return String(name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent';
}

function pickOption(options, kind) {
  return options.find((o) => o.kind === kind) ?? options.find((o) => o.kind.startsWith(kind.split('_')[0]));
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

export class Supervisor extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.runDir           folder for ledger.jsonl and agent logs
   * @param {{command:string,args:string[],env?:object}} o.agentCommand
   * @param {boolean} [o.isolate=true]  start sub-agents without the user's Claude Code settings
   * @param {string} [o.mode='default'] permission mode set on every session
   * @param {string} [o.model]          default model (matched against the agent's model options)
   * @param {number} [o.maxConcurrent=4]
   * @param {(agent, request) => boolean} [o.autoApprove] permission policy; unapproved requests go to the card
   */
  constructor({ runDir, agentCommand, isolate = true, mode = 'default', model = null, maxConcurrent = 4, autoApprove = null, budgetCheckMs = 1000 }) {
    super();
    this.runDir = runDir;
    this.agentCommand = agentCommand;
    this.isolate = isolate;
    this.mode = mode;
    this.model = model;
    this.maxConcurrent = maxConcurrent;
    this.autoApprove = autoApprove;
    this.ledger = new Ledger(path.join(runDir, 'ledger.jsonl'));
    this.state = replay(readEvents(this.ledger.file));
    this.rt = new Map();
    this.closed = false;
    this.deferQueue = false;
    this.budgetTimer = setInterval(() => { for (const id of this.state.order) this.#checkBudget(id); }, budgetCheckMs);
    this.budgetTimer.unref?.();
  }

  /** Starts a new run in runsDir/<runId>. */
  static create({ runsDir, goal = '', ...opts }) {
    const runId = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const sup = new Supervisor({ runDir: path.join(runsDir, runId), ...opts });
    sup.#record('run_started', { runId, goal });
    return sup;
  }

  /**
   * Re-opens a run after Orbit stopped (crash or quit). Agents that were mid-work lost their
   * process, so they become "interrupted"; restart(id) continues them. Queued agents stay queued
   * until resumeQueue().
   */
  static open(runDir, opts) {
    const sup = new Supervisor({ runDir, ...opts });
    sup.deferQueue = true;
    for (const id of sup.state.order) {
      const a = sup.state.agents[id];
      if (BUSY.has(a.state)) sup.#record('agent_state', { id, state: 'interrupted', reason: `Orbit stopped while this agent was ${a.state}` });
    }
    return sup;
  }

  // ---- Queries ----------------------------------------------------------------

  get runId() { return this.state.run?.id ?? null; }
  agent(id) { return this.state.agents[id] ?? null; }
  card(id) { const a = this.agent(id); return a ? toCard(a) : null; }
  cards() { return this.state.order.map((id) => toCard(this.state.agents[id])); }

  /** Resolves with the cards once all (or any) of `ids` have settled. */
  wait(ids = this.state.order, mode = 'all') {
    const settled = () => {
      const s = ids.map((id) => this.agent(id)).filter(Boolean).map((a) => SETTLED.has(a.state));
      return mode === 'any' ? s.some(Boolean) : s.every(Boolean);
    };
    return new Promise((resolve) => {
      if (settled()) return resolve(ids.map((id) => this.card(id)));
      const on = () => { if (settled()) { this.off('event', on); resolve(ids.map((id) => this.card(id))); } };
      this.on('event', on);
    });
  }

  // ---- Commands ---------------------------------------------------------------

  /** @returns {string} the new agent's id */
  spawn({ name, task, role = '', writes = false, cwd = null, budget = {}, model = null }) {
    if (!task) throw new Error('task is required');
    let id = slug(name);
    for (let n = 2; this.state.agents[id]; n++) id = `${slug(name)}-${n}`;
    this.#record('agent_spawned', { id, name: name || id, task, role, writes, cwd: cwd ?? this.runDir, budget, model: model ?? this.model });
    this.#pump();
    return id;
  }

  /** Pause now (cancel the turn, keep the session) or after the current step (hold the next progress call). */
  async pause(id, { when = 'now' } = {}) {
    const a = this.#need(id);
    const rt = this.rt.get(id);
    if (a.state === 'queued') return this.#record('agent_state', { id, state: 'stopped', reason: 'removed from the queue' });
    if (!rt?.turn) return;
    if (a.state === 'paused' || (when === 'step' && rt.softPause)) return; // already paused or pausing
    this.#record('control', { id, action: when === 'step' ? 'pause_step' : 'pause' });
    if (when === 'step') {
      rt.softPause = 'paused by you after a step';
      if (a.state === 'running') this.#record('agent_state', { id, state: 'running', reason: 'pausing after this step' });
      return;
    }
    if (rt.held?.kind === 'step') return; // already parked at a step boundary
    rt.intent = 'pause';
    await this.#cancelTurn(id);
  }

  async resume(id) {
    const a = this.#need(id);
    const rt = this.rt.get(id);
    this.#record('control', { id, action: 'resume' });
    if (a.state === 'interrupted') return this.restart(id);
    if (rt?.held?.kind === 'step') {
      rt.softPause = null;
      this.#release(id, 'allow_once');
      this.#record('agent_state', { id, state: 'running' });
      return;
    }
    if (rt?.turn) { rt.softPause = null; return; } // "pausing after this step" was requested; cancel it
    if (['paused', 'idle', 'blocked'].includes(a.state)) return this.#prompt(id, 'Continue where you left off.');
  }

  /** Cancel whatever the agent is doing and give it a new instruction in the same session. */
  async redirect(id, text) {
    const a = this.#need(id);
    if (!text?.trim()) throw new Error('redirect text is required');
    if (!this.rt.get(id)?.conn) throw new Error(`${id} has no live session (state ${a.state})`);
    this.#record('control', { id, action: 'redirect', text });
    const rt = this.rt.get(id);
    if (rt.turn) { rt.intent = 'redirect'; await this.#cancelTurn(id); }
    rt.softPause = null;
    return this.#prompt(id, `Change of plan from the user: ${text.trim()}\n\nKeep reporting progress with report_progress, and end with the report JSON block as before.`);
  }

  /**
   * Ask an agent that isn't mid-turn a question (e.g. the Conductor wanting detail). Resolves
   * with its answer; the card returns to the state it was in. No report is expected.
   */
  async message(id, text) {
    const a = this.#need(id);
    const rt = this.rt.get(id);
    if (!rt?.conn) throw new Error(`${id} has no live session (state ${a.state})`);
    if (rt.turn) throw new Error(`${id} is busy; use redirect to interrupt it`);
    this.#record('control', { id, action: 'message', text });
    const query = { state: a.state, reason: a.reason, answer: null };
    rt.query = query;
    await this.#prompt(id, text);
    return query.answer;
  }

  /** Answer a held permission request (the card's "Needs you"). */
  answer(id, allow) {
    const rt = this.rt.get(id);
    if (rt?.held?.kind !== 'permission') throw new Error(`${id} isn't waiting for a permission answer`);
    this.#record('control', { id, action: allow ? 'approve' : 'deny', title: rt.held.title });
    this.#release(id, allow ? 'allow_once' : 'reject_once');
    this.#record('agent_state', { id, state: 'running' });
  }

  async stop(id) {
    const a = this.#need(id);
    const rt = this.rt.get(id);
    this.#record('control', { id, action: 'stop' });
    if (rt) {
      rt.intent = 'stop';
      if (rt.turn) await Promise.race([this.#cancelTurn(id), new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
      killTree(rt.child);
    }
    if (!TERMINAL.has(a.state)) this.#record('agent_state', { id, state: 'stopped', reason: 'stopped by you' });
    this.#pump();
  }

  /** Start an interrupted, failed or stopped agent again in a new process. */
  restart(id) {
    const a = this.#need(id);
    if (this.rt.get(id)?.child?.exitCode === null) throw new Error(`${id} is still running`);
    this.rt.delete(id);
    const p = a.progress;
    const note = `Note: you were interrupted (${a.reason ?? a.state}) and are being restarted.` +
      (p.total ? ` Progress so far: ${p.done} of ${p.total} steps; next was "${p.step}".` : '') +
      ` Work you already wrote is on disk: check it before redoing anything.`;
    this.#record('agent_state', { id, state: 'queued', reason: 'restarting' });
    this.rt.set(id, { restartNote: note });
    this.#pump();
  }

  /** Start queued agents after open(). */
  resumeQueue() { this.deferQueue = false; this.#pump(); }

  endRun(summary = null) {
    this.#record('run_ended', { summary });
  }

  /** Kill every agent process. Does not record anything, so a later open() sees them as interrupted. */
  async shutdown() {
    this.closed = true;
    clearInterval(this.budgetTimer);
    const exits = [];
    for (const rt of this.rt.values()) {
      if (rt.child && rt.child.exitCode === null) {
        rt.intent = 'shutdown';
        exits.push(new Promise((r) => rt.child.once('exit', r)));
        killTree(rt.child);
      }
    }
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 3000))]);
  }

  // ---- Internals --------------------------------------------------------------

  #need(id) {
    const a = this.agent(id);
    if (!a) throw new Error(`no agent ${id}`);
    return a;
  }

  #record(type, data = {}) {
    const ev = this.ledger.append(type, data);
    reduce(this.state, ev);
    this.emit('event', ev);
    return ev;
  }

  #pump() {
    if (this.closed) return;
    let busy = this.state.order.filter((id) => BUSY.has(this.state.agents[id].state)).length;
    for (const id of this.state.order) {
      if (busy >= this.maxConcurrent) break;
      if (this.state.agents[id].state !== 'queued') continue;
      if (this.deferQueue && !this.rt.get(id)?.restartNote) continue;
      busy++;
      this.#start(id);
    }
  }

  async #start(id) {
    const a = this.state.agents[id];
    const prior = this.rt.get(id);
    const rt = { child: null, conn: null, sessionId: null, turn: null, turnText: '', held: null, softPause: null, intent: null, reportRetry: false, tools: new Map(), sawOrbitProgress: false, exited: false };
    this.rt.set(id, rt);
    this.#record('agent_state', { id, state: 'starting' });
    try {
      const cmd = this.agentCommand;
      fs.mkdirSync(path.join(this.runDir, 'agents'), { recursive: true });
      rt.child = spawn(cmd.command, cmd.args ?? [], { cwd: a.cwd, env: { ...process.env, ...cmd.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      rt.child.stderr.pipe(fs.createWriteStream(path.join(this.runDir, 'agents', `${id}.stderr.log`), { flags: 'a' }));
      rt.child.on('exit', (code, signal) => this.#onExit(id, rt, code ?? signal));
      rt.child.on('error', (e) => this.#fail(id, rt, `couldn't start the agent: ${e.message}`));
      rt.conn = new acp.ClientSideConnection(() => ({
        sessionUpdate: async (n) => this.#onUpdate(id, rt, n.update),
        requestPermission: (p) => this.#onPermission(id, rt, p),
      }), acp.ndJsonStream(Writable.toWeb(rt.child.stdin), Readable.toWeb(rt.child.stdout)));

      await rt.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
      const ns = await rt.conn.newSession({
        cwd: a.cwd,
        mcpServers: [{ name: 'orbit', command: process.execPath, args: [PROGRESS_MCP], env: [] }],
        ...(this.isolate && { _meta: ISOLATION_META }),
      });
      rt.sessionId = ns.sessionId;
      this.#record('agent_session', { id, sessionId: ns.sessionId });

      if (this.mode && ns.modes?.availableModes?.some((m) => m.id === this.mode) && ns.modes.currentModeId !== this.mode) {
        await rt.conn.setSessionMode({ sessionId: ns.sessionId, modeId: this.mode });
      }
      if (a.model) {
        const opt = (ns.configOptions ?? []).find((o) => o.category === 'model' || o.id === 'model');
        const flat = (opt?.options ?? []).flatMap((o) => o.options ?? [o]);
        const want = a.model.toLowerCase();
        const hit = flat.find((o) => String(o.value).toLowerCase() === want) ?? flat.find((o) => `${o.value} ${o.name}`.toLowerCase().includes(want));
        if (hit && hit.value !== opt.currentValue) await rt.conn.setSessionConfigOption({ sessionId: ns.sessionId, configId: opt.id, value: hit.value });
        else if (!hit) this.#record('agent_activity', { id, activity: `Model "${a.model}" isn't offered; using ${opt?.currentValue ?? 'the default'}` });
      }
      await this.#prompt(id, buildTaskPrompt(a, prior?.restartNote));
    } catch (e) {
      this.#fail(id, rt, `couldn't start the session: ${e.message}`);
    }
  }

  #prompt(id, text) {
    const rt = this.rt.get(id);
    rt.turnText = '';
    rt.intent = null;
    this.#record('agent_state', { id, state: 'running' });
    const turn = rt.conn.prompt({ sessionId: rt.sessionId, prompt: [{ type: 'text', text }] })
      .then((r) => this.#onTurnEnd(id, rt, r.stopReason), (e) => this.#onTurnError(id, rt, e))
      .finally(() => { if (rt.turn === turn) rt.turn = null; });
    rt.turn = turn;
    return turn;
  }

  async #cancelTurn(id) {
    const rt = this.rt.get(id);
    const turn = rt?.turn;
    if (!turn) return;
    const cancelled = rt.conn.cancel({ sessionId: rt.sessionId }).catch(() => {});
    this.#release(id, null); // ACP: after session/cancel, pending permission requests are answered "cancelled"
    await cancelled;
    await turn;
  }

  /** Answers the held request with the given option kind, or "cancelled" when kind is null. */
  #release(id, kind) {
    const rt = this.rt.get(id);
    const held = rt?.held;
    if (!held) return;
    rt.held = null;
    const opt = kind && pickOption(held.options, kind);
    held.resolve(opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  #onTurnEnd(id, rt, stopReason) {
    if (this.rt.get(id) !== rt || this.closed) return;
    rt.turn = null; // before any event goes out, so listeners can message the agent right away
    const intent = rt.intent;
    rt.intent = null;
    this.#release(id, null);
    const query = rt.query;
    rt.query = null;
    if (query && stopReason !== 'cancelled') {
      query.answer = rt.turnText.trim();
      this.#record('agent_answer', { id, answer: query.answer.slice(0, 4000) });
      this.#record('agent_state', { id, state: query.state, reason: query.reason });
      return this.#pump();
    }
    if (stopReason === 'cancelled') {
      if (intent === 'stop' || intent === 'redirect' || intent === 'shutdown') return;
      this.#record('agent_state', { id, state: intent === 'pause' ? 'paused' : 'idle', reason: intent === 'pause' ? 'paused by you' : 'the agent cancelled its turn' });
      return this.#pump();
    }
    if (stopReason !== 'end_turn') {
      this.#record('agent_state', { id, state: 'failed', reason: `turn ended: ${stopReason}` });
      return this.#pump();
    }
    rt.softPause = null;
    const report = parseReport(rt.turnText);
    if (report) {
      rt.reportRetry = false;
      this.#record('agent_report', { id, report });
      this.#record('agent_state', { id, state: report.status, reason: report.status === 'blocked' ? report.questions[0] ?? 'needs an answer' : null });
      return this.#pump();
    }
    if (!rt.reportRetry) {
      rt.reportRetry = true;
      this.#record('agent_activity', { id, activity: 'Asked for the missing report' });
      this.#prompt(id, REPORT_REMINDER);
      return;
    }
    rt.reportRetry = false;
    this.#record('agent_report', { id, report: { status: 'failed', summary: rt.turnText.trim().slice(-600), changes: [], branch: null, questions: [], next: null, malformed: true } });
    this.#record('agent_state', { id, state: 'failed', reason: 'no valid report after one reminder' });
    this.#pump();
  }

  #onTurnError(id, rt, e) {
    if (this.rt.get(id) !== rt) return;
    rt.turn = null;
    if (rt.exited || rt.intent === 'stop' || rt.intent === 'shutdown') return;
    if (rt.intent) return this.#onTurnEnd(id, rt, 'cancelled'); // an agent that errors on cancel still stopped
    const reason = e?.message ?? String(e);
    // A dying agent closes the connection just before its exit event; let onExit report the exit code.
    if (/connection closed/i.test(reason)) return setTimeout(() => { if (!rt.exited) this.#fail(id, rt, reason); }, 500);
    this.#fail(id, rt, reason);
  }

  #onExit(id, rt, code) {
    rt.exited = true;
    if (this.rt.get(id) !== rt) return;
    this.#release(id, null);
    if (rt.intent === 'stop' || rt.intent === 'shutdown' || this.closed) return;
    const a = this.state.agents[id];
    if (!TERMINAL.has(a.state)) this.#record('agent_state', { id, state: 'failed', reason: `agent process exited (${code})` });
    else rt.conn = null; // done agents lose follow-ups once their process is gone
    this.#pump();
  }

  #fail(id, rt, reason) {
    if (this.rt.get(id) !== rt) return;
    const a = this.state.agents[id];
    if (TERMINAL.has(a.state)) return;
    this.#record('agent_state', { id, state: 'failed', reason });
    killTree(rt.child);
    this.#pump();
  }

  #onUpdate(id, rt, u) {
    if (this.rt.get(id) !== rt || this.closed) return;
    const a = this.state.agents[id];
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text' && rt.turnText.length < MAX_TURN_TEXT) rt.turnText += u.content.text;
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const prev = rt.tools.get(u.toolCallId) ?? { first: u.title ?? '', title: '', input: {} };
        if (u.title) prev.title = u.title;
        if (u.rawInput && typeof u.rawInput === 'object') prev.input = { ...prev.input, ...u.rawInput };
        rt.tools.set(u.toolCallId, prev);
        if (PROGRESS_TOOL.test(prev.first) || PROGRESS_TOOL.test(prev.title)) {
          this.#progressFrom(id, rt, prev.input);
        } else if (prev.title && !PLACEHOLDER_TITLE.test(prev.title) && u.status !== 'completed' && prev.title !== a.activity) {
          this.#record('agent_activity', { id, activity: prev.title.split('\n')[0].slice(0, 160) });
        }
        if (u.status === 'completed' || u.status === 'failed') rt.tools.delete(u.toolCallId);
        break;
      }
      case 'plan':
        if (!rt.sawOrbitProgress && Array.isArray(u.entries)) {
          const done = u.entries.filter((e) => e.status === 'completed').length;
          const cur = u.entries.find((e) => e.status === 'in_progress');
          this.#progressFrom(id, rt, { done, total: u.entries.length, step: cur?.content ?? '' }, false);
        }
        break;
      case 'usage_update': {
        const cost = u.cost?.amount;
        const model = u._meta?.['_claude/model'];
        if (u.used !== a.usage.used || (cost !== undefined && cost !== a.usage.cost) || (model && model !== a.usage.model)) {
          this.#record('agent_usage', { id, used: u.used, size: u.size, cost, model });
          this.#checkBudget(id);
        }
        break;
      }
      default:
        break;
    }
  }

  #progressFrom(id, rt, input, fromOrbit = true) {
    const { done, total, step } = input ?? {};
    if (typeof done !== 'number' || typeof total !== 'number' || typeof step !== 'string') return; // still streaming
    if (fromOrbit) rt.sawOrbitProgress = true;
    const p = this.state.agents[id].progress;
    if (p.done !== done || p.total !== total || p.step !== step) this.#record('agent_progress', { id, done, total, step });
  }

  #onPermission(id, rt, p) {
    if (this.rt.get(id) !== rt || this.closed) return { outcome: { outcome: 'cancelled' } };
    const a = this.state.agents[id];
    const tracked = rt.tools.get(p.toolCall?.toolCallId);
    const title = p.toolCall?.title || tracked?.title || tracked?.first || 'Tool call';
    if (PROGRESS_TOOL.test(title) || PROGRESS_TOOL.test(tracked?.first ?? '')) {
      this.#progressFrom(id, rt, p.toolCall?.rawInput ?? tracked?.input);
      if (!rt.softPause) return { outcome: { outcome: 'selected', optionId: pickOption(p.options, 'allow_once').optionId } };
      // "Pause after this step": park the agent on its step boundary.
      const reason = rt.softPause;
      return new Promise((resolve) => {
        rt.held = { kind: 'step', resolve, options: p.options, title };
        this.#record('agent_state', { id, state: 'paused', reason });
      });
    }
    if (rt.intent) return { outcome: { outcome: 'cancelled' } };
    if (this.autoApprove?.(toCard(a), p)) {
      return { outcome: { outcome: 'selected', optionId: pickOption(p.options, 'allow_once').optionId } };
    }
    return new Promise((resolve) => {
      rt.held = { kind: 'permission', resolve, options: p.options, title };
      this.#record('agent_needs', { id, kind: 'permission', title, path: p.toolCall?.locations?.[0]?.path ?? null });
      this.#record('agent_state', { id, state: 'needs_you', reason: title });
    });
  }

  #checkBudget(id) {
    const a = this.state.agents[id];
    const rt = this.rt.get(id);
    if (!a || a.overBudget || !rt?.turn) return;
    const b = a.budget ?? {};
    const elapsed = toCard(a).elapsedMs;
    let reason = null;
    if (b.costUsd && a.usage.cost >= b.costUsd) reason = `over budget: $${a.usage.cost.toFixed(2)} of $${b.costUsd.toFixed(2)}`;
    else if (b.ms && elapsed >= b.ms) reason = `over time budget: ${Math.round(elapsed / 1000)}s of ${Math.round(b.ms / 1000)}s`;
    else if (b.contextTokens && a.usage.used >= b.contextTokens) reason = `over context budget: ${a.usage.used} tokens`;
    if (!reason) return;
    this.#record('agent_over_budget', { id, reason });
    rt.softPause = reason;
  }
}
