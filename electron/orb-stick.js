// Geometry for "Stick to Claude Code": where the orb goes on the Claude window, and how a drag
// becomes a saved spot. Everything is in DIPs (Electron's device-independent pixels), so the orb
// keeps the same distance from the window's corner at any resolution or display scaling.

export const CORNERS = ['tl', 'tr', 'bl', 'br'];
/** Default: bottom-right, a little in from the side and above Claude's prompt box. */
export const DEFAULT_ANCHOR = Object.freeze({ corner: 'br', dx: 24, dy: 140 });

export function isAnchor(a) {
  return !!a && CORNERS.includes(a.corner) && [a.dx, a.dy].every((n) => Number.isFinite(n) && n >= 0 && n <= 10000);
}

/** Orb top-left for a Claude window rect (DIP) and an anchor, kept inside the window. */
export function orbPositionFor(win, anchor, size) {
  const a = isAnchor(anchor) ? anchor : DEFAULT_ANCHOR;
  let x = a.corner[1] === 'r' ? win.x + win.width - a.dx - size : win.x + a.dx;
  let y = a.corner[0] === 'b' ? win.y + win.height - a.dy - size : win.y + a.dy;
  x = clampInto(x, win.x, win.width, size);
  y = clampInto(y, win.y, win.height, size);
  return { x: Math.round(x), y: Math.round(y) };
}

/** The anchor for an orb the user dropped at `pos`: measured from the window corner nearest to it. */
export function anchorFor(win, pos, size) {
  const cx = pos.x + size / 2;
  const cy = pos.y + size / 2;
  const right = cx > win.x + win.width / 2;
  const bottom = cy > win.y + win.height / 2;
  const dx = right ? win.x + win.width - (pos.x + size) : pos.x - win.x;
  const dy = bottom ? win.y + win.height - (pos.y + size) : pos.y - win.y;
  return {
    corner: `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}`,
    dx: Math.round(Math.min(Math.max(dx, 0), Math.max(win.width - size, 0))),
    dy: Math.round(Math.min(Math.max(dy, 0), Math.max(win.height - size, 0))),
  };
}

function clampInto(v, start, length, size) {
  if (length <= size) return start + (length - size) / 2; // window smaller than the orb: centre it
  return Math.min(Math.max(v, start), start + length - size);
}
