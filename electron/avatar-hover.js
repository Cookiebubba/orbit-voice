// Whether an avatar's window takes the mouse: only while the cursor is on the avatar (or the user is
// holding it), so everywhere else clicks go through to the app underneath.
//
// The page knows where the avatar is drawn and says so (setHit: its rect in the window's px). This
// polls the real cursor itself (the main process's own screen.getCursorScreenPoint) and decides.
// It used to rest entirely on the page seeing forwarded mouse moves (setIgnoreMouseEvents with
// `forward`), and those come from one global low-level mouse hook that Windows silently removes
// if the main thread stalls past the hook timeout. Electron never puts it back while any window
// still forwards, so from then on the avatar could never be clicked, grabbed or thrown. The page's
// own hover messages still count (setPageHover), as a second, faster signal.
//
// Pure (no Electron here): the window and cursor are passed in, so the tests run it in node.

export const HOVER_POLL_MS = 33;
const PAD = 2; // px of slack around the avatar's rect

export function createHoverPoller({ getCursor, getBounds, setIgnore, isLive = () => true, onCursor = () => {}, intervalMs = HOVER_POLL_MS, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let hit = null; // the avatar's rect in the window's px: { x, y, w, h }
  let pageHover = false; // the page says the cursor is on him, or he's held
  let hold = false; // a press or drag is under way (the page keeps the mouse for it)
  let taking = null; // what the window was last told (true: it takes the mouse)
  let timer = null;
  let lastCursor = null;

  function decide() {
    if (!isLive()) return apply(false);
    let over = false;
    const c = getCursor?.();
    const b = getBounds?.();
    if (c && b) {
      const lx = c.x - b.x;
      const ly = c.y - b.y;
      if (hit) over = lx >= hit.x - PAD && lx <= hit.x + hit.w + PAD && ly >= hit.y - PAD && ly <= hit.y + hit.h + PAD;
      // The cursor near his window: the page gets it (his eye follows it, with or without forwarding).
      const near = lx > -200 && ly > -200 && lx < b.width + 200 && ly < b.height + 200;
      const key = near ? `${Math.round(c.x)},${Math.round(c.y)}` : null;
      if (key !== lastCursor) {
        lastCursor = key;
        onCursor(near ? { x: c.x, y: c.y } : null);
      }
    }
    apply(hold || pageHover || over);
  }
  function apply(take) {
    if (take === taking) return;
    taking = take;
    setIgnore(!take);
  }

  return {
    /** The avatar's rect in the window's px (null: nothing to hit). */
    setHit(rect) {
      hit = rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0 ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null;
      decide();
    },
    /** The page's own word: the cursor is on him (from mouse moves), and whether a press is under way. */
    setPageHover(on, { held = false } = {}) {
      pageHover = !!on;
      hold = !!held;
      decide();
    },
    /** Poll while the window shows; stop while it's hidden (it lets every click through then). */
    start() {
      if (!timer) timer = setTimer(decide, intervalMs);
      decide();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
      pageHover = false;
      hold = false;
      apply(false);
    },
    /** Forget what the window was told (it was made again, or reset elsewhere): the next decision is sent. */
    reset() {
      taking = null;
      decide();
    },
    tick: decide,
    get taking() {
      return !!taking;
    },
    get running() {
      return !!timer;
    },
  };
}
