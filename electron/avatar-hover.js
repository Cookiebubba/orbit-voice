// Whether an avatar's window takes the mouse: only while the cursor is on the avatar (or the user is
// holding it), so everywhere else clicks go through to the app underneath.
//
// The page knows where the avatar is drawn and says so (setHit: its rect in the window's px), every
// time it moves and every half second anyway (a heartbeat). This polls the real cursor itself (the
// main process's own screen.getCursorScreenPoint) and decides. Three lessons are built in:
//   - It never rests on forwarded mouse moves (setIgnoreMouseEvents with `forward`). Those come from
//     one global low-level mouse hook that Windows silently removes if the main thread stalls, and
//     Electron never puts it back while any window still forwards.
//   - It never rests on the page's timers either. A page's timers and frames can be slowed or stopped
//     (Chromium throttles and freezes pages; a busy renderer misses beats), and the avatar hasn't moved
//     because of that. So the last rect stands until the page says something else or the window goes
//     (hidden, closed, made again: stop/reset). Going quiet is only logged (onQuiet), never acted on.
//     (Before, a rect not heard for 3 s was dropped, and a press on him then went to the app below.)
//   - It doesn't flap. Onto him it takes the mouse at once; it lets go only once the cursor has been
//     off him (with a few px of slack) for LEAVE_MS, so the mouse mode can't change faster than that
//     while the cursor is on him or at his edge.
// The page's own word adds only that a press or drag is under way (setHeld), which keeps the mouse
// wherever the cursor goes until it ends.
//
// Pure (no Electron here): the window and cursor are passed in, so the tests run it in node.

export const HOVER_POLL_MS = 33;
export const LEAVE_MS = 150; // the cursor off him this long before clicks go through again
export const QUIET_LOG_MS = 3000; // the page not heard for this long: logged (nothing else changes)
export const HELD_STALE_MS = 15_000; // a press the page stopped mentioning (its pointerup lost) lets go
const PAD = 2; // px of slack around the avatar's rect
const EXIT_PAD = 6; // ...and while it takes the mouse (so his edge doesn't flicker)

export function createHoverPoller({ getCursor, getBounds, setIgnore, isLive = () => true, onCursor = () => {}, onMode = () => {}, onRunning = () => {}, onQuiet = () => {}, intervalMs = HOVER_POLL_MS, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let hit = null; // the avatar's rect in the window's px: { x, y, w, h }
  let heardAt = 0; // the page's last word (a rect or the press state)
  let quiet = false; // logged that the page went quiet (once per quiet spell)
  let held = false; // a press or drag is under way (the page keeps the mouse for it)
  let heldAt = 0;
  let taking = null; // what the window was last told (true: it takes the mouse)
  let offSince = null; // when the cursor left him while the window took the mouse
  let timer = null;
  let lastCursor = null;

  function heard() {
    heardAt = now();
    quiet = false;
  }

  function decide() {
    if (!isLive()) {
      offSince = null;
      return apply(false);
    }
    const t = now();
    if (!quiet && heardAt && t - heardAt > QUIET_LOG_MS) {
      quiet = true;
      onQuiet(t - heardAt);
    }
    if (held && t - heldAt > HELD_STALE_MS) held = false;
    let over = false;
    const c = testCursor || getCursor?.();
    const b = getBounds?.();
    if (c && b) {
      const lx = c.x - b.x;
      const ly = c.y - b.y;
      const pad = taking ? EXIT_PAD : PAD;
      if (hit) over = lx >= hit.x - pad && lx <= hit.x + hit.w + pad && ly >= hit.y - pad && ly <= hit.y + hit.h + pad;
      // The cursor near his window: the page gets it (his eye follows it, with or without forwarding).
      const near = lx > -200 && ly > -200 && lx < b.width + 200 && ly < b.height + 200;
      const key = near ? `${Math.round(c.x)},${Math.round(c.y)}` : null;
      if (key !== lastCursor) {
        lastCursor = key;
        onCursor(near ? { x: c.x, y: c.y } : null);
      }
    }
    if (held || over || !hit) offSince = null;
    if (held || over) return apply(true);
    // Off him: clicks go through, once he's been left for LEAVE_MS (at once if there's nothing to hit).
    if (taking && hit) {
      if (offSince == null) offSince = t;
      if (t - offSince < LEAVE_MS) return;
    }
    offSince = null;
    apply(false);
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
      heard();
      decide();
    },
    /** The page: a press or drag is (true) or isn't (false) under way. (`on`, its own hover guess, is not used.) */
    setPageHover(_on, { held: h = false } = {}) {
      held = !!h;
      heldAt = now();
      heard();
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
      offSince = null;
      apply(false);
    },
    /** The window was made again: forget what it was told and where he was (its new page says). */
    reset() {
      taking = null;
      hit = null;
      held = false;
      offSince = null;
      heardAt = 0;
      decide();
    },
    tick: decide,
    get taking() {
      return !!taking;
    },
    get running() {
      return !!timer;
    },
    /** For the tests and the log: whether it knows his rect, a press, and whether the page went quiet. */
    get state() {
      return { hit: !!hit, held, taking: !!taking, running: !!timer, quiet };
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

// Developer testing only (the parity driver's `cursor.set`, electron/parity-driver.js): where every
// poller takes the cursor to be instead of the real one. null (always, outside the parity suite):
// the real cursor.
let testCursor = null;
export function setTestCursor(p) {
  testCursor = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
}
