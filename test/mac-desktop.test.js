// src/platform/mac/desktop.js (the Claude app on macOS, through Orbit's helper) against a stand-in
// helper whose Claude window has the real app's accessibility shape (test/fixtures/mac-claude.js).
// Runs on any OS: nothing reaches a real window.

import test from 'node:test';
import assert from 'node:assert/strict';
import { answerKind, createMacDesktop, normText, parseArgs, Tree } from '../src/platform/mac/desktop.js';
import { createFakeClaude } from './fixtures/mac-claude.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const fast = () => Promise.resolve();
function setup(opts) {
  const claude = createFakeClaude(opts);
  const d = createMacDesktop({ request: (op, a) => claude.request(op, a), sleep: fast });
  return { claude, d, s: claude.state };
}

test('arguments are read as desktop.ps1 reads them', () => {
  assert.deepEqual(parseArgs(['-TitleB64', 'eA==', '-ExpectNew', '-FrontHwnd', '12', '-Rects']), { TitleB64: 'eA==', ExpectNew: true, FrontHwnd: '12', Rects: true });
  assert.deepEqual(parseArgs(['stray', '-Action', 'status']), { Action: 'status' });
});

test('answer kinds and text comparison match desktop.ps1', () => {
  assert.equal(answerKind('Allow once'), 'allow_once');
  assert.equal(answerKind('Always allow for this website'), 'allow_always');
  assert.equal(answerKind('Allow for this session'), 'allow_session');
  assert.equal(answerKind('Deny'), 'deny');
  assert.equal(answerKind('No, keep going'), 'deny');
  assert.equal(answerKind('Send'), null);
  assert.ok(normText('it’s  "fine"\r\n ok') === normText("it's “fine”\nok"));
});

test('the tree: parents, children, subtrees', () => {
  const t = new Tree([
    { i: 0, p: -1 },
    { i: 1, p: 0 },
    { i: 2, p: 1 },
    { i: 3, p: 0 },
  ]);
  assert.deepEqual(t.children(t.root).map((n) => n.i), [1, 3]);
  assert.deepEqual(t.descendants(t.nodes[1]).map((n) => n.i), [2]);
  assert.ok(t.within(t.nodes[2], t.nodes[1]) && !t.within(t.nodes[3], t.nodes[1]));
  assert.equal(t.depth(t.nodes[2]), 2);
});

test('info: the open session, the prompt box and where it is, whether Claude is working', async () => {
  const { d, claude } = setup({ working: false });
  const r = await d.run('info', ['-Rects', '-FrontHwnd', String(claude.hwnd)]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sessionTitle, 'Fix the login bug');
  assert.equal(r.promptBoxFound, true);
  assert.equal(r.promptText, '');
  assert.deepEqual(r.promptBoxRect, { x: 400, y: 1000, w: 420, h: 21 });
  assert.deepEqual(r.sendButtonRect, { x: 828, y: 996, w: 28, h: 28 }, 'Send (off while the box is empty) is still found for its place');
  assert.equal(r.claudeWorking, false);
  assert.equal(r.windowId, claude.hwnd);
  assert.deepEqual(r.windows, [{ id: claude.hwnd, title: 'Fix the login bug', kind: 'main', front: true, minimized: false }]);
  const busy = setup({ working: true });
  assert.equal((await busy.d.run('info', [])).claudeWorking, true);
});

test('list: the sidebar sessions with their titles (the row labels carry extra words)', async () => {
  const { d } = setup();
  const r = await d.run('list', []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sessions.map((s) => s.title), ['Fix the login bug', 'Write the release notes', 'Plan viewer alpha']);
  assert.equal(r.sessions[1].label, 'Write the release notes Cloud');
  assert.deepEqual(r.sessions.map((s) => s.front), [true, false, false]);
});

