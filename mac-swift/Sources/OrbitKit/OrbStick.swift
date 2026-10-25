// "Stick to Claude Code" (electron/orb-stick.js): where the orb goes on the Claude window, and how a
// drag becomes a saved spot. In screen points, so the orb keeps the same distance from the window's
// corner at any display scaling.
import Foundation

public enum OrbStick {
  public static let corners = ["tl", "tr", "bl", "br"]
  /** The orb window's side (points). */
  public static let orbSize: Double = 128

  /** A spot on the Claude window: a corner and the distance in from it. */
  public struct Anchor: Codable, Equatable, Sendable {
    public var corner: String
    public var dx: Double
    public var dy: Double
    public init(corner: String, dx: Double, dy: Double) { (self.corner, self.dx, self.dy) = (corner, dx, dy) }

    public init?(json: JSONValue?) {
      guard let c = json?["corner"]?.stringValue, let dx = json?["dx"]?.doubleValue, let dy = json?["dy"]?.doubleValue else { return nil }
      self.init(corner: c, dx: dx, dy: dy)
      guard OrbStick.isAnchor(self) else { return nil }
    }

    public var json: JSONValue { ["corner": .string(corner), "dx": .number(dx), "dy": .number(dy)] }
  }

  /** Default: bottom-right, a little in from the side and above Claude's prompt box. */
  public static let defaultAnchor = Anchor(corner: "br", dx: 24, dy: 140)

  public static func isAnchor(_ a: Anchor?) -> Bool {
    guard let a else { return false }
    return corners.contains(a.corner) && [a.dx, a.dy].allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 10000 }
  }

  /** Orb top-left for a Claude window rect and an anchor, kept inside the window. */
  public static func orbPosition(win: Rect, anchor: Anchor?, size: Double = orbSize) -> ScreenPoint {
    let a = isAnchor(anchor) ? anchor! : defaultAnchor
    let c = Array(a.corner)
    var x = c[1] == "r" ? win.x + win.w - a.dx - size : win.x + a.dx
    var y = c[0] == "b" ? win.y + win.h - a.dy - size : win.y + a.dy
    x = clampInto(x, win.x, win.w, size)
    y = clampInto(y, win.y, win.h, size)
    return ScreenPoint(x: jsRound(x), y: jsRound(y))
  }

  /** The anchor for an orb the user dropped at `pos`: measured from the window corner nearest to it. */
  public static func anchorFor(win: Rect, pos: ScreenPoint, size: Double = orbSize) -> Anchor {
    let cx = pos.x + size / 2
    let cy = pos.y + size / 2
    let right = cx > win.x + win.w / 2
    let bottom = cy > win.y + win.h / 2
    let dx = right ? win.x + win.w - (pos.x + size) : pos.x - win.x
    let dy = bottom ? win.y + win.h - (pos.y + size) : pos.y - win.y
    return Anchor(
      corner: "\(bottom ? "b" : "t")\(right ? "r" : "l")",
      dx: jsRound(min(max(dx, 0), max(win.w - size, 0))),
      dy: jsRound(min(max(dy, 0), max(win.h - size, 0)))
    )
  }

  private static func clampInto(_ v: Double, _ start: Double, _ length: Double, _ size: Double) -> Double {
    if length <= size { return start + (length - size) / 2 } // window smaller than the orb: centre it
    return min(max(v, start), start + length - size)
  }

  /**
   * Where the orb starts when it floats free: the saved spot if it's still on a display (with 20
   * points of slack up and left), else the bottom-right of the main display's visible frame.
   */
  public static func startPosition(saved: ScreenPoint?, areas: [Rect], main: Rect, size: Double = orbSize) -> ScreenPoint {
    if let s = saved, areas.contains(where: { s.x >= $0.x - 20 && s.y >= $0.y - 20 && s.x < $0.maxX && s.y < $0.maxY }) { return s }
    return ScreenPoint(x: main.x + main.w - size - 24, y: main.y + main.h - size - 24)
  }
}
