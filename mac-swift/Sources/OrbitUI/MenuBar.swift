// The menu-bar icon (electron/main.js "tray"): a template image, and a menu with Open Orbit,
// Talk / sleep (with the hotkey), Open at login, Quit. macOS opens the menu on click.
import AppKit
import OrbitKit

@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
  private let item: NSStatusItem
  private let menu = NSMenu()
  var openOrbit: () -> Void = {}
  var talk: () -> Void = {}
  var quit: () -> Void = {}
  var hotkeyLabel: () -> String = { "⌃⌥G" }
  var login: (any LoginItemControl)?
  var onLoginChanged: () -> Void = {}

  /** `assets`: the folder holding trayTemplate.png (+ @2x). */
  init(assets: URL?) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    super.init()
    let image = assets.flatMap { Self.trayImage($0) } ?? NSImage(systemSymbolName: "circle.circle", accessibilityDescription: "Orbit")
    image?.isTemplate = true // black and alpha, tinted by the system
    item.button?.image = image
    item.button?.setAccessibilityLabel("Orbit")
    menu.delegate = self
    item.menu = menu
    refresh()
  }

  static func trayImage(_ dir: URL) -> NSImage? {
    let one = dir.appendingPathComponent("trayTemplate.png"), two = dir.appendingPathComponent("trayTemplate@2x.png")
    guard let base = NSImage(contentsOf: one) else { return nil }
    let img = NSImage(size: NSSize(width: 18, height: 18))
    for url in [one, two] {
      if let data = try? Data(contentsOf: url), let rep = NSBitmapImageRep(data: data) {
        rep.size = NSSize(width: 18, height: 18)
        img.addRepresentation(rep)
      }
    }
    return img.representations.isEmpty ? base : img
  }

  func refresh() {
    item.button?.toolTip = "Orbit: \(hotkeyLabel()) to talk"
    menu.removeAllItems()
    menu.addItem(withTitle: "Open Orbit", action: #selector(openAction), keyEquivalent: "").target = self
    menu.addItem(withTitle: "Talk / sleep  (\(hotkeyLabel()))", action: #selector(talkAction), keyEquivalent: "").target = self
    menu.addItem(.separator())
    let l = menu.addItem(withTitle: "Open at login", action: #selector(loginAction), keyEquivalent: "")
    l.target = self
    l.state = login?.enabled == true ? .on : .off
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Orbit", action: #selector(quitAction), keyEquivalent: "").target = self
  }

  /** The menu's items as shown (for checks): titles, with "[x]" on a checked one. */
  var itemTitles: [String] { menu.items.map { $0.isSeparatorItem ? "-" : ($0.state == .on ? "[x] " : "") + $0.title } }

  func menuNeedsUpdate(_ menu: NSMenu) { refresh() }

  @objc private func openAction() { openOrbit() }
  @objc private func talkAction() { talk() }
  @objc private func loginAction() {
    login?.set(!(login?.enabled ?? false))
    refresh()
    onLoginChanged()
  }
  @objc private func quitAction() { quit() }

  func remove() { NSStatusBar.system.removeStatusItem(item) }
}
