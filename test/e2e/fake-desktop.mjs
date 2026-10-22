// A stand-in for the Claude desktop app's windows, for scripts/fuzz-e2e.mjs: the real Orbit
// (electron/main.js) loads it through ORBIT_FAKE_DESKTOP (honoured only when the app isn't
// packaged) and src/desktop.js hands it each action with exactly the arguments desktop.ps1 would
// get. It keeps a small model of Claude (several windows, sidebars, prompt boxes, new-session
// pages) with the same rules as desktop.ps1, and records every call in globalThis.__orbitE2E.
// Nothing here looks at, clicks or types into the real Claude app.

const S = () => {
  globalThis.__orbitE2E ??= {};
  const e = globalThis.__orbitE2E;
  e.desktop ??= {
    // Highest in z-order first. title: the session shown (null: a new session or no page).
    windows: [{ hwnd: 101, kind: 'main', title: null, newPage: null, promptText: '', min: false }],
    sidebar: [], // session titles in the main window's sidebar
    folders: ['alpha', 'beta', 'gamma'],
    calls: [], // { mode, at, hint }
    sends: [], // { at, text, title, expectTitle, expectNew }
    chaos: 0, // chance an action fails like the real window sometimes does
    rng: Math.random,
    newCount: 0,
  };
  return e.desktop;
};
export const desktopState = S;

const decode = (b) => (typeof b === 'string' ? Buffer.from(b, 'base64').toString('utf8') : null);
function parse(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-ExpectNew', '-DryRun', '-Fill', '-Filled', '-Clear'].includes(a)) o[a.slice(1)] = true;
    else if (a.startsWith('-')) o[a.slice(1)] = args[++i];
  }
  return o;
}

const raise = (st, w) => {
  st.windows = [w, ...st.windows.filter((x) => x !== w)];
  w.min = false;
};
const listWindows = (st, front) => st.windows.map((w) => ({ id: w.hwnd, title: w.title, kind: w.kind, front: w === front, minimized: w.min }));

