// Orbit Agents, build step 1: the ACP spike.
//
// Drives one Claude agent over ACP (stdio) and checks the three things the
// design depends on:
//   1. Progress: session/update gives enough to fill a card (plan, tool calls).
//   2. Pause: session/cancel stops a turn mid-task and the agent keeps its
//      memory (a codeword it was told but never wrote to disk).
//   3. Redirect: cancel + a new prompt changes direction without restarting.
// Bonus: "pause after this step" by holding a permission request.
//
// The agent works in a fresh temp folder, never in the repo. Every update is
// logged to runs/<stamp>.jsonl; the verdict goes to runs/<stamp>.results.json.

import { spawn } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUNS = path.join(HERE, 'runs');
fs.mkdirSync(RUNS, { recursive: true });
const LOG = path.join(RUNS, `${STAMP}.jsonl`);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-acp-spike-'));
const CODEWORD = 'ORCHID-42';
const HOLD_MS = 6000;
const PROGRESS_MCP = path.join(HERE, 'progress-mcp.mjs');
const WANT_MODE = 'default';           // never inherit the user's bypassPermissions
const WANT_MODEL = /sonnet/i;          // sub-agents get a cheaper model than the user's default
// Isolated by default: don't load the user's settings (allow rules, connectors, plugins). ISOLATE=0 to compare.
const ISOLATE = process.env.ISOLATE !== '0';
const ISOLATION_META = { claudeCode: { options: { settingSources: [], strictMcpConfig: true, allowDangerouslySkipPermissions: false } } };
const PHASE_TIMEOUT_MS = 4 * 60 * 1000;

const t0 = Date.now();
const ms = () => Date.now() - t0;
const secs = () => (ms() / 1000).toFixed(1).padStart(6);
let phase = 'init';
const logStream = fs.createWriteStream(LOG);
const log = (kind, data) => logStream.write(JSON.stringify({ t: ms(), phase, kind, ...data }) + '\n');
const say = (msg) => console.log(`${secs()}s [${phase}] ${msg}`);

// ---- Card state: exactly what the card view would show ----------------------
const card = { state: 'starting', planDone: 0, planTotal: 0, step: '', activity: '' };
const counts = {};           // sessionUpdate type -> count (whole run)
const phaseStats = {};       // phase -> { updates, toolCalls, text }
const titles = new Map();    // toolCallId -> title
let progressReports = 0;
let lastUsage = null;

// Progress via the injected orbit MCP tool: read its arguments off the ACP stream.
function maybeProgress(u) {
  const name = `${u.title ?? ''} ${titles.get(u.toolCallId) ?? ''} ${u._meta?.claudeCode?.toolName ?? ''}`;
  const a = u.rawInput;
  if (!/report_progress/.test(name) || !a || typeof a.done !== 'number') return false;
  progressReports++;
  Object.assign(card, { planDone: a.done, planTotal: a.total, step: a.step });
  say(`card  progress ${a.done}/${a.total} · ${a.step}   (via orbit.report_progress)`);
  return true;
}
let updatesDuringHold = null;
const stat = () => (phaseStats[phase] ??= { updates: 0, toolCalls: 0, text: '' });

function onUpdate(u) {
  counts[u.sessionUpdate] = (counts[u.sessionUpdate] || 0) + 1;
  stat().updates++;
  if (updatesDuringHold) updatesDuringHold.push(u.sessionUpdate);
  log('update', { update: u });
  switch (u.sessionUpdate) {
    case 'plan': {
      const done = u.entries.filter((e) => e.status === 'completed').length;
      const cur = u.entries.find((e) => e.status === 'in_progress');
      if (done !== card.planDone || u.entries.length !== card.planTotal || (cur?.content ?? '') !== card.step) {
        Object.assign(card, { planDone: done, planTotal: u.entries.length, step: cur?.content ?? '' });
        say(`card  progress ${done}/${u.entries.length}${cur ? ` · ${cur.content}` : ''}`);
      }
      break;
    }
    case 'usage_update':
      lastUsage = { used: u.used, size: u.size, cost: u.cost?.amount ?? lastUsage?.cost, model: u._meta?.['_claude/model'] ?? lastUsage?.model };
      break;
    case 'tool_call':
      stat().toolCalls++;
      titles.set(u.toolCallId, u.title);
      if (maybeProgress(u)) break;
      card.activity = u.title;
      say(`card  activity: ${u.title} (${u.status ?? 'pending'})`);
      break;
    case 'tool_call_update':
      if (u.title && !titles.has(u.toolCallId)) titles.set(u.toolCallId, u.title);
      if (maybeProgress(u)) break;
      if (u.status === 'completed' || u.status === 'failed') say(`tool  ${u.status === 'completed' ? '✓' : '✗'} ${titles.get(u.toolCallId) ?? u.toolCallId}`);
      break;
    case 'agent_message_chunk':
      if (u.content?.type === 'text') stat().text += u.content.text;
      break;
    default:
      break;
  }
}

