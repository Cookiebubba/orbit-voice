// Whether an avatar's window takes the mouse (electron/avatar-hover.js): only while the cursor is on
// the avatar (or the user is holding it), so everywhere else clicks go through to the app underneath.
//
// The page knows where the avatar is drawn and says so (setHit: its rect in the window's px), every
// time it moves and every half second anyway (a heartbeat). This polls the real cursor itself and
// decides. Two lessons are built in:
//   - It never rests on the page's timers. A page's timers and frames can be slowed or stopped
//     (WebKit throttles hidden or occluded pages; a busy page misses beats), and the avatar hasn't
//     moved because of that. So the last rect stands until the page says something else or the
//     window goes (hidden, closed, made again: stop/reset). Going quiet is only logged (onQuiet),
//     never acted on. (Before, a rect not heard for 3 s was dropped, and a press on him then went
//     to the app below.)
//   - It doesn't flap. Onto him it takes the mouse at once; it lets go only once the cursor has been
//     off him (with a few px of slack) for leaveMs, so the mouse mode can't change faster than that
//     while the cursor is on him or at his edge.
// The page's own word adds only that a press or drag is under way (setHeld), which keeps the mouse
// wherever the cursor goes until it ends.
//
// Pure: the window, the cursor and the clock are passed in, so the tests drive it by hand.
import Foundation

@MainActor
public final class HoverPoller {
  public static let pollMs: Double = 33
  public static let leaveMs: Double = 150 // the cursor off him this long before clicks go through again
  public static let quietLogMs: Double = 3000 // the page not heard for this long: logged (nothing else changes)
  public static let heldStaleMs: Double = 15_000 // a press the page stopped mentioning (its pointerup lost) lets go
  private static let pad: Double = 2 // px of slack around the avatar's rect
  private static let exitPad: Double = 6 // ...and while it takes the mouse (so his edge doesn't flicker)

  public struct State: Equatable, Sendable { public var hit: Bool, held: Bool, taking: Bool, running: Bool, quiet: Bool }

  private let getCursor: () -> ScreenPoint?
  private let getBounds: () -> Rect?
  private let setIgnore: (Bool) -> Void
  private let isLive: () -> Bool
  private let onCursor: (ScreenPoint?) -> Void
  private let onMode: (Bool) -> Void
  private let onRunning: (Bool) -> Void
  private let onQuiet: (Double) -> Void
  private let clock: OverlayClock
  private let intervalMs: Double

  private var hit: Rect? // the avatar's rect in the window's px
  private var heardAt: Double = 0 // the page's last word (a rect or the press state)
  private var quiet = false // logged that the page went quiet (once per quiet spell)
  private var held = false // a press or drag is under way (the page keeps the mouse for it)
  private var heldAt: Double = 0
  private var taking: Bool? // what the window was last told (true: it takes the mouse)
  private var offSince: Double? // when the cursor left him while the window took the mouse
  private var timer: OverlayTimer?
  private var lastCursor: String?

  public init(clock: OverlayClock, getCursor: @escaping () -> ScreenPoint?, getBounds: @escaping () -> Rect?, setIgnore: @escaping (Bool) -> Void,
              isLive: @escaping () -> Bool = { true }, onCursor: @escaping (ScreenPoint?) -> Void = { _ in }, onMode: @escaping (Bool) -> Void = { _ in },
              onRunning: @escaping (Bool) -> Void = { _ in }, onQuiet: @escaping (Double) -> Void = { _ in }, intervalMs: Double = HoverPoller.pollMs) {
    self.clock = clock
    self.getCursor = getCursor
    self.getBounds = getBounds
    self.setIgnore = setIgnore
    self.isLive = isLive
    self.onCursor = onCursor
    self.onMode = onMode
    self.onRunning = onRunning
    self.onQuiet = onQuiet
    self.intervalMs = intervalMs
  }

  private func heard() {
    heardAt = clock.now
    quiet = false
  }

