// "Orbit anywhere" focus helper for macOS: the same line protocol as src/platform/win/focus.ps1.
// Follows which window is in front, in any app, from NSWorkspace (an app came to the front) and
// accessibility notifications (its focused window changed, its title changed, it was minimized);
// a one-second safety net catches anything missed and windows that closed.
//
// Reports (stdout):
//   {"fg":<win>,"idle":ms}             the window in front changed (or its title, or minimized)
//   {"gone":[id,...]}                  windows reported before that no longer exist
//   {"id":n,"describe":<win>|null}     answer to "describe"
//   {"id":n,"list":[<win>,...]}        answer to "list": the app windows a person switches between, front first
//   {"id":n,"switched":bool,"how":".."} answer to "switch"
//   {"id":n,"watching":n}              answer to "watch"
//   {"wins":[{"hwnd","min","cloaked","x","y","w","h"},...]}  the watched windows, whenever one moves or resizes
// (No {"switching":..}: macOS doesn't tell other apps about Cmd+Tab without Input Monitoring.)
// <win>: see Wins.describe. Coordinates are points (Electron's screen coordinates on macOS).
// Commands (stdin): "describe <id> <hwnd>", "list <id>", "switch <id> <hwnd>", "watch <id> <hwnd>,<hwnd>,...|-", "quit".

import AppKit
import ApplicationServices

final class FocusMode {
  private var frontObserver: AppObserver?
  private var focusedWindowEl: AXUIElement?
  private var lastKey = ""
  private var seen = Set<Int>()
  private var watching: [Int] = []
  private var watchObservers: [pid_t: AppObserver] = [:]
  private var lastWins = ""
  private var fastUntil = DispatchTime.now()
  private var fastTimer: DispatchSourceTimer?
  private var timers: [DispatchSourceTimer] = []

