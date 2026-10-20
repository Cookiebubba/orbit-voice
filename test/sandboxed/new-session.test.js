// Starting a brand-new Claude session by voice, drafting into it, and reading it back. Runs with
// test/fuzz/register.mjs, so Claude's window is a fake: nothing is pressed, typed or sent for real.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-new-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');

// The fake desktop picks its answer with rng(); queue exact answers per call (index into its list).
// getDesktopInfo's list: 0 = session "T", 4 = a new empty session, 5 = some other page.
// newSession's list: 0 = created, 2 = project not in sidebar. sendToDesktop's: 0 = sent.
const queue = [];
const LIST_LEN = { info: 7, new: 6, send: 3, switch: 4, sidebar: 2 };
let nextLen = 7;
globalThis.__fuzz = {
  rng: () => {
    const i = queue.length ? queue.shift() : 0;
    return (i + 0.5) / nextLen;
  },
  str: () => 'grok x claude',
  calls: [],
  windowTitle: () => 'T',
};
// The fake records the call before picking, so set the list length from the last recorded call.
const calls = globalThis.__fuzz.calls;
const origPush = calls.push.bind(calls);
calls.push = (c) => {
  nextLen = LIST_LEN[c.name] || 2;
  return origPush(c);
};
const answer = (...indexes) => queue.push(...indexes);
const sends = () => calls.filter((c) => c.name === 'send');

const { initConfig } = await import('../../src/config.js');
const { createToolRunner, TOOL_TIMING } = await import('../../src/tools.js');
initConfig({ dir: path.join(root, 'cfg') });
TOOL_TIMING.openSessionWaitMs = 300;
TOOL_TIMING.openSessionPollMs = 50;
TOOL_TIMING.newSessionWaitMs = 300;

function runner() {
  let utterance = null;
  const events = [];
  const r = createToolRunner({
    notify: (e) => events.push(e),
    utteranceSince: async (since) => (utterance && utterance.at >= since ? utterance : null),
    recentUtterance: () => utterance,
  });
  const say = async (text, at) => {
    await new Promise((res) => setTimeout(res, 3));
    utterance = { text, at: at ?? Date.now() };
    await new Promise((res) => setTimeout(res, 3));
  };
  return { r, say, events };
}

// ---- sessions on disk ----
const sessionsDir = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions', 'acct', 'org');
fs.mkdirSync(sessionsDir, { recursive: true });
function writeSession(id, { title, createdAt, lastFocusedAt, text }) {
  const cwd = path.join(root, 'proj');
  fs.writeFileSync(path.join(sessionsDir, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, title, cwd, createdAt, lastFocusedAt, lastActivityAt: lastFocusedAt }));
  const dir = path.join(process.env.HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    [
      { type: 'user', timestamp: t, message: { role: 'user', content: text } },
      { type: 'assistant', timestamp: t, message: { role: 'assistant', content: [{ type: 'text', text: `reply to ${text}` }] } },
    ].map((x) => JSON.stringify(x)).join('\n'),
  );
}
writeSession('old-1', { title: 'An older session', createdAt: Date.now() - 86_400_000, lastFocusedAt: Date.now() - 3_600_000, text: 'old work' });

test('new_session only runs on a fresh request from the user, once per request', async () => {
  const { r, say } = runner();
  assert.equal((await r.run('new_session', '{}')).ok, false, 'nobody asked');
  await say('start a new session');
  answer(0);
  const res = await r.run('new_session', '{}');
  assert.equal(res.ok, true);
  assert.equal(res.new_session, true);
  assert.equal((await r.run('new_session', '{}')).ok, false, 'one request starts one session');
  await say('and another new one');
  answer(0);
  assert.equal((await r.run('new_session', '{}')).ok, true);
  // An app notification is never the user's request.
  r.noteNotification();
  assert.equal((await r.run('new_session', '{}')).ok, false);
  assert.equal(calls.filter((c) => c.name === 'new').length, 2);
});

test('new_session needs the user to ask for a new one in their own words', async () => {
  calls.length = 0;
  const { r, say } = runner();
  for (const words of ['what did Claude do?', 'yes', "don't start a new session", 'no new session please']) {
    await say(words);
    assert.equal((await r.run('new_session', '{}')).ok, false, words);
  }
  assert.equal(calls.filter((c) => c.name === 'new').length, 0);
  for (const words of ['start a new session', 'new thread please', 'start fresh', "let's start over"]) {
    await say(words);
    answer(0);
    assert.equal((await r.run('new_session', '{}')).ok, true, words);
  }
});

test('switching sessions needs a request from the user, not a notification or transcript', async () => {
  calls.length = 0;
  const { r, say } = runner();
  assert.equal((await r.run('switch_session', JSON.stringify({ session: 'older' }))).ok, false, 'nobody spoke');
  await say('switch to my older session');
  answer(0);
  assert.equal((await r.run('switch_session', JSON.stringify({ session: 'older' }))).ok, true);
  r.noteNotification();
  assert.equal((await r.run('switch_session', JSON.stringify({ session: 'older' }))).ok, false, 'after a notification');
  assert.equal(calls.filter((c) => c.name === 'switch').length, 1);
});

test('new_session with an unknown project lists the folders it could use', async () => {
  const { r, say } = runner();
  await say('new session in nonsense');
  answer(2);
  const res = await r.run('new_session', JSON.stringify({ project: 'nonsense' }));
  assert.equal(res.ok, false);
  assert.deepEqual(res.projects, ['grok x claude', 'grok x claude']); // data for Grok to read out
  assert.doesNotMatch(res.next_step, /grok x claude/); // never inside its instructions
  assert.equal(calls.at(-1).args.project, 'nonsense');
});

