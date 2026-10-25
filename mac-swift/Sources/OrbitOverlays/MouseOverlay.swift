// Orbit's mouse on screen: one click-through overlay per display running mouse.html, driven by
// OrbitKit's OrbitMouseModel (the glide planning). On macOS the glide space is screen points (what
// the accessibility API reports controls in), so each display's `area` and `workArea` are both its
// visible frame and the page's scale is 1.
import AppKit
import OrbitKit

@MainActor
final class MousePage: MousePagePort {
  let panel: OverlayWindow
  let page: OverlayPage
  private var gone = false

  init(display: MouseDisplay, url: URL, base: URL, ready: @escaping () -> Void) {
    panel = OverlayWindow(frame: Rect(x: display.workArea.x, y: display.workArea.y, w: 1, h: 1), title: "Orbit mouse")
    panel.ignoresMouseEvents = true // always: clicks land in whatever is under it
    panel.level = .statusBar // over the avatars and other apps' floating windows
    page = OverlayPage(url: url, base: base)
    panel.contentView = page.webView
    page.onLoad = ready
    page.load()
  }

  func setBounds(_ r: Rect) { if !gone { panel.topLeftFrame = r } }
  func showInactive() {
    guard !gone else { return }
    panel.level = .statusBar
    panel.showInactive()
  }
  func hide() { panel.orderOut(nil) }
  func send(_ message: JSONValue) { page.emit("mouse:state", message) }
  func destroy() {
    guard !gone else { return }
    gone = true
    page.destroy()
    panel.orderOut(nil)
    panel.contentView = nil
    panel.close()
  }
}

@MainActor
final class MouseOverlay {
  let model: OrbitMouseModel

  init(url: @escaping () -> URL?, base: URL, enabled: @escaping () -> Bool, clock: OverlayClock = MainClock.shared) {
    model = OrbitMouseModel(
      clock: clock,
      displays: { MouseOverlay.displays() },
      enabled: enabled,
      makePage: { display, ready in
        MousePage(display: display, url: url() ?? base, base: base, ready: ready)
      }
    )
  }

  static func displays() -> [MouseDisplay] {
    ScreenSpace.displays().map { MouseDisplay(id: $0.id, area: $0.visible, workArea: $0.visible) }
  }
}
