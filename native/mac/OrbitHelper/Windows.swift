// Top-level windows: the window server's list (CGWindowList: every window, front to back, with its
// owner and bounds) joined with the accessibility API (titles, minimized, the focused window).
// A window's "hwnd" in Orbit is its CGWindowID. Rects are in points, top-left origin of the main
// display: the same space as Electron's screen coordinates on macOS.

import AppKit
import ApplicationServices

struct CGWin {
  let id: CGWindowID
  let pid: pid_t
  let layer: Int
  let bounds: CGRect
  let onscreen: Bool
  let alpha: Double
  let owner: String
  let name: String // empty without Screen Recording permission (other apps' titles)
}

enum Wins {
  /** Every window the window server knows, front to back. `onscreen`: only those on screen now. */
  static func cg(onscreenOnly: Bool = false) -> [CGWin] {
    let opts: CGWindowListOption = onscreenOnly ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { d in
      guard let id = d[kCGWindowNumber as String] as? NSNumber, let pid = d[kCGWindowOwnerPID as String] as? NSNumber else { return nil }
      var rect = CGRect.zero
      if let b = d[kCGWindowBounds as String] as? NSDictionary { rect = CGRect(dictionaryRepresentation: b) ?? .zero }
      return CGWin(
        id: CGWindowID(id.uint32Value),
        pid: pid_t(pid.int32Value),
        layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
        bounds: rect,
        onscreen: (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
        alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
        owner: (d[kCGWindowOwnerName as String] as? String) ?? "",
        name: (d[kCGWindowName as String] as? String) ?? ""
      )
    }
  }

  static func cgWindow(_ id: CGWindowID) -> CGWin? {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], !list.isEmpty else { return nil }
    return cg().first { $0.id == id }
  }

  struct AppInfo {
    let exe: String
    let bundle: String
    let name: String
  }
  private static var appCache: [pid_t: AppInfo] = [:]
  static func app(_ pid: pid_t) -> AppInfo {
    if let a = appCache[pid] { return a }
    let ra = NSRunningApplication(processIdentifier: pid)
    let exe = ra?.executableURL?.lastPathComponent ?? ""
    let a = AppInfo(exe: exe, bundle: ra?.bundleIdentifier ?? "", name: ra?.localizedName ?? exe)
    if ra != nil { appCache[pid] = a }
    if appCache.count > 400 { appCache.removeAll() }
    return a
  }

  /** The system's own surfaces (the Dock, Mission Control, Spotlight...), Orbit's own, or an app. */
  static let shellBundles: Set<String> = [
    "com.apple.dock", "com.apple.WindowManager", "com.apple.controlcenter", "com.apple.notificationcenterui",
    "com.apple.Spotlight", "com.apple.systemuiserver", "com.apple.loginwindow", "com.apple.screencaptureui",
    "com.apple.TextInputMenuAgent", "com.apple.wifi.WiFiAgent", "com.apple.UserNotificationCenter",
  ]
  static var orbitPid: pid_t = 0
  static func kind(pid: pid_t, bundle: String) -> String {
    if pid == orbitPid || pid == getpid() { return "orbit" }
    if shellBundles.contains(bundle) { return "shell" }
    return "app"
  }

  static func dpi(for rect: CGRect) -> Int {
    let mid = CGPoint(x: rect.midX, y: rect.midY)
    // NSScreen frames are bottom-left origin; flip against the main screen.
    let mainH = NSScreen.screens.first?.frame.height ?? 0
    for s in NSScreen.screens {
      let f = s.frame
      let flipped = CGRect(x: f.minX, y: mainH - f.maxY, width: f.width, height: f.height)
      if flipped.contains(mid) { return Int((s.backingScaleFactor * 96).rounded()) }
    }
    return Int(((NSScreen.main?.backingScaleFactor ?? 1) * 96).rounded())
  }

  /** A window as Orbit reports it (focus.ps1's <win>): { hwnd, owner, pid, exe, bundle, app, title, cls, kind, min, max, cloaked, elevated, x, y, w, h, dpi }. */
  static func describe(_ id: CGWindowID, cgList: [CGWin]? = nil, ax axWin: AXUIElement? = nil) -> [String: Any]? {
    let list = cgList ?? cg()
    guard let c = list.first(where: { $0.id == id }) else { return nil }
    let info = app(c.pid)
    let el = axWin ?? AX.window(id, pid: c.pid)
    var title = c.name
    var min = false, max = false, subrole = ""
    var rect = c.bounds
    if let el = el {
      let v = AX.many(el, [kAXTitleAttribute, kAXMinimizedAttribute, "AXFullScreen", kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute])
      if let t = v[0] as? String, !t.isEmpty { title = t }
      min = (v[1] as? NSNumber)?.boolValue ?? false
      max = (v[2] as? NSNumber)?.boolValue ?? false
      subrole = (v[3] as? String) ?? ""
      if let p = AX.point(v[4]), let s = AX.size(v[5]), s.width > 0 { rect = CGRect(origin: p, size: s) }
    }
    return [
      "hwnd": Int(id), "owner": 0, "pid": Int(c.pid), "exe": info.exe, "bundle": info.bundle, "app": info.name,
      "title": cut(title, 300), "cls": subrole.isEmpty ? "AXWindow" : subrole, "kind": kind(pid: c.pid, bundle: info.bundle),
      "min": min, "max": max, "cloaked": !c.onscreen && !min, "elevated": false,
      "x": Int(rect.origin.x.rounded()), "y": Int(rect.origin.y.rounded()), "w": Int(rect.width.rounded()), "h": Int(rect.height.rounded()),
      "dpi": dpi(for: rect),
    ]
  }