// ---- Permission handling: allow writes inside WORK only; optionally hold one --
let holdNextPermission = false;
const permAsked = [];
async function onPermission(p) {
  const title = p.toolCall?.title ?? '(untitled)';
  const raw = p.toolCall?.rawInput ?? {};
  const target = raw.file_path || raw.path || p.toolCall?.locations?.[0]?.path || '';
  const inside = !target || path.resolve(WORK, target).toLowerCase().startsWith(WORK.toLowerCase());
  log('permission', { title, target, options: p.options.map((o) => o.kind) });
  permAsked.push(title);
  say(`perm  asked: ${title}${target ? ` → ${path.basename(target)}` : ''}`);

  if (holdNextPermission) {
    holdNextPermission = false;
    card.state = 'needs_you';
    say(`soft pause: holding this request for ${HOLD_MS / 1000}s (card shows "Needs you")`);
    updatesDuringHold = [];
    await new Promise((r) => setTimeout(r, HOLD_MS));
    say(`soft pause: released; ${updatesDuringHold.length} updates arrived while held`);
    results.softPause = { heldMs: HOLD_MS, updatesWhileHeld: updatesDuringHold.length, types: [...new Set(updatesDuringHold)] };
    updatesDuringHold = null;
    card.state = 'running';
  }
  const pick = inside
    ? p.options.find((o) => o.kind === 'allow_once') ?? p.options.find((o) => o.kind.startsWith('allow'))
    : p.options.find((o) => o.kind === 'reject_once') ?? p.options.find((o) => o.kind.startsWith('reject'));
  if (!inside) say(`perm  REJECTED (outside the work folder): ${target}`);
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

// ---- Helpers -----------------------------------------------------------------
const stepFile = (n) => path.join(WORK, `step-${n}.txt`);
const exists = (n) => fs.existsSync(stepFile(n));
const listFiles = () => fs.readdirSync(WORK).filter((f) => !f.startsWith('.')).sort();
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

function waitFor(pred, label, timeout = PHASE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(iv); reject(new Error(`timeout waiting for ${label}`)); }
    }, 150);
  });
}

