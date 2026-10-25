// The overlays' window: a borderless, transparent, non-activating panel that never takes focus,
// casts no shadow, joins every Space (and full-screen Spaces, as an auxiliary window), and sits
// either just above one window (its host) or floating on top. Clicks go through it while
// ignoresMouseEvents is on (the avatars' hover poll turns it off only while the cursor is on him).
//
// Coordinates: AppKit's are bottom-left origin; everything else in Orbit (the pages, the helper, the
// parity driver) uses top-left screen points with the main display's top-left at 0,0. ScreenSpace is
// the one place that converts.
import AppKit
import OrbitKit

@MainActor
public enum ScreenSpace {
  /** The height of the main display (the one with the menu bar): the flip line. */
  private static var flipHeight: Double { Double(NSScreen.screens.first?.frame.maxY ?? 0) }

  /** A top-left rect (points) as an AppKit frame. */
  public static func appKit(_ r: Rect) -> NSRect { NSRect(x: r.x, y: flipHeight - r.y - r.h, width: r.w, height: r.h) }

  /** An AppKit frame as a top-left rect. */
  public static func topLeft(_ f: NSRect) -> Rect { Rect(x: Double(f.minX), y: flipHeight - Double(f.maxY), w: Double(f.width), h: Double(f.height)) }

  /** An AppKit screen point as a top-left point. */
  public static func topLeft(_ p: NSPoint) -> ScreenPoint { ScreenPoint(x: Double(p.x), y: flipHeight - Double(p.y)) }

  /** A top-left point as an AppKit screen point. */
  public static func appKit(_ p: ScreenPoint) -> NSPoint { NSPoint(x: p.x, y: flipHeight - p.y) }

  /** The cursor (top-left points). */
  public static var cursor: ScreenPoint { topLeft(NSEvent.mouseLocation) }

  /** Every display's visible frame (no menu bar, no Dock), top-left, with its id and scale. */
  public static func displays() -> [(id: Int, visible: Rect, frame: Rect, scale: Double)] {
    NSScreen.screens.map { s in
      let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
      return (id, topLeft(s.visibleFrame), topLeft(s.frame), Double(s.backingScaleFactor))
    }
  }

  /** The visible frame of the display a rect is most on (the main display's if none). */
  public static func visibleFrame(matching r: Rect) -> Rect {
    let ds = displays()
    var best: (area: Double, rect: Rect)?
    for d in ds {
      if let i = d.frame.intersection(r) {
        let a = i.w * i.h
        if a > (best?.area ?? 0) { best = (a, d.visible) }
      }
    }
    if let b = best { return b.rect }
    // Off every display: the nearest one by its centre.
    let near = ds.min { hypot($0.frame.midX - r.midX, $0.frame.midY - r.midY) < hypot($1.frame.midX - r.midX, $1.frame.midY - r.midY) }
    return near?.visible ?? Rect(x: 0, y: 0, w: 1440, h: 900)
  }

  /** The visible frame of the display a point is on (the main display's if none). */
  public static func visibleFrame(at p: ScreenPoint) -> Rect {
    displays().first { $0.frame.contains(p.x, p.y) }?.visible ?? displays().first?.visible ?? Rect(x: 0, y: 0, w: 1440, h: 900)
  }
}

/** A borderless, transparent, non-activating panel for an overlay page. */
@MainActor
public final class OverlayWindow: NSPanel {
  public init(frame: Rect, title: String) {
    super.init(contentRect: ScreenSpace.appKit(frame), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    self.title = title
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    isMovable = false
    isMovableByWindowBackground = false
    hidesOnDeactivate = false
    isReleasedWhenClosed = false
    becomesKeyOnlyIfNeeded = true
    worksWhenModal = true
    animationBehavior = .none
    // Every Space, and over full-screen apps as an auxiliary window; never in the window cycle.
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
    ignoresMouseEvents = true
    acceptsMouseMovedEvents = true
    level = .floating
  }

  // Never key or main: clicking the avatar never takes focus from the app you're in.
  public override var canBecomeKey: Bool { false }
  public override var canBecomeMain: Bool { false }

  /** The frame in top-left screen points. */
  public var topLeftFrame: Rect {
    get { ScreenSpace.topLeft(frame) }
    set { setFrame(ScreenSpace.appKit(newValue), display: true) }
  }

  /** Show without activating Orbit or taking focus. */
  public func showInactive() { orderFrontRegardless() }

  /**
   * Floating over other apps (.top), or at the normal level just above one window (.above(id), a
   * CGWindowID: the host's), so whatever covers the host covers this too. If that window can't be
   * found (gone, another Space), it floats.
   */
  public func apply(layer: OverlayLayer) {
    switch layer {
    case .top:
      level = .floating
      if isVisible { orderFrontRegardless() }
    case .above(let id):
      level = .normal
      if isVisible {
        if id > 0, Self.windowExists(id) { order(.above, relativeTo: id) } else {
          level = .floating
          orderFrontRegardless()
        }
      }
    }
  }

  private static func windowExists(_ id: Int) -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]] else { return false }
    return !list.isEmpty
  }
}
