// Geometry for the avatar's window (electron/buddy-geometry.js): the pixel buddy's and Qubit's strip
// along the bottom of the window he lives on. Pure functions in screen points, top-left origin (as
// the pages and the parity driver use; the AppKit layer converts at one place, ScreenSpace).
//
// macOS reports windows in points already (the accessibility API, CGWindowList), so where Electron
// converted the tracker's physical pixels to DIPs, here the host rect goes in as it comes.
import Foundation

/** JavaScript's Math.round (halves go up, also for negatives), so numbers match the Electron build. */
@inlinable public func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }

/** A point on screen (top-left origin, points). */
public struct ScreenPoint: Codable, Equatable, Sendable, CustomStringConvertible {
  public var x: Double, y: Double
  public init(x: Double, y: Double) { (self.x, self.y) = (x, y) }
  public var description: String { "(\(Int(x)),\(Int(y)))" }
}

extension Rect {
  /** Every number finite. */
  public var isFinite: Bool { [x, y, w, h].allSatisfy { $0.isFinite } }
  /** As the pages want a window's bounds: { x, y, width, height }. */
  public var boundsJSON: JSONValue { ["x": .number(x), "y": .number(y), "width": .number(w), "height": .number(h)] }
  /** As the pages want a rect inside the strip: { x, y, w, h }. */
  public var rectJSON: JSONValue { ["x": .number(x), "y": .number(y), "w": .number(w), "h": .number(h)] }
  /** From { x, y, w, h } (or { x, y, width, height }); nil unless every number is there and finite. */
  public init?(json: JSONValue?) {
    guard let j = json, let x = j["x"]?.doubleValue, let y = j["y"]?.doubleValue,
          let w = (j["w"] ?? j["width"])?.doubleValue, let h = (j["h"] ?? j["height"])?.doubleValue else { return nil }
    let r = Rect(x: x, y: y, w: w, h: h)
    guard r.isFinite else { return nil }
    self = r
  }
}

public enum AvatarGeometry {
  /** Points: room above Claude's prompt box to jump. */
  public static let buddyHeight: Double = 240
  /** Widest a free-floating strip gets: room to roam without spanning a whole wide screen. */
  public static let freeStripMaxWidth: Double = 900
  /** How far Claude's visible prompt box reaches beyond its text field. */
  public static let boxPadX: Double = 12
  public static let boxPadTop: Double = 14

  /** The strip for a host window: its bottom `height` (at most 60% of it), full width. */
  public static func stripBounds(host win: Rect, height: Double = buddyHeight) -> Rect {
    let h = max(60, min(height, jsRound(win.h * 0.6)))
    return Rect(x: jsRound(win.x), y: jsRound(win.y + win.h - h), w: max(80, jsRound(win.w)), h: h)
  }

  /**
   * The free-floating strip (no host window to live on): along the bottom of a display's visible
   * frame (just above the Dock), centred, at most `maxWidth` wide with a margin each side.
   */
  public static func freeStrip(area: Rect, height: Double = buddyHeight, maxWidth: Double = freeStripMaxWidth) -> Rect {
    let h = max(60, min(height, jsRound(area.h * 0.6)))
    let w = max(80, min(maxWidth, jsRound(area.w - 48)))
    return Rect(x: jsRound(area.x + (area.w - w) / 2), y: jsRound(area.y + area.h - h), w: w, h: h)
  }

  /**
   * A rect the window helper reported (with the window's rect in the same space) relative to the
   * strip. Measured as fractions of the host window, so it's right whatever space the helper used.
   * nil if anything is missing or the rect isn't on the window.
   */
  public static func rectInStrip(_ raw: Rect?, rawWin: Rect?, host: Rect?, strip: Rect?) -> Rect? {
    guard let raw, let rawWin, let host, let strip else { return nil }
    guard rawWin.w > 0, rawWin.h > 0, raw.w > 0, raw.h > 0, raw.isFinite, rawWin.isFinite else { return nil }
    let fx = (raw.x - rawWin.x) / rawWin.w
    let fy = (raw.y - rawWin.y) / rawWin.h
    let fw = raw.w / rawWin.w
    let fh = raw.h / rawWin.h
    if fx < -0.05 || fy < -0.05 || fx + fw > 1.05 || fy + fh > 1.05 { return nil }
    return Rect(x: host.x + fx * host.w - strip.x, y: host.y + fy * host.h - strip.y, w: fw * host.w, h: fh * host.h)
  }

