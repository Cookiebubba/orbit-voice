// Which Claude window the orb docks on, when Claude has several (the main window, sessions popped
// out into their own). The one most recently in front: the foreground one, or the last Claude
// window that was in front while another app is. If that one is minimized, the most recent one
// that isn't; with every Claude window minimized, that first one (and the orb hides). Before any
// Claude window has been in front, the highest one in z-order (as desktop.ps1 picks it too).
//
// pick(state) takes the helper's report (see claude-window.ps1):
//   { wins: [{ hwnd, min, x, y, w, h }, ...highest in z-order first], fg: hwnd | 0, front }
// and returns what Orbit docks on: { found, hwnd, min, front, x, y, w, h, windows }.

const isWin = (w) => !!w && Number.isSafeInteger(w.hwnd) && w.hwnd > 0 && [w.x, w.y, w.w, w.h].every(Number.isFinite);

export function createWindowPicker() {
  let mru = []; // Claude windows by when they were last in front, latest first

  return {
    pick(state) {
      const wins = Array.isArray(state?.wins) ? state.wins.filter(isWin) : [];
      const byHwnd = new Map(wins.map((w) => [w.hwnd, w]));
      mru = mru.filter((h) => byHwnd.has(h)); // closed windows drop out
      const fg = state?.fg;
      if (byHwnd.has(fg)) mru = [fg, ...mru.filter((h) => h !== fg)];
      if (!wins.length) return { found: false };
      const order = [...mru.map((h) => byHwnd.get(h)), ...wins.filter((w) => !mru.includes(w.hwnd))];
      const w = order.find((x) => !x.min) || order[0];
      const front = ['claude', 'orbit', 'other'].includes(state.front) ? state.front : 'other';
      return { found: true, hwnd: w.hwnd, min: !!w.min, front, x: w.x, y: w.y, w: w.w, h: w.h, windows: wins.length };
    },
    /** Latest first (for tests). */
    recent: () => [...mru],
  };
}
