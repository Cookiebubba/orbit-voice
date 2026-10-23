// Reading and looking at app windows for the voice ("Orbit anywhere", phase 3). Read-only: nothing
// here clicks, types, focuses or copies anything. Every result is the window's own text, marked as
// data (policy.js), and nothing is ever written to the log but what happened.

import fs from 'node:fs';
import { appName, captureWindow, uiaRequest } from '../platform/index.js';
import { DATA_NOTE, readable, windowText } from './policy.js';
import { profileFor } from './index.js';
import { profileSummary } from './profiles.js';
import { label } from './windows.js';

const READ_CHARS = 4000;

/** Failure words for a helper error code. */
function failure(r) {
  switch (r?.error) {
    case 'no_window':
    case 'gone':
      return 'That window has closed.';
    case 'timeout':
      return 'That app took too long to answer (it may be busy).';
    case 'access_denied':
      return 'Windows kept Orbit out of that app (it may run as administrator).';
    case 'unavailable':
      return r.message || 'Reading other apps works only on Windows for now.';
    default:
      return 'Orbit could not read that window.';
  }
}

/** The labelled controls of the app (from its profile), or undefined if there's none in time. */
async function controlsOf(win, waitMs = 2500) {
  const p = await Promise.race([profileFor(win).catch(() => null), new Promise((r) => setTimeout(() => r(null), waitMs).unref?.())]);
  return p ? profileSummary(p) : undefined;
}

/** The window's text, the control with focus and its main controls. */
export async function readWindow(win, { maxChars = READ_CHARS } = {}) {
  const ok = readable(win);
  if (!ok.ok) return { ok: false, error: ok.say };
  const [r, layout] = await Promise.all([uiaRequest('read', { hwnd: win.hwnd, maxChars: maxChars + 500 }), controlsOf(win)]);
  if (!r?.ok) return { ok: false, error: failure(r) };
  const text = windowText((Array.isArray(r.lines) ? r.lines : []).join('\n'), maxChars);
  return {
    ok: true,
    window: label(win),
    app: appName(win),
    minimized: win.min || undefined,
    text: text || '(no text Orbit can read: it may be a picture or a canvas; look_at_window can look at it)',
    truncated: !!r.truncated || text.endsWith('…') || undefined,
    focused_control: r.focused ? windowText(`${r.focused.t}${r.focused.n ? `: ${r.focused.n}` : ''}`, 160) : undefined,
    controls: layout?.controls?.length ? layout.controls.slice(0, 25).map((c) => windowText(c, 100)) : undefined,
    note: DATA_NOTE,
  };
}

/** What's selected in the window (text, or list items). Never uses the clipboard. */
export async function readSelection(win) {
  const ok = readable(win);
  if (!ok.ok) return { ok: false, error: ok.say };
  const r = await uiaRequest('selection', { hwnd: win.hwnd });
  if (!r?.ok) return { ok: false, error: failure(r) };
  if (r.kind === 'text') return { ok: true, window: label(win), selected_text: windowText(r.text, 6000), in_control: r.from?.n ? windowText(r.from.n, 80) : undefined, note: DATA_NOTE };
  if (r.kind === 'items') return { ok: true, window: label(win), selected_items: r.items.slice(0, 20).map((s) => windowText(s, 200)), note: DATA_NOTE };
  return { ok: true, window: label(win), nothing_selected: true, note: "Orbit can't see a selection there. Some apps (canvases, some editors) don't show it to Orbit." };
}

/**
 * Look at the window as a picture: its text by on-device OCR, and, only with "Let Claude see
 * windows" on, Claude's answer to `question` about the picture (`vision`: (picture, question) =>
 * { ok, spoken }). The picture is deleted before this returns.
 */
export async function lookAtWindow(win, { question = '', vision = null } = {}) {
  const ok = readable(win);
  if (!ok.ok) return { ok: false, error: ok.say };
  if (win.min) return { ok: false, error: 'That window is minimized, so there is nothing to see. Ask the user to restore it (or say "switch to it").' };
  const shot = await captureWindow(win.hwnd, { ocr: true });
  if (!shot?.ok) return { ok: false, error: shot?.error === 'minimized' ? 'That window is minimized, so there is nothing to see.' : failure(shot) };
  try {
    if (!(shot.lit > 0.05)) return { ok: false, error: 'The picture of that window came back black (it may be minimized or protected).' };
    const out = { ok: true, window: label(win), seen_text: windowText(shot.ocr || '', 3000) || '(no readable text in the picture)', note: DATA_NOTE };
    if (vision) {
      const v = await vision(shot.path, question);
      if (v?.ok) out.claude_saw = windowText(v.spoken, 600);
      else out.claude_could_not_look = String(v?.error || 'no answer').slice(0, 160);
      if (v?.needsSignIn) out.sign_in_needed = true;
    } else {
      out.how = 'Read on this PC (text in the picture only). Claude sees the picture only if the user turns on "Let Claude see windows" in Orbit Settings.';
    }
    return out;
  } finally {
    if (shot.path) fs.rm(shot.path, { force: true }, () => {});
  }
}
