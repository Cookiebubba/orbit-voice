// Stand-in for src/desktop.js: records every call and answers like the real script might, with
// randomness from the fuzzer's seeded generator (globalThis.__fuzz).
const fz = () => globalThis.__fuzz;
const record = (name, args) => fz().calls.push({ name, args, at: Date.now() });

function pick(results) {
  const f = fz();
  return results[Math.floor(f.rng() * results.length)];
}

// Claude's windows as desktop.ps1 lists them (the front one first here), sometimes several.
// fz().otherWindows(): more windows to list (default none), so the rng answers stay in step.
const windows = (title) => [{ id: 11, title, kind: 'main', front: true, minimized: false }, ...(fz().otherWindows?.() || [])];

export function getDesktopInfo() {
  record('info');
  const title = fz().windowTitle();
  const w = windows(title);
  return Promise.resolve(
    pick([
      { ok: true, sessionTitle: title, promptBoxFound: true, promptText: '', windowId: 11, windows: w },
      { ok: true, sessionTitle: title, promptBoxFound: true, promptText: '' },
      { ok: true, sessionTitle: title, promptBoxFound: false, promptText: '' },
      { ok: true, sessionTitle: title, promptBoxFound: true, promptText: 'typed by user' },
      // A new session nothing has been sent in yet: no title (see desktop.ps1 -Mode new).
      { ok: true, sessionTitle: null, newSession: true, folder: fz().str(), promptBoxFound: true, promptText: '' },
      // Some other Claude page with a prompt box that isn't a Code session.
      { ok: true, sessionTitle: null, newSession: false, folder: null, promptBoxFound: true, promptText: '' },
      { ok: false, error: 'claude_window_not_found', message: 'The Claude desktop app is not open.' },
    ]),
  );
}

export function listSidebarSessions() {
  record('sidebar');
  // Same shape as desktop.ps1's sidebar mode: the label is the button's name (title + badges).
  const title = fz().windowTitle();
  const rows = [{ title, label: title, open: true, front: true, window: 11 }, { title: fz().str(), label: `${fz().str()} Running`, open: false, front: false, window: 11 }];
  return Promise.resolve(pick([{ ok: true, sessionTitle: title, sessions: rows }, { ok: false, error: 'claude_window_not_found', message: 'x' }]));
}

export function switchSession(title) {
  record('switch', { title });
  return Promise.resolve(pick([{ ok: true, sessionTitle: String(title).slice(0, 200) }, { ok: false, error: 'session_not_found', message: 'x' }, { ok: true, switched: true, broughtForward: true, sessionTitle: String(title).slice(0, 200), windowId: 22 }, { ok: false, error: 'window_not_raised', message: 'x' }]));
}

export function newSession(opts = {}) {
  record('new', { project: opts.project });
  return Promise.resolve(
    pick([
      { ok: true, created: true, newSession: true, folder: fz().str() },
      { ok: true, created: false, newSession: true, folder: null },
      { ok: false, error: 'project_not_in_sidebar', message: 'x', projects: [fz().str(), fz().str()] },
      { ok: false, error: 'project_ambiguous', message: 'x', projects: [fz().str(), fz().str()] },
      { ok: false, error: 'prompt_box_not_empty', message: 'x' },
      { ok: false, error: 'new_button_not_found', message: 'x' },
    ]),
  );
}

export function sendToDesktop(text, opts = {}) {
  record('send', { text, expectTitle: opts.expectTitle, expectNew: !!opts.expectNew, expectFolder: opts.expectFolder ?? null, filled: !!opts.filled });
  return Promise.resolve(pick([{ ok: true, sessionTitle: opts.expectTitle || (opts.expectNew ? fz().str() : 't') }, { ok: false, error: 'prompt_box_not_empty', message: 'x' }, { ok: false, error: 'session_ambiguous', message: 'x' }, { ok: false, error: 'prompt_box_changed', message: 'x' }]));
}

// Pressing Claude's Stop button (recorded; the fuzzer checks each one was asked for).
export function stopClaude(opts = {}) {
  record('stop', { expectTitle: opts.expectTitle ?? null });
  return Promise.resolve(pick([{ ok: true, stopped: true, confirmed: true, sessionTitle: fz().windowTitle() }, { ok: false, error: 'not_working', message: "Claude isn't working in this session (there's no Stop button), so there was nothing to stop." }, { ok: false, error: 'script_failed', message: 'x' }]));
}

// What Claude waits on: fz().pending() when a test sets it (null = nothing), else a permission
// prompt, a question, or nothing. Answers are recorded (the fuzzer checks each one was the user's).
const FUZZ_PERMISSION = { kind: 'permission', title: 'Allow Claude to run a command?', detail: 'npm test', options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'allow_always', label: 'Always allow' }, { id: 'deny', label: 'Deny' }], key: 'perm0000000000001' };
const FUZZ_QUESTION = { kind: 'question', question: 'Which one?', choices: [{ n: 1, label: 'Redis', description: '', selected: true }, { n: 2, label: 'Postgres', description: '', selected: false }], multiSelect: false, page: null, canSkip: true, key: 'ques0000000000001' };
const pendingNow = () => (typeof fz().pending === 'function' ? fz().pending() : pick([FUZZ_PERMISSION, FUZZ_QUESTION, null]));
export function getPendingPrompt(opts = {}) {
  record('pending', { expectTitle: opts.expectTitle ?? null });
  const p = pendingNow();
  return Promise.resolve({ ok: true, sessionTitle: opts.expectTitle || fz().windowTitle(), pending: p, count: p ? 1 : 0 });
}
export function answerPrompt(opts = {}) {
  record('answer', { key: opts.key, choice: opts.choice, option: opts.option ?? 0, expectTitle: opts.expectTitle ?? null });
  return Promise.resolve({ ok: true, answered: true, pressed: String(opts.choice), confirmed: true, sessionTitle: opts.expectTitle || fz().windowTitle(), next: null });
}

// Typing a draft into the box (not sent), and taking it out again: never a send.
export function fillDesktop(text, opts = {}) {
  record('fill', { text, expectTitle: opts.expectTitle, expectNew: !!opts.expectNew, replace: opts.replace ?? null });
  return Promise.resolve(pick([{ ok: true, filled: true }, { ok: false, error: 'prompt_box_not_empty', message: 'x' }, { ok: false, error: 'fill_not_verified', message: 'x' }]));
}

export function clearDesktop(text, opts = {}) {
  record('clear', { text, expectTitle: opts.expectTitle, expectNew: !!opts.expectNew });
  return Promise.resolve({ ok: true, cleared: true });
}

// The real module's setup hooks (electron/main.js), unused here.
export function setFrontWindowHint() {}
export function setDesktopDriver() {}
export function onPromptBoxWork() {
  return () => {};
}
