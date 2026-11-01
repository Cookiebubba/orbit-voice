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

import { STAGE_FRESH_MS, stageMatchesNative, validateStage } from '../src/avatar-stage.js';

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
  // One avatar per place: a window's Qubit never shows on the window home's avatar is on, and a
  // window's new Qubit comes up only once one fading out of that window has gone.
  const homeHwnd = () => Number(home()?.hostHwnd) || 0;
  const leaving = new Map(); // context id -> promise: its old avatar is fading out
  const place = (g) => {
    const b = g.bounds;
    if (g.automatic && kind === 'qubit') {
      const s = g.stage;
      if (!g.anchored && s && stageMatchesNative(s, b)) g.anchored = true;
      const valid = g.stageEnabled && g.anchored && Date.now() < g.stageUntil && stageMatchesNative(s, b, { origin: false }) && !b.min && !b.cloaked && current()?.hwnd === g.hwnd;
      g.avatar.onRoam?.(valid ? s.frame : null, b, { owner: g.id, identity: `${g.instanceId || ''}:${g.epoch || ''}`, eligible: !!valid });
      return;
    }
    if (!b || (g.hwnd && g.hwnd === homeHwnd())) {
      if (g.managed) g.avatar.onStage?.(null, null, true);
      return g.avatar.onClaude({ found: false });
    }
    if (kind === 'qubit' && g.stageEnabled) {
      const s = g.stage;
      if (!g.anchored && s && stageMatchesNative(s, b)) g.anchored = true;
      const valid = g.anchored && Date.now() < g.stageUntil && stageMatchesNative(s, b, { origin: false });
      g.avatar.onStage?.(valid ? s.frame : null, b, true);
      if (!valid || s.frame.suspended || s.frame.exclusions.length) return g.avatar.onClaude({ found: false });
    } else g.avatar.onStage?.(null, b, false);
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
    const g = { id: ctx.id, hwnd: ctx.hwnd, pid: ctx.pid || null, automatic: !!ctx.automatic, managed: !!ctx.managed, avatar, bounds: ctx.native || null, stageEnabled: !!ctx.stageEnabled, instanceId: ctx.instanceId, epoch: ctx.epoch, stage: null, anchored: false, stageUntil: 0, stageTimer: null, lastActiveAt: Number.isFinite(ctx.lastActiveAt) ? ctx.lastActiveAt : Date.now() };
    guests.set(ctx.id, g);
    avatar.onVoice(voiceFor(ctx.id));
    const up = () => {
      if (guests.get(ctx.id) !== g) return;
      avatar.setEnabled(true, size, { entrance });
      place(g);
    };
    const fading = leaving.get(ctx.id);
    if (fading) fading.then(up);
    else up();
    log(`avatar: ${kind} joined a window (${guests.size} beside home)`);
  }
  function remove(id) {
    const g = guests.get(id);
    if (!g) return;
    guests.delete(id);
    clearTimeout(g.stageTimer);
    // (Wait for every avatar still fading out of that window, not just this one.)
    const p = Promise.all([leaving.get(id), g.avatar.leave()]).finally(() => leaving.get(id) === p && leaving.delete(id));
    leaving.set(id, p);
  }
  const rewatch = () => watch([...guests.values()].map((g) => g.hwnd).filter((h) => h > 0));

  const host = {
    /** The contexts changed (src/anywhere/contexts.js snapshot): add, remove and wake avatars. */
    sync(snapshot) {
      if (!snapshot) return;
      lastSnap = snapshot;
      activeId = snapshot.active?.id || 'home';
      const wanted = new Map((snapshot.contexts || []).filter((c) => !c.home).map((c) => [c.id, c]));
      for (const id of [...guests.keys()]) if (!wanted.has(id)) remove(id);
      for (const [id, c] of wanted) {
        let g = guests.get(id);
        const replaced = g && (g.hwnd !== c.hwnd || g.pid !== (c.pid || null) || g.instanceId !== c.instanceId || g.epoch !== c.epoch);
        if (g && replaced && !(g.automatic && c.automatic) && !(g.managed && c.managed)) { remove(id); g = null; }
        if (g) {
          if (Number.isFinite(c.lastActiveAt)) g.lastActiveAt = c.lastActiveAt;
          if (replaced || g.stageEnabled !== !!c.stageEnabled) {
            clearTimeout(g.stageTimer); g.stage = null; g.anchored = false; g.stageUntil = 0;
            if (replaced) g.bounds = null;
          }
          if (c.native) g.bounds = c.native;
          g.hwnd = c.hwnd; g.pid = c.pid || null; g.automatic = !!c.automatic; g.managed = !!c.managed;
          g.stageEnabled = !!c.stageEnabled;
          g.instanceId = c.instanceId;
          g.epoch = c.epoch;
        } else add(c, { entrance: true });
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
    /** Latest-only optional stage; heartbeat renews the lease without rebuilding renderer geometry. */
    onStage(id, value, receivedAt = Date.now()) {
      const g = guests.get(id);
      if (!g || !g.stageEnabled) return;
      const s = validateStage(value, g.instanceId);
      const usable = s?.available && Number(s.frame.window.handle) === g.hwnd && s.frame.window.pid === g.pid && (g.epoch == null || s.frame.window.epoch === g.epoch) ? s : null;
      if (JSON.stringify(g.stage) !== JSON.stringify(usable)) { g.stage = usable; g.anchored = false; }
      g.stageUntil = receivedAt + STAGE_FRESH_MS;
      clearTimeout(g.stageTimer);
      if (usable && g.stageUntil > Date.now()) {
        g.stageTimer = setTimeout(() => { g.stage = null; g.anchored = false; place(g); }, g.stageUntil - Date.now());
        g.stageTimer.unref?.();
      }
      place(g);
    },
    /** The watched windows moved, resized, minimized or hid (from the focus helper). */
    onWins(wins) {
      const visible = new Set(shown());
      for (const w of wins || []) {
        for (const g of guests.values()) {
          if (g.hwnd !== w.hwnd) continue;
          if (g.pid && g.pid !== w.pid) { g.bounds = null; g.stage = null; g.anchored = false; if (g.automatic) place(g); else { g.avatar.onStage?.(null, null, g.stageEnabled); g.avatar.onClaude({ found: false }); } continue; }
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
    /** The avatar settings changed (click to talk, throwing): every guest's page hears. */
    refresh() {
      for (const g of guests.values()) g.avatar.refresh?.();
    },
    setEnabled(on) {
      const was = enabled;
      enabled = !!on;
      if (!enabled) for (const id of [...guests.keys()]) remove(id);
      else if (!was && lastSnap) host.sync(lastSnap);
      rewatch();
    },
    stop() {
      for (const g of guests.values()) { clearTimeout(g.stageTimer); g.avatar.stop(); }
    },
    get guests() {
      return [...guests.values()].map((g) => ({ id: g.id, hwnd: g.hwnd, visible: shown().includes(g.id), window: g.avatar.window }));
    },
    get activeId() {
      return activeId;
    },
    /** For tests: each guest with its window's bounds (as the focus helper reports them) and its avatar. */
    debug() {
      const vis = new Set(shown());
      return [...guests.values()].map((g) => ({ id: g.id, hwnd: g.hwnd, shown: vis.has(g.id), active: g.id === activeId, bounds: g.bounds ? { ...g.bounds } : null, avatar: g.avatar }));
    },
  };
  return host;
}
