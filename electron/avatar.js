// The avatar's window: a transparent, click-through strip along the bottom of the Claude window
// (the same window the orb docks on), where the avatar lives. Two avatars use it, each with its own
// page: the pixel buddy (buddy.html) and Qubit (qubit.html). It follows the Claude window, sits just
// above it in z-order like the orb (so other apps still cover both), and hides while Claude is
// minimized or not open (the page is told, so it can stop drawing).
//
// It also knows where Claude's prompt box is and tells the page, which turns the box's top edge into
// a platform. Two ways:
//   - fast (onBoxRect): the Claude window helper watches the box itself and reports where it is the
//     moment it moves (someone typing, the window moving or resizing, a sidebar opening, Orbit
//     typing a draft in; see electron/claude-window.ps1). Only where it is, never its text.
//   - full (findBox): the same UI Automation script Grok's tools use, now and then (after the window
//     settles, every 20 s while showing, after a draft or a send): the box and, for Qubit, Claude's
//     Send button (only there while the box has text), which he stomps when a prompt goes. Between
//     full looks the Send button keeps its place from the box's right end and bottom (it sits on the
//     box's row), so it moves with the box.
//
// Free-floating (`free`, macOS for now, where there's no Claude window tracker yet): the strip
// lives along the bottom of the screen the cursor is on, just above the Dock, always on top and on
// every Space. There's no prompt box or Send button to stand on there, so the avatar has the
// floor (the top of the Dock) to itself; it moves when the screen layout changes.
//
// Boxless (`boxless`, "Orbit anywhere": his strip on another app's window, see avatar-host.js): the
// same strip and placement on that window, but there's no prompt box there, so he stands on the
// window's bottom edge (the box is never looked for).
//
// Switching avatars is a handover: the new one's window comes up (its page plays an entrance) while
// the old one's page fades out (leave()), and then the old window closes.
//
// Lifted (lift(true), from the page: the user picked the avatar up to throw it): the window grows to
// cover the work area of the display it's on (never the taskbar), always on top, so the avatar can be
// dragged and fly anywhere on that screen. It stays click-through except over the avatar (the page
// says where it is, as always). The strip's place keeps being worked out meanwhile (the Claude window
// may move) and is sent to the page, so the avatar can land back on it; lift(false) gives the strip
// back. If the page goes quiet while lifted (no lift(true) for LIFT_MAX_QUIET_MS), the strip comes back
// by itself, so the window can never be left covering the screen.

import { BrowserWindow, screen } from 'electron';

import { BUDDY_HEIGHT, boxInStrip, buddyBoundsFor, freeStripFor, sendAtOffset, sendInStrip, sendOffsetFor, usableBox } from './buddy-geometry.js';
import { isAvatarAction } from '../src/avatar-commands.js';
import { cueName } from '../src/emote-cues.js';

export { BUDDY_HEIGHT };

export const AVATAR_KINDS = Object.freeze({
  buddy: { title: 'Orbit buddy', events: ['finished', 'draft', 'sent'], sendButton: false },
  qubit: { title: 'Orbit Qubit', events: ['finished', 'draft', 'sent', 'error'], sendButton: true, emotes: true },
});
const LEAVE_MS = 450; // the page's fade-out, and a little more
export const LIFT_MAX_QUIET_MS = 12_000; // lifted with no word from the page for this long: back to the strip

