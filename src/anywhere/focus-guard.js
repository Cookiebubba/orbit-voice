// The focus guard ("Orbit anywhere", phase 7): the safety net that keeps the user's focus theirs.
//
//   Prevent (the real protection, elsewhere): every act goes through UI Automation with
//   AutoSetFocus off or window messages (hands.js); Orbit's own avatar windows never take focus.
//
//   Detect: the window in front changes (the focus helper's EVENT_SYSTEM_FOREGROUND). It's theft
//   when the new window is one Orbit (or a helper) acted on in the last few seconds, the user
//   hasn't touched the mouse or keyboard in the last half second, Alt+Tab isn't open, and it isn't
//   a switch the user asked for (switch_to_window marks those).
//
//   Restore: the user's window goes back to the front, with the same chain switch_to_window uses
//   (Windows remembers which control had the caret in it). The theft is logged (no titles), and the
//   app's profile remembers that this kind of act pulls it forward, so the hands use another way
//   next time.
//
//   Won't: inject anything into other apps, fight UAC or credential prompts, menus, IME windows,
//   admin windows or games. Windows decides who may take the foreground, so a restore can be denied;
//   a keystroke typed in the few milliseconds before the restore can't be recalled.

export const GUARD_LIMITS = Object.freeze({ actWindowMs: 8000, inputGraceMs: 500, maxRestoresPerMinute: 6 });

export function createFocusGuard({ focusStore, switchTo, isIntentional = () => false, onTheft = () => {}, enabled = () => true, now = () => Date.now(), limits = GUARD_LIMITS } = {}) {
  const acts = new Map(); // hwnd -> { at, action, role, app }
  const restores = [];
  let off = null;

  async function onChange({ current, previous }) {
    if (!enabled() || !current?.hwnd || !previous?.hwnd || current.hwnd === previous.hwnd) return;
    const t = now();
    const act = acts.get(current.hwnd);
    if (!act || t - act.at > limits.actWindowMs) return; // not a window Orbit just worked in
    if (focusStore.switching) return; // Alt+Tab
    if (isIntentional(current.hwnd)) return; // the user asked to go there
    if (Number.isFinite(current.idle) && current.idle < limits.inputGraceMs) return; // the user clicked or typed
    while (restores.length && t - restores[0] > 60_000) restores.shift();
    if (restores.length >= limits.maxRestoresPerMinute) return; // never a tug of war
    restores.push(t);
    const r = await Promise.resolve(switchTo(previous.hwnd)).catch(() => ({ error: 'failed' }));
    onTheft({ thief: current, victim: previous, act, restored: !!r?.switched, how: r?.how || r?.error || '' });
  }

  return {
    start() {
      if (!off && focusStore) off = focusStore.on('change', (e) => void onChange(e));
    },
    stop() {
      off?.();
      off = null;
    },
    /** Orbit (or a helper) just acted in this window: if it comes forward by itself now, it's theft. */
    noteAct(hwnd, { action = '', role = '', app = '' } = {}) {
      const h = Math.floor(Number(hwnd)) || 0;
      if (!h) return;
      acts.set(h, { at: now(), action, role, app });
      if (acts.size > 64) acts.delete(acts.keys().next().value);
    },
    get running() {
      return !!off;
    },
  };
}