export async function run(mode, args) {
  const st = S();
  const o = parse(args);
  const hint = Number(o.FrontHwnd || 0);
  st.calls.push({ mode, at: Date.now(), hint });
  await new Promise((r) => setTimeout(r, 5 + Math.floor(st.rng() * 60))); // the real script takes a moment
  if (!st.windows.length) return { ok: false, error: 'claude_window_not_found', message: 'The Claude desktop app is not open.' };
  if (st.rng() < st.chaos) {
    const fail = { info: 'claude_page_not_found', list: 'claude_page_not_found', switch: 'switch_not_confirmed', new: 'new_session_not_confirmed', send: 'send_button_not_found' }[mode];
    return { ok: false, error: fail || 'script_exception', message: 'x' };
  }
  const front = st.windows.find((w) => w.hwnd === hint && !w.min) || st.windows.find((w) => !w.min) || st.windows[0];
  const windows = listWindows(st, front);

  if (mode === 'info') {
    return { ok: true, sessionTitle: front.title, newSession: !!front.newPage, folder: front.newPage?.folder ?? null, promptBoxFound: true, promptText: front.promptText, windowId: front.hwnd, windows };
  }
  if (mode === 'list') {
    const open = new Map(st.windows.filter((w) => w.title).map((w) => [w.title, w.hwnd]));
    const main = st.windows.find((w) => w.kind === 'main');
    return { ok: true, sessionTitle: front.title, windowId: front.hwnd, windows, sessions: st.sidebar.map((t) => ({ title: t, label: t, open: open.has(t), front: t === front.title, window: open.get(t) || main?.hwnd })) };
  }
  if (mode === 'switch') {
    const want = (decode(o.TitleB64) || '').trim();
    if (!want) return { ok: false, error: 'empty_title' };
    if (front.title === want) return { ok: true, switched: false, sessionTitle: want, windowId: front.hwnd, message: 'That session is already open.' };
    const shown = st.windows.find((w) => w.title === want) || null;
    if (shown) {
      raise(st, shown);
      return { ok: true, switched: true, broughtForward: true, sessionTitle: want, windowId: shown.hwnd };
    }
    const hit = st.sidebar.find((t) => t === want) || st.sidebar.find((t) => t.toLowerCase().includes(want.toLowerCase()));
    const main = st.windows.find((w) => w.kind === 'main');
    if (!hit || !main) return { ok: false, error: 'session_not_in_sidebar', message: "Couldn't find that session in Claude's sidebar.", sessionTitle: front.title };
    const other = st.windows.find((w) => w.title === hit);
    if (other) {
      raise(st, other);
      return { ok: true, switched: true, broughtForward: true, sessionTitle: hit, windowId: other.hwnd };
    }
    main.title = hit;
    main.newPage = null;
    raise(st, main);
    return { ok: true, switched: true, sessionTitle: hit, windowId: main.hwnd };
  }
  if (mode === 'new') {
    const target = front.kind === 'main' ? front : st.windows.find((w) => w.kind === 'main');
    if (!target) return { ok: false, error: 'new_button_not_found', message: 'x', sessionTitle: front.title };
    if (target.promptText) return { ok: false, error: 'prompt_box_not_empty', message: 'The prompt box has text typed in it.', sessionTitle: target.title };
    const want = (decode(o.ProjectB64) || '').trim().toLowerCase();
    let folder = st.folders[0];
    if (want) {
      const hits = st.folders.filter((f) => f === want || f.includes(want));
      if (!hits.length) return { ok: false, error: 'project_not_in_sidebar', message: 'x', projects: st.folders, sessionTitle: target.title };
      if (hits.length > 1) return { ok: false, error: 'project_ambiguous', message: 'x', projects: hits, sessionTitle: target.title };
      folder = hits[0];
    } else if (target.newPage) {
      raise(st, target);
      return { ok: true, created: false, newSession: true, folder: target.newPage.folder, windowId: target.hwnd };
    }
    target.title = null;
    target.newPage = { folder };
    raise(st, target);
    return { ok: true, created: true, newSession: true, folder, windowId: target.hwnd };
  }
  if (mode === 'send') {
    const text = decode(o.TextB64) || '';
    let target = front;
    if (o.ExpectTitleB64) {
      const expect = decode(o.ExpectTitleB64);
      const m = st.windows.filter((w) => w.title === expect);
      if (!m.length) return { ok: false, error: 'session_changed', message: 'x', sessionTitle: front.title };
      if (m.length > 1) return { ok: false, error: 'session_ambiguous', message: 'x', sessionTitle: front.title };
      target = m[0];
    } else if (o.ExpectNew) {
      const folder = o.ExpectFolderB64 ? decode(o.ExpectFolderB64) : null;
      const m = st.windows.filter((w) => !w.title && w.newPage && (folder === null || w.newPage.folder === folder));
      if (m.length !== 1) return { ok: false, error: m.length ? 'session_ambiguous' : 'session_changed', message: 'x', sessionTitle: front.title };
      target = m[0];
    }
    if (!text.trim()) return { ok: false, error: 'empty_text' };
    // As desktop.ps1: -Clear empties the box only if it holds exactly the draft; -Fill types the
    // draft in (replacing only Orbit's previous draft, PrevB64) and stops; -Filled sends only if
    // the box still holds exactly the draft. Only a send is recorded in `sends`.
    const same = (a, b) => String(a ?? '').replace(/\r/g, '').trim() === String(b ?? '').replace(/\r/g, '').trim();
    if (o.Clear) {
      const cleared = !!target.promptText && same(target.promptText, text);
      if (cleared) target.promptText = '';
      return { ok: true, cleared, sessionTitle: target.title };
    }
    if (o.Filled) {
      if (!same(target.promptText, text)) return { ok: false, error: 'prompt_box_changed', message: 'x', sessionTitle: target.title };
    } else {
      const mayReplace = o.PrevB64 && target.promptText && same(target.promptText, decode(o.PrevB64));
      if (target.promptText && !mayReplace) return { ok: false, error: 'prompt_box_not_empty', message: 'x', sessionTitle: target.title };
      target.promptText = text;
    }
    if (o.Fill) {
      st.fills = (st.fills || 0) + 1;
      return { ok: true, filled: true, sent: false, sessionTitle: target.title, windowId: target.hwnd };
    }
    if (o.DryRun) {
      target.promptText = '';
      return { ok: true, sent: false, dryRun: true, sessionTitle: target.title, windowId: target.hwnd };
    }
    target.promptText = ''; // Claude empties the box once it accepts the message
    st.sends.push({ at: Date.now(), text, title: target.title, expectTitle: o.ExpectTitleB64 ? decode(o.ExpectTitleB64) : null, expectNew: !!o.ExpectNew });
    if (o.ExpectNew) {
      target.title = `Fresh session ${++st.newCount}`;
      target.newPage = null;
      st.sidebar.unshift(target.title);
    }
    return { ok: true, sent: true, confirmed: true, sessionTitle: target.title, newSession: !!o.ExpectNew, windowId: target.hwnd };
  }
  return { ok: false, error: 'script_exception', message: `unknown mode ${mode}` };
}

export default { run };
