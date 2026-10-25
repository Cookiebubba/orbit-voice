// Orbit's mouse (electron/orbit-mouse.js): a second, visual cursor of Orbit's own. It never moves the
// user's mouse or clicks: it shows where Orbit is pointing and where Orbit is acting (each act glides
// there first, then presses), while the real input goes through the accessibility API.
//
// One overlay window per display, inside its visible frame, sized to the part of it a glide needs (a
// transparent window repaints all of itself each frame while it moves): click-through, always on top,
// never focusable. Each shows only while the cursor or its glide is on that display, and the page in
// it (ui/src/mouse/main.js) draws only while something moves. Glides are planned here in the glide
// space (`area`; on macOS screen points, as the accessibility API reports controls) on the shared
// clock (Date.now's), so each display's page draws its part of a glide that crosses displays.
//
// Idle, it hides: after pointing (it rests on the control a few seconds) or shortly after the last
// act, it fades out and the windows hide. A fresh appearance fades in a little up and left of the
// target and glides in.
//
// The windows themselves are OrbitNative's (MouseOverlay); this is the planning, with the page
// windows behind a port so the tests drive it with stand-ins.
import Foundation

public enum MouseMath {
  public static let fadeMs: Double = 260
  public static let enterDip = ScreenPoint(x: -46, y: -34)
  public static let margin: Double = 56
  public static let roomDip: Double = 160

  /** Ease in and out (cubic): the same curve the page draws with (ui/src/mouse/look.js). */
  public static func ease(_ t: Double) -> Double {
    if t <= 0 { return 0 }
    if t >= 1 { return 1 }
    return t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
  }

  /** How long a glide of `dist` points takes: quick for short hops, never a jump. */
  public static func glideMs(_ dist: Double) -> Double {
    let d = dist.isFinite ? max(0, dist) : 0
    return jsRound(min(700, max(260, 240 + d * 0.45)))
  }

  /** A glide: from, to, when it started (ms, shared clock) and how long it takes. */
  public struct Motion: Equatable, Sendable {
    public var from: ScreenPoint, to: ScreenPoint, t0: Double, ms: Double
    public init(from: ScreenPoint, to: ScreenPoint, t0: Double, ms: Double) { (self.from, self.to, self.t0, self.ms) = (from, to, t0, ms) }
    public var json: JSONValue {
      ["from": ["x": .number(from.x), "y": .number(from.y)], "to": ["x": .number(to.x), "y": .number(to.y)], "t0": .number(t0), "ms": .number(ms)]
    }
  }

  /** Where a glide is at time t. */
  public static func glideAt(_ m: Motion?, _ t: Double) -> ScreenPoint? {
    guard let m else { return nil }
    let k = m.ms > 0 ? ease((t - m.t0) / m.ms) : 1
    return ScreenPoint(x: m.from.x + (m.to.x - m.from.x) * k, y: m.from.y + (m.to.y - m.from.y) * k)
  }

  public static func inside(_ r: Rect, _ p: ScreenPoint) -> Bool { p.x >= r.x && p.y >= r.y && p.x < r.maxX && p.y < r.maxY }
  public static func overlaps(_ a: Rect, _ b: Rect) -> Bool { a.x < b.maxX && b.x < a.maxX && a.y < b.maxY && b.y < a.maxY }
  /** The box around some points, padded. */
  public static func boxOf(_ pts: [ScreenPoint], pad: Double) -> Rect {
    let xs = pts.map(\.x), ys = pts.map(\.y)
    let x = xs.min()! - pad, y = ys.min()! - pad
    return Rect(x: x, y: y, w: xs.max()! + pad - x, h: ys.max()! + pad - y)
  }
  public static func union(_ a: Rect, _ b: Rect) -> Rect {
    let x = min(a.x, b.x), y = min(a.y, b.y)
    return Rect(x: x, y: y, w: max(a.maxX, b.maxX) - x, h: max(a.maxY, b.maxY) - y)
  }
  public static func within(_ a: Rect, _ b: Rect) -> Bool { a.x >= b.x && a.y >= b.y && a.maxX <= b.maxX && a.maxY <= b.maxY }
}

/** A display as the mouse sees it: its visible frame in glide space (`area`) and in window space (`workArea`). */
public struct MouseDisplay: Equatable, Sendable {
  public var id: Int
  public var area: Rect
  public var workArea: Rect
  public init(id: Int, area: Rect, workArea: Rect) { (self.id, self.area, self.workArea) = (id, area, workArea) }
  public var scale: Double { area.w / max(1, workArea.w) }
}

/** One display's overlay window, as the model drives it. */
@MainActor
public protocol MousePagePort: AnyObject {
  func setBounds(_ r: Rect)
  func showInactive()
  func hide()
  func send(_ message: JSONValue)
  func destroy()
}

@MainActor
public final class OrbitMouseModel {
  /** A page for a display; it calls `ready` once its page has loaded. */
  public typealias MakePage = (_ display: MouseDisplay, _ ready: @escaping @MainActor () -> Void) -> MousePagePort

