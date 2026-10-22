// Geometry for the avatar's window (see avatar.js): the pixel buddy's and Qubit's strip along the
// bottom of the Claude window. Pure functions, in DIPs, so they're tested without Electron.

export const BUDDY_HEIGHT = 240; // DIPs: room above Claude's prompt box to jump

/** The strip for a Claude window rect in DIPs: its bottom BUDDY_HEIGHT (at most 60% of it), full width. */
export function buddyBoundsFor(win, height = BUDDY_HEIGHT) {
  const h = Math.max(60, Math.min(height, Math.round(win.height * 0.6)));
  return { x: Math.round(win.x), y: Math.round(win.y + win.height - h), width: Math.max(80, Math.round(win.width)), height: h };
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

/** How far Claude's visible prompt box reaches beyond its text field (DIPs). */
export const BOX_PADDING = Object.freeze({ padX: 12, padTop: 14 });