  /** One decision from the cursor, the rect and the press (the poll's tick). */
  public func tick() {
    if !isLive() {
      offSince = nil
      return apply(false)
    }
    let t = clock.now
    if !quiet, heardAt > 0, t - heardAt > Self.quietLogMs {
      quiet = true
      onQuiet(t - heardAt)
    }
    if held, t - heldAt > Self.heldStaleMs { held = false }
    var over = false
    if let c = getCursor(), let b = getBounds() {
      let lx = c.x - b.x
      let ly = c.y - b.y
      let pad = taking == true ? Self.exitPad : Self.pad
      if let h = hit {
        over = lx >= h.x - pad && lx <= h.x + h.w + pad && ly >= h.y - pad && ly <= h.y + h.h + pad
      }
      // The cursor near his window: the page gets it (his eye follows it).
      let near = lx > -200 && ly > -200 && lx < b.w + 200 && ly < b.h + 200
      let key: String? = near ? "\(Int(jsRound(c.x))),\(Int(jsRound(c.y)))" : nil
      if key != lastCursor {
        lastCursor = key
        onCursor(near ? c : nil)
      }
    }
    if held || over || hit == nil { offSince = nil }
    if held || over { return apply(true) }
    // Off him: clicks go through, once he's been left for leaveMs (at once if there's nothing to hit).
    if taking == true, hit != nil {
      if offSince == nil { offSince = t }
      if t - offSince! < Self.leaveMs { return }
    }
    offSince = nil
    apply(false)
  }

  private func apply(_ take: Bool) {
    if take == taking { return }
    taking = take
    setIgnore(!take)
    onMode(take)
  }

  /** The avatar's rect in the window's px (nil: nothing to hit). Sent on every move and as a heartbeat. */
  public func setHit(_ rect: Rect?) {
    if let r = rect, r.isFinite, r.w > 0, r.h > 0 { hit = r } else { hit = nil }
    heard()
    tick()
  }

  /** The page: a press or drag is (true) or isn't (false) under way. (`on`, its own hover guess, is not used.) */
  public func setPageHover(_ on: Bool, held h: Bool = false) {
    held = h
    heldAt = clock.now
    heard()
    tick()
  }

  public func setHeld(_ h: Bool) {
    held = h
    heldAt = clock.now
    tick()
  }

  /** Poll while the window shows; stop while it's hidden (it lets every click through then). */
  public func start() {
    if timer == nil {
      timer = clock.every(intervalMs) { [weak self] in self?.tick() }
      onRunning(true)
    }
    tick()
  }

  public func stop() {
    if let t = timer {
      t.cancel()
      onRunning(false)
    }
    timer = nil
    held = false
    offSince = nil
    apply(false)
  }

  /** The window was made again: forget what it was told and where he was (its new page says). */
  public func reset() {
    taking = nil
    hit = nil
    held = false
    offSince = nil
    heardAt = 0
    tick()
  }

  public var isTaking: Bool { taking == true }
  public var isRunning: Bool { timer != nil }
  public var state: State { State(hit: hit != nil, held: held, taking: taking == true, running: timer != nil, quiet: quiet) }
  /** The rect the page last gave, for the parity driver's "figure". */
  public var lastHit: Rect? { hit }
}

/**
 * A log line at most every `everyMs` per kind, saying how many changes it stands for (no text from
 * anyone; just the kind and a count).
 */
@MainActor
public final class RateLimitedLog {
  private let log: (String) -> Void
  private let everyMs: Double
  private let now: () -> Double
  private var last: [String: (at: Double, skipped: Int)] = [:]

  public init(everyMs: Double = 10_000, now: @escaping () -> Double, _ log: @escaping (String) -> Void) {
    self.log = log
    self.everyMs = everyMs
    self.now = now
  }

  @discardableResult
  public func callAsFunction(_ kind: String, _ message: String) -> Bool {
    let t = now()
    var s = last[kind] ?? (at: -Double.infinity, skipped: 0)
    if t - s.at < everyMs {
      s.skipped += 1
      last[kind] = s
      return false
    }
    log(s.skipped > 0 ? "\(message) (and \(s.skipped) more like it before)" : message)
    last[kind] = (at: t, skipped: 0)
    return true
  }
}
