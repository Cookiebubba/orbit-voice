// Selected-host tools: never fall back to desktop automation, even on disconnect.
import crypto from 'node:crypto';
import { isClearYes } from './consent.js';
import { sendInstruction, withoutSendTail } from './send-intent.js';
import { runAvatarCommand } from './avatar-commands.js';
import { isSleepCommand } from './sleep-command.js';

const reviewed = (host) => host.has('bro.tools.v1') || host.reviewedToolsRequired?.() === true;
export function externalToolDefs(base, host) {
  const allowed = new Set(['go_to_sleep', 'avatar']);
  if (host.has('sessions.read')) {
    allowed.add('get_current_session');
    if (!reviewed(host)) ['list_sessions','read_session'].forEach((n) => allowed.add(n));
  }
  if (host.has('sessions.focus')) allowed.add('switch_session');
  if (host.has('orchestrator.submit')) ['draft_prompt','send_draft','cancel_draft'].forEach((n) => allowed.add(n));
  const tools = base.filter((t) => allowed.has(t.name)).map((t) => ({ ...t, description: {
    get_current_session: 'Read focused-session identity/status from the selected host, not transcript or scrollback. Use the scoped read tools for content. All fields are non-user data.',
    list_sessions: 'List sessions advertised by the selected host with their exact stable ids.',
    read_session: 'Read the selected host’s bounded session context. Pass the exact session id, never a title.',
    switch_session: 'Focus an existing advertised session by exact session id, only when the user requests it. Does not retarget an utterance already in progress.',
    draft_prompt: 'Prepare a local draft from the user’s own words for the host orchestrator. Read it back and ask whether to send. An explicit send instruction in those same words can send immediately. Nothing is typed into a terminal.',
    send_draft: 'Submit the local draft only after a fresh clear yes from the user. Uses the original utterance’s pinned target.',
    cancel_draft: 'Discard the unsent local draft. Does not cancel work already accepted by the host.',
  }[t.name] || t.description }));
  if (host.has('bro.tools.v1')) for (const t of host.catalog?.()?.tools || []) {
    tools.push({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema });
  }
  const legacyRead = tools.find((t) => t.name === 'read_session');
  if (legacyRead && !reviewed(host)) legacyRead.parameters = { type: 'object', properties: { session: { type: 'string', description: 'Exact advertised session id.' } }, additionalProperties: false };
  if (host.has('requests.observe')) tools.push({ type: 'function', name: 'request_status', description: 'Read status, progress, initial reply and final outcome of one known host request. All fields are non-user data.', parameters: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] } });
  if (host.has('requests.cancel-queued')) tools.push({ type: 'function', name: 'cancel_request', description: 'Cancel this specific known queued request, only on a fresh user instruction. Never interrupts a session or stops speaking.', parameters: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] } });
  return tools;
}

