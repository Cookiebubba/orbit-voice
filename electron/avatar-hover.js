// Whether an avatar's window takes the mouse: only while the cursor is on the avatar (or the user is
// holding it), so everywhere else clicks go through to the app underneath.
//
// The page knows where the avatar is drawn and says so (setHit: its rect in the window's px), every
// time it moves and every half second anyway (a heartbeat). This polls the real cursor itself (the
// main process's own screen.getCursorScreenPoint) and decides. Two lessons are built in:
//   - It never rests on forwarded mouse moves (setIgnoreMouseEvents with `forward`). Those come from
//     one global low-level mouse hook that Windows silently removes if the main thread stalls, and
//     Electron never puts it back while any window still forwards.
//   - Nothing the page said is ever assumed to stay true without the page saying it again. A rect
//     not heard for HIT_STALE_MS is forgotten (the window lets clicks through), and a fresh one puts
//     things right within the heartbeat. (Before, a lift and drop the page didn't follow cleared the
//     rect, and a Qubit standing still never sent it again: he couldn't be clicked or picked up.)
// The page's own word adds only that a press or drag is under way (setHeld), which keeps the mouse
// wherever the cursor goes until it ends.
//
// Pure (no Electron here): the window and cursor are passed in, so the tests run it in node.

export const HOVER_POLL_MS = 33;
export const HIT_STALE_MS = 3000; // a rect not heard again for this long is forgotten
export const HELD_STALE_MS = 5000; // ...and a press the page stopped mentioning
const PAD = 2; // px of slack around the avatar's rect

// Developer testing only (the parity driver's `cursor.set`, electron/parity-driver.js): where every
// poller takes the cursor to be instead of the real one. null (always, outside the parity suite):
// the real cursor.
let testCursor = null;
export function setTestCursor(p) {
  testCursor = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
}

export function createHoverPoller({ getCursor, getBounds, setIgnore, isLive = () => true, onCursor = () => {}, onMode = () => {}, onRunning = () => {}, intervalMs = HOVER_POLL_MS, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let hit = null; // the avatar's rect in the window's px: { x, y, w, h }
  let hitAt = 0;
  let held = false; // a press or drag is under way (the page keeps the mouse for it)
  let heldAt = 0;
  let taking = null; // what the window was last told (true: it takes the mouse)
  let timer = null;
  let lastCursor = null;

  function decide() {
    if (!isLive()) return apply(false);
    const t = now();
    if (hit && t - hitAt > HIT_STALE_MS) hit = null;
    if (held && t - heldAt > HELD_STALE_MS) held = false;
    let over = false;
    const c = testCursor || getCursor?.();
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
    apply(held || over);
  }
  function apply(take) {
    if (take === taking) return;
    taking = take;
    setIgnore(!take);
    onMode(take);
  }

  return {
    /** The avatar's rect in the window's px (null: nothing to hit). Sent on every move and as a heartbeat. */
    setHit(rect) {
      hit = rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0 ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null;
      hitAt = now();
      decide();
    },
    /** The page: a press or drag is (true) or isn't (false) under way. (`on`, its own hover guess, is not used.) */
    setPageHover(_on, { held: h = false } = {}) {
      held = !!h;
      heldAt = now();
      decide();
    },
    setHeld(h) {
      held = !!h;
      heldAt = now();
      decide();
    },
    /** Poll while the window shows; stop while it's hidden (it lets every click through then). */
    start() {
      if (!timer) {
        timer = setTimer(decide, intervalMs);
        onRunning(true);
      }
      decide();
    },
    stop() {
      if (timer) {
        clearTimer(timer);
        onRunning(false);
      }
      timer = null;
      held = false;
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
    /** For the tests and the log: whether it has a fresh rect, and a press. */
    get state() {
      return { hit: !!hit, held, taking: !!taking, running: !!timer };
    },
    /** For the parity driver: the avatar's rect as the page last reported it (window px), or null. */
    get hitRect() {
      return hit ? { ...hit } : null;
    },
  };
}

/**
 * A log line at most every `everyMs` per kind, saying how many changes it stands for (no text from
 * anyone; just the kind and a count).
 */
export function rateLimitedLog(log, { everyMs = 10_000, now = () => Date.now() } = {}) {
  const last = new Map(); // kind -> { at, skipped }
  return (kind, message) => {
    const t = now();
    const s = last.get(kind) || { at: -Infinity, skipped: 0 };
    if (t - s.at < everyMs) {
      s.skipped++;
      last.set(kind, s);
      return false;
    }
    log(s.skipped ? `${message} (and ${s.skipped} more like it before)` : message);
    last.set(kind, { at: t, skipped: 0 });
    return true;
  };
}
