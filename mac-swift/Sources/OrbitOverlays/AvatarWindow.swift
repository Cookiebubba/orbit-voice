// An avatar's real window (AvatarModel's AvatarWindowPort): an OverlayWindow holding the avatar's page
// in an OverlayPage. The model decides where it goes and when it shows; this does it in AppKit.
import AppKit
import OrbitKit
import WebKit

@MainActor
final class AvatarWindow: AvatarWindowPort {
  let panel: OverlayWindow
  let page: OverlayPage
  private var gone = false

  init(kind: AvatarKind, url: URL, base: URL, onMessage: @escaping (String, [JSONValue]) -> Void, loaded: @escaping () -> Void) {
    panel = OverlayWindow(frame: Rect(x: 0, y: 0, w: 400, h: AvatarGeometry.buddyHeight), title: kind.title)
    page = OverlayPage(url: url, base: base)
    page.webView.frame = panel.contentView?.bounds ?? .zero
    panel.contentView = page.webView
    page.onMessage = onMessage
    page.onLoad = loaded
    page.load()
  }

  var frame: Rect { panel.topLeftFrame }
  func setFrame(_ r: Rect) { if !gone { panel.topLeftFrame = r } }
  var isVisible: Bool { !gone && panel.isVisible }
  func showInactive() { if !gone { panel.showInactive() } }
  func hide() { panel.orderOut(nil) }
  func setLayer(_ layer: OverlayLayer) { if !gone { panel.apply(layer: layer) } }
  func setIgnoresMouse(_ ignore: Bool) { if !gone { panel.ignoresMouseEvents = ignore } }
  func send(_ channel: String, _ payload: JSONValue) { page.emit(channel, payload) }

  func destroy() {
    guard !gone else { return }
    gone = true
    page.destroy()
    panel.orderOut(nil)
    panel.contentView = nil
    panel.close()
  }

  /**
   * A synthetic pointer event for the parity driver, delivered to this page only (never posted to
   * the system, the real cursor never moves): a PointerEvent (and the matching mouse event) at that
   * screen point, as a real press, drag or release would arrive.
   */
  func pointer(type: String, at p: ScreenPoint) {
    let f = frame
    let cx = p.x - f.x, cy = p.y - f.y
    let (pt, mt, buttons): (String, String, Int) = switch type {
    case "down": ("pointerdown", "mousedown", 1)
    case "up": ("pointerup", "mouseup", 0)
    default: ("pointermove", "mousemove", pressed ? 1 : 0)
    }
    if type == "down" { pressed = true }
    if type == "up" { pressed = false }
    let js = """
    (() => {
      const o = { bubbles: true, cancelable: true, composed: true, clientX: \(cx), clientY: \(cy), screenX: \(p.x), screenY: \(p.y), button: 0, buttons: \(buttons), view: window };
      const t = document.elementFromPoint(\(cx), \(cy)) || document.body || document.documentElement;
      const pe = new PointerEvent('\(pt)', { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true });
      // (An untrusted event has no coalesced events of its own: it stands for itself, as a real one does.)
      Object.defineProperty(pe, 'getCoalescedEvents', { value: () => [pe] });
      t.dispatchEvent(pe);
      t.dispatchEvent(new MouseEvent('\(mt)', o));
      return true;
    })()
    """
    page.webView.evaluateJavaScript(js, completionHandler: nil)
  }
  private var pressed = false
}
