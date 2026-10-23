// A stand-in for the Claude desktop app's windows, for scripts/fuzz-e2e.mjs: the real Orbit
// (electron/main.js) loads it through ORBIT_FAKE_DESKTOP (honoured only when the app isn't
// packaged) and src/desktop.js hands it each action with exactly the arguments desktop.ps1 would
// get. It keeps a small model of Claude (several windows, sidebars, prompt boxes, new-session
// pages) with the same rules as desktop.ps1, and records every call in globalThis.__orbitE2E.
// Nothing here looks at, clicks or types into the real Claude app.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

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

/**
 * Where Claude's prompt box is, as UI Automation reports it (st.layout can move it), in window `w`:
 * like the real one it grows upward with its text's lines (20 px a line), and Claude's Send button
 * stays at its bottom right. Only there while the box has text (as the real Send button).
 */
export function boxLayout(st, w) {
  const L = { promptBoxRect: { x: 300, y: 700, w: 600, h: 24 }, windowRect: { x: 0, y: 0, w: 1200, h: 800 }, sendButtonRect: { x: 868, y: 696, w: 32, h: 32 }, ...st.layout };
  const lines = Math.min(8, String(w?.promptText || '').split('\n').length);
  if (lines > 1 && L.promptBoxRect) {
    const grow = 20 * (lines - 1);
    L.promptBoxRect = { ...L.promptBoxRect, y: L.promptBoxRect.y - grow, h: L.promptBoxRect.h + grow };
  }
  return L;
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
    // Where the prompt box is, as UI Automation reports it (st.layout can change it), and with
    // -Rects Claude's Send button, which (like the real one) is only there while the box has text.
    const L = boxLayout(st, front);
    const sendButtonRect = args.includes('-Rects') && front.promptText ? L.sendButtonRect : null;
    return { ok: true, sessionTitle: front.title, newSession: !!front.newPage, folder: front.newPage?.folder ?? null, promptBoxFound: !!L.promptBoxRect, promptText: front.promptText, windowId: front.hwnd, windows, promptBoxRect: L.promptBoxRect, windowRect: L.windowRect, sendButtonRect };
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

/**
 * A stand-in for electron/claude-window.ps1 (the Claude window watcher): reports this fake's windows
 * as if they were on screen (far off to the left, so the avatar's strip that follows them is never
 * in sight; a window's own `rect` overrides that), every second and on each command (and on
 * `S().nudge()`, for a test that moved a window). Child-process shaped: stdin, stdout, 'exit'.
 * Like the real one it watches a window's prompt box ("box <hwnd>"): every 150 ms (the window is
 * "in front"), and at once when a window moves; one line per change.
 */
export function windowHelper() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let watching = 0;
  let lastBox = '';
  const reportBox = () => {
    const st = S();
    const w = watching && st.windows.find((x) => x.hwnd === watching);
    if (!w || w.min || child.stdout.writableEnded) return;
    const L = boxLayout(st, w);
    const line = JSON.stringify({ box: { hwnd: watching, rect: L.promptBoxRect, win: L.windowRect } });
    if (line === lastBox) return;
    lastBox = line;
    (st.boxReports ??= []).push({ at: Date.now(), rect: L.promptBoxRect });
    child.stdout.write(`${line}\n`);
  };
  let tick = 0;
  const boxTimer = setInterval(() => {
    tick++;
    if (watching && tick % 5 === 0) reportBox();
  }, 30);
  const report = () => {
    const st = S();
    const wins = st.windows.map((w, i) => ({ hwnd: w.hwnd, min: !!w.min, x: -4200 + i * 40, y: 120 + i * 30, w: 1200, h: 800, ...w.rect }));
    const fg = st.windows.find((w) => !w.min)?.hwnd || 0;
    if (!child.stdout.writableEnded) child.stdout.write(`${JSON.stringify({ wins, fg, front: fg ? 'claude' : 'other' })}
`);
  };
  child.stdin.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      const m = line.trim().match(/^box (\d+)$/);
      if (m) {
        watching = Number(m[1]);
        lastBox = '';
        S().boxWatch = watching;
        setTimeout(reportBox, 5);
      }
    }
    setTimeout(report, 10); // follow / pause
  });
  const timer = setInterval(report, 1000);
  setTimeout(report, 50);
  child.kill = () => {
    clearInterval(timer);
    clearInterval(boxTimer);
    child.stdout.end();
    setImmediate(() => child.emit('exit', 0));
  };
  S().helperStarted = (S().helperStarted || 0) + 1;
  S().nudge = () => {
    report();
    setTimeout(reportBox, 5); // the window moved: the box with it
  };
  return child;
}

export default { run, windowHelper };
