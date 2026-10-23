// Which window the user means ("this window", "the Discord one", "my notes in Notepad").
//
//   "this" / nothing named   the window the user is in: the active context's window (phase 4) or
//                            else the app window that was in front last (focus.lastApp)
//   a name                   the best match among the windows open now, by app name and title
//                            words; a tie between different windows is ambiguous (the voice asks)

import { appName, describeWindow, focus, listWindows } from '../platform/index.js';

const STOP = new Set(['the', 'a', 'an', 'my', 'that', 'this', 'one', 'window', 'app', 'in', 'on', 'of', 'to', 'for', 'and', 'thing', 'program', 'please']);
const words = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w));

const THIS = /^(this|here|current|focused|front|active|it|that|the one i'?m (in|on|looking at))?\s*(window|app|one|screen)?$/i;
/** Does the user mean the window they're in (no name given)? */
export const meansThisWindow = (q) => !String(q || '').trim() || THIS.test(String(q).trim());

/** How well a window matches the words: 0 (not at all) to 1 (every word). */
export function matchScore(win, query) {
  const q = words(query);
  if (!q.length) return 0;
  const app = words(appName(win));
  const exe = words(String(win?.exe || '').replace(/\.exe$/i, ''));
  const title = words(win?.title);
  let hit = 0;
  for (const w of q) {
    if (app.includes(w) || exe.includes(w)) hit += 1;
    else if (title.includes(w)) hit += 0.9;
    else if (w.length >= 4 && [...app, ...exe, ...title].some((t) => t.startsWith(w) || (t.length >= 4 && w.startsWith(t)))) hit += 0.6;
  }
  return hit / q.length;
}

let activeWindow = () => null; // phase 4: the active context's window
/** Contexts (phase 4) say which window is "this one" while the conversation lives in one. */
export function setActiveWindowSource(fn) {
  activeWindow = typeof fn === 'function' ? fn : () => null;
}

/**
 * The window the user means. Resolves { win } (fresh from the helper when possible), or
 * { error, say } with `candidates` when it's ambiguous or nothing matches.
 */
export async function resolveWindow(query = '') {
  if (meansThisWindow(query)) {
    const base = activeWindow() || focus.lastApp;
    if (!base) return { error: 'no_window', say: "Orbit hasn't seen you in an app window yet. Click into the one you mean, then ask again." };
    const fresh = (await describeWindow(base.hwnd)) || null;
    if (!fresh || !fresh.hwnd) return { error: 'gone', say: 'That window has closed.' };
    return { win: fresh };
  }
  const open = await listWindows();
  // Windows seen lately but not in the Alt+Tab list now (minimized ones are still listed) are gone.
  const pool = open.length ? open : focus.recent;
  const scored = pool.map((w) => ({ w, s: matchScore(w, query) })).filter((x) => x.s >= 0.5);
  scored.sort((a, b) => b.s - a.s);
  if (!scored.length) return { error: 'no_match', say: `There's no open window that matches "${String(query).slice(0, 60)}".`, candidates: pool.slice(0, 8).map(label) };
  const best = scored.filter((x) => x.s === scored[0].s);
  if (best.length > 1) {
    // Several windows of one app: the one used most recently wins.
    const order = focus.recent.map((r) => r.hwnd);
    const known = best.filter((x) => order.includes(x.w.hwnd)).sort((a, b) => order.indexOf(a.w.hwnd) - order.indexOf(b.w.hwnd));
    if (known.length) return { win: known[0].w };
    return { error: 'ambiguous', say: 'More than one window matches. Which one?', candidates: best.slice(0, 6).map((x) => label(x.w)) };
  }
  return { win: scored[0].w };
}

/** A window as the voice names it: "Notepad: shopping list.txt". */
export function label(win) {
  const app = appName(win);
  const title = String(win?.title || '').slice(0, 80);
  return title && title !== app ? `${app}: ${title}` : app || title || 'a window';
}