test('starting a new session drops the draft meant for the old one', async () => {
  const { r, say } = runner();
  await say('tell claude hello');
  answer(0); // info: session T
  assert.equal((await r.run('draft_prompt', JSON.stringify({ text: 'hello' }))).drafted, true);
  assert.ok(r.getDraft());
  await say('actually start a new session');
  answer(0);
  const res = await r.run('new_session', '{}');
  assert.equal(res.previous_draft_discarded, true);
  assert.equal(r.getDraft(), null);
});

test('a draft on a new session is sent only while that new session is still open', async () => {
  calls.length = 0;
  const { r, say } = runner();
  await say('ask claude hey are you there');
  answer(4); // info: a new, empty session
  const d = await r.run('draft_prompt', JSON.stringify({ text: 'hey are you there' }));
  assert.equal(d.drafted, true);
  assert.match(d.target_session, /new session/);
  assert.equal(r.getDraft().targetTitle, 'a new session');
  await say('yes send it');
  answer(0); // send: ok
  const sent = await r.run('send_draft', '{}');
  assert.equal(sent.ok, true);
  assert.deepEqual(
    sends().map((s) => ({ text: s.args.text, expectTitle: s.args.expectTitle, expectNew: s.args.expectNew, expectFolder: s.args.expectFolder })),
    [{ text: 'hey are you there', expectTitle: null, expectNew: true, expectFolder: 'grok x claude' }],
  );
});

test('no draft into a page that is not a Code session, or before the user speaks after a notification', async () => {
  const { r, say } = runner();
  assert.match((await r.run('draft_prompt', JSON.stringify({ text: 'x' }))).error, /ask the user/i, 'nobody has spoken');
  await say('tell claude x');
  answer(5); // info: a prompt box, but no Code session and no new session
  assert.match((await r.run('draft_prompt', JSON.stringify({ text: 'x' }))).error, /not showing a Code session/);
  await say('what is it doing?');
  r.noteNotification(); // refused before the window is even looked at
  assert.match((await r.run('draft_prompt', JSON.stringify({ text: 'x' }))).error, /after the latest app notification/);
  await say('tell claude y');
  answer(0);
  assert.equal((await r.run('draft_prompt', JSON.stringify({ text: 'y' }))).drafted, true);
});

test('reading the open session never quietly reads a different one', async () => {
  const { r } = runner();
  // A new, empty session is open: nothing to read, and not the older session either.
  answer(4);
  const fresh = await r.run('get_current_session', '{}');
  assert.equal(fresh.new_session, true);
  assert.equal(fresh.messages, undefined);
  // The window shows a session that isn't on disk yet (and no brand-new one exists): pending.
  globalThis.__fuzz.windowTitle = () => 'hey are you there';
  answer(0);
  const pending = await r.run('get_current_session', '{}');
  assert.equal(pending.transcript_pending, true);
  assert.equal(pending.messages, undefined);
  answer(0);
  assert.equal((await r.run('read_session', '{}')).transcript_pending, true);
  // Claude saved it, under an auto title that differs from the window for now: the newest,
  // just-created, most recently focused session is the one.
  writeSession('new-1', { title: 'Greeting check', createdAt: Date.now() - 5000, lastFocusedAt: Date.now(), text: 'hey are you there' });
  answer(0);
  const got = await r.run('read_session', '{}');
  assert.equal(got.session.title, 'Greeting check');
  assert.deepEqual(got.messages.map((m) => m.text), ['hey are you there', 'reply to hey are you there']);
  // Once the window shows the saved title, it's found by title.
  globalThis.__fuzz.windowTitle = () => 'Greeting check';
  answer(0);
  assert.equal((await r.run('get_current_session', '{}')).session.title, 'Greeting check');
  // An explicitly named session is still found by its words.
  assert.equal((await r.run('read_session', JSON.stringify({ session: 'older' }))).session.title, 'An older session');
});

test('after sending a new session its first prompt, an older session with the same title is not read instead', async () => {
  // Found in the real end-to-end test: Claude titled two sessions "Are you there", and saves the
  // new one's details a few seconds after its first prompt.
  writeSession('dup-old', { title: 'Are you there', createdAt: Date.now() - 3_600_000, lastFocusedAt: Date.now() - 1_000, text: 'old greeting' });
  const { r, say } = runner();
  await say('tell claude hey are you there');
  answer(4); // info: a new, empty session
  assert.equal((await r.run('draft_prompt', JSON.stringify({ text: 'hey are you there' }))).drafted, true);
  await say('yes send it');
  globalThis.__fuzz.str = () => 'Are you there'; // the title Claude gives it, reported by the send
  answer(0);
  assert.equal((await r.run('send_draft', '{}')).ok, true);
  globalThis.__fuzz.str = () => 'grok x claude';
  globalThis.__fuzz.windowTitle = () => 'Are you there';
  answer(0);
  const early = await r.run('read_session', '{}');
  assert.equal(early.transcript_pending, true, 'not the older "Are you there"');
  writeSession('dup-new', { title: 'Are you there', createdAt: Date.now() - 500, lastFocusedAt: Date.now() - 500, text: 'hey are you there' });
  answer(0);
  const got = await r.run('read_session', '{}');
  assert.deepEqual(got.messages.map((m) => m.text), ['hey are you there', 'reply to hey are you there']);
});