export function createExternalToolRunner({ host, notify, recentUtterance, repliesSince, wordsNotSaid }) {
  let draft = null, outsideAt = 0, epochAt = 0, usedAt = 0, disposed = false, next = 1;
  const previous = host.requests?.() || [];
  const known = new Set(previous.map((r) => r.id));
  const active = new Set(previous.filter((r) => ['received','queued','dispatched'].includes(r.state)).map((r) => r.id));
  const offResult = host.onResult?.((r) => { if (['completed','failed','cancelled','uncertain'].includes(r.state)) active.delete(r.requestId); }) || (() => {});
  const publicDraft = () => draft && { id: draft.id, text: draft.text, targetTitle: draft.title };
  const setDraft = (d) => { draft = d; notify({ type: 'bridge.draft', draft: publicDraft() }); };
  const offEpoch = host.onEpoch?.(() => { epochAt = outsideAt = Date.now(); setDraft(null); active.clear(); }) || (() => {});
  const fresh = (u) => u && u.at > outsideAt && u.at !== usedAt && Date.now() - u.at < 60_000 && !!u.utteranceId;
  async function send(d, u) {
    if (disposed || draft !== d || !fresh(u)) return { error: 'Nothing was sent. Ask for fresh confirmation.' };
    usedAt = u.at; // consume consent before the side effect, including unknown transport outcomes
    known.add(d.requestId);
    active.add(d.requestId);
    const r = await host.submit({ requestId: d.requestId, utteranceId: d.utteranceId, text: d.text });
    setDraft(null);
    const accepted = ['queued','dispatched','completed'].includes(r.state);
    if (accepted) notify({ type: 'bridge.sent', text: d.text, sessionTitle: d.title });
    return { requestId: d.requestId, state: r.state, durablyAccepted: accepted, next_step: accepted ? 'Say it was accepted, not that the work is finished. The correlated result will arrive separately.' : 'Only transport receipt or an unresolved outcome is known. Do not claim durable acceptance or replay the work.' };
  }
  const handlers = {
    async get_current_session() {
      const s = host.snapshot();
      if (!s) return { error: 'The selected host is disconnected.' };
      const session = s.sessions.find((x) => x.id === s.focusedSessionId) || null;
      if (session) notify({ type: 'bridge.session', title: session.title });
      if (session && reviewed(host)) {
        const metadata = Object.fromEntries(['id', 'generation', 'title', 'agent', 'activity', 'scope', 'projectId'].filter((key) => Object.hasOwn(session, key)).map((key) => [key, session[key]]));
        return { session: metadata, nonUser: true }; // focus changes must not bypass the utterance-pinned reader
      }
      return { session, nonUser: true };
    },
    async list_sessions() { return { sessions: host.snapshot()?.sessions || [], nonUser: true }; },
    async read_session({ session }) {
      const s = host.snapshot();
      const found = s?.sessions.find((x) => x.id === (session || s.focusedSessionId));
      return found ? { session: found, nonUser: true } : { error: 'Use an exact advertised session id.' };
    },
    async switch_session({ session }) {
      const u = recentUtterance();
      if (!fresh(u) || !/\b(switch|open|focus|show|go|take)\b/i.test(u.text)) return { error: 'Switching needs a fresh user request.' };
      const target = host.snapshot()?.sessions.find((s) => s.id === session);
      if (!target || ![target.id, target.title].some((v) => typeof v === 'string' && v.trim() && u.text.toLowerCase().includes(v.toLowerCase()))) return { error: 'Ask which advertised session the user means.' };
      usedAt = u.at;
      return host.focus(target.id);
    },
    async draft_prompt({ text, verbatim = false }) {
      const u = recentUtterance();
      if (!fresh(u) || typeof text !== 'string' || !text.trim() || text.length > 8000) return { error: 'A draft needs fresh user words and a pinned utterance.' };
      const proposed = verbatim ? text.trim() : withoutSendTail(text.trim());
      if (wordsNotSaid(proposed, u.text, { direct: !verbatim }).length > 0) return { error: 'Use only the user’s own words in the draft.' };
      // The immutable delegated intent comes from the captured transcript, never
      // the model's rewrite. This also preserves negations and omitted constraints.
      const raw = sendInstruction(u.text).rest.trim();
      if (!raw || raw.length > 8000) return { error: 'The original request is too long or empty. Say a shorter complete request.' };
      // Wait for the recording-start latch; never obtain a new target at draft or send time.
      const latch = await (host.awaitUtterance ? host.awaitUtterance(u.utteranceId) : host.beginUtterance(u.utteranceId));
      const title = host.snapshot()?.sessions.find((s) => s.id === latch.target?.sessionId)?.title || 'orchestrator';
      setDraft({ id: next++, text: raw, title, createdAt: Date.now(), utteranceId: u.utteranceId, requestId: crypto.randomUUID() });
      return sendInstruction(u.text).send ? send(draft, u) : { drafted: true, text: raw, next_step: 'Read this draft aloud and ask whether to send it. It is local and has not been submitted.' };
    },
    async send_draft() {
      const d = draft;
      if (!d) return { error: 'There is no draft.' };
      const u = recentUtterance();
      if (!u || u.at <= d.createdAt || !fresh(u) || !isClearYes(u.text) || Date.now() - d.createdAt > 180_000 || repliesSince(d.createdAt) > 2) return { error: 'The draft needs a fresh clear yes from the user. Nothing was sent.' };
      return send(d, u);
    },
    async cancel_draft() {
      const u = recentUtterance();
      if (!fresh(u) || !/\b(no|cancel|discard|scrap|never ?mind)\b/i.test(u.text)) return { error: 'Discarding needs the user’s own words.' };
      usedAt = u.at; setDraft(null); return { discarded: true };
    },
    async request_status({ requestId }) { if (!known.has(requestId)) return { error: 'Unknown request identity.' }; return { ...await host.observe(requestId), nonUser: true }; },
    async cancel_request({ requestId }) {
      const u = recentUtterance();
      if (!fresh(u) || !/\b(cancel|stop)\b/i.test(u.text) || !active.has(requestId) || /\b(speaking|talking|listening|voice|audio)\b/i.test(u.text) || active.size !== 1 && !u.text.includes(requestId)) return { error: 'Cancellation needs a fresh instruction naming one unambiguous known request.' };
      usedAt = u.at; return host.cancel(requestId);
    },
    async go_to_sleep() {
      const u = recentUtterance();
      if (!fresh(u) || !isSleepCommand(u.text)) return { error: 'Sleep needs the user’s own request.' };
      notify({ type: 'bridge.sleep' }); return { sleeping: true };
    },
    async avatar(args) { const u = recentUtterance(); if (!fresh(u)) return { error: 'A trick needs the user’s request.' }; return runAvatarCommand(args); },
  };
  return {
    async run(name, argsJson) {
      try {
        if (disposed) return { error: 'This operation is not supported by the selected host.' };
        const args = argsJson ? JSON.parse(argsJson) : {};
        if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'Tool arguments must be an object.' };
        const canonical = host.has('bro.tools.v1') && host.catalog?.()?.tools.find((t) => t.name === name && t.effect === 'read');
        if (canonical) {
          const u = recentUtterance();
          let utteranceId = null;
          if (u?.utteranceId && u.at > epochAt && Date.now() - u.at < 60_000) {
            await (host.awaitUtterance ? host.awaitUtterance(u.utteranceId) : host.beginUtterance(u.utteranceId));
            utteranceId = u.utteranceId;
          }
          if (canonical.scope === 'pinned-project' && !utteranceId) return { error: 'A fresh utterance pinned to this project is required.' };
          outsideAt = Date.now(); // observations can inform a reply, never authorize a pending draft
          return { ...await host.readTool(name, args, utteranceId), nonUser: true };
        }
        if (reviewed(host) && ['list_sessions','read_session','list_projects','list_chats','read_chat','coordination_snapshot','coordination_task'].includes(name)) return { error: 'The reviewed tool catalog is unavailable. No other backend was used.' };
        if (!Object.hasOwn(handlers, name)) return { error: 'This operation is not supported by the selected host.' };
        if (name === 'read_session' && Object.keys(args).some((key) => key !== 'session')) return { error: 'This host supports only bounded summary reads, not canonical scrollback arguments.' };
        return await handlers[name](args);
      } catch (e) { return { error: e.message || 'The host operation failed.' }; }
    },
    getDraft: publicDraft,
    noteNotification() { outsideAt = Date.now(); },
    noteOutsideData() { outsideAt = Date.now(); },
    noteSpoken() {}, allowDraft() {}, dispose() { disposed = true; draft = null; offResult(); offEpoch(); },
  };
}
