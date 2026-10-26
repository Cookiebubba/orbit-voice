// Orbit's mouse: a second, visual cursor of Orbit's own. Windows has one mouse and it is the user's,
// so this one never moves it or clicks: it shows where Orbit is pointing ("show me where") and where
// Orbit is acting (each act glides here first, then presses), while the real input goes through UI
// Automation or the app's pipe (src/anywhere/hands.js).
//
// One overlay window per display, inside its work area (never the taskbar, which is off-limits anyway),
// sized to the part of it a glide needs (a transparent window repaints all of itself each frame, so a
// whole-display one costs several times more while it moves): transparent, click-through (mouse events ignored, so clicks land in the window under it), always on
// top, never focusable (WS_EX_NOACTIVATE), never in the taskbar. Each shows only while the cursor or
// its glide is on that display, and the page in it (ui/src/mouse/main.js) draws only while something
// moves. Glides are planned here in physical screen pixels on the shared clock (Date.now), so each
// display's page draws its part of a glide that crosses displays, at that display's scaling.
//
// What it draws is only the arrow (one solid fill, no outline, ring or shadow: Qubit's art rules).
// Idle, it hides: after pointing (it rests on the control a few seconds) or shortly after the last act, it fades out
// and the windows hide. A fresh appearance fades in a little up and left of the target and glides in.

// (The default import: in Electron it is the API; under plain Node, in the tests, only a path, and the
// tests pass their own BrowserWindow and screen.)
import electron from 'electron';

/** Ease in and out (cubic): the same curve the page draws with (ui/src/mouse/look.js). */
export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const MOUSE_TIMING = Object.freeze({ fadeMs: 260, enterDip: { x: -46, y: -34 }, margin: 56, roomDip: 160 });

/** How long a glide of `distDip` (display-independent pixels) takes: quick for short hops, never a jump. */
export const glideMs = (distDip) => Math.round(Math.min(700, Math.max(260, 240 + Math.max(0, Number(distDip) || 0) * 0.45)));

/** Where a glide { from, to, t0, ms } is at time t (physical px). */
export function glideAt(m, t) {
  if (!m) return null;
  const k = m.ms > 0 ? ease((t - m.t0) / m.ms) : 1;
  return { x: m.from.x + (m.to.x - m.from.x) * k, y: m.from.y + (m.to.y - m.from.y) * k };
}

const inside = (r, p) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const boxOf = (pts, pad) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
};
const union = (a, b) => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const within = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
const VOICE_KEYS = ['phase', 'asleep', 'hearing', 'muted', 'draft', 'sending', 'claudeWorking'];

