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

import { appName, uiaRequest } from '../platform/index.js';
import { actable, windowText } from './policy.js';
import { focusGuard, isHomeWindow, profileFor, profileStore } from './index.js';
import { heal, isOutwardLabel, locate } from './profiles.js';
import { label } from './windows.js';

export const HAND_LIMITS = Object.freeze({ actsPerRequest: 12, confirmMs: 60_000, textMax: 4000 });
export const ACTIONS = Object.freeze(['type', 'set_text', 'press', 'toggle', 'select', 'expand', 'collapse']);

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
  const actionable = pool.filter((n) => (action ? canDo(n, action) : /[VITSE]/.test(n.pat || '')));
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

/** Which pattern an action needs on a node (null if it can't). */
export function canDo(node, action) {
  const p = String(node?.pat || '');
  switch (action) {
    case 'type':
    case 'set_text':
      return /V/.test(p) && !node.ro && !node.pw;
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
    default:
      return 'Orbit could not do that in that window.';
  }
}

/**
 * Do one act now (the gate was passed by the caller). Scans, finds the control, checks it, acts,
 * verifies. Resolves { ok, did, verified, stole_focus } or { ok: false, error }.
 */
export async function perform({ win, node, action, text = '', control = null, profile = null, scan = null }) {
  // An app this kind of act pulled forward before (the focus guard noted it): the other way.
  const prefer = (profile?.quirks || []).includes(`activates:${action}:${node.t}`) ? 'legacy' : '';
  focusGuard.noteAct(win.hwnd, { action, role: node.t, app: appName(win) }); // if it comes forward now, that's theft
  const r = await uiaRequest('act', { hwnd: win.hwnd, i: node.i, rid: node.rid || '', t: node.t, n: node.n || '', action, value: String(text ?? '').slice(0, HAND_LIMITS.textMax), ...(prefer ? { prefer } : {}) });
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
  if (!canDo(f.node, action)) return { ok: false, error: `"${windowText(f.node.n || f.node.a || query, 60)}" can't be used to ${action.replace('_', ' ')}.` };
  const outward = isOutward({ node: f.node, action, text, control: f.control, profile });
  return { ok: true, plan: { win, node: f.node, action, text, control: f.control || null, profile, scan, outward } };
}
