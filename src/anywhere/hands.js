// Orbit's hands ("Orbit anywhere", phase 5): acting in another app's window without the mouse,
// the keyboard or the focus. Every act goes to one control of one window through UI Automation
// with AutoSetFocus off (uia.ps1 "act"), or window messages for classic Win32 controls (WM_CHAR to
// type into an edit box, BN_CLICKED to its parent for a button), so the window is never brought
// forward and the user's cursor and keys stay theirs. Each act is checked first (the control is
// still there and enabled) and verified after (read back).
//
// The gate, in Orbit's own code (it doesn't rely on the model behaving):
//   - only on the user's own words since the latest app notification (a window, a web page or a
//     helper can never start an act), at most 12 acts per request, never in off-limits windows;
//   - every act is classified: local (typing a draft, ticking a box, picking a list item, pressing
//     a control that stays inside the app) or outward (send, post, delete, buy, overwrite, sign out,
//     the Enter key in a chat box... see profiles.js OUTWARD_WORDS; anything unknown counts as
//     outward). Outward acts are held: Orbit says exactly what will happen and waits for a clear yes
//     in the user's next words (no notification in between, under a minute, key-checked so the act
//     can't change underneath). The one exception: a message the user dictated and said to send in
//     the same breath ("type 'running late' in Discord and send it"); Orbit reads it back once.
//     Never an exception for deleting, buying or anything else outward.
//
// Text in web apps (2026-10): a web app (OpenCode, Discord, anything Chromium, Electron or WebView2)
// only takes text that arrives as input events; UI Automation's SetValue shows it in the box but the
// app never sees it (its Send stays grey). So a text act is checked for whether the app really took
// it (uia.ps1: its Send-like button came on, or the box was put back), and if not, Orbit tries the
// next way, without asking, and says so briefly:
//   1. "value": UI Automation, no focus at all (every app; the only way for most desktop apps);
//   2. "cdp": the app's own DevTools protocol, no focus either: only with the setting on and only for
//      an app the user started with a debugging port (src/anywhere/cdp.js);
//   3. "borrow": the box takes the focus for a moment and the text goes in as keystrokes, then the
//      user's window comes straight back. Only after the user said yes to it for that app (asked
//      once, remembered in the app's profile).
// The way that worked is remembered in the app's profile (inputMethod) and tried first next time.
//
// Apps under Orbit (2026-10): an app the user approved once is restarted under Orbit's pipe keeper
// (keeper.js), and then "pipe" comes first: real input events over a private pipe, no port, no
// focus. A rich editor (Discord's Slate box) is never given SetValue at all (uia.ps1 refuses it,
// "rich_box"); if the app isn't under Orbit yet, the act comes back needs_keeper, and Orbit asks the
// user once whether to restart that app under Orbit (act-tools.js) instead of borrowing focus.
//
// Orbit's mouse (2026-10): each act first glides Orbit's own cursor (an overlay, never the user's
// mouse) to its control and presses there (mouse.js leadIn), so acts in the background are visible.

import { appName, switchToWindow, uiaRequest } from '../platform/index.js';
import { getSetting } from '../config.js';
import { cdpClick, cdpEnter, cdpType } from './cdp.js';
import { keeperForWindow } from './keeper.js';
import { leadIn } from './mouse.js';
import { markIntentional } from './switching.js';
import { actable, windowText } from './policy.js';
import { focusGuard, isHomeWindow, profileFor, profileStore } from './index.js';
import { heal, isOutwardLabel, locate } from './profiles.js';
import { label } from './windows.js';

export const HAND_LIMITS = Object.freeze({ actsPerRequest: 12, confirmMs: 60_000, textMax: 4000 });
export const ACTIONS = Object.freeze(['type', 'set_text', 'press', 'enter', 'toggle', 'select', 'expand', 'collapse']);

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Find the control the user means in a fresh scan: by the app profile's ladder first (a key or
 * name it knows), else by name and role in the scan. Returns { node, by, control?, ambiguous? }.
 */
