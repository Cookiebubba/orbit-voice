// Stand-in for src/desktop.js: records every call and answers like the real script might, with
// randomness from the fuzzer's seeded generator (globalThis.__fuzz).
const fz = () => globalThis.__fuzz;
const record = (name, args) => fz().calls.push({ name, args, at: Date.now() });

function pick(results) {
  const f = fz();
  return results[Math.floor(f.rng() * results.length)];
}

export function getDesktopInfo() {
  record('info');
  const title = fz().windowTitle();
  return Promise.resolve(
    pick([
      { ok: true, sessionTitle: title, promptBoxFound: true, promptText: '' },
      { ok: true, sessionTitle: title, promptBoxFound: true, promptText: '' },
      { ok: true, sessionTitle: title, promptBoxFound: false, promptText: '' },
      { ok: true, sessionTitle: title, promptBoxFound: true, promptText: 'typed by user' },
      { ok: false, error: 'claude_window_not_found', message: 'The Claude desktop app is not open.' },
    ]),
  );
}

export function listSidebarSessions() {
  record('sidebar');
  // Same shape as desktop.ps1's sidebar mode: the label is the button's name (title + badges).
  const title = fz().windowTitle();
  const rows = [{ title, label: title, open: true }, { title: fz().str(), label: `${fz().str()} Running`, open: false }];
  return Promise.resolve(pick([{ ok: true, sessionTitle: title, sessions: rows }, { ok: false, error: 'claude_window_not_found', message: 'x' }]));
}

export function switchSession(title) {
  record('switch', { title });
  return Promise.resolve(pick([{ ok: true, sessionTitle: String(title).slice(0, 200) }, { ok: false, error: 'session_not_found', message: 'x' }]));
}

export function sendToDesktop(text, opts = {}) {
  record('send', { text, expectTitle: opts.expectTitle });
  return Promise.resolve(pick([{ ok: true, sessionTitle: opts.expectTitle || 't' }, { ok: false, error: 'prompt_box_not_empty', message: 'x' }]));
}