test('switch: presses the session in the sidebar and confirms the page changed', async () => {
  const { d, s } = setup();
  const r = await d.run('switch', ['-TitleB64', b64('release notes')]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.switched, true);
  assert.equal(r.sessionTitle, 'Write the release notes');
  assert.equal(s.open, 'Write the release notes');
  const again = await d.run('switch', ['-TitleB64', b64('Write the release notes')]);
  assert.equal(again.switched, false);
  const none = await d.run('switch', ['-TitleB64', b64('no such session')]);
  assert.equal(none.error, 'session_not_in_sidebar');
});

test('send: fills the box, checks it landed, presses Send, sees the box empty', async () => {
  const { d, s } = setup();
  const r = await d.run('send', ['-TextB64', b64('Please run the tests'), '-ExpectTitleB64', b64('Fix the login bug')]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sent, true);
  assert.equal(r.confirmed, true);
  assert.deepEqual(s.sent, ['Please run the tests']);
});

test('send: never into another session, never over text already in the box', async () => {
  const other = setup();
  const r = await other.d.run('send', ['-TextB64', b64('hello'), '-ExpectTitleB64', b64('Some other session')]);
  assert.equal(r.error, 'session_changed');
  assert.deepEqual(other.s.sent, []);
  const typed = setup();
  typed.s.box = 'the user is typing';
  const r2 = await typed.d.run('send', ['-TextB64', b64('hello')]);
  assert.equal(r2.error, 'prompt_box_not_empty');
  assert.equal(typed.s.box, 'the user is typing', "the user's text stays");
  assert.deepEqual(typed.s.sent, []);
});

test('send: a box that refuses the text is reported, nothing is sent', async () => {
  const { d, s } = setup();
  s.rejectSetValue = true;
  const r = await d.run('send', ['-TextB64', b64('hello there')]);
  assert.equal(r.error, 'fill_not_verified');
  assert.deepEqual(s.sent, []);
});

test('send while Claude works: Stop is where Send goes, so nothing is sent and the box is emptied again', async () => {
  const { d, s } = setup({ working: true });
  const r = await d.run('send', ['-TextB64', b64('next step')]);
  assert.equal(r.error, 'send_button_not_found');
  assert.equal(r.why, 'claude_working');
  assert.equal(s.box, '', 'the text typed for this send is taken out again');
});

test('fill, then send the filled draft; clear only Orbit’s own draft', async () => {
  const { d, s } = setup();
  const f = await d.run('send', ['-TextB64', b64('draft one'), '-Fill']);
  assert.equal(f.filled, true, JSON.stringify(f));
  assert.equal(s.box, 'draft one');
  const revised = await d.run('send', ['-TextB64', b64('draft two'), '-Fill', '-PrevB64', b64('draft one')]);
  assert.equal(revised.filled, true, JSON.stringify(revised));
  assert.equal(s.box, 'draft two');
  const sent = await d.run('send', ['-TextB64', b64('draft two'), '-Filled']);
  assert.equal(sent.sent, true, JSON.stringify(sent));
  s.box = 'edited by the user';
  s.working = false;
  const cleared = await d.run('send', ['-TextB64', b64('draft two'), '-Clear']);
  assert.equal(cleared.cleared, false);
  assert.equal(s.box, 'edited by the user');
});

test('dry run fills, checks and clears without pressing Send', async () => {
  const { d, s } = setup();
  const r = await d.run('send', ['-TextB64', b64('just checking'), '-DryRun']);
  assert.equal(r.dryRun, true, JSON.stringify(r));
  assert.equal(s.box, '');
  assert.deepEqual(s.sent, []);
});

test('stop: presses Claude’s own Stop and sees Send come back', async () => {
  const { d, s } = setup({ working: true });
  const r = await d.run('stop', []);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.confirmed, true);
  assert.equal(s.working, false);
  const idle = await d.run('stop', []);
  assert.equal(idle.error, 'not_working');
});

test('new: Claude’s New button, or New session in a folder; an empty new session is confirmed', async () => {
  const { d, s } = setup();
  const r = await d.run('new', []);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.equal(r.folder, 'orbit-voice');
  assert.equal(s.open, null);
  const again = await d.run('new', []);
  assert.equal(again.created, false, 'a new session is already open');
  const f = setup();
  const r2 = await f.d.run('new', ['-ProjectB64', b64('ladder 6')]);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.folder, 'Fire');
  const missing = await f.d.run('new', ['-ProjectB64', b64('nowhere')]);
  assert.equal(missing.error, 'project_not_in_sidebar');
});