export function findControl(scan, query, { role = '', profile = null, action = '' } = {}) {
  const q = norm(query);
  if (!q || !Array.isArray(scan?.nodes)) return { node: null };
  const known = profile?.controls?.find((c) => norm(c.key) === q || norm(c.name) === q || norm(c.aid) === q);
  if (known) {
    const f = locate(known, scan);
    if (f) return { node: f.node, by: f.by, healed: f.healed, control: known };
  }
  // By name in the scan itself (list and tree items go by their text here: a channel, a file).
  const nodes = scan.nodes;
  const usable = (n) => n.i !== 0 && !n.pw && (!role || String(n.t).toLowerCase() === role.toLowerCase());
  const exact = nodes.filter((n) => usable(n) && (norm(n.n) === q || norm(n.a) === q));
  const partial = (n) => !!norm(n.n) && (norm(n.n).includes(q) || q.includes(norm(n.n)));
  const pool = exact.length ? exact : nodes.filter((n) => usable(n) && q.length >= 3 && partial(n));
  // Those that can do what's asked (or anything at all), then those whose name starts with the words.
  // A label that can't do it stands for the control it's in (a sidebar row's text): that control.
  const can = (n) => canDo(n, actionFor(n, action));
  const seen = new Set();
  const actionable = (action ? pool.map((n) => (can(n) ? n : ownerFor(nodes, n, action))) : pool.filter((n) => /[VITSE]/.test(n.pat || '')))
    .filter((n) => n && !seen.has(n.i) && seen.add(n.i));
  let hits = actionable.length ? actionable : pool;
  if (hits.length > 1) {
    const starts = hits.filter((n) => norm(n.n).startsWith(q));
    if (starts.length) hits = starts;
  }
  if (hits.length > 1) {
    // Several: the one that's enabled, if only one is.
    const enabled = hits.filter((n) => n.en);
    if (enabled.length === 1) return { node: enabled[0], by: 'name' };
    return { node: null, ambiguous: hits.slice(0, 6).map((n) => `${n.t}: ${n.n || n.a}`) };
  }
  return hits[0] ? { node: hits[0], by: exact.length ? 'name' : 'partial' } : { node: null };
}

/**
 * The action as this node takes it: a press on something that can only be picked (a sidebar row, a
 * list entry, a tab) picks it, as a click on it would.
 */
export function actionFor(node, action) {
  return action === 'press' && !canDo(node, 'press') && canDo(node, 'select') ? 'select' : action;
}

/**
 * The control a label is part of: a text or image that can't do `action` itself (System Settings'
 * "Wi-Fi" is a text inside its sidebar row), up to three levels up, when that control can and has no
 * other name of its own. It carries the label's name. null if there's none.
 */
export function ownerFor(nodes, node, action) {
  const label = norm(node?.n);
  if (!label || !Array.isArray(nodes)) return null;
  const byI = new Map(nodes.map((n) => [n.i, n]));
  let cur = node;
  for (let k = 0; k < 3; k++) {
    const up = byI.get(cur.p);
    if (!up || up.i === 0 || up.i === cur.i || up.pw) return null;
    const own = norm(up.n);
    if (own && own !== label && !own.includes(label)) return null; // a group with a name of its own
    if (canDo(up, actionFor(up, action))) return { ...up, n: up.n || node.n };
    cur = up;
  }
  return null;
}

/** Which pattern an action needs on a node (null if it can't). */
export function canDo(node, action) {
  const p = String(node?.pat || '');
  switch (action) {
    case 'type':
    case 'set_text':
      return (/V/.test(p) || !!node.rich) && !node.ro && !node.pw;
    case 'enter':
      return (/V/.test(p) || !!node.rich) && !node.pw;
    case 'press':
      return /[IAT]/.test(p);
    case 'toggle':
      return /T/.test(p) || /[IA]/.test(p);
    case 'select':
      return /S/.test(p);
    case 'expand':
    case 'collapse':
      return /E/.test(p);
    default:
      return false;
  }
}

/**
 * Is this act outward? Typing, ticking, picking and expanding stay inside the app; pressing is
 * outward if the control's label (or the profile) says so, or if nothing is known about it.
 * Typing text that ends in a line break into a chat box would send it: outward too.
 */
export function isOutward({ node, action, text = '', control = null, profile = null }) {
  const name = String(node?.n || node?.a || '');
  if (action === 'type' || action === 'set_text') return /[\r\n]\s*$/.test(String(text)) && /message|chat|reply|comment|post/i.test(name);
  if (action === 'enter') return true; // Enter in a box sends (a chat) or submits: always asked
  if (action === 'select' || action === 'expand' || action === 'collapse') return false;
  if (control?.outward || (profile?.outward || []).includes(control?.key)) return true;
  if (isOutwardLabel(name)) return true;
  if (action === 'toggle') return false;
  // Pressing something unnamed is unknown: outward.
  return !name.trim();
}

