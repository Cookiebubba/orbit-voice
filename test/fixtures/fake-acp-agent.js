#!/usr/bin/env node
// A scripted ACP agent for the Supervisor tests. It speaks real ACP (the SDK's agent side) and
// behaves like the Claude adapter did in the spike: it reports progress through the injected
// orbit.report_progress tool (and waits for that permission), streams tool calls with a
// placeholder title first, emits usage_update with a running cost, honours session/cancel, and
// remembers everything within a session.
//
// The task text carries a directive that sets the script, e.g.
//   [fake steps=4 stepMs=30 codeword=ORCHID write=ask report=good costPerStep=0.05 crashAt=0]
//   report: good | bad (never valid) | badOnce (valid only after one reminder)
//   write:  auto | ask (request permission for each file write)
// FAKE_RECORD=<file>: append what the client sent (session/new, mode, config) as JSON lines.

import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const record = (kind, data) => {
  if (process.env.FAKE_RECORD) fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ pid: process.pid, kind, ...data }) + '\n');
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new Error('aborted'));
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

function parseDirective(text) {
  const m = /\[fake([^\]]*)\]/.exec(text);
  if (!m) return null;
  const cfg = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)=(\S+)/g)) cfg[k] = /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  return cfg;
}

const promptText = (p) => p.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
let callSeq = 0;

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
    this.sessions = new Map();
  }

  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false }, agentInfo: { name: 'fake-acp-agent', version: '1.0.0' } };
  }

  async newSession(params) {
    const sessionId = `fake-${process.pid}-${this.sessions.size + 1}`;
    record('newSession', { mcpServers: params.mcpServers?.map((s) => s.name), meta: params._meta ?? null, cwd: params.cwd });
    this.sessions.set(sessionId, {
      cfg: { steps: 3, stepMs: 20, write: 'auto', report: 'good', costPerStep: 0.01, crashAt: 0 },
      done: 0, codeword: null, redirect: null, denied: [], cost: 0, used: 20000, reminded: false, abort: null,
    });
    return {
      sessionId,
      modes: { currentModeId: 'bypassPermissions', availableModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'].map((id) => ({ id, name: id })) },
      configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fable', options: [{ value: 'fable', name: 'Fable' }, { value: 'sonnet', name: 'Sonnet' }] }],
    };
  }

  async authenticate() { return {}; }
  async setSessionMode(p) { record('setSessionMode', { modeId: p.modeId }); return {}; }
  async setSessionConfigOption(p) { record('setSessionConfigOption', { configId: p.configId, value: p.value }); return { configOptions: [] }; }

  async cancel(p) {
    this.sessions.get(p.sessionId)?.abort?.abort();
  }

  update(sessionId, update) {
    return this.conn.sessionUpdate({ sessionId, update });
  }

  async say(sessionId, text) {
    await this.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  }

  async progress(sessionId, s, signal, step) {
    const toolCallId = `p${++callSeq}`;
    const rawInput = { done: s.done, total: s.cfg.steps, step };
    // Streamed like the real adapter: empty input first, then the arguments.
    await this.update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'mcp__orbit__report_progress', kind: 'other', status: 'pending', rawInput: {} });
    await this.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, rawInput });
    const res = await this.conn.requestPermission({
      sessionId,
      toolCall: { toolCallId, title: 'mcp__orbit__report_progress', kind: 'other', status: 'pending', rawInput },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
    });
    if (signal.aborted || res.outcome.outcome === 'cancelled') throw new Error('aborted');
    await this.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
  }

  async writeStep(sessionId, s, signal, n) {
    const toolCallId = `w${++callSeq}`;
    const name = `step-${n}.txt`;
    const title = s.redirect ? `Write ${name} (redirected: ${s.redirect})` : `Write ${name}`;
    await this.update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'Preparing file…', kind: 'edit', status: 'pending', rawInput: {} });
    await this.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, title, locations: [{ path: `/work/${name}` }], rawInput: { file_path: `/work/${name}` } });
    if (s.cfg.write === 'ask') {
      const res = await this.conn.requestPermission({
        sessionId,
        toolCall: { toolCallId, title, kind: 'edit', status: 'pending', locations: [{ path: `/work/${name}` }], rawInput: { file_path: `/work/${name}` } },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      });
      if (signal.aborted || res.outcome.outcome === 'cancelled') throw new Error('aborted');
      if (res.outcome.optionId === 'reject') {
        s.denied.push(name);
        await this.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
        return;
      }
    }
    if (s.cfg.crashAt === n) process.exit(3);
    await sleep(s.cfg.stepMs, signal);
    await this.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
    s.cost += s.cfg.costPerStep;
    s.used += 1000;
    await this.update(sessionId, { sessionUpdate: 'usage_update', used: s.used, size: 1000000, cost: { amount: s.cost, currency: 'USD' }, _meta: { '_claude/model': 'fake-sonnet' } });
  }

  report(s) {
    return {
      status: s.denied.length ? 'blocked' : 'done',
      summary: `Wrote ${s.done} step files${s.redirect ? ` (redirected: ${s.redirect})` : ''}.`,
      changes: Array.from({ length: s.done }, (_, i) => `step-${i + 1}.txt`).filter((f) => !s.denied.includes(f)),
      branch: null,
      questions: s.denied.length ? [`Write denied for ${s.denied.join(', ')}; skip or retry?`] : [],
    };
  }

  async prompt(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error(`no session ${params.sessionId}`);
    const text = promptText(params);
    s.abort = new AbortController();
    const { signal } = s.abort;
    const sid = params.sessionId;
    try {
      const cfg = parseDirective(text);
      if (cfg) Object.assign(s.cfg, cfg);
      if (cfg?.codeword) s.codeword = cfg.codeword;
      const change = /Change of plan from the user:\s*(.+)/s.exec(text);
      if (change) s.redirect = change[1].trim().split('\n')[0].slice(0, 60);

      if (/what'?s the codeword/i.test(text)) {
        await this.say(sid, `The codeword is ${s.codeword}. I had finished ${s.done} of ${s.cfg.steps} steps.`);
        return { stopReason: 'end_turn' };
      }
      if (/report JSON block/i.test(text) && s.done >= s.cfg.steps) {
        s.reminded = true;
      } else {
        while (s.done < s.cfg.steps) {
          await this.progress(sid, s, signal, `Write step-${s.done + 1}.txt`);
          await this.writeStep(sid, s, signal, s.done + 1);
          s.done++;
        }
        await this.progress(sid, s, signal, 'finished');
      }
      const valid = s.cfg.report === 'good' || (s.cfg.report === 'badOnce' && s.reminded);
      await this.say(sid, `All done.\n\n${valid ? '```json\n' + JSON.stringify(this.report(s), null, 2) + '\n```' : 'Report: everything went fine (no JSON, oops).'}`);
      return { stopReason: 'end_turn' };
    } catch (e) {
      if (signal.aborted || e.message === 'aborted') return { stopReason: 'cancelled' };
      throw e;
    } finally {
      s.abort = null;
    }
  }
}

new acp.AgentSideConnection((conn) => new FakeAgent(conn), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
