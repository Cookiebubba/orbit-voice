// The avatar's window: a transparent, click-through strip along the bottom of the Claude window
// (the same window the orb docks on), where the avatar lives. Two avatars use it, each with its own
// page: the pixel buddy (buddy.html) and Qubit (qubit.html). It follows the Claude window, sits just
// above it in z-order like the orb (so other apps still cover both), and hides while Claude is
// minimized or not open (the page is told, so it can stop drawing).
//
// It also finds where Claude's prompt box is (through the same UI Automation script Grok's tools
// use, now and then: after the window settles, every 20 s while showing, and after a draft or a
// send, when the box grows or shrinks) and tells the page, which turns the box's top edge into a
// platform. For Qubit it also finds Claude's Send button (only there while the box has text), which
// he stomps when a prompt goes.
//
// Switching avatars is a handover: the new one's window comes up (its page plays an entrance) while
// the old one's page fades out (leave()), and then the old window closes.

import { BrowserWindow, screen } from 'electron';

import { BUDDY_HEIGHT, boxInStrip, buddyBoundsFor, sendInStrip } from './buddy-geometry.js';
import { isAvatarAction } from '../src/avatar-commands.js';

export { BUDDY_HEIGHT };

export const AVATAR_KINDS = Object.freeze({
  buddy: { title: 'Orbit buddy', events: ['finished', 'draft', 'sent'], sendButton: false },
  qubit: { title: 'Orbit Qubit', events: ['finished', 'draft', 'sent', 'error'], sendButton: true },
});
const LEAVE_MS = 450; // the page's fade-out, and a little more

export function createAvatar({ kind = 'buddy', url, webPreferences, lockDown, getDesktopInfo, log = () => {}, info: info_ = () => {} }) {
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
  let voice = { phase: 'off' };
  let pendingEntrance = false;

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
  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('buddy:state', { voice, box: lastBox, send: lastSend, boxKnown, scale, visible: visible() });
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
    if (visible()) {
      win.hide();
      send(); // the page stops drawing while hidden
    }
  }

  /** Re-place (or hide) the strip for the current Claude window. */
  function place() {
    if (leaving) return;
    if (!enabled || !claude?.found || claude.min) return hide();
    ensure();
    claudeDip = screen.screenToDipRect(null, { x: claude.x, y: claude.y, width: claude.w, height: claude.h });
    const b = buddyBoundsFor(claudeDip);
    const cur = win.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) win.setBounds(b);
    if (!win.isVisible()) {
      win.showInactive();
      layer = null;
      send();
    }
    setLayer(claude.front === 'other' ? `above:${claude.hwnd}` : 'top');
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
    if (boxBusy || !enabled || leaving || !visible() || !claudeDip) return;
    boxBusy = true;
    try {
      const info = await getDesktopInfo({ rects: K.sendButton });
      if (!visible()) return;
      const strip = win.getBounds();
      // The script reads the Claude window Orbit works with, which is the one the strip is on.
      const next = info?.ok ? boxInStrip(info.promptBoxRect, info.windowRect, claudeDip, strip) : null;
      // Only the part of the box inside the strip counts (a box taller than the strip has no top here).
      const usable = next && next.y > 20 && next.y < strip.height ? next : null;
      const sendRect = usable && K.sendButton ? sendInStrip(info.sendButtonRect, info.windowRect, claudeDip, strip) : null;
      const nextSend = !usable ? null : sendRect || lastSend;
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
    /** The Claude window changed (from the tracker). */
    onClaude(state) {
      claude = state;
      place();
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
      if (name === 'draft' || name === 'sent') refind(name === 'draft' ? 350 : 700);
    },
    /**
     * Something the user asked the avatar to do ({ action, dir }, see src/avatar-commands.js), by
     * the fast path or the voice model's `avatar` tool. Only while it's on screen.
     */
    command(cmd) {
      if (!cmd || !isAvatarAction(kind, cmd.action)) return { ok: false, error: 'not something this avatar does' };
      if (leaving || !enabled || !visible()) return { ok: false, error: "The avatar isn't on screen right now (the Claude window is minimized or closed)." };
      win.webContents.send('buddy:command', { action: cmd.action, ...(cmd.dir === 'left' || cmd.dir === 'right' ? { dir: cmd.dir } : {}) });
      return { ok: true };
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
    stop() {
      clearInterval(boxTimer);
      clearTimeout(settleTimer);
    },
  };
}