const SEND_IN_SAME_BREATH = /\b(and|then|&)\s+(send|post|submit)\s+(it|that|this)\b|\b(send|post) it\b/i;
/**
 * The same-breath exception: the user dictated exactly this text and said to send it in the same
 * words ("type 'on my way' in Discord and send it"). Only for sending what they dictated.
 */
export function sameBreathSend(utterance, typed, controlName) {
  const u = String(utterance || '');
  const t = String(typed || '').trim();
  if (!t || !SEND_IN_SAME_BREATH.test(u)) return false;
  if (!/\b(send|post|submit|reply)\b/i.test(String(controlName || ''))) return false;
  if (/\b(don'?t|do not|never|wait)\b/i.test(u)) return false;
  return norm(u).includes(norm(t));
}

/** One act's description, as Orbit says it before an outward act ("Press Send in Discord"). */
export function describeAct({ action, node, text, win }) {
  const where = appName(win) || 'that window';
  const what = node?.n || node?.a || 'that control';
  const quoted = text ? ` "${windowText(String(text), 120)}"` : '';
  switch (action) {
    case 'press':
      return `press ${what} in ${where}`;
    case 'type':
    case 'set_text':
      return `type${quoted} into ${what} in ${where}`;
    case 'toggle':
      return `switch ${what} in ${where}`;
    case 'select':
      return `pick ${what} in ${where}`;
    case 'enter':
      return `press Enter in ${what} in ${where}`;
    default:
      return `${action} ${what} in ${where}`;
  }
}

function failure(r) {
  switch (r?.error) {
    case 'stale':
      return 'That control changed before Orbit could use it. Try again.';
    case 'disabled':
      return 'That control is turned off (greyed out) right now.';
    case 'not_supported':
      return "That control can't do that.";
    case 'password':
      return 'Orbit never types into password fields.';
    case 'no_window':
      return 'That window has closed.';
    case 'timeout':
      return 'That app took too long to answer.';
    case 'unavailable':
      return r.message || 'Acting in other apps works only on Windows for now.';
    case 'no_focus':
    case 'focus_lost':
      return r.message || 'The box would not take the focus, so nothing was typed.';
    default:
      return 'Orbit could not do that in that window.';
  }
}

export const INPUT_METHODS = Object.freeze(['pipe', 'value', 'cdp', 'borrow']);
const METHOD_SAYS = { cdp: "through the app's debugging port", borrow: 'by borrowing focus for a moment' };

/**
 * The order to try the ways of typing in this app: the one that worked last time first. 'borrow'
 * only with the user's OK for this app (`borrowOk`: given now, or remembered in the profile).
 */
export function inputOrder(profile, { borrowOk = false, cdpOn = false, pipeOn = false } = {}) {
  const ok = { pipe: pipeOn, value: true, cdp: cdpOn, borrow: borrowOk || profile?.borrowFocusOk === true };
  // Under Orbit: the pipe first, always (it is how the app takes real typing).
  const first = pipeOn ? ['pipe'] : INPUT_METHODS.includes(profile?.inputMethod) && profile.inputMethod !== 'pipe' ? [profile.inputMethod] : [];
  return [...new Set([...first, ...INPUT_METHODS.filter((m) => m !== 'pipe')])].filter((m) => ok[m]);
}

/**
 * Typing that the app really takes (see the top): each way in order until one registers. Resolves
 * like uia's act, plus { method, needs_borrow }: needs_borrow when no way allowed so far worked
 * (the text may show in the box, but the app didn't take it).
 */
async function typeText({ win, node, action, text, profile }, { borrowOk = false, only = '', before: known = null } = {}) {
  const pipeOn = !!keeperForWindow(win);
  const order = only ? [only] : inputOrder(profile, { borrowOk, cdpOn: getSetting('anywhereCdp') === true, pipeOn });
  let before = typeof known === 'string' ? known : null; // the box's text before the first try (a retry replaces the whole box)
  let first = null;
  for (const method of order) {
    const act = before !== null && action === 'type' ? 'set_text' : action;
    const value = before !== null && action === 'type' ? before + text : text;
    let r;
    if (method === 'cdp' || method === 'pipe') {
      r = await cdpType(win, { name: node.n || node.a || '', text: value, action: act });
      if (!r.ok) continue; // not available for this app: the next way
      const check = await uiaRequest('scan', { hwnd: win.hwnd, maxNodes: 4000, values: true }).catch(() => null);
      const box = check?.nodes?.find((n) => n.rid && n.rid === node.rid) || check?.nodes?.find((n) => n.n === node.n && n.t === node.t);
      const same = (a, b) => String(a || '').replace(/\r/g, '').trim() === String(b || '').replace(/\r/g, '').trim();
      r = { ok: true, via: r.via, verified: !box || same(box.v, value) || !!node.rich, registered: true };
    } else if (method === 'borrow') {
      markIntentional(win.hwnd); // focus moves there on purpose, for a moment: not the guard's business
      r = await uiaRequest('act', { hwnd: win.hwnd, i: node.i, rid: node.rid || '', t: node.t, n: node.n || '', action: act, value: String(value).slice(0, HAND_LIMITS.textMax), method: 'borrow' });
      // The user's window back in front at once (whatever happened).
      const back = Number(r?.fg) || 0;
      if (back && back !== Number(win.hwnd)) {
        for (let i = 0; i < 3; i++) {
          const sw = await Promise.resolve(switchToWindow(back)).catch(() => null);
          if (sw?.switched) break;
          await new Promise((res) => setTimeout(res, 150)); // (Windows can refuse while the app is still activating)
        }
      }
      if (!r?.ok) {
        first ??= r;
        continue;
      }
    } else {
      const prefer = (profile?.quirks || []).includes(`activates:${action}:${node.t}`) ? 'legacy' : '';
      r = await uiaRequest('act', { hwnd: win.hwnd, i: node.i, rid: node.rid || '', t: node.t, n: node.n || '', action: act, value: String(value).slice(0, HAND_LIMITS.textMax), ...(prefer ? { prefer } : {}) });
      // A rich editor (Discord's Slate box): nothing was written; the next way, if there is one.
      if (r?.error === 'rich_box') {
        if (before === null && typeof r.before === 'string') before = r.before;
        first ??= { ...r, ok: true, registered: false };
        continue;
      }
      if (!r?.ok) return r;
    }
    if (before === null && typeof r.before === 'string') before = r.before;
    first ??= r;
    // Taken (or nothing tells otherwise: a desktop app's box): done, and remembered for this app.
    if (r.registered !== false) {
      if (profile && profile.inputMethod !== method && (method !== 'value' || profile.inputMethod)) {
        profile.inputMethod = method;
        if (method === 'borrow') profile.borrowFocusOk = true;
        profileStore().save(profile);
      }
      return { ...r, method, before };
    }
  }
  // Not taken. Not under Orbit yet: the way is to restart the app under Orbit (asked once per app);
  // borrowing focus can't work from Orbit's background helper (Windows won't let it).
  const needsKeeper = !only && !pipeOn;
  return { ...first, ok: first?.ok !== false, error: undefined, registered: false, method: 'value', before, needs_keeper: needsKeeper || undefined, needs_borrow: !needsKeeper && !only && !inputOrder(profile, { borrowOk }).includes('borrow') };
}

/**
 * Do one act now (the gate was passed by the caller). Scans, finds the control, checks it, acts,
 * verifies. Resolves { ok, did, verified, stole_focus } or { ok: false, error }. Text acts may try
 * more than one way (see the top): `borrowOk` is the user's yes to borrowing focus in this app.
 */
export async function perform({ win, node, action, text = '', control = null, profile = null, scan = null }, { borrowOk = false, only = '', before = null, lead = true } = {}) {
  // Orbit's mouse glides to the control and presses there first (mouse.js: about 220 ms, never more
  // than a moment), so the act is visible; the input itself still goes in without the user's mouse.
  if (lead) await leadIn({ win, node, scan });
  if (action === 'type' || action === 'set_text') {
    focusGuard.noteAct(win.hwnd, { action, role: node.t, app: appName(win) });
    const r = await typeText({ win, node, action, text, profile }, { borrowOk, only, before });
    if (!r?.ok) return { ok: false, error: failure(r) };
    if (control && profile && scan) {
      const found = locate(control, scan);
      if (found && heal(profile, control, scan, found)) profileStore().save(profile);
    }
    return {
      ok: true,
      did: describeAct({ action, node, text, win }),
      verified: r.verified !== false,
      registered: r.registered,
      via: r.via,
      method: r.method,
      how: METHOD_SAYS[r.method],
      needs_borrow: r.needs_borrow || undefined,
      needs_keeper: r.needs_keeper || undefined,
      before: r.before, // (internal: a retry the other way replaces the whole box; never passed on)
      stole_focus: !!r.stoleFocus,
    };
  }
  // Enter in a box: only through the pipe (Windows can't press a key in a window without its focus).
  if (action === 'enter') {
    if (!keeperForWindow(win)) return { ok: false, error: 'Pressing Enter there needs the app under Orbit.', needs_keeper: true };
    const r = await cdpEnter(win, { name: node.n || node.a || '' });
    if (!r?.ok) return { ok: false, error: r?.message || failure(r) };
    return { ok: true, did: describeAct({ action, node, text, win }), verified: true, via: r.via };
  }
  // An app this kind of act pulled forward before (the focus guard noted it): the other way.
  const prefer = (profile?.quirks || []).includes(`activates:${action}:${node.t}`) ? 'legacy' : '';
  focusGuard.noteAct(win.hwnd, { action, role: node.t, app: appName(win) }); // if it comes forward now, that's theft
  let r = await uiaRequest('act', { hwnd: win.hwnd, i: node.i, rid: node.rid || '', t: node.t, n: node.n || '', action, value: String(text ?? '').slice(0, HAND_LIMITS.textMax), ...(prefer ? { prefer } : {}) });
  // Under Orbit, a press the app didn't take through UI Automation: a click in the page instead.
  if (!r?.ok && action === 'press' && keeperForWindow(win) && r?.error !== 'disabled') {
    const c = await cdpClick(win, { name: node.n || node.a || '' });
    if (c?.ok) r = { ok: true, via: c.via, verified: true };
  }
  if (!r?.ok) return { ok: false, error: failure(r) };
  if (control && profile && scan) {
    const found = locate(control, scan);
    if (found && heal(profile, control, scan, found)) profileStore().save(profile);
  }
  return { ok: true, did: describeAct({ action, node, text, win }), verified: r.verified !== false, via: r.via, stole_focus: !!r.stoleFocus };
}

/**
 * Plan one act: the control in a fresh scan, whether it can be done, and whether it's outward.
 * Resolves { ok: true, plan } or { ok: false, error, ... }.
 */
export async function plan({ win, control: query, role = '', action, text = '' }) {
  const ok = actable(win);
  if (!ok.ok) return { ok: false, error: ok.say };
  // Claude's own window has its own tools, with their own consent rules and the no-focus path
  // (desktop.ps1): prompts are drafted and sent, its controls are claude_app. Never acted on here.
  if (isHomeWindow(win)) return { ok: false, error: "That's Claude's window: prompts for Claude go through draft_prompt (and send_draft), and Claude's own controls through claude_app." };
  if (!ACTIONS.includes(action)) return { ok: false, error: `Orbit can't "${String(action).slice(0, 30)}". It can ${ACTIONS.join(', ')}.` };
  if ((action === 'type' || action === 'set_text') && !String(text || '').length) return { ok: false, error: 'Say what to type.' };
  const profile = await profileFor(win).catch(() => null);
  const scan = await uiaRequest('scan', { hwnd: win.hwnd, maxNodes: 4000 });
  if (!scan?.ok) return { ok: false, error: failure(scan) };
  const f = findControl(scan, query, { role, profile, action });
  if (f.ambiguous) return { ok: false, error: `More than one control matches "${windowText(String(query), 60)}".`, candidates: f.ambiguous.map((c) => windowText(c, 80)) };
  if (!f.node) return { ok: false, error: `There's no "${windowText(String(query), 60)}" in ${label(win)}.`, controls: profile?.controls?.slice(0, 20).map((c) => c.key) };
  if (f.node.pw) return { ok: false, error: failure({ error: 'password' }) };
  if (!f.node.en) return { ok: false, error: failure({ error: 'disabled' }) };
  const how = actionFor(f.node, action);
  if (!canDo(f.node, how)) return { ok: false, error: `"${windowText(f.node.n || f.node.a || query, 60)}" can't be used to ${action.replace('_', ' ')}.` };
  const outward = isOutward({ node: f.node, action: how, text, control: f.control, profile });
  return { ok: true, plan: { win, node: f.node, action: how, text, control: f.control || null, profile, scan, outward } };
}