  @MainActor private final class Page {
    let port: MousePagePort
    var display: MouseDisplay
    var box: Rect // its window (window space)
    let token: Int
    var ready = false
    var shown = false
    init(port: MousePagePort, display: MouseDisplay, box: Rect, token: Int) { (self.port, self.display, self.box, self.token) = (port, display, box, token) }
  }

  public struct GlideResult: Equatable, Sendable {
    public var shown: Bool
    public var ms: Double?
    public var why: String?
  }

  private let clock: OverlayClock
  private let displays: () -> [MouseDisplay]
  private let makePage: MakePage
  private let enabled: () -> Bool
  private var pages: [Int: Page] = [:]
  private var nextToken = 0
  private var pos: ScreenPoint? // where the tip is meant to be at the end of the motion
  private var motion: MouseMath.Motion?
  private var press: Double? // when it pressed
  private var visible = false
  private var enter = false
  private var voice: JSONValue = ["phase": "off"]
  private var hideTimer: OverlayTimer?
  private var fadeTimer: OverlayTimer?
  private var trimTimer: OverlayTimer?
  private var stopped = false

  public init(clock: OverlayClock, displays: @escaping () -> [MouseDisplay], enabled: @escaping () -> Bool = { true }, makePage: @escaping MakePage) {
    self.clock = clock
    self.displays = displays
    self.enabled = enabled
    self.makePage = makePage
  }

  private func displayAt(_ p: ScreenPoint) -> MouseDisplay? { displays().first { MouseMath.inside($0.area, p) } }

  private func page(_ d: MouseDisplay) -> Page {
    if let pg = pages[d.id] { return pg }
    let box = Rect(x: d.workArea.x, y: d.workArea.y, w: 1, h: 1) // (sized when it shows)
    nextToken += 1
    let token = nextToken
    let port = makePage(d) { [weak self] in
      guard let self, let pg = self.pages[d.id], pg.token == token else { return }
      pg.ready = true
      self.send(pg)
    }
    let pg = Page(port: port, display: d, box: box, token: token)
    pages[d.id] = pg
    return pg
  }