export function createAvatar({ kind = 'buddy', url, webPreferences, lockDown, getDesktopInfo, log = () => {}, info: info_ = () => {}, free = false, boxless = false, onWindow = () => {}, prefs = () => ({}) }) {
  const K = AVATAR_KINDS[kind];
  if (!K) throw new Error(`unknown avatar ${kind}`);
  let win = null;
  let enabled = false;
  let leaving = false;
  let scale = 2;
  let claude = null; // tracker state (screen px)
  let claudeDip = null;
  let layer = null;
  let boxTimer = null;
  let settleTimer = null;
  let lastBox = null;
  let lastSend = null; // Claude's Send button (Qubit), kept while the box is there (it's only there with text)
  let boxKnown = false; // looked for the box at least once since showing
  let boxBusy = false;
  let lastRaw = null; // the helper's latest report: { rect, win } in UI Automation's space
  let rawAt = 0; // when it came
  let sendOffset = null; // the Send button from the box's right end and bottom: { r, b }
  let voice = { phase: 'off' };
  let pendingEntrance = false;
  let lifted = null; // { area, strip } (DIPs) while the window covers the work area
  let liftTimer = null;

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: 400,
      height: BUDDY_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      focusable: false, // clicking the avatar never takes focus from Claude
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      title: K.title,
      webPreferences,
    });
    lockDown(win);
    win.setIgnoreMouseEvents(true, { forward: true }); // clicks go through to Claude
    onWindow(win); // (macOS: on every Space)
    win.loadURL(url());
    win.webContents.on('did-finish-load', () => {
      send();
      if (pendingEntrance) {
        pendingEntrance = false;
        sendEvent('enter');
      }
    });
    win.on('closed', () => (win = null));
    return win;
  }

  const visible = () => !!win && !win.isDestroyed() && win.isVisible();
  /** The strip's bounds: the window's own, or (lifted) where the strip would be. */
  const stripBounds = () => (lifted ? lifted.strip : win.getBounds());
  const send = () => {
    if (!win || win.isDestroyed()) return;
    const p = prefs() || {};
    win.webContents.send('buddy:state', {
      voice,
      box: lastBox,
      send: lastSend,
      boxKnown,
      scale,
      visible: visible(),
      bounds: stripBounds(),
      lift: lifted ? { area: lifted.area, strip: lifted.strip } : null,
      prefs: { clickTalk: p.clickTalk !== false, throw: p.throw !== false },
    });
  };
  const sendEvent = (name) => {
    if (win && !win.isDestroyed()) win.webContents.send('buddy:event', name);
  };

  function setLayer(next) {
    if (!win || next === layer) return;
    layer = next;
    if (next === 'top') return win.setAlwaysOnTop(true, 'screen-saver');
    win.setAlwaysOnTop(false);
    try {
      win.moveAbove(`window:${claude.hwnd}:0`);
    } catch {
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  }

  function hide() {
    clearInterval(boxTimer);
    boxTimer = null;
    drop({ quiet: true });
    if (visible()) {
      win.hide();
      send(); // the page stops drawing while hidden
    }
  }

  /** The box (and Send button) in the strip from the helper's latest report. True if it changed. */
  function applyRaw() {
    if (!lastRaw || !visible() || !claudeDip) return false;
    const strip = stripBounds();
    const usable = usableBox(lastRaw.rect ? boxInStrip(lastRaw.rect, lastRaw.win, claudeDip, strip) : null, strip.height);
    const nextSend = usable && lastSend ? sendAtOffset(usable, sendOffset, lastSend) || lastSend : null;
    const changed = JSON.stringify(usable) !== JSON.stringify(lastBox) || JSON.stringify(nextSend) !== JSON.stringify(lastSend) || !boxKnown;
    if (!changed) return false;
    if (!!usable !== !!lastBox) info_(usable ? `${kind}: standing room on the prompt box (${usable.w}×${strip.height - usable.y} px from the bottom)` : `${kind}: no prompt box to stand on`);
    lastBox = usable;
    lastSend = nextSend;
    boxKnown = true;
    send();
    return true;
  }

  /** Free-floating: the strip along the bottom of the work area, nothing to stand on but the floor. */
  function placeFree() {
    ensure();
    claudeDip = null;
    let area;
    try {
      area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    } catch {
      area = screen.getPrimaryDisplay().workArea;
    }
    const b = freeStripFor(area);
    if (lifted) lifted.strip = b;
    const cur = win.getBounds();
    if (!lifted && (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height)) win.setBounds(b);
    if (!boxKnown || lastBox || lastSend) {
      lastBox = null;
      lastSend = null;
      boxKnown = true; // the page doesn't wait for a prompt box that will never come
    }
    if (!win.isVisible()) {
      win.showInactive();
      layer = null;
    }
    if (layer !== 'top') {
      layer = 'top';
      win.setAlwaysOnTop(true, 'screen-saver');
    }
    send();
  }

  /** The work area of the display the strip is on (DIPs): never the taskbar or the Dock. */
  function areaFor(b) {
    try {
      return { ...screen.getDisplayMatching(b).workArea };
    } catch {
      return { ...screen.getPrimaryDisplay().workArea };
    }
  }

  /** Picked up: the window covers the work area (always on top) until drop(). Again: still lifted. */
  function lift() {
    if (!win || win.isDestroyed() || !visible() || leaving) return false;
    if (!lifted) {
      const strip = win.getBounds();
      lifted = { strip, area: areaFor(strip) };
      win.setBounds(lifted.area);
      win.setAlwaysOnTop(true, 'screen-saver');
      layer = 'top';
      info_(`${kind}: picked up (the window covers the work area while it's held or flying)`);
    }
    clearTimeout(liftTimer);
    liftTimer = setTimeout(() => {
      log(`${kind}: no word from the page while lifted: the strip comes back`);
      drop();
    }, LIFT_MAX_QUIET_MS);
    send();
    return true;
  }

  /** Back to the strip (where it is now), click-through again. */
  function drop({ quiet = false } = {}) {
    clearTimeout(liftTimer);
    liftTimer = null;
    if (!lifted) return;
    const strip = lifted.strip;
    lifted = null;
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setBounds(strip);
    layer = null;
    if (quiet) return;
    if (free) placeFree();
    else if (claude?.found && !claude.min && enabled) setLayer(claude.front === 'other' ? `above:${claude.hwnd}` : 'top');
    send();
  }
  // The screen layout changed (a display added or removed, the Dock moved): re-place the strip.
  let screenHooked = false;
  function hookScreen() {
    if (screenHooked || !free) return;
    screenHooked = true;
    const again = () => enabled && !leaving && place();
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, again);
  }

  /** Re-place (or hide) the strip for the current Claude window. */
  function place() {
    if (leaving) return;
    if (free) {
      if (!enabled) return hide();
      hookScreen();
      return placeFree();
    }
    if (!enabled || !claude?.found || claude.min) return hide();
    ensure();
    claudeDip = screen.screenToDipRect(null, { x: claude.x, y: claude.y, width: claude.w, height: claude.h });
    const b = buddyBoundsFor(claudeDip);
    if (lifted) {
      // Held or flying: the window stays on the work area; the page learns where the strip is now.
      if (JSON.stringify(b) !== JSON.stringify(lifted.strip)) {
        lifted.strip = b;
        if (!applyRaw()) send();
      }
      return;
    }
    const cur = win.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
      win.setBounds(b);
      if (!applyRaw()) send(); // the box where the helper last saw it, for the new strip (its next report follows)
    }
    if (!win.isVisible()) {
      win.showInactive();
      layer = null;
      send();
    }
    setLayer(claude.front === 'other' ? `above:${claude.hwnd}` : 'top');
    if (boxless) {
      if (!boxKnown) {
        boxKnown = true; // nothing to wait for: he has the window's bottom edge
        send();
      }
      return;
    }
    // Find the prompt box again once the window stops moving (at once the first time), and now and
    // then while it shows.
    refind(boxKnown ? 900 : 60);
    if (!boxTimer) boxTimer = setInterval(findBox, 20_000);
  }

  function refind(ms) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(findBox, ms);
  }

  async function findBox() {
    if (free || boxless || boxBusy || !enabled || leaving || !visible() || !claudeDip) return;
    boxBusy = true;
    const askedAt = Date.now();
    try {
      const info = await getDesktopInfo({ rects: K.sendButton });
      if (!visible()) return;
      const strip = stripBounds();
      // The script reads the Claude window Orbit works with, which is the one the strip is on.
      // Only the part of the box inside the strip counts (a box taller than the strip has no top here).
      let usable = usableBox(info?.ok ? boxInStrip(info.promptBoxRect, info.windowRect, claudeDip, strip) : null, strip.height);
      const sendRect = usable && K.sendButton ? sendInStrip(info.sendButtonRect, info.windowRect, claudeDip, strip) : null;
      // Where Send sits from the box's right end and bottom (so it moves with the box in between).
      if (usable && sendRect) sendOffset = sendOffsetFor(usable, sendRect);
      // The helper saw the box since this look began: its report is newer than this one.
      if (rawAt > askedAt && lastRaw) usable = usableBox(lastRaw.rect ? boxInStrip(lastRaw.rect, lastRaw.win, claudeDip, strip) : null, strip.height);
      const nextSend = !usable ? null : sendAtOffset(usable, sendOffset, sendRect || lastSend) || sendRect || lastSend;
      const changed = JSON.stringify(usable) !== JSON.stringify(lastBox) || JSON.stringify(nextSend) !== JSON.stringify(lastSend) || !boxKnown;
      if (!!usable !== !!lastBox) info_(usable ? `${kind}: standing room on the prompt box (${usable.w}×${strip.height - usable.y} px from the bottom)` : `${kind}: no prompt box to stand on`);
      lastBox = usable;
      lastSend = nextSend;
      boxKnown = true;
      if (changed) send();
    } catch (e) {
      log(`${kind}: couldn't find the prompt box: ${String(e?.message || e).slice(0, 120)}`);
      if (!boxKnown) {
        boxKnown = true; // the page stops waiting for it
        send();
      }
    } finally {
      boxBusy = false;
    }
  }

  return {
    kind,
    /** Turn it on or off, at a size (1–3). `entrance`: switched on live, so the page plays an entrance. */
    setEnabled(on, size = 2, { entrance = false } = {}) {
      enabled = !!on;
      scale = Math.max(1, Math.min(3, Number(size) || 2));
      if (!enabled) {
        hide();
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
        return;
      }
      if (entrance && !win) pendingEntrance = true;
      send();
      place();
    },
    /** Hand over: the page fades out, then the window closes. Resolves when it's gone. */
    leave() {
      if (leaving) return Promise.resolve();
      drop({ quiet: true });
      leaving = true;
      enabled = false;
      clearInterval(boxTimer);
      clearTimeout(settleTimer);
      sendEvent('leave');
      return new Promise((resolve) =>
        setTimeout(() => {
          if (win && !win.isDestroyed()) win.destroy();
          win = null;
          resolve();
        }, visible() ? LEAVE_MS : 0),
      );
    },
    /** The Claude window changed (from the tracker). Free-floating, it doesn't follow one. */
    onClaude(state) {
      claude = state;
      if (!free) place();
    },
    /** Where the window helper sees the prompt box now ({ hwnd, rect, win }; see claude-window.ps1). */
    onBoxRect(b) {
      if (free || boxless || !b || leaving || !enabled || !claude?.found || Number(b.hwnd) !== Number(claude.hwnd)) return;
      const ok = (r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite);
      lastRaw = { rect: ok(b.rect) ? b.rect : null, win: ok(b.win) ? b.win : null };
      if (!lastRaw.win) return;
      rawAt = Date.now();
      applyRaw();
    },
    /** It's on screen and wants the box watched: the Claude window it's on (hwnd), or 0. */
    get boxWindow() {
      return !free && !boxless && !leaving && enabled && visible() && claude?.found && !claude.min ? claude.hwnd : 0;
    },
    /** Orbit's voice state (as the orb gets it, plus a few things only the avatars use). */
    onVoice(state) {
      if (!state || typeof state !== 'object') return;
      voice = {
        phase: state.phase,
        asleep: !!state.asleep,
        hearing: !!state.hearing,
        input: Number(state.input) || 0,
        output: Number(state.output) || 0,
        claudeWorking: !!state.claudeWorking,
        muted: !!state.muted, // the mic is muted (the call stays up)
        draft: !!state.draft, // a drafted prompt is in Claude's box, waiting for a yes
        sending: !!state.sending, // the prompt is being sent
      };
      send();
    },
    /** Something happened that it reacts to: 'finished' | 'draft' | 'sent' (| 'error' for Qubit). */
    event(name) {
      if (!K.events.includes(name)) return;
      sendEvent(name);
      // A draft fills Claude's box (it grows) and a send empties it: look again.
      if (!boxless && (name === 'draft' || name === 'sent')) refind(name === 'draft' ? 350 : 700);
    },
    /** A feeling as the voice's words play (an emote cue, timed by the main window's audio). Qubit only. */
    emote(name) {
      const cue = cueName(name);
      if (!K.emotes || !cue || leaving || !enabled || !visible()) return false;
      win.webContents.send('buddy:emote', cue);
      return true;
    },
    /**
     * Something the user asked the avatar to do ({ action, dir }, see src/avatar-commands.js), by
     * the fast path or the voice model's `avatar` tool. Only while it's on screen.
     */
    command(cmd) {
      if (!cmd || !isAvatarAction(kind, cmd.action)) return { ok: false, error: 'not something this avatar does' };
      if (leaving || !enabled || !visible()) return { ok: false, error: free ? "The avatar isn't on screen right now." : "The avatar isn't on screen right now (the Claude window is minimized or closed)." };
      win.webContents.send('buddy:command', { action: cmd.action, ...(cmd.dir === 'left' || cmd.dir === 'right' ? { dir: cmd.dir } : {}) });
      return { ok: true };
    },
    /** Picked up (true: the window covers the work area while it's held or flying) or put back (false). */
    lift(on) {
      if (on) return lift();
      drop();
      return true;
    },
    get lifted() {
      return !!lifted;
    },
    /** The window this avatar lives on (its HWND), or 0 (free-floating, or not on one now). */
    get hostHwnd() {
      return !free && claude?.found ? Number(claude.hwnd) || 0 : 0;
    },
    /** The settings it reads changed (click to talk, throwing): tell the page. */
    refresh() {
      send();
    },
    /** The cursor is over the avatar (take clicks) or not (let them through to Claude). */
    hover(on) {
      if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true });
    },
    get window() {
      return win;
    },
    get enabled() {
      return enabled;
    },
    /** Floating along the bottom of the screen (no Claude window to live on). */
    get free() {
      return free;
    },
    stop() {
      clearInterval(boxTimer);
      clearTimeout(settleTimer);
      clearTimeout(liftTimer);
    },
  };
}
