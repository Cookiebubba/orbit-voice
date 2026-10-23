// The voice's switch_to_window ("Orbit anywhere", phase 6): bring a window to the front when the
// user asks ("switch to Discord", "bring up Photoshop", "take me there"). See switching.js for the
// method; this is the gate:
//   - the user's own latest words ask to switch (their words carry the request, so a notification
//     arriving after them doesn't void it), under two minutes old; or a clear yes to Orbit's own
//     "take you there?" offer (a helper's approval, phase 8), said after that offer;
//   - one request, one switch ("don't switch" is never one);
//   - the focus guard is told it's intentional, so it isn't undone.

import { switchToWindow } from '../platform/index.js';
import { asksToSwitch, markIntentional, switchOutcome, SWITCH_LIMITS } from './switching.js';
import { windowText } from './policy.js';
import { label, resolveWindow } from './windows.js';

export const SWITCH_TOOL_DEF = Object.freeze({
  type: 'function',
  name: 'switch_to_window',
  description:
    'Bring an app window to the front, only when the user asks: "switch to Discord", "bring up Photoshop", "take me there". It is the one thing that moves the user\x27s focus. Not for Claude Code sessions (that is switch_session).',
  parameters: {
    type: 'object',
    properties: { window: { type: 'string', description: 'The app or title words the user used ("Discord", "the Photoshop one"); empty for the one Orbit just offered to take them to.' } },
    required: [],
  },
});

let offer = null; // { hwnd, name, at }: Orbit offered "take you there?" (phase 8)
/** Orbit offered to take the user to this window; a clear yes to it is a request to switch. */
export function offerSwitch(win, now = Date.now()) {
  offer = win?.hwnd ? { hwnd: win.hwnd, name: label(win), at: now } : null;
}

export function createSwitchHandler({ recentUtterance = () => null, isClearYes = () => false, available = () => true, notify = () => {} } = {}) {
  let used = 0; // the `at` of the request that already switched
  return {
    async switch_to_window({ window } = {}) {
      if (!available()) return { ok: false, error: 'Orbit anywhere is off (Settings -> Orbit anywhere), or not available on this computer.' };
      const spoke = recentUtterance();
      const words = String(spoke?.text || '');
      const fresh = !!spoke && Date.now() - spoke.at <= SWITCH_LIMITS.askMaxAgeMs && spoke.at !== used;
      const yesToOffer = !!offer && fresh && spoke.at > offer.at && Date.now() - offer.at <= SWITCH_LIMITS.askMaxAgeMs && isClearYes(words);
      if (!fresh || (!asksToSwitch(words) && !yesToOffer)) {
        return { ok: false, error: 'Not switched: only switch windows when the user has just asked to, in their own words (each request switches once).' };
      }
      const query = typeof window === 'string' ? window.trim().slice(0, 120) : '';
      let target = null;
      if (!query || /^(there|it|that( one)?)$/i.test(query)) {
        if (!offer) return { ok: false, error: 'Which window? Ask the user what to switch to.' };
        target = { hwnd: offer.hwnd, name: offer.name };
      } else {
        const t = await resolveWindow(query);
        if (!t.win) return { ok: false, error: t.say, ...(t.candidates ? { open_windows: t.candidates } : {}) };
        target = { hwnd: t.win.hwnd, name: label(t.win) };
      }
      markIntentional(target.hwnd);
      const r = switchOutcome(await switchToWindow(target.hwnd), windowText(target.name, 80));
      if (r.ok) {
        used = spoke.at;
        offer = null;
        notify({ type: 'bridge.anywhere', action: 'switch' });
      }
      return r.ok ? { ...r, ok: undefined, window: windowText(target.name, 120), next_step: r.flashing ? 'Tell the user in one short sentence.' : 'Say a word or two at most ("There you go."), or nothing.' } : r;
    },
  };
}