  func run() {
    let nc = NSWorkspace.shared.notificationCenter
    nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
      self?.followFrontApp()
      self?.report()
    }
    nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] n in
      if let ra = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
        self?.watchObservers.removeValue(forKey: ra.processIdentifier)
      }
      self?.checkGone()
    }
    nc.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.report()
      self?.reportWins(force: true)
    }
    followFrontApp()
    report(force: true)
    timers.append(every(1.0) { [weak self] in
      self?.report()
      self?.checkGone()
      self?.reportWins(force: false)
    })
    IO.readLines { [weak self] line in self?.command(line) }
  }

  /** Listen to the app in front: its focused window changing, minimizing, and that window's title. */
  private func followFrontApp() {
    guard let ra = NSWorkspace.shared.frontmostApplication else { return }
    let pid = ra.processIdentifier
    if frontObserver?.pid != pid {
      frontObserver = AppObserver(pid: pid) { [weak self] name, el in
        if name == kAXFocusedWindowChangedNotification || name == kAXMainWindowChangedNotification { self?.followFocusedWindow() }
        self?.report()
      }
      frontObserver?.add([kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification, kAXWindowCreatedNotification])
    }
    followFocusedWindow()
  }

  private func followFocusedWindow() {
    guard let obs = frontObserver else { return }
    let a = AX.app(obs.pid)
    guard let w = AX.attr(a, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return }
    let el = w as! AXUIElement
    if let f = focusedWindowEl, CFEqual(f, el) { return }
    focusedWindowEl = el
    obs.add([kAXTitleChangedNotification, kAXUIElementDestroyedNotification], on: el)
  }

  private func report(force: Bool = false) {
    let w = Wins.front()
    let key = "\(w["hwnd"] ?? 0)|\(w["title"] ?? "")|\(w["min"] ?? false)|\(w["kind"] ?? "")|\(w["pid"] ?? 0)"
    if !force && key == lastKey { return }
    lastKey = key
    if let h = w["hwnd"] as? Int, h > 0 { seen.insert(h) }
    IO.emit(["fg": w, "idle": Wins.idleMs()])
  }

  private func checkGone() {
    if seen.isEmpty { return }
    let alive = Set(Wins.cg().map { Int($0.id) })
    let gone = seen.subtracting(alive)
    if gone.isEmpty { return }
    seen.subtract(gone)
    watching.removeAll { gone.contains($0) }
    IO.emit(["gone": Array(gone).sorted()])
  }

  // ---- watched windows (Qubit lives on them) ----

  private func setWatch(_ ids: [Int]) {
    watching = Array(Set(ids.filter { $0 > 0 })).prefix(16).map { $0 }
    watchObservers.removeAll()
    let list = Wins.cg()
    for id in watching {
      guard let c = list.first(where: { Int($0.id) == id }), let el = AX.window(c.id, pid: c.pid) else { continue }
      if watchObservers[c.pid] == nil {
        watchObservers[c.pid] = AppObserver(pid: c.pid) { [weak self] _, _ in self?.moving() }
      }
      watchObservers[c.pid]?.add([kAXWindowMovedNotification, kAXWindowResizedNotification, kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification], on: el)
    }
    lastWins = ""
    reportWins(force: true)
  }

  /** A watched window moved: report now, and look often for a moment (a drag sends few events). */
  private func moving() {
    reportWins(force: false)
    fastUntil = .now() + .milliseconds(600)
    if fastTimer == nil {
      fastTimer = every(0.03) { [weak self] in
        guard let self = self else { return }
        self.reportWins(force: false)
        if DispatchTime.now() > self.fastUntil {
          self.fastTimer?.cancel()
          self.fastTimer = nil
        }
      }
    }
  }

  private func reportWins(force: Bool) {
    if watching.isEmpty { return }
    let list = Wins.cg()
    var out: [[String: Any]] = []
    for id in watching {
      guard let c = list.first(where: { Int($0.id) == id }) else { continue }
      var rect = c.bounds
      var min = false
      if let el = AX.window(c.id, pid: c.pid) {
        let v = AX.many(el, [kAXMinimizedAttribute, kAXPositionAttribute, kAXSizeAttribute])
        min = (v[0] as? NSNumber)?.boolValue ?? false
        if let p = AX.point(v[1]), let s = AX.size(v[2]) { rect = CGRect(origin: p, size: s) }
      }
      out.append(["hwnd": id, "min": min, "cloaked": !c.onscreen && !min, "x": Int(rect.minX.rounded()), "y": Int(rect.minY.rounded()), "w": Int(rect.width.rounded()), "h": Int(rect.height.rounded())])
    }
    let key = out.map { "\($0)" }.joined()
    if !force && key == lastWins { return }
    lastWins = key
    IO.emit(["wins": out])
  }

  // ---- commands ----

  private func command(_ line: String) {
    let parts = line.split(separator: " ").map(String.init)
    guard let cmd = parts.first else { return }
    let id = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
    switch cmd {
    case "quit":
      exit(0)
    case "describe":
      let h = parts.count > 2 ? Int(parts[2]) ?? 0 : 0
      let d: Any = h > 0 ? (Wins.describe(CGWindowID(h)) ?? NSNull()) : NSNull()
      if let dd = d as? [String: Any], let hh = dd["hwnd"] as? Int { seen.insert(hh) }
      IO.emit(["id": id, "describe": d])
    case "list":
      let list = Wins.appWindows()
      for w in list { if let h = w["hwnd"] as? Int { seen.insert(h) } }
      IO.emit(["id": id, "list": list])
    case "switch":
      let h = parts.count > 2 ? Int(parts[2]) ?? 0 : 0
      var r = h > 0 ? Wins.switchTo(CGWindowID(h)) : ["error": "no_window"]
      r["id"] = id
      IO.emit(r)
      report()
    case "watch":
      let arg = parts.count > 2 ? parts[2] : "-"
      let ids = arg == "-" ? [] : arg.split(separator: ",").compactMap { Int($0) }
      setWatch(ids)
      IO.emit(["id": id, "watching": watching.count])
    default:
      if id > 0 { IO.emit(["id": id, "error": "bad_request"]) }
    }
  }
}
