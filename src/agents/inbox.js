// The control path from the card view to whichever Supervisor owns a run.
//
//   runs/<id>/inbox.jsonl  requests appended by the bridge: { rid, t, agent, action, text? }
//   runs/<id>/owner.json   the owning Supervisor's heartbeat: { pid, beat }
//
// The owner reads its inbox, runs each request once, and records a `control_result` event in the
// ledger, which the card view already streams. Like the ledger, this works whether the Supervisor
// runs in Orbit's own process or another one, and needs no extra socket.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ACTIONS = new Set(['pause', 'pause_step', 'resume', 'redirect', 'stop', 'approve', 'deny', 'restart']);
export const AGENT_ID = /^[a-z0-9-]{1,40}$/;
export const MAX_TEXT = 4000;
export const BEAT_MS = 2000;
const STALE_MS = 3 * BEAT_MS;

export const inboxFile = (runDir) => path.join(runDir, 'inbox.jsonl');
export const ownerFile = (runDir) => path.join(runDir, 'owner.json');

/** Checks a control request; returns an error message or null. */
export function validateControl({ agent, action, text }) {
  if (!ACTIONS.has(action)) return 'unknown action';
  if (typeof agent !== 'string' || !AGENT_ID.test(agent)) return 'bad agent id';
  if (action === 'redirect') {
    if (typeof text !== 'string' || !text.trim()) return 'a redirect needs an instruction';
    if (text.length > MAX_TEXT) return `instructions are limited to ${MAX_TEXT} characters`;
  }
  return null;
}

/** Appends a request to the run's inbox. Returns its request id. */
export function appendControl(runDir, { agent, action, text }) {
  const rid = crypto.randomBytes(6).toString('hex');
  const req = { rid, t: Date.now(), agent, action, ...(action === 'redirect' && { text: text.trim() }) };
  fs.appendFileSync(inboxFile(runDir), JSON.stringify(req) + '\n');
  return rid;
}

/** Is a Supervisor alive and reading this run's inbox? */
export function ownerLive(runDir, now = Date.now()) {
  try {
    const o = JSON.parse(fs.readFileSync(ownerFile(runDir), 'utf8'));
    return typeof o.beat === 'number' && now - o.beat < STALE_MS;
  } catch {
    return false;
  }
}

export function writeBeat(runDir) {
  const tmp = `${ownerFile(runDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, beat: Date.now() }));
  fs.renameSync(tmp, ownerFile(runDir)); // atomic, so readers never see half a file
}

export function clearBeat(runDir) {
  try { fs.unlinkSync(ownerFile(runDir)); } catch { /* already gone */ }
}

/** Tails an inbox from its current end (requests from before we owned the run are ignored). */
export function createInboxReader(runDir) {
  const file = inboxFile(runDir);
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let partial = '';
  return function readNew() {
    let size;
    try { size = fs.statSync(file).size; } catch { return []; }
    if (size < offset) { offset = 0; partial = ''; }
    if (size === offset) return [];
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString('utf8')).split('\n');
    partial = lines.pop();
    const out = [];
    for (const line of lines) {
      try { const r = JSON.parse(line); if (r && typeof r.rid === 'string') out.push(r); } catch { /* skip */ }
    }
    return out;
  };
}
