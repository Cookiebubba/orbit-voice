// Switching windows when the user asks ("Orbit anywhere", phase 6): "switch to Discord", "bring up
// Photoshop", "take me there". The one thing Orbit does that moves the user's focus, and only on
// their words. The method is the brief's tested chain, run by the focus helper:
//   1. minimized? restore it (ShowWindow SW_RESTORE: 5 of 5)
//   2. SetForegroundWindow, and check it took (2 of 5 alone: Windows' foreground lock decides)
//   3. refused? minimize it without activating, then restore it (4 of 4 with 2+3)
//   4. still refused? flash its taskbar button and say so
// Never the Alt-key trick (it types a real Alt into the user's app) or AttachThreadInput with the
// user's foreground app (it can hang both). The focus guard (phase 7) is told it's intentional, so
// it isn't undone.
//
// A leaf module (no imports): tools.js imports Orbit anywhere, so this can't borrow from it.

export const SWITCH_LIMITS = Object.freeze({ askMaxAgeMs: 2 * 60_000, guardGraceMs: 3000 });

// Words that ask to go to a window (the same verbs switch_session listens for), and "take me there",
// "show me", "go there" (the target is the one Orbit just offered, phase 8's approvals).
const SWITCH = /\b(switch|swap|flip|jump|open|pull\s+(it\s+|that\s+)?up|bring\s+(it\s+|that\s+)?up|go\s+(back\s+|over\s+)?(to|into)|take\s+me|back\s+to|change\s+(over\s+)?to|move\s+(over\s+)?to)\b/i;
const THERE = /\b(take me (there|to it)|show me|go there|bring (it|that) up|switch (me )?(there|to it))\b/i;
const NEGATED = /\b(don'?t|do\s+not|never|not|no\s+need\s+to|stop)\b(\s+\S+){0,3}?\s+(switch|swap|flip|jump|open|pull|bring|go|take|change|move|show)\b/i;

/** Do these words ask to switch windows? (Not "don't switch", not a question about switching.) */
export function asksToSwitch(words) {
  const w = String(words || '');
  return (SWITCH.test(w) || THERE.test(w)) && !NEGATED.test(w);
}

let intentional = { hwnd: 0, until: 0 };
/** The focus guard asks: was this switch the user's own request? */
export function switchIsIntentional(hwnd, now = Date.now()) {
  return now < intentional.until && (!intentional.hwnd || intentional.hwnd === hwnd);
}
/** Mark a switch as the user's request for a moment (the guard leaves it alone). */
export function markIntentional(hwnd, ms = SWITCH_LIMITS.guardGraceMs, now = Date.now()) {
  intentional = { hwnd: Math.floor(Number(hwnd)) || 0, until: now + ms };
}

/** What the helper's switch answer means, in words for the voice. */
export function switchOutcome(r, name) {
  if (!r || r.error) return { ok: false, error: r?.error === 'no_window' ? 'That window has closed.' : `Orbit could not switch to ${name}.` };
  if (r.switched) return { ok: true, switched: true, how: r.how };
  if (r.how === 'flash') return { ok: true, switched: false, flashing: true, say: `Windows wouldn't let Orbit bring ${name} forward, so its taskbar button is flashing.` };
  return { ok: false, error: `Windows wouldn't let Orbit bring ${name} forward.` };
}
