// The stand-in host: a small window of our own with a text box near its bottom (the "prompt box",
// labelled "Prompt" like Claude's) and a Send button, so Qubit has a window and a box to stand on in
// checks. Never the real Claude app. A second window ("Other app") is a place for a guest avatar.
//
// It writes where its windows and box are to $TMPDIR/orbit-standin-<pid>.json whenever they change
// (top-left screen points), which the stand-in helper (StandInHelper.swift) reports in the
// claude-window protocol: no accessibility permission is needed to check the overlays.
import AppKit
import OrbitKit
import OrbitOverlays

@MainActor
final class StandInApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var main: NSWindow!
  private var other: NSWindow!
  private var box: NSTextField!
  private var sendButton: NSButton!
  private var timer: Timer?
  private let frame: NSRect

  init(frame: NSRect) { self.frame = frame }

  static func geometryFile(pid: Int32) -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("orbit-standin-\(pid).json")
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.setActivationPolicy(.regular)
    main = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    main.title = "Stand-in Claude"
    main.isReleasedWhenClosed = false
    main.delegate = self
    let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
    content.wantsLayer = true
    content.layer?.backgroundColor = NSColor(calibratedWhite: 0.97, alpha: 1).cgColor
    let label = NSTextField(labelWithString: "Stand-in Claude window (OverlayDemo). Qubit stands on the box below.")
    label.frame = NSRect(x: 24, y: frame.height - 60, width: frame.width - 48, height: 24)
    label.autoresizingMask = [.width, .minYMargin]
    content.addSubview(label)
    box = NSTextField(frame: NSRect(x: frame.width * 0.2, y: 40, width: frame.width * 0.6, height: 44))
    box.placeholderString = "Reply to Claude…"
    box.setAccessibilityLabel("Prompt")
    box.autoresizingMask = [.width, .minXMargin, .maxXMargin]
    content.addSubview(box)
    sendButton = NSButton(title: "Send", target: nil, action: nil)
    sendButton.frame = NSRect(x: frame.width * 0.8 - 74, y: 47, width: 64, height: 30)
    sendButton.setAccessibilityLabel("Send")
    sendButton.autoresizingMask = [.minXMargin, .maxXMargin]
    content.addSubview(sendButton)
    main.contentView = content
    main.makeKeyAndOrderFront(nil)

    let of = NSRect(x: frame.minX + frame.width + 40, y: frame.minY, width: 520, height: 420)
    other = NSWindow(contentRect: of, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    other.title = "Other app"
    other.isReleasedWhenClosed = false
    other.delegate = self
    let oc = NSView(frame: NSRect(origin: .zero, size: of.size))
    oc.wantsLayer = true
    oc.layer?.backgroundColor = NSColor(calibratedRed: 0.93, green: 0.96, blue: 1, alpha: 1).cgColor
    other.contentView = oc
    other.orderFront(nil)

    write()
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in MainActor.assumeIsolated { self.write() } }
  }

  func windowDidMove(_ notification: Notification) { write() }
  func windowDidResize(_ notification: Notification) { write() }
  func windowDidMiniaturize(_ notification: Notification) { write() }
  func windowDidDeminiaturize(_ notification: Notification) { write() }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  private var lastWritten = ""
  private func write() {
    func screenRect(_ v: NSView) -> Rect {
      let inWin = v.convert(v.bounds, to: nil)
      return ScreenSpace.topLeft(v.window!.convertToScreen(inWin))
    }
    func win(_ w: NSWindow) -> JSONValue {
      let r = ScreenSpace.topLeft(w.frame)
      return ["id": .number(Double(w.windowNumber)), "min": .bool(w.isMiniaturized || !w.isVisible), "x": .number(r.x), "y": .number(r.y), "w": .number(r.w), "h": .number(r.h)]
    }
    let j: JSONValue = [
      "pid": .number(Double(getpid())),
      "main": win(main),
      "other": win(other),
      "box": screenRect(box).rectJSON,
      "send": screenRect(sendButton).rectJSON,
    ]
    let text = j.text
    if text == lastWritten { return }
    lastWritten = text
    try? Data(text.utf8).write(to: Self.geometryFile(pid: getpid()), options: .atomic)
  }

  func applicationWillTerminate(_ notification: Notification) {
    try? FileManager.default.removeItem(at: Self.geometryFile(pid: getpid()))
  }
}

