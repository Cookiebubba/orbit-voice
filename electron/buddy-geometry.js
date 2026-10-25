// Geometry for the avatar's window (see avatar.js): the pixel buddy's and Qubit's strip along the
// bottom of the Claude window. Pure functions, in DIPs, so they're tested without Electron.

export const BUDDY_HEIGHT = 240; // DIPs: room above Claude's prompt box to jump

/** The strip for a Claude window rect in DIPs: its bottom BUDDY_HEIGHT (at most 60% of it), full width. */
export function buddyBoundsFor(win, height = BUDDY_HEIGHT) {
  const h = Math.max(60, Math.min(height, Math.round(win.height * 0.6)));
  return { x: Math.round(win.x), y: Math.round(win.y + win.height - h), width: Math.max(80, Math.round(win.width)), height: h };
}

/** Widest a free-floating strip gets (DIPs): room to roam without spanning a whole wide screen. */
export const FREE_STRIP_MAX_WIDTH = 900;

/**
 * The free-floating strip (no Claude window to live on, e.g. macOS for now): along the bottom of a
 * display's work area (so just above the Dock or taskbar), centred, at most FREE_STRIP_MAX_WIDTH
 * wide with a margin each side.
 */
export function freeStripFor(area, height = BUDDY_HEIGHT, maxWidth = FREE_STRIP_MAX_WIDTH) {
  const h = Math.max(60, Math.min(height, Math.round(area.height * 0.6)));
  const w = Math.max(80, Math.min(maxWidth, Math.round(area.width - 48)));
  return { x: Math.round(area.x + (area.width - w) / 2), y: Math.round(area.y + area.height - h), width: w, height: h };
}

/**
 * A rect UI Automation reported (in its own coordinate space, whatever its DPI awareness, with the
 * window's rect in the same space) relative to the strip, in its CSS px. Measured as fractions of
 * the Claude window, so it's right at any display scaling. null if anything is missing or the rect
 * isn't on the window.
 */
export function rectInStrip(uiaRect, uiaWin, claudeDip, strip) {
  if (!uiaRect || !uiaWin || !claudeDip || !strip) return null;
  if (!(uiaWin.w > 0 && uiaWin.h > 0 && uiaRect.w > 0 && uiaRect.h > 0)) return null;
  const fx = (uiaRect.x - uiaWin.x) / uiaWin.w;
  const fy = (uiaRect.y - uiaWin.y) / uiaWin.h;
  const fw = uiaRect.w / uiaWin.w;
  const fh = uiaRect.h / uiaWin.h;
  if (fx < -0.05 || fy < -0.05 || fx + fw > 1.05 || fy + fh > 1.05) return null;
  return { x: claudeDip.x + fx * claudeDip.width - strip.x, y: claudeDip.y + fy * claudeDip.height - strip.y, w: fw * claudeDip.width, h: fh * claudeDip.height };
}

/** The prompt box relative to the strip (see rectInStrip), padded out to the rounded box you see. */
export function boxInStrip(uiaBox, uiaWin, claudeDip, strip) {
  const r = rectInStrip(uiaBox, uiaWin, claudeDip, strip);
  if (!r) return null;
  // UI Automation reports the text field itself; the rounded box you see has padding around it.
  const { padX, padTop } = BOX_PADDING;
  return { x: Math.round(r.x - padX), y: Math.round(r.y - padTop), w: Math.round(r.w + 2 * padX), h: Math.round(r.h + padTop) };
}

/** Claude's Send button relative to the strip (see rectInStrip), rounded. null if not on the window. */
export function sendInStrip(uiaSend, uiaWin, claudeDip, strip) {
  const r = rectInStrip(uiaSend, uiaWin, claudeDip, strip);
  return r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

/** Only a box whose top is inside the strip counts (a box taller than the strip has no top here). */
export const usableBox = (box, stripHeight) => (box && box.y > 20 && box.y < stripHeight ? box : null);

/** Where Claude's Send button sits from the box's right end and bottom (it's on the box's row). */
export const sendOffsetFor = (box, send) => (box && send ? { r: box.x + box.w - send.x, b: box.y + box.h - send.y } : null);

/** The Send button at that offset from a box that moved or grew (its size as last seen). */
export const sendAtOffset = (box, offset, size) => (box && offset && size ? { x: box.x + box.w - offset.r, y: box.y + box.h - offset.b, w: size.w, h: size.h } : null);

/**
 * The avatar's window while it's held or thrown: the window it lives on (`host`, DIPs), clipped to the
 * work area of its display (never under the taskbar), so the avatar stays inside that window and never
 * shows over another one. No host (free-floating, or none known): the work area itself. null if the
 * two don't overlap.
 */
export function liftRectFor(host, workArea) {
  const ok = (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  if (!ok(workArea)) return null;
  if (!ok(host)) return { x: Math.round(workArea.x), y: Math.round(workArea.y), width: Math.round(workArea.width), height: Math.round(workArea.height) };
  const x1 = Math.max(host.x, workArea.x);
  const y1 = Math.max(host.y, workArea.y);
  const x2 = Math.min(host.x + host.width, workArea.x + workArea.width);
  const y2 = Math.min(host.y + host.height, workArea.y + workArea.height);
  if (x2 - x1 < 40 || y2 - y1 < 40) return null;
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
}

/** How far Claude's visible prompt box reaches beyond its text field (DIPs). */
export const BOX_PADDING = Object.freeze({ padX: 12, padTop: 14 });