const results = { stamp: STAMP, work: WORK, checks: {} };
const check = (name, pass, detail) => {
  results.checks[name] = { pass: !!pass, detail };
  say(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}`);
};

// ---- Run ---------------------------------------------------------------------
const child = spawn(process.execPath, [ADAPTER], { cwd: WORK, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
const errLog = fs.createWriteStream(path.join(RUNS, `${STAMP}.stderr.log`));
child.stderr.pipe(errLog);
child.on('exit', (code) => log('adapter-exit', { code }));

const conn = new acp.ClientSideConnection(
  () => ({
    sessionUpdate: async (n) => onUpdate(n.update),
    requestPermission: onPermission,
  }),
  acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
);

const text = (s) => [{ type: 'text', text: s }];

async function main() {
  say(`work folder: ${WORK}`);
  const init = await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  results.initialize = { protocolVersion: init.protocolVersion, agentInfo: init.agentInfo, agentCapabilities: init.agentCapabilities, authMethods: (init.authMethods ?? []).map((m) => m.id) };
  say(`connected: ${init.agentInfo?.name ?? 'agent'} ${init.agentInfo?.version ?? ''}, protocol v${init.protocolVersion}`);

  const ns = await conn.newSession({ cwd: WORK, mcpServers: [{ name: 'orbit', command: process.execPath, args: [PROGRESS_MCP], env: [] }], ...(ISOLATE && { _meta: ISOLATION_META }) });
  results.isolated = ISOLATE;
  const { sessionId, modes } = ns;
  const cfg = ns.configOptions ?? [];
  results.session = {
    sessionId,
    inheritedMode: modes?.currentModeId,
    availableModes: modes?.availableModes?.map((m) => m.id),
    configOptions: cfg.map((o) => ({ id: o.id, category: o.category, current: o.currentValue, values: o.options?.map?.((v) => v.value ?? v.group) })),
  };
  say(`session ${sessionId} · inherited mode ${modes?.currentModeId ?? '?'}`);
  if (modes?.availableModes?.some((m) => m.id === WANT_MODE) && modes.currentModeId !== WANT_MODE) {
    await conn.setSessionMode({ sessionId, modeId: WANT_MODE });
    say(`mode set → ${WANT_MODE}`);
  }
  const modelOpt = cfg.find((o) => o.category === 'model' || o.id === 'model');
  const flat = (modelOpt?.options ?? []).flatMap((o) => o.options ?? [o]);
  const pickModel = flat.find((o) => WANT_MODEL.test(`${o.value} ${o.name}`));
  if (modelOpt && pickModel) {
    await conn.setSessionConfigOption({ sessionId, configId: modelOpt.id, value: pickModel.value });
    say(`model set → ${pickModel.value} (was ${modelOpt.currentValue})`);
  }
  results.session.mode = WANT_MODE;
  results.session.model = pickModel?.value ?? modelOpt?.currentValue ?? null;
  card.state = 'running';

  // Phase A: start a 6-step task, soft-pause on the first write, cancel after step 2.
  phase = 'A-run';
  holdNextPermission = true;
  const firstUpdateAt = { t: null };
  const firstWatch = setInterval(() => { if (stat().updates && !firstUpdateAt.t) firstUpdateAt.t = ms(); }, 50);
  const startA = ms();
  const pA = conn.prompt({ sessionId, prompt: text(
    `You're helping test a progress-tracking system.\n` +
    `The secret codeword for this session is ${CODEWORD}. Never write it to any file and don't mention it unless asked.\n\n` +
    `Task: in the current folder, create six files, step-1.txt through step-6.txt, one at a time and in order. ` +
    `Each file holds a two-line poem about orbits followed by a line "STEP <n> DONE". ` +
    `Before the first file and after each file, call the orbit report_progress tool (done, total=6, step = what's next). ` +
    `Use a separate tool call for each file. Don't read or list anything first; the folder is empty.`) });
  let stopA = null;
  pA.then((r) => { stopA = { reason: r.stopReason, t: ms() }; }, (e) => { stopA = { error: String(e), t: ms() }; });

  await waitFor(() => exists(2) || stopA, 'step-2.txt');
  clearInterval(firstWatch);
  results.timing = { firstUpdateMs: firstUpdateAt.t ? firstUpdateAt.t - startA : null };
  if (stopA) throw new Error(`turn A ended before step 2 was written: ${JSON.stringify(stopA)}`);

  say('PAUSE NOW → session/cancel');
  const cancelAt = ms();
  await conn.cancel({ sessionId });
  await waitFor(() => stopA, 'turn A to stop', 60000);
  const filesAtStop = listFiles();
  await new Promise((r) => setTimeout(r, 4000));
  const filesAfter4s = listFiles();
  results.timing.cancelToStopMs = stopA.t - cancelAt;
  check('cancel ends the turn', stopA.reason === 'cancelled', `stopReason=${stopA.reason ?? stopA.error}, ${stopA.t - cancelAt} ms after cancel`);
  check('nothing written after cancel', filesAtStop.join() === filesAfter4s.join(), `files: ${filesAfter4s.join(', ')}`);
  check('progress data present', (progressReports > 0 || (counts.plan ?? 0) > 0) && (counts.tool_call ?? 0) > 0, `orbit progress reports=${progressReports}, plan updates=${counts.plan ?? 0}, tool calls=${counts.tool_call ?? 0}`);
  check('usage + cost streamed', !!lastUsage?.used, lastUsage ? `context ${lastUsage.used}/${lastUsage.size}, model ${lastUsage.model}, cost $${lastUsage.cost?.toFixed?.(2) ?? '?'}` : 'none');
  if (results.softPause) check('soft pause holds the agent', results.softPause.updatesWhileHeld <= 2, `${results.softPause.updatesWhileHeld} updates during a ${HOLD_MS / 1000}s hold`);
  else check('soft pause holds the agent', false, 'no permission request arrived (agent may be in an auto-accept mode)');
  const doneBeforeCancel = filesAfter4s.filter((f) => /^step-\d\.txt$/.test(f)).length;
  const hashes = Object.fromEntries(filesAfter4s.map((f) => [f, sha(path.join(WORK, f))]));

  // Phase B: memory check, same session, no tools allowed.
  phase = 'B-memory';
  const rB = await conn.prompt({ sessionId, prompt: text(
    `Quick check before you continue. Answer in one line and don't use any tools or read any files: ` +
    `what's the secret codeword, and how many step files had you finished when I interrupted?`) });
  const answerB = stat().text.trim();
  say(`agent: "${answerB.replace(/\s+/g, ' ').slice(0, 200)}"`);
  check('memory kept after cancel', answerB.includes(CODEWORD), 'codeword recalled from context (it was never on disk)');
  check('knows where it stopped', new RegExp(`\\b(${doneBeforeCancel}|${['zero','one','two','three','four','five','six'][doneBeforeCancel]})\\b`, 'i').test(answerB), `expected ${doneBeforeCancel}`);
  check('answered without tools', stat().toolCalls === 0 && rB.stopReason === 'end_turn', `tool calls=${stat().toolCalls}, stopReason=${rB.stopReason}`);

  // Phase C: resume, then redirect mid-turn once one more file lands.
  phase = 'C-resume';
  const target = doneBeforeCancel + 1;
  let stopC = null;
  conn.prompt({ sessionId, prompt: text('Continue where you left off.') })
    .then((r) => { stopC = { reason: r.stopReason }; }, (e) => { stopC = { error: String(e) }; });
  await waitFor(() => exists(target) || stopC, `step-${target}.txt`);
  check('resume continues the task', exists(target), `step-${target}.txt written after resume`);

  phase = 'C-redirect';
  say('REDIRECT → session/cancel + new prompt');
  await conn.cancel({ sessionId });
  await waitFor(() => stopC, 'resume turn to stop', 60000);
  const resumedUpTo = listFiles().filter((f) => /^step-\d\.txt$/.test(f)).length;
  const rC = await conn.prompt({ sessionId, prompt: text(
    `Change of plan from the user: stop writing poems. Write each remaining step file as a single line in uppercase: ` +
    `"STEP <n>: REDIRECTED". Don't touch the files that already exist. Then create summary.txt listing every step file ` +
    `and whether it holds a poem or was redirected. Keep reporting progress with report_progress.`) });
  say(`redirect turn ended: ${rC.stopReason}`);

  // Phase D: verify the end state on disk.
  phase = 'D-verify';
  const all = [1, 2, 3, 4, 5, 6].map((n) => ({ n, body: read(stepFile(n)) }));
  const poems = all.filter((f) => f.body && /STEP \d DONE/.test(f.body)).map((f) => f.n);
  const redirected = all.filter((f) => f.body && /STEP \d: REDIRECTED/.test(f.body)).map((f) => f.n);
  const untouched = Object.entries(hashes).every(([f, h]) => sha(path.join(WORK, f)) === h);
  const anyCodeword = listFiles().some((f) => read(path.join(WORK, f))?.includes(CODEWORD));
  check('redirect changed direction', redirected.length > 0 && redirected.every((n) => n > resumedUpTo), `poems: ${poems.join(',')} · redirected: ${redirected.join(',')}`);
  check('all six files exist', all.every((f) => f.body !== null));
  check('earlier work untouched', untouched, 'hashes of files written before the cancel are unchanged');
  check('summary.txt written', fs.existsSync(path.join(WORK, 'summary.txt')));
  check('codeword never written to disk', !anyCodeword);
  if (ISOLATE) check('isolated: file writes ask permission', permAsked.some((t) => /write|step-\d|summary/i.test(t)), `${permAsked.length} requests: ${[...new Set(permAsked.map((t) => t.split(' ')[0]))].join(', ')}`);

  results.updateCounts = counts;
  results.card = card;
  results.permissionsAsked = permAsked;
  results.usage = lastUsage;
  results.progressReports = progressReports;
  results.phases = Object.fromEntries(Object.entries(phaseStats).map(([k, v]) => [k, { updates: v.updates, toolCalls: v.toolCalls }]));
  results.files = Object.fromEntries(listFiles().map((f) => [f, read(path.join(WORK, f))]));
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  results.error = String(e?.stack ?? e);
  say(`ERROR ${e?.message ?? e}`);
} finally {
  const failed = Object.entries(results.checks).filter(([, c]) => !c.pass).map(([k]) => k);
  results.summary = { passed: Object.keys(results.checks).length - failed.length, failed, totalMs: ms() };
  fs.writeFileSync(path.join(RUNS, `${STAMP}.results.json`), JSON.stringify(results, null, 2));
  say(`done: ${results.summary.passed} passed, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
  say(`log: ${LOG}`);
  child.kill();
  logStream.end();
  setTimeout(() => process.exit(exitCode || (failed.length ? 1 : 0)), 300);
}
