// The pixel buddy's window: a transparent, click-through strip along the bottom of the Claude
// window (the same window the orb docks on), where the buddy walks, jumps and naps. It follows the
// Claude window, sits just above it in z-order like the orb (so other apps still cover both), and
// hides while Claude is minimized or not open.
//
// It also finds where Claude's prompt box is (through the same UI Automation script Grok's tools
// use, now and then: after the window settles, and every 20 s while showing) and tells the page,
// which turns the box's top edge into a platform.

import { BrowserWindow, screen } from 'electron';

import { BUDDY_HEIGHT, boxInStrip, buddyBoundsFor } from './buddy-geometry.js';

export { BUDDY_HEIGHT };

export function createBuddy({ url, webPreferences, lockDown, getDesktopInfo, log = () => {}, info: info_ = () => {} }) {
  let win = null;
  let enabled = false;
  let scale = 2;
  let claude = null; // tracker state (screen px)
  let claudeDip = null;
  let layer = null;
  let boxTimer = null;
  let settleTimer = null;
  let lastBox = null;
  let boxBusy = false;
  let voice = { phase: 'off' };

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
      focusable: false, // clicking the buddy never takes focus from Claude
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      title: 'Orbit buddy',
      webPreferences,
    });
    lockDown(win);
    win.setIgnoreMouseEvents(true, { forward: true }); // clicks go through to Claude
    win.loadURL(url());
    win.webContents.on('did-finish-load', () => send());
    win.on('closed', () => (win = null));
    return win;
  }

  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('buddy:state', { voice, box: lastBox, scale });
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
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  /** Re-place (or hide) the strip for the current Claude window. */
  function place() {
    if (!enabled || !claude?.found || claude.min) return hide();
    ensure();
    claudeDip = screen.screenToDipRect(null, { x: claude.x, y: claude.y, width: claude.w, height: claude.h });
    const b = buddyBoundsFor(claudeDip);
    const cur = win.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) win.setBounds(b);
    if (!win.isVisible()) {
      win.showInactive();
      layer = null;
    }
    setLayer(claude.front === 'other' ? `above:${claude.hwnd}` : 'top');
    // Find the prompt box again once the window stops moving, and now and then while it shows.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(findBox, 900);
    if (!boxTimer) boxTimer = setInterval(findBox, 20_000);
  }

  async function findBox() {
    if (boxBusy || !enabled || !win || win.isDestroyed() || !win.isVisible() || !claudeDip) return;
    boxBusy = true;
    try {
      const info = await getDesktopInfo();
      const strip = win.getBounds();
      // The script reads the Claude window Orbit works with, which is the one the strip is on.
      const next = info?.ok ? boxInStrip(info.promptBoxRect, info.windowRect, claudeDip, strip) : null;
      // Only the part of the box inside the strip counts (a box taller than the strip has no top here).
      const usable = next && next.y > 20 && next.y < strip.height ? next : null;
      if (JSON.stringify(usable) !== JSON.stringify(lastBox)) {
        if (!!usable !== !!lastBox) info_(usable ? `buddy: standing room on the prompt box (${usable.w}×${strip.height - usable.y} px from the bottom)` : 'buddy: no prompt box to stand on');
        lastBox = usable;
        send();
      }
    } catch (e) {
      log(`buddy: couldn't find the prompt box: ${String(e?.message || e).slice(0, 120)}`);
    } finally {
      boxBusy = false;
    }
  }

  return {
    /** Turn it on or off (the setting), at a size (1–3: CSS px per art pixel). */
    setEnabled(on, size = 2) {
      enabled = !!on;
      scale = Math.max(1, Math.min(3, Number(size) || 2));
      if (!enabled) {
        hide();
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
        return;
      }
      send();
      place();
    },
    /** The Claude window changed (from the tracker). */
    onClaude(state) {
      claude = state;
      place();
    },
    /** Orbit's voice state (as the orb gets it). */
    onVoice(state) {
      voice = state && typeof state === 'object' ? { phase: state.phase, asleep: !!state.asleep, hearing: !!state.hearing, input: Number(state.input) || 0, output: Number(state.output) || 0, claudeWorking: !!state.claudeWorking } : voice;
      send();
    },
    /** Something happened that it reacts to: 'finished' | 'draft' | 'sent'. */
    event(name) {
      if (win && !win.isDestroyed() && ['finished', 'draft', 'sent'].includes(name)) win.webContents.send('buddy:event', name);
    },
    /** The cursor is over the buddy (take clicks) or not (let them through to Claude). */
    hover(on) {
      if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true });
    },
    get window() {
      return win;
    },
    get enabled() {
      return enabled;
    },
    stop() {
      clearInterval(boxTimer);
      clearTimeout(settleTimer);
    },
  };
}
