// Geometry for the pixel buddy's window (see buddy.js). Pure functions, in DIPs, so they're tested
// without Electron.

export const BUDDY_HEIGHT = 240; // DIPs: room above Claude's prompt box to jump

/** The strip for a Claude window rect in DIPs: its bottom BUDDY_HEIGHT (at most 60% of it), full width. */
export function buddyBoundsFor(win, height = BUDDY_HEIGHT) {
  const h = Math.max(60, Math.min(height, Math.round(win.height * 0.6)));
  return { x: Math.round(win.x), y: Math.round(win.y + win.height - h), width: Math.max(80, Math.round(win.width)), height: h };
}

/**
 * The prompt box relative to the strip, in its CSS px, from the box and window rects UI Automation
 * reported (in its own coordinate space, whatever its DPI awareness) and the strip's bounds.
 * Measured as fractions of the Claude window, so it's right at any display scaling. null if
 * anything is missing or the box isn't on the window.
 */
export function boxInStrip(uiaBox, uiaWin, claudeDip, strip) {
  if (!uiaBox || !uiaWin || !claudeDip || !strip) return null;
  if (!(uiaWin.w > 0 && uiaWin.h > 0 && uiaBox.w > 0 && uiaBox.h > 0)) return null;
  const fx = (uiaBox.x - uiaWin.x) / uiaWin.w;
  const fy = (uiaBox.y - uiaWin.y) / uiaWin.h;
  const fw = uiaBox.w / uiaWin.w;
  const fh = uiaBox.h / uiaWin.h;
  if (fx < -0.05 || fy < -0.05 || fx + fw > 1.05 || fy + fh > 1.05) return null;
  const x = claudeDip.x + fx * claudeDip.width - strip.x;
  const y = claudeDip.y + fy * claudeDip.height - strip.y;
  // UI Automation reports the text field itself; the rounded box you see has padding around it.
  const { padX, padTop } = BOX_PADDING;
  return { x: Math.round(x - padX), y: Math.round(y - padTop), w: Math.round(fw * claudeDip.width + 2 * padX), h: Math.round(fh * claudeDip.height + padTop) };
}

/** How far Claude's visible prompt box reaches beyond its text field (DIPs). */
export const BOX_PADDING = Object.freeze({ padX: 12, padTop: 14 });