  /** The prompt box relative to the strip, padded out to the rounded box you see. */
  public static func boxInStrip(_ raw: Rect?, rawWin: Rect?, host: Rect?, strip: Rect?) -> Rect? {
    guard let r = rectInStrip(raw, rawWin: rawWin, host: host, strip: strip) else { return nil }
    // The helper reports the text field itself; the rounded box you see has padding around it.
    return Rect(x: jsRound(r.x - boxPadX), y: jsRound(r.y - boxPadTop), w: jsRound(r.w + 2 * boxPadX), h: jsRound(r.h + boxPadTop))
  }

  /** Claude's Send button relative to the strip, rounded. nil if not on the window. */
  public static func sendInStrip(_ raw: Rect?, rawWin: Rect?, host: Rect?, strip: Rect?) -> Rect? {
    guard let r = rectInStrip(raw, rawWin: rawWin, host: host, strip: strip) else { return nil }
    return Rect(x: jsRound(r.x), y: jsRound(r.y), w: jsRound(r.w), h: jsRound(r.h))
  }

  /** Only a box whose top is inside the strip counts (a box taller than the strip has no top here). */
  public static func usableBox(_ box: Rect?, stripHeight: Double) -> Rect? {
    guard let box, box.y > 20, box.y < stripHeight else { return nil }
    return box
  }

  /** Where Send sits from the box's right end and bottom (it's on the box's row). */
  public struct SendOffset: Equatable, Sendable {
    public var r: Double, b: Double
    public init(r: Double, b: Double) { (self.r, self.b) = (r, b) }
  }

  public static func sendOffset(box: Rect?, send: Rect?) -> SendOffset? {
    guard let box, let send else { return nil }
    return SendOffset(r: box.x + box.w - send.x, b: box.y + box.h - send.y)
  }

  /** The Send button at that offset from a box that moved or grew (its size as last seen). */
  public static func sendAt(box: Rect?, offset: SendOffset?, size: Rect?) -> Rect? {
    guard let box, let offset, let size else { return nil }
    return Rect(x: box.x + box.w - offset.r, y: box.y + box.h - offset.b, w: size.w, h: size.h)
  }

  /**
   * The avatar's window while it's held or thrown: the window it lives on, clipped to the visible
   * frame of its display (never under the menu bar or the Dock), so the avatar stays inside that
   * window and never shows over another one. No host (free-floating): the visible frame itself.
   * nil if the two don't overlap (by 40 points or more).
   */
  public static func liftRect(host: Rect?, workArea: Rect?) -> Rect? {
    func ok(_ r: Rect?) -> Bool { guard let r else { return false }; return r.isFinite && r.w > 0 && r.h > 0 }
    guard ok(workArea), let wa = workArea else { return nil }
    guard ok(host), let host else { return Rect(x: jsRound(wa.x), y: jsRound(wa.y), w: jsRound(wa.w), h: jsRound(wa.h)) }
    let x1 = max(host.x, wa.x), y1 = max(host.y, wa.y)
    let x2 = min(host.maxX, wa.maxX), y2 = min(host.maxY, wa.maxY)
    if x2 - x1 < 40 || y2 - y1 < 40 { return nil }
    return Rect(x: jsRound(x1), y: jsRound(y1), w: jsRound(x2 - x1), h: jsRound(y2 - y1))
  }

  // MARK: - where the figure stands (for the parity driver)

  /**
   * What the avatar stands on, from where its page says it is drawn (`hit`, the window's px) and
   * the strip's box: "box", "floor" or "air". Qubit's feet are half his side below his centre (his
   * hit rect is 0.62 sides each way); the pixel buddy's 2 art px above its rect's bottom.
   */
  public static func standingOn(kind: String, hit: Rect?, stripHeight: Double, box: Rect?, size: Double, lifted: Bool) -> String? {
    guard let hit else { return nil }
    if lifted { return "air" }
    let feet: Double, floor: Double
    if kind == "buddy" {
      let scale = max(1, min(4, size))
      feet = hit.maxY - 2 * scale
      floor = stripHeight - 2 * scale
    } else {
      let side = hit.h / 1.24
      feet = hit.midY + side / 2
      floor = stripHeight - 3 // director.js FLOOR
    }
    let tol: Double = 6
    if let box, abs(feet - box.y) <= tol, hit.midX >= box.x - 2, hit.midX <= box.maxX + 2 { return "box" }
    if abs(feet - floor) <= tol { return "floor" }
    return "air"
  }
}
