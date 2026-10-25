// The tool oracle's stand-in for src/desktop.js: every call is recorded with what it was asked and
// what it answered (picked by the oracle's seeded generator), so the Swift engine can be given the
// same answers and checked to ask the same things (parity/oracle/tools.mjs).
const o = () => globalThis.__oracle;
const answer = (name, args, choices) => {
  const r = choices[Math.floor(o().rng() * choices.length)];
  o().calls.push({ name, args, answer: r });
  return Promise.resolve(r);
};
const title = () => o().windowTitle();
const str = () => o().str();

export function getDesktopInfo() {
  const t = title();
  return answer('info', {}, [
    { ok: true, sessionTitle: t, promptBoxFound: true, promptText: '', windowId: 11, windows: [{ id: 11, title: t, kind: 'main', front: true, minimized: false }, { id: 12, title: 'Other one', kind: 'main', front: false, minimized: false }] },
    { ok: true, sessionTitle: t, promptBoxFound: true, promptText: '' },
    { ok: true, sessionTitle: t, promptBoxFound: false, promptText: '' },
    { ok: true, sessionTitle: t, promptBoxFound: true, promptText: 'typed by user' },
    { ok: true, sessionTitle: null, newSession: true, folder: 'alpha', promptBoxFound: true, promptText: '' },
    { ok: true, sessionTitle: null, newSession: true, folder: null, promptBoxFound: true, promptText: '' },
    { ok: true, sessionTitle: null, newSession: false, folder: null, promptBoxFound: true, promptText: '' },
    { ok: false, error: 'claude_window_not_found', message: 'The Claude desktop app is not open.' },
  ]);
}

export function listSidebarSessions() {
  return answer('sidebar', {}, [{ ok: false, error: 'claude_window_not_found', message: 'x' }]);
}

export function switchSession(t) {
  return answer('switch', { title: t }, [{ ok: true, sessionTitle: String(t).slice(0, 200) }, { ok: false, error: 'session_not_found', message: 'No such session.' }]);
}

export function newSession(opts = {}) {
  return answer('new', { project: opts.project ?? '' }, [
    { ok: true, created: true, newSession: true, folder: 'alpha' },
    { ok: true, created: false, newSession: true, folder: null },
    { ok: false, error: 'project_not_in_sidebar', message: 'x', projects: ['alpha', 'beta'] },
    { ok: false, error: 'new_button_not_found', message: 'x' },
  ]);
}

export function sendToDesktop(text, opts = {}) {
  return answer('send', { text, expectTitle: opts.expectTitle ?? null, expectNew: !!opts.expectNew, expectFolder: opts.expectFolder ?? null, filled: !!opts.filled }, [
    { ok: true, sessionTitle: opts.expectTitle || (opts.expectNew ? 'Fresh session' : 't') },
    { ok: true, sessionTitle: opts.expectTitle || 'x' },
    { ok: false, error: 'prompt_box_changed', message: 'The box changed.' },
    { ok: false, error: 'send_button_not_found', why: 'claude_working', message: 'x' },
  ]);
}

export function stopClaude(opts = {}) {
  return answer('stop', { expectTitle: opts.expectTitle ?? null }, [
    { ok: true, stopped: true, confirmed: true, sessionTitle: title() },
    { ok: false, error: 'not_working', message: "Claude isn't working in this session (there's no Stop button), so there was nothing to stop." },
    { ok: false, error: 'script_failed', message: 'x' },
  ]);
}

const PERMISSION = { kind: 'permission', title: 'Allow Claude to run a command?', detail: 'npm test', options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'allow_always', label: 'Always allow' }, { id: 'deny', label: 'Deny' }], key: 'perm0000000000001' };
const QUESTION = { kind: 'question', question: 'Which one?', choices: [{ n: 1, label: 'Redis', description: '', selected: true }, { n: 2, label: 'Postgres', description: 'SQL', selected: false }], multiSelect: false, page: null, canSkip: true, key: 'ques0000000000001' };
export function getPendingPrompt(opts = {}) {
  const t = opts.expectTitle || title();
  return answer('pending', { expectTitle: opts.expectTitle ?? null }, [
    { ok: true, sessionTitle: t, pending: PERMISSION, count: 1 },
    { ok: true, sessionTitle: t, pending: QUESTION, count: 2 },
    { ok: true, sessionTitle: t, pending: null, count: 0 },
    { ok: false, error: 'session_not_open', message: 'That session is not open.' },
  ]);
}

export function answerPrompt(opts = {}) {
  return answer('answer', { key: opts.key, choice: opts.choice, option: opts.option ?? 0, expectTitle: opts.expectTitle ?? null }, [
    { ok: true, answered: true, pressed: String(opts.choice), confirmed: true, sessionTitle: opts.expectTitle || title(), next: null },
    { ok: true, answered: true, pressed: String(opts.choice), sessionTitle: opts.expectTitle || title(), next: QUESTION },
    { ok: false, error: 'prompt_changed', message: 'It changed.', pending: PERMISSION },
  ]);
}

export function fillDesktop(text, opts = {}) {
  return answer('fill', { text, expectTitle: opts.expectTitle ?? null, expectNew: !!opts.expectNew, expectFolder: opts.expectFolder ?? null, replace: opts.replace ?? null }, [
    { ok: true, filled: true },
    { ok: true, filled: true },
    { ok: false, error: 'prompt_box_not_empty', message: 'x' },
    { ok: false, error: 'fill_not_verified', message: 'Could not check it.' },
  ]);
}

export function clearDesktop(text, opts = {}) {
  return answer('clear', { text, expectTitle: opts.expectTitle ?? null, expectNew: !!opts.expectNew, expectFolder: opts.expectFolder ?? null }, [{ ok: true, cleared: true }]);
}

export const APP_ACTIONS = Object.freeze(['status', 'folders', 'sidebar', 'tab', 'panel', 'scroll', 'load_earlier', 'model', 'permission', 'rename', 'archive', 'delete']);
export function claudeApp(action, opts = {}) {
  const args = { action, value: opts.value ?? '', title: opts.title ?? '' };
  if (action === 'status') return answer('app', args, [{ ok: true, sessionTitle: title(), sidebar: true, tab: 'code', model: 'Opus 5.5 High', permission: 'Ask permissions', panels: {}, newSession: false, folder: null }]);
  if (action === 'folders') return answer('app', args, [{ ok: true, folders: [{ folder: 'alpha', group: '' }, { folder: 'beta', group: '' }], sessionTitle: title() }, { ok: false, error: 'x', message: 'x' }]);
  return answer('app', args, [{ ok: true, sessionTitle: title() }, { ok: false, error: 'control_not_found', message: 'x' }, { ok: false, error: 'not_offered', message: 'x', options: ['Opus', 'Sonnet'] }]);
}

export function setFrontWindowHint() {}
export function setDesktopDriver() {}
export function onPromptBoxWork() {
  return () => {};
}
