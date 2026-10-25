// Whether an avatar's window takes the mouse (electron/avatar-hover.js): only while the cursor is on
// the avatar (or the user is holding it), so everywhere else clicks go through to the app underneath.
//
// The page knows where the avatar is drawn and says so (setHit: its rect in the window's px), every
// time it moves and every half second anyway (a heartbeat). This polls the real cursor itself and
// decides. Nothing the page said is assumed to stay true without the page saying it again: a rect
// not heard for hitStaleMs is forgotten (the window lets clicks through), and a fresh one puts things
// right within the heartbeat. The page's own word adds only that a press or drag is under way
// (setHeld), which keeps the mouse wherever the cursor goes until it ends.
//
// Pure: the window, the cursor and the clock are passed in, so the tests drive it by hand.
import Foundation

@MainActor
public final class HoverPoller {
  public static let pollMs: Double = 33
  public static let hitStaleMs: Double = 3000 // a rect not heard again for this long is forgotten
  public static let heldStaleMs: Double = 5000 // ...and a press the page stopped mentioning
  private static let pad: Double = 2 // px of slack around the avatar's rect

  public struct State: Equatable, Sendable { public var hit: Bool, held: Bool, taking: Bool, running: Bool }

  private let getCursor: () -> ScreenPoint?
  private let getBounds: () -> Rect?
  private let setIgnore: (Bool) -> Void
  private let isLive: () -> Bool
  private let onCursor: (ScreenPoint?) -> Void
  private let onMode: (Bool) -> Void
  private let onRunning: (Bool) -> Void
  private let clock: OverlayClock
  private let intervalMs: Double

  private var hit: Rect? // the avatar's rect in the window's px
  private var hitAt: Double = 0
  private var held = false // a press or drag is under way (the page keeps the mouse for it)
  private var heldAt: Double = 0
  private var taking: Bool? // what the window was last told (true: it takes the mouse)
  private var timer: OverlayTimer?
  private var lastCursor: String?

  public init(clock: OverlayClock, getCursor: @escaping () -> ScreenPoint?, getBounds: @escaping () -> Rect?, setIgnore: @escaping (Bool) -> Void,
              isLive: @escaping () -> Bool = { true }, onCursor: @escaping (ScreenPoint?) -> Void = { _ in }, onMode: @escaping (Bool) -> Void = { _ in },
              onRunning: @escaping (Bool) -> Void = { _ in }, intervalMs: Double = HoverPoller.pollMs) {
    self.clock = clock
    self.getCursor = getCursor
    self.getBounds = getBounds
    self.setIgnore = setIgnore
    self.isLive = isLive
    self.onCursor = onCursor
    self.onMode = onMode
    self.onRunning = onRunning
    self.intervalMs = intervalMs
  }

  /** One decision from the cursor, the rect and the press (the poll's tick). */
  public func tick() {
    if !isLive() { return apply(false) }
    let t = clock.now
    if hit != nil, t - hitAt > Self.hitStaleMs { hit = nil }
    if held, t - heldAt > Self.heldStaleMs { held = false }
    var over = false
    if let c = getCursor(), let b = getBounds() {
      let lx = c.x - b.x
      let ly = c.y - b.y
      if let h = hit {
        over = lx >= h.x - Self.pad && lx <= h.x + h.w + Self.pad && ly >= h.y - Self.pad && ly <= h.y + h.h + Self.pad
      }
      // The cursor near his window: the page gets it (his eye follows it).
      let near = lx > -200 && ly > -200 && lx < b.w + 200 && ly < b.h + 200
      let key: String? = near ? "\(Int(jsRound(c.x))),\(Int(jsRound(c.y)))" : nil
      if key != lastCursor {
        lastCursor = key
        onCursor(near ? c : nil)
      }
    }
    apply(held || over)
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
    hitAt = clock.now
    tick()
  }

  /** The page: a press or drag is (true) or isn't (false) under way. (`on`, its own hover guess, is not used.) */
  public func setPageHover(_ on: Bool, held h: Bool = false) {
    held = h
    heldAt = clock.now
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
    apply(false)
  }

  /** Forget what the window was told (it was made again): the next decision is sent. */
  public func reset() {
    taking = nil
    tick()
  }

  public var isTaking: Bool { taking == true }
  public var isRunning: Bool { timer != nil }
  public var state: State { State(hit: hit != nil, held: held, taking: taking == true, running: timer != nil) }
  /** The rect the page last gave (fresh or not yet forgotten), for the parity driver's "figure". */
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