test('send into a new session: only where the folder matches; its title comes once sent', async () => {
  const { d, s } = setup({ open: null });
  s.newFolder = 'orbit-voice';
  const wrong = await d.run('send', ['-TextB64', b64('start here'), '-ExpectNew', '-ExpectFolderB64', b64('Fire')]);
  assert.equal(wrong.error, 'session_changed');
  const r = await d.run('send', ['-TextB64', b64('start here'), '-ExpectNew', '-ExpectFolderB64', b64('orbit-voice')]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.newSession, true);
  assert.equal(r.sessionTitle, 'start here');
});

test('pending and answer: a permission card, read and answered by its key', async () => {
  const { d, s } = setup({ card: { kind: 'permission', title: 'Allow Claude to run a command?', command: 'npm test' } });
  const p = await d.run('pending', []);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.pending.kind, 'permission');
  assert.equal(p.pending.detail, 'npm test');
  assert.match(p.pending.title, /run a command/);
  assert.deepEqual(p.pending.options.map((o) => o.id), ['allow_once', 'allow_always', 'deny']);
  const stale = await d.run('answer', ['-KeyB64', b64('0000'), '-Choice', 'allow_once']);
  assert.equal(stale.error, 'prompt_changed');
  const a = await d.run('answer', ['-KeyB64', b64(p.pending.key), '-Choice', 'deny']);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.pressed, 'Deny');
  assert.equal(a.confirmed, true);
  assert.equal(s.answer, 'Deny');
});

test('pending and answer: a question card, an option picked and submitted', async () => {
  const { d, s } = setup({ card: { kind: 'question', question: 'Which database?', options: ['Postgres', 'SQLite'] } });
  const p = await d.run('pending', []);
  assert.equal(p.pending.kind, 'question', JSON.stringify(p));
  assert.equal(p.pending.question, 'Which database?');
  assert.deepEqual(p.pending.choices.map((c) => c.label), ['Postgres', 'SQLite']);
  assert.equal(p.pending.canSkip, true);
  assert.equal(p.pending.multiSelect, false);
  const a = await d.run('answer', ['-KeyB64', b64(p.pending.key), '-Choice', 'option', '-Option', '2']);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(s.answer, 'SQLite');
});

test('app: status, the sidebar, and picking a model from its menu', async () => {
  const { d, s } = setup();
  const st = await d.run('app', ['-Action', 'status']);
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.model, 'Opus 5.5 High');
  assert.equal(st.permission, 'Bypass permissions');
  assert.equal(st.tab, 'code');
  assert.equal(st.sidebar, true);
  const folders = await d.run('app', ['-Action', 'folders']);
  assert.deepEqual(folders.folders, [{ folder: 'Fire', group: 'ladder 6' }, { folder: 'orbit-voice', group: '' }]);
  const m = await d.run('app', ['-Action', 'model', '-ValueB64', b64('sonnet')]);
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.equal(m.now, 'Sonnet 5.5');
  assert.equal(s.model, 'Sonnet 5.5');
  const hide = await d.run('app', ['-Action', 'sidebar', '-ValueB64', b64('hide')]);
  assert.equal(hide.ok, true, JSON.stringify(hide));
  assert.equal(s.sidebar, false);
});

test('no Claude window, no permission: plain errors', async () => {
  const none = createMacDesktop({ request: async (op) => (op === 'windows' ? { ok: true, running: false, windows: [] } : { ok: false }), sleep: fast });
  assert.equal((await none.run('info', [])).error, 'claude_window_not_found');
  const denied = createMacDesktop({ request: async () => ({ ok: false, error: 'access_denied', message: 'x' }), sleep: fast });
  const r = await denied.run('info', []);
  assert.equal(r.error, 'accessibility_denied');
  assert.match(r.message, /Accessibility/);
});