export function createOrbitMouse({ url, webPreferences = {}, lockDown = () => {}, BrowserWindow = electron?.BrowserWindow, screen = electron?.screen, enabled = () => true, log = () => {}, now = () => Date.now() } = {}) {
  const pages = new Map(); // display id -> { win, display, area (physical), box (its window, DIPs), ready, shown }
  let pos = null; // where the tip is meant to be at the end of the motion (physical px)
  let motion = null; // { from, to, t0, ms }
  let press = null; // { at }
  let visible = false;
  let enter = false;
  let voice = { phase: 'off' };
  let hideTimer = null;
  let fadeTimer = null;
  let trimTimer = null;
  let hooked = false;
  let stopped = false;

  /**
   * A display's work area in the helpers' coordinates: physical pixels on Windows; elsewhere DIPs
   * times its scaling.
   */
  const physArea = (d) => {
    const wa = d.workArea;
    try {
      if (typeof screen.dipToScreenRect === 'function' && process.platform === 'win32') {
        const r = screen.dipToScreenRect(null, wa);
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    } catch {}
    const s = d.scaleFactor || 1;
    return { x: wa.x * s, y: wa.y * s, w: wa.width * s, h: wa.height * s };
  };
  const displays = () => {
    try {
      return screen.getAllDisplays().map((d) => ({ d, area: physArea(d) }));
    } catch {
      return [];
    }
  };
  const displayAt = (p) => displays().find((x) => inside(x.area, p)) || null;

  function hook() {
    if (hooked || typeof screen.on !== 'function') return;
    hooked = true;
    const again = () => {
      // Displays changed: windows for displays that are gone go; the others take their new place.
      const now_ = new Map(displays().map((x) => [x.d.id, x]));
      for (const [id, pg] of pages) {
        const x = now_.get(id);
        if (!x) {
          if (!pg.win.isDestroyed()) pg.win.destroy();
          pages.delete(id);
          continue;
        }
        pg.display = x.d;
        pg.area = x.area;
        hidePage(pg); // (sized again for the next glide)
        pg.box = { x: x.d.workArea.x, y: x.d.workArea.y, width: 1, height: 1 };
        if (!pg.win.isDestroyed()) pg.win.setBounds(pg.box);
      }
    };
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, again);
  }

  function page({ d, area }) {
    let pg = pages.get(d.id);
    if (pg && !pg.win.isDestroyed()) return pg;
    const wa = d.workArea;
    const box = { x: wa.x, y: wa.y, width: 1, height: 1 }; // (sized when it shows)
    const win = new BrowserWindow({
      ...box,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false, // never takes focus (WS_EX_NOACTIVATE on Windows)
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      title: 'Orbit mouse',
      webPreferences,
    });
    lockDown(win);
    win.setIgnoreMouseEvents(true); // clicks go through to whatever is under it
    win.setAlwaysOnTop(true, 'screen-saver');
    pg = { win, display: d, area, box, ready: false, shown: false };
    pages.set(d.id, pg);
    win.webContents.on('did-finish-load', () => {
      pg.ready = true;
      send(pg);
    });
    win.on('closed', () => {
      if (pages.get(d.id) === pg) pages.delete(d.id);
    });
    win.loadURL(url());
    hook();
    return pg;
  }

  const scaleOf = (pg) => pg.area.w / Math.max(1, pg.display.workArea.width);
  // The page places physical points by its display (area: the work area's physical origin; wa: its
  // DIP origin) and its own window's place on screen (window.screenX/Y, current even mid-resize).
  const message = (pg) => ({
    visible,
    enter,
    motion,
    press,
    voice,
    area: { x: pg.area.x, y: pg.area.y },
    wa: { x: pg.display.workArea.x, y: pg.display.workArea.y },
    origin: { x: pg.area.x + (pg.box.x - pg.display.workArea.x) * scaleOf(pg), y: pg.area.y + (pg.box.y - pg.display.workArea.y) * scaleOf(pg) },
    scale: scaleOf(pg),
  });
  /** The window (DIPs) a physical region needs on this display, with room around it, inside the work area. */
  function fit(pg, region) {
    const s = scaleOf(pg);
    const wa = pg.display.workArea;
    const room = MOUSE_TIMING.roomDip;
    const x0 = Math.max(wa.x, Math.floor(wa.x + (region.x - pg.area.x) / s - room));
    const y0 = Math.max(wa.y, Math.floor(wa.y + (region.y - pg.area.y) / s - room));
    const x1 = Math.min(wa.x + wa.width, Math.ceil(wa.x + (region.x + region.w - pg.area.x) / s + room));
    const y1 = Math.min(wa.y + wa.height, Math.ceil(wa.y + (region.y + region.h - pg.area.y) / s + room));
    return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  }
  function send(pg) {
    if (!pg.ready || pg.win.isDestroyed()) return;
    pg.win.webContents.send('mouse:state', message(pg));
  }
  function broadcast() {
    for (const pg of pages.values()) if (pg.shown) send(pg);
  }

  function showOn(region) {
    for (const x of displays()) {
      if (!overlaps(x.area, region)) continue;
      const pg = page(x);
      // Fresh: just the room this glide needs. Showing: it only grows (never moves under the cursor).
      const want = fit(pg, region);
      const next = pg.shown ? (within(want, pg.box) ? pg.box : union(pg.box, want)) : want;
      if (next !== pg.box) {
        pg.box = next;
        pg.win.setBounds(next);
      }
      if (!pg.shown) {
        pg.shown = true;
        pg.win.showInactive();
        pg.win.setAlwaysOnTop(true, 'screen-saver'); // (z-order set while hidden may not stick)
      }
    }
  }
  function hidePage(pg) {
    if (!pg.shown) return;
    pg.shown = false;
    if (!pg.win.isDestroyed()) pg.win.hide();
  }
  /** After a glide: only the displays the cursor is on stay shown. */
  function trim() {
    if (!visible || !pos) return;
    const region = boxOf([pos], MOUSE_TIMING.margin);
    for (const pg of pages.values()) if (pg.shown && !overlaps(pg.area, region)) hidePage(pg);
  }

  function fadeOut() {
    clearTimeout(hideTimer);
    if (!visible) return;
    visible = false;
    enter = false;
    broadcast();
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (visible) return;
      for (const pg of pages.values()) hidePage(pg);
      press = null;
    }, MOUSE_TIMING.fadeMs + 60);
  }

  const api = {
    /**
     * Glide the tip to (x, y) (physical screen pixels), taking `ms` (or a time from the distance),
     * then resting there `holdMs` before it fades.
     * Returns { shown, ms, arrived (a promise) } or { shown: false, why }.
     */
    glide({ x, y, ms = null, holdMs = 1500 } = {}) {
      if (stopped || !enabled()) return { shown: false, why: 'off' };
      const to = { x: Number(x), y: Number(y) };
      if (![to.x, to.y].every(Number.isFinite)) return { shown: false, why: 'no_place' };
      const target = displayAt(to);
      if (!target) return { shown: false, why: 'off_screen' };
      const t = now();
      const scale = target.area.w / Math.max(1, target.d.workArea.width);
      const was = visible && motion ? glideAt(motion, t) : null;
      const from = was || { x: to.x + MOUSE_TIMING.enterDip.x * scale, y: to.y + MOUSE_TIMING.enterDip.y * scale };
      const dist = Math.hypot(to.x - from.x, to.y - from.y) / scale;
      const dur = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : glideMs(dist);
      enter = !was;
      motion = { from, to, t0: t, ms: dur };
      pos = to;
      visible = true;
      clearTimeout(hideTimer);
      clearTimeout(fadeTimer);
      clearTimeout(trimTimer);
      showOn(boxOf([from, to], MOUSE_TIMING.margin));
      broadcast();
      let done;
      const arrived = new Promise((res) => (done = res));
      trimTimer = setTimeout(() => {
        trim();
        done();
      }, dur);
      hideTimer = setTimeout(fadeOut, dur + Math.max(0, Number(holdMs) || 0));
      return { shown: true, ms: dur, arrived };
    },
    /** The press: the arrow dips for a moment at its tip, where Orbit acts. */
    press() {
      if (!visible) return false;
      press = { at: now() };
      broadcast();
      return true;
    },
    /** Fade out now (the setting went off, or nothing more to show). */
    hide: fadeOut,
    /** Is this point (physical px) on a display's work area? (Off it, there's nothing to show.) */
    onScreen(p) {
      return !!(p && displayAt(p));
    },
    /** Orbit's voice state (as the avatars get it): the colour, and the pulse while he speaks. */
    onVoice(s) {
      if (!s || typeof s !== 'object') return;
      const next = { output: Math.min(1, Math.max(0, Number(s.output) || 0)) };
      for (const k of VOICE_KEYS) next[k] = k === 'phase' ? String(s.phase || 'off') : !!s[k];
      voice = next;
      if (visible) broadcast();
    },
    /** Make the windows ahead of time (hidden), so the first glide has its page ready. */
    prewarm() {
      if (stopped || !enabled()) return;
      for (const x of displays()) page(x);
    },
    stop() {
      stopped = true;
      for (const tm of [hideTimer, fadeTimer, trimTimer]) clearTimeout(tm);
      for (const pg of pages.values()) if (!pg.win.isDestroyed()) pg.win.destroy();
      pages.clear();
    },
    /** For tests: where it is and which windows show. */
    debug() {
      return {
        visible,
        pos: pos && { ...pos },
        now: motion ? glideAt(motion, now()) : null,
        pages: [...pages.values()].map((pg) => ({ id: pg.display.id, shown: pg.shown, ready: pg.ready, area: { ...pg.area }, win: pg.win })),
      };
    },
  };
  return api;
}