  /** The displays changed: windows for displays that are gone go; the others take their new place. */
  public func displaysChanged() {
    let now = Dictionary(displays().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    for (id, pg) in pages {
      guard let d = now[id] else {
        pg.port.destroy()
        pages[id] = nil
        continue
      }
      pg.display = d
      hidePage(pg) // (sized again for the next glide)
      pg.box = Rect(x: d.workArea.x, y: d.workArea.y, w: 1, h: 1)
      pg.port.setBounds(pg.box)
    }
  }

  // The page places glide-space points by its display (area: the visible frame's glide-space origin;
  // wa: its window-space origin) and its own window's place on screen (window.screenX/Y).
  private func message(_ pg: Page) -> JSONValue {
    let s = pg.display.scale
    let wa = pg.display.workArea
    return [
      "visible": .bool(visible),
      "enter": .bool(enter),
      "motion": motion?.json ?? .null,
      "press": press.map { ["at": .number($0)] } ?? .null,
      "voice": voice,
      "area": ["x": .number(pg.display.area.x), "y": .number(pg.display.area.y)],
      "wa": ["x": .number(wa.x), "y": .number(wa.y)],
      "origin": ["x": .number(pg.display.area.x + (pg.box.x - wa.x) * s), "y": .number(pg.display.area.y + (pg.box.y - wa.y) * s)],
      "scale": .number(s),
    ]
  }

  /** The window (window space) a glide-space region needs on this display, with room around it, inside the visible frame. */
  private func fit(_ pg: Page, _ region: Rect) -> Rect {
    let s = pg.display.scale
    let wa = pg.display.workArea
    let a = pg.display.area
    let room = MouseMath.roomDip
    let x0 = max(wa.x, (wa.x + (region.x - a.x) / s - room).rounded(.down))
    let y0 = max(wa.y, (wa.y + (region.y - a.y) / s - room).rounded(.down))
    let x1 = min(wa.maxX, (wa.x + (region.maxX - a.x) / s + room).rounded(.up))
    let y1 = min(wa.maxY, (wa.y + (region.maxY - a.y) / s + room).rounded(.up))
    return Rect(x: x0, y: y0, w: max(1, x1 - x0), h: max(1, y1 - y0))
  }

  private func send(_ pg: Page) {
    guard pg.ready else { return }
    pg.port.send(message(pg))
  }

  private func broadcast() {
    for pg in pages.values where pg.shown { send(pg) }
  }

  private func showOn(_ region: Rect) {
    for d in displays() where MouseMath.overlaps(d.area, region) {
      let pg = page(d)
      // Fresh: just the room this glide needs. Showing: it only grows (never moves under the cursor).
      let want = fit(pg, region)
      let next = pg.shown ? (MouseMath.within(want, pg.box) ? pg.box : MouseMath.union(pg.box, want)) : want
      if next != pg.box {
        pg.box = next
        pg.port.setBounds(next)
      }
      if !pg.shown {
        pg.shown = true
        pg.port.showInactive()
      }
    }
  }

  private func hidePage(_ pg: Page) {
    guard pg.shown else { return }
    pg.shown = false
    pg.port.hide()
  }

  /** After a glide: only the displays the cursor is on stay shown. */
  private func trim() {
    guard visible, let p = pos else { return }
    let region = MouseMath.boxOf([p], pad: MouseMath.margin)
    for pg in pages.values where pg.shown && !MouseMath.overlaps(pg.display.area, region) { hidePage(pg) }
  }

  private func fadeOut() {
    hideTimer?.cancel()
    guard visible else { return }
    visible = false
    enter = false
    broadcast()
    fadeTimer?.cancel()
    fadeTimer = clock.after(MouseMath.fadeMs + 60) { [weak self] in
      guard let self, !self.visible else { return }
      for pg in self.pages.values { self.hidePage(pg) }
      self.press = nil
    }
  }

  /**
   * Glide the tip to (x, y) (glide space), taking `ms` (or a time from the distance), then resting
   * there `holdMs` before it fades. `arrived` runs when the glide ends.
   */
  @discardableResult
  public func glide(x: Double, y: Double, ms: Double? = nil, holdMs: Double = 1500, arrived: (@MainActor () -> Void)? = nil) -> GlideResult {
    if stopped || !enabled() { return GlideResult(shown: false, why: "off") }
    let to = ScreenPoint(x: x, y: y)
    guard x.isFinite, y.isFinite else { return GlideResult(shown: false, why: "no_place") }
    guard let target = displayAt(to) else { return GlideResult(shown: false, why: "off_screen") }
    let t = clock.now
    let scale = target.scale
    let was = visible && motion != nil ? MouseMath.glideAt(motion, t) : nil
    let from = was ?? ScreenPoint(x: to.x + MouseMath.enterDip.x * scale, y: to.y + MouseMath.enterDip.y * scale)
    let dist = hypot(to.x - from.x, to.y - from.y) / scale
    let dur = (ms.map { $0.isFinite && $0 >= 0 } ?? false) ? jsRound(ms!) : MouseMath.glideMs(dist)
    enter = was == nil
    motion = MouseMath.Motion(from: from, to: to, t0: t, ms: dur)
    pos = to
    visible = true
    hideTimer?.cancel()
    fadeTimer?.cancel()
    trimTimer?.cancel()
    showOn(MouseMath.boxOf([from, to], pad: MouseMath.margin))
    broadcast()
    trimTimer = clock.after(dur) { [weak self] in
      self?.trim()
      arrived?()
    }
    hideTimer = clock.after(dur + max(0, holdMs.isFinite ? holdMs : 0)) { [weak self] in self?.fadeOut() }
    return GlideResult(shown: true, ms: dur)
  }

  /** The press: the arrow dips for a moment at its tip, where Orbit acts. */
  @discardableResult
  public func doPress() -> Bool {
    guard visible else { return false }
    press = clock.now
    broadcast()
    return true
  }

  /** Fade out now (the setting went off, or nothing more to show). */
  public func hide() { fadeOut() }

  /** Is this point (glide space) on a display's visible frame? (Off it, there's nothing to show.) */
  public func onScreen(_ p: ScreenPoint) -> Bool { displayAt(p) != nil }

  /** Orbit's voice state (as the avatars get it): the colour, and the pulse while he speaks. */
  public func onVoice(_ s: JSONValue) {
    guard case .object(let o) = s else { return }
    var next: [String: JSONValue] = ["output": .number(min(1, max(0, o["output"]?.doubleValue ?? 0)))]
    for k in ["phase", "asleep", "hearing", "muted", "draft", "sending", "claudeWorking"] {
      next[k] = k == "phase" ? .string(o["phase"]?.stringValue ?? "off") : .bool(o[k]?.boolValue ?? false)
    }
    voice = .object(next)
    if visible { broadcast() }
  }

  /** Make the windows ahead of time (hidden), so the first glide has its page ready. */
  public func prewarm() {
    if stopped || !enabled() { return }
    for d in displays() { _ = page(d) }
  }

  public func stop() {
    stopped = true
    for t in [hideTimer, fadeTimer, trimTimer] { t?.cancel() }
    for pg in pages.values { pg.port.destroy() }
    pages.removeAll()
  }

  // MARK: for the parity driver and the tests

  public var isVisible: Bool { visible }
  /** Where the tip is now (on its glide), or where it rests. */
  public var now: ScreenPoint? { motion != nil ? MouseMath.glideAt(motion, clock.now) : pos }
  public var target: ScreenPoint? { pos }
  /** Windows that show now. */
  public var shownWindows: Int { pages.values.filter(\.shown).count }
  public var windowCount: Int { pages.count }
  public func pageInfo() -> [(id: Int, shown: Bool, ready: Bool, box: Rect)] {
    pages.values.map { ($0.display.id, $0.shown, $0.ready, $0.box) }.sorted { $0.id < $1.id }
  }
}
