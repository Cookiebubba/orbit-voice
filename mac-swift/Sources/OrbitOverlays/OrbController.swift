// The floating orb (index.html#orb) that stands in for the main window while it's hidden, and "Stick
// to Claude Code" (the orb parts of electron/main.js): it rides on the Claude window at a saved spot
// (OrbitKit's OrbStick), just above it in z-order (on top only while Claude or Orbit is in front, so
// other apps can cover both), hides while Claude is minimized, and floats free again when Claude
// isn't on screen. Dragging it picks a new spot on the window (or a new free spot). On macOS Orbit
// moves the orb itself whenever the tracker reports the window moved.
//
// The orb takes the mouse (it is clicked, dragged and right-clicked), but never focus.
import AppKit
import OrbitKit

@MainActor
final class OrbController {
  let panel: OverlayWindow
  let page: OverlayPage
  private let settings: () -> [String: JSONValue]
  private let allowed: () -> Bool
  private let emitEvent: (Overlays.OrbEvent) -> Void
  private(set) var orbMode = false // the orb is meant to be showing (the main window is hidden)
  private var layer: String? // "free" | "top" | "above:<id>"
  private var drag: (cursor: ScreenPoint, origin: Rect)?
  var claude = ClaudeState.none
  private var lastState: JSONValue?

  init(url: URL, base: URL, settings: @escaping () -> [String: JSONValue], allowed: @escaping () -> Bool, emit: @escaping (Overlays.OrbEvent) -> Void) {
    self.settings = settings
    self.allowed = allowed
    self.emitEvent = emit
    panel = OverlayWindow(frame: Rect(x: 0, y: 0, w: OrbStick.orbSize, h: OrbStick.orbSize), title: "Orbit orb")
    panel.ignoresMouseEvents = false
    page = OverlayPage(url: url, base: base)
    panel.contentView = page.webView
    page.onMessage = { [weak self] ch, args in self?.message(ch, args) }
    page.onLoad = { [weak self] in
      if let s = self?.lastState { self?.page.emit("orb:state", s) }
    }
    page.load()
    layer = "free"
    panel.topLeftFrame = frameAt(startPosition())
  }

  private func frameAt(_ p: ScreenPoint) -> Rect { Rect(x: p.x, y: p.y, w: OrbStick.orbSize, h: OrbStick.orbSize) }

  private func startPosition() -> ScreenPoint {
    let saved = settings()["orbPosition"]?.arrayValue.flatMap { a -> ScreenPoint? in
      guard a.count == 2, let x = a[0].doubleValue, let y = a[1].doubleValue else { return nil }
      return ScreenPoint(x: x, y: y)
    }
    let ds = ScreenSpace.displays()
    return OrbStick.startPosition(saved: saved, areas: ds.map(\.visible), main: ds.first?.visible ?? Rect(x: 0, y: 0, w: 1440, h: 900))
  }

  private var sticking: Bool { settings()["orbStick"]?.boolValue == true && claude.found }
  private var anchor: OrbStick.Anchor { OrbStick.Anchor(json: settings()["orbStickAnchor"]) ?? OrbStick.defaultAnchor }

  /** Orbit's voice state for the orb page. */
  func onState(_ s: JSONValue) {
    lastState = s
    page.emit("orb:state", s)
  }

  func action(_ a: String) { page.emit("orb:action", .string(a)) }

  func show() {
    orbMode = true
    drag = nil // a click on the orb starts a "drag" that never ends; don't let it block the orb
    place()
  }

  func hide() {
    orbMode = false
    drag = nil
    panel.orderOut(nil)
  }

  private func setLayer(_ next: String) {
    guard next != layer else { return }
    layer = next
    if next == "free" || next == "top" { panel.apply(layer: .top) } else { panel.apply(layer: .above(claude.hwnd)) }
  }

  func place() {
    if drag != nil { return }
    if !allowed() { return panel.orderOut(nil) } // the avatar stands in for it
    if !sticking {
      if layer != "free" {
        setLayer("free")
        panel.topLeftFrame = frameAt(startPosition())
      }
      if orbMode, !panel.isVisible {
        panel.showInactive()
        panel.apply(layer: .top)
      }
      return
    }
    if claude.min || !orbMode {
      if panel.isVisible { panel.orderOut(nil) }
      return
    }
    let p = OrbStick.orbPosition(win: claude.rect, anchor: anchor)
    if panel.topLeftFrame != frameAt(p) { panel.topLeftFrame = frameAt(p) }
    if !panel.isVisible {
      panel.showInactive()
      layer = nil // z-order set while hidden may not stick: apply it again now that it shows
    }
    setLayer(claude.front == "other" ? "above:\(claude.hwnd)" : "top")
  }

  private func message(_ ch: String, _ args: [JSONValue]) {
    switch ch {
    case "orb:restore": emitEvent(.restore)
    case "orb:action": if let a = args.first?.stringValue, a.count < 40 { emitEvent(.action(a)) }
    case "orb:drag-start":
      drag = (ScreenSpace.cursor, panel.topLeftFrame)
    case "orb:drag-move":
      guard let d = drag else { return }
      let c = ScreenSpace.cursor
      panel.topLeftFrame = Rect(x: d.origin.x + c.x - d.cursor.x, y: d.origin.y + c.y - d.cursor.y, w: OrbStick.orbSize, h: OrbStick.orbSize)
    case "orb:drag-end":
      drag = nil
      let f = panel.topLeftFrame
      if sticking, !claude.min {
        // Remember the spot relative to the nearest corner of the Claude window, then snap inside it.
        emitEvent(.save(["orbStickAnchor": OrbStick.anchorFor(win: claude.rect, pos: ScreenPoint(x: f.x, y: f.y)).json]))
      } else {
        emitEvent(.save(["orbPosition": [.number(jsRound(f.x)), .number(jsRound(f.y))]]))
      }
      place()
    default: break
    }
  }

  var parity: ParityWindow { ParityWindow(visible: panel.isVisible, frame: panel.topLeftFrame, view: "orb") }

  func stop() {
    page.destroy()
    panel.orderOut(nil)
    panel.close()
  }
}
