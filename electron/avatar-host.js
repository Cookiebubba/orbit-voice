// A Qubit in every window Orbit is in ("Orbit anywhere", phase 4). The home avatar (avatar.js on the
// Claude window, as before) is unchanged; this hosts the others: one avatar strip per context
// window (src/anywhere/contexts.js), placed with the same geometry along that window's bottom edge,
// z-ordered just above it (so other apps still cover him), hidden while it's minimized or on another
// virtual desktop. Those windows have no prompt box, so he stands on the window's bottom edge.
//
// Only the active context's avatar is fully alive (listening, talking, emotes, tricks); the others
// rest (Orbit's voice state reads "off" to them, so they doze or potter about on their own) until
// the conversation comes back to their window. A new context's avatar pops in with an entrance; a
// closed or dismissed one fades out. At most 4 guests show at once (the most recently active).
//
// Window positions come from the focus helper's "watch" (per-process window events, no polling).

export const MAX_GUESTS = 4;
const REST = Object.freeze({ phase: 'off', asleep: true });

export function createAvatarHost({ makeAvatar, home = () => null, watch = () => {}, current = () => null, log = () => {} } = {}) {
  const guests = new Map(); // context id -> { id, hwnd, avatar, bounds, lastActiveAt }
  let kind = null; // 'qubit' | 'buddy' | null
  let size = 2;
  let activeId = 'home';
  let voice = REST;
  let enabled = true;
  let lastSnap = null; // the latest contexts snapshot, to rebuild from (kind changes, re-enabled)

  const frontFor = (hwnd) => {
    const c = current();
    if (c?.hwnd === hwnd) return 'claude'; // (its own window in front: "on top", like Claude in front)
    if (c?.kind === 'orbit') return 'orbit';
    return 'other';
  };
  const place = (g) => {
    if (!g.bounds) return g.avatar.onClaude({ found: false });
    const b = g.bounds;
    g.avatar.onClaude({ found: !b.cloaked, hwnd: g.hwnd, min: !!b.min, front: frontFor(g.hwnd), x: b.x, y: b.y, w: b.w, h: b.h });
  };
  const voiceFor = (id) => (id === activeId ? voice : REST);
  const shown = () =>
    [...guests.values()]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, MAX_GUESTS)
      .map((g) => g.id);

  function add(ctx, { entrance }) {
    if (!kind || !enabled) return;
    const avatar = makeAvatar(kind);
    const g = { id: ctx.id, hwnd: ctx.hwnd, avatar, bounds: null, lastActiveAt: Number.isFinite(ctx.lastActiveAt) ? ctx.lastActiveAt : Date.now() };
    guests.set(ctx.id, g);
    avatar.onVoice(voiceFor(ctx.id));
    avatar.setEnabled(true, size, { entrance });
    place(g);
    log(`avatar: ${kind} joined a window (${guests.size} beside home)`);
  }
  function remove(id) {
    const g = guests.get(id);
    if (!g) return;
    guests.delete(id);
    g.avatar.leave();
  }
  const rewatch = () => watch([...guests.values()].map((g) => g.hwnd));

  const host = {
    /** The contexts changed (src/anywhere/contexts.js snapshot): add, remove and wake avatars. */
    sync(snapshot) {
      if (!snapshot) return;
      lastSnap = snapshot;
      activeId = snapshot.active?.id || 'home';
      const wanted = new Map((snapshot.contexts || []).filter((c) => !c.home).map((c) => [c.id, c]));
      for (const id of [...guests.keys()]) if (!wanted.has(id)) remove(id);
      for (const [id, c] of wanted) {
        const g = guests.get(id);
        if (g && Number.isFinite(c.lastActiveAt)) g.lastActiveAt = c.lastActiveAt;
        else add(c, { entrance: true });
      }
      // Beyond the cap, the least recently active rest hidden (their windows keep their context).
      const visible = new Set(shown());
      for (const g of guests.values()) {
        g.avatar.onVoice(voiceFor(g.id));
        if (!visible.has(g.id)) g.avatar.onClaude({ found: false });
        else place(g);
      }
      home()?.onVoice?.(voiceFor('home'));
      rewatch();
    },
    /** The watched windows moved, resized, minimized or hid (from the focus helper). */
    onWins(wins) {
      const visible = new Set(shown());
      for (const w of wins || []) {
        for (const g of guests.values()) {
          if (g.hwnd !== w.hwnd) continue;
          g.bounds = w;
          if (visible.has(g.id)) place(g);
        }
      }
    },
    /** The window in front changed: each guest's z-order follows (above his window, or on top). */
    onFocus() {
      const visible = new Set(shown());
      for (const g of guests.values()) if (visible.has(g.id) && g.bounds) place(g);
    },
    /** Orbit's voice state: the active window's avatar gets it, the others rest. */
    onVoice(state) {
      voice = state && typeof state === 'object' ? state : REST;
      for (const g of guests.values()) g.avatar.onVoice(voiceFor(g.id));
      home()?.onVoice?.(voiceFor('home'));
    },
    /** The avatar kind or size changed (Settings): guests are made again as the new one. */
    setKind(next, nextSize = size) {
      const changed = (next || null) !== kind;
      kind = next || null;
      size = nextSize;
      if (!changed) {
        for (const g of guests.values()) g.avatar.setEnabled(true, size);
        return;
      }
      const bounds = new Map([...guests.values()].map((g) => [g.id, g.bounds]));
      for (const id of [...guests.keys()]) remove(id);
      if (lastSnap) host.sync(lastSnap);
      for (const g of guests.values()) {
        g.bounds = bounds.get(g.id) || null;
        place(g);
      }
      rewatch();
    },
    /** The avatar the user is talking to now: the active window's, else home's. */
    active() {
      return guests.get(activeId)?.avatar || home();
    },
    /** Is this web contents one of the guests' pages? (for their hover messages) */
    guestFor(webContents) {
      for (const g of guests.values()) if (g.avatar.window && g.avatar.window.webContents === webContents) return g.avatar;
      return null;
    },
    setEnabled(on) {
      const was = enabled;
      enabled = !!on;
      if (!enabled) for (const id of [...guests.keys()]) remove(id);
      else if (!was && lastSnap) host.sync(lastSnap);
      rewatch();
    },
    stop() {
      for (const g of guests.values()) g.avatar.stop();
    },
    get guests() {
      return [...guests.values()].map((g) => ({ id: g.id, hwnd: g.hwnd, visible: shown().includes(g.id), window: g.avatar.window }));
    },
    get activeId() {
      return activeId;
    },
  };
  return host;
}