  /** The window in front: the frontmost app's focused window. */
  static func front() -> [String: Any] {
    guard let ra = NSWorkspace.shared.frontmostApplication else { return ["hwnd": 0, "kind": "none"] }
    let pid = ra.processIdentifier
    let a = AX.app(pid)
    var id: CGWindowID = 0
    var el: AXUIElement? = nil
    if let w = AX.attr(a, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
      el = (w as! AXUIElement)
      id = AX.windowID(el!)
    }
    if id == 0, let w = AX.attr(a, kAXMainWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
      el = (w as! AXUIElement)
      id = AX.windowID(el!)
    }
    if id == 0 {
      // No window in front (Finder's desktop, an app with all windows closed).
      let info = app(pid)
      let k = kind(pid: pid, bundle: info.bundle)
      return ["hwnd": 0, "kind": k == "orbit" ? "orbit" : (info.bundle == "com.apple.finder" ? "shell" : "none"), "pid": Int(pid), "exe": info.exe, "bundle": info.bundle]
    }
    return describe(id, ax: el) ?? ["hwnd": 0, "kind": "none"]
  }

  /** Ordinary app windows a person would switch between (what Cmd+Tab and Mission Control show), front first. */
  static func appWindows(includeMinimized: Bool = true) -> [[String: Any]] {
    let list = cg()
    var out: [[String: Any]] = []
    var axByPid: [pid_t: [(el: AXUIElement, id: CGWindowID)]] = [:]
    for c in list where c.layer == 0 && c.alpha > 0 && c.bounds.width >= 80 && c.bounds.height >= 60 {
      let info = app(c.pid)
      if kind(pid: c.pid, bundle: info.bundle) != "app" { continue }
      if axByPid[c.pid] == nil { axByPid[c.pid] = AX.windows(of: c.pid) }
      guard let ax = axByPid[c.pid]?.first(where: { $0.id == c.id }) else { continue } // not a real window (a menu, a tooltip)
      guard let d = describe(c.id, cgList: list, ax: ax.el) else { continue }
      let min = d["min"] as? Bool ?? false
      if !c.onscreen && !min { continue } // on another Space, or its app is hidden (as Windows leaves out cloaked ones)
      if min && !includeMinimized { continue }
      out.append(d)
      if out.count >= 60 { break }
    }
    return out
  }

  /**
   * Bring a window to the front, only when the user asked: un-minimize, raise it, and activate its
   * app. { switched, how }.
   */
  static func switchTo(_ id: CGWindowID) -> [String: Any] {
    guard let c = cg().first(where: { $0.id == id }) else { return ["error": "no_window"] }
    guard let el = AX.window(id, pid: c.pid) else { return ["error": "no_window"] }
    var how = "foreground"
    if AX.bool(el, kAXMinimizedAttribute) == true {
      AX.set(el, kAXMinimizedAttribute, kCFBooleanFalse)
      how = "restore"
    }
    AX.perform(el, kAXRaiseAction)
    AX.set(el, kAXMainAttribute, kCFBooleanTrue)
    let ra = NSRunningApplication(processIdentifier: c.pid)
    if #available(macOS 14.0, *) {
      ra?.activate(from: NSRunningApplication.current, options: [])
      if NSWorkspace.shared.frontmostApplication?.processIdentifier != c.pid { ra?.activate() }
    } else {
      ra?.activate(options: [.activateIgnoringOtherApps])
    }
    var switched = false
    for _ in 0..<20 {
      if NSWorkspace.shared.frontmostApplication?.processIdentifier == c.pid {
        let f = front()
        if (f["hwnd"] as? Int) == Int(id) { switched = true; break }
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return ["switched": switched, "how": how]
  }

  /** Seconds since the user last touched the mouse or keyboard, in ms. */
  static func idleMs() -> Int {
    let s = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    return Int(s * 1000)
  }
}
