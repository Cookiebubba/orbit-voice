// "Stick to Claude Code" helper for macOS: the same protocol as electron/claude-window.ps1, minus
// moving the orb itself (on macOS Orbit moves its own window when this reports a change).
//
// Reports one JSON line per change:
//   {"wins":[{"hwnd":id,"min":false,"x":0,"y":0,"w":1200,"h":800},...],"fg":id,"front":"claude"|"orbit"|"other"}
//   wins: Claude's windows, highest first. fg: the Claude window in front (0 if none). Points.
//   {"box":{"hwnd":id,"rect":{"x","y","w","h"}|null,"win":{"x","y","w","h"}}}
//   where the prompt box of the watched window is (only where; never what's in it).
// Commands (stdin): "follow ..." and "pause" (accepted, nothing to do here), "box <id>" (watch that
// window's prompt box; 0 stops), "burst" (Orbit is about to type into the box: look often for 2.5 s).
//
// Claude is found by bundle id (com.anthropic.claudefordesktop); --pid <n> (Orbit's own tests: a
// stand-in window) watches that process instead.

import AppKit
import ApplicationServices

let claudeBundleId = "com.anthropic.claudefordesktop"

/** Claude's running app (or the stand-in process the tests name). */
func claudePids(onlyPid: pid_t) -> [pid_t] {
  if onlyPid > 0 { return kill(onlyPid, 0) == 0 ? [onlyPid] : [] }
  return NSRunningApplication.runningApplications(withBundleIdentifier: claudeBundleId).map { $0.processIdentifier }
}

/** Claude's real windows (standard windows of a useful size), highest first, with the AX element. */
func claudeWindows(onlyPid: pid_t) -> [(id: CGWindowID, el: AXUIElement, min: Bool, rect: CGRect, pid: pid_t)] {
  let pids = claudePids(onlyPid: onlyPid)
  if pids.isEmpty { return [] }
  let order = Wins.cg() // front to back (minimized windows come after the on-screen ones)
  var out: [(id: CGWindowID, el: AXUIElement, min: Bool, rect: CGRect, pid: pid_t)] = []
  for pid in pids {
    for (el, id) in AX.windows(of: pid) where id != 0 {
      let v = AX.many(el, [kAXSubroleAttribute, kAXMinimizedAttribute, kAXPositionAttribute, kAXSizeAttribute])
      let sub = (v[0] as? String) ?? ""
      if sub != "AXStandardWindow" && sub != "" { continue }
      guard let p = AX.point(v[2]), let s = AX.size(v[3]), s.width >= 200, s.height >= 150 else { continue }
      out.append((id, el, (v[1] as? NSNumber)?.boolValue ?? false, CGRect(origin: p, size: s), pid))
    }
  }
  let rank = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($0.element.id, $0.offset) })
  out.sort { a, b in
    if a.min != b.min { return !a.min }
    return (rank[a.id] ?? Int.max) < (rank[b.id] ?? Int.max)
  }
  return out
}

final class ClaudeWindowMode {
  private let onlyPid: pid_t
  private var observers: [pid_t: AppObserver] = [:]
  private var lastReport = ""
  private var boxWin: CGWindowID = 0
  private var boxEl: AXUIElement?
  private var boxLastFind = DispatchTime(uptimeNanoseconds: 0)
  private var lastBox = ""
  private var burstUntil = DispatchTime(uptimeNanoseconds: 0)
  private var fastUntil = DispatchTime(uptimeNanoseconds: 0)
  private var lastBoxPoll = DispatchTime(uptimeNanoseconds: 0)
  private var claudeFront = false
  private var timers: [DispatchSourceTimer] = []

  init(onlyPid: pid_t) { self.onlyPid = onlyPid }

  func run() {
    let nc = NSWorkspace.shared.notificationCenter
    for n in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification] {
      nc.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in
        self?.attach()
        self?.report()
      }
    }
    attach()
    report(force: true)
    // Safety net (a missed event), and the cadence for the prompt box.
    timers.append(every(1.0) { [weak self] in
      self?.attach()
      self?.report()
    })
    timers.append(every(0.03) { [weak self] in self?.tick() })
    IO.readLines { [weak self] line in self?.command(line) }
  }

  /** Listen to every Claude process's windows moving, resizing, minimizing, opening and closing. */
  private func attach() {
    let pids = Set(claudePids(onlyPid: onlyPid))
    for pid in observers.keys where !pids.contains(pid) { observers.removeValue(forKey: pid) }
    for pid in pids where observers[pid] == nil {
      guard let o = AppObserver(pid: pid, onEvent: { [weak self] _, _ in
        self?.report()
        self?.fastUntil = .now() + .milliseconds(500)
      }) else { continue }
      o.add([kAXWindowMovedNotification, kAXWindowResizedNotification, kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification, kAXWindowCreatedNotification, kAXUIElementDestroyedNotification, kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXApplicationActivatedNotification, kAXApplicationDeactivatedNotification])
      observers[pid] = o
      AX.enableWebTree(pid) // its page's tree, for the prompt box
    }
  }

  private func report(force: Bool = false) {
    let wins = claudeWindows(onlyPid: onlyPid)
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    let claudePidsNow = Set(wins.map { $0.pid })
    let front: String = claudePidsNow.contains(frontPid) ? "claude" : (frontPid == Wins.orbitPid ? "orbit" : "other")
    claudeFront = front == "claude"
    var fg: CGWindowID = 0
    if front == "claude" {
      let a = AX.app(frontPid)
      if let w = AX.attr(a, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
        let id = AX.windowID(w as! AXUIElement)
        if wins.contains(where: { $0.id == id }) { fg = id }
      }
    }
    // A window on another Space (or a hidden app) isn't on screen: report it as minimized (the orb hides).
    let onscreen = Set(Wins.cg(onscreenOnly: true).map { $0.id })
    let list: [[String: Any]] = wins.map { w in
      ["hwnd": Int(w.id), "min": w.min || !onscreen.contains(w.id), "x": Int(w.rect.minX.rounded()), "y": Int(w.rect.minY.rounded()), "w": Int(w.rect.width.rounded()), "h": Int(w.rect.height.rounded())]
    }
    let obj: [String: Any] = ["wins": list, "fg": Int(fg), "front": front]
    let key = "\(list)|\(fg)|\(front)"
    if !force && key == lastReport { return }
    lastReport = key
    IO.emit(obj)
  }

  // ---- the prompt box ----

  private func tick() {
    let now = DispatchTime.now()
    // While a Claude window moves (a drag sends few events), look at it often.
    if now < fastUntil { report() }
    guard boxWin != 0 else { return }
    let gap: UInt64 = now < burstUntil || now < fastUntil ? 30 : (claudeFront ? 150 : 1500)
    if now.uptimeNanoseconds - lastBoxPoll.uptimeNanoseconds < gap * 1_000_000 { return }
    lastBoxPoll = now
    pollBox()
  }

  private func findBox() -> AXUIElement? {
    guard let w = claudeWindows(onlyPid: onlyPid).first(where: { $0.id == boxWin }) else { return nil }
    // Claude's own page: the largest web area; its prompt box is the text area named "Prompt".
    var found: [AXUIElement] = []
    var count = 0
    func walk(_ e: AXUIElement, _ depth: Int) {
      count += 1
      if count > 6000 || depth > 60 || found.count > 4 { return }
      let v = AX.many(e, [kAXRoleAttribute, kAXDescriptionAttribute, kAXTitleAttribute, kAXChildrenAttribute])
      let role = (v[0] as? String) ?? ""
      if role == "AXTextArea" || role == "AXTextField", ((v[1] as? String) ?? (v[2] as? String)) == "Prompt" {
        found.append(e)
        return
      }
      // The conversation itself never holds the prompt box: skip its (large) subtree.
      if role == "AXGroup", (v[1] as? String) == "Chat messages" { return }
      for c in (v[3] as? [AXUIElement]) ?? [] { walk(c, depth + 1) }
    }
    walk(w.el, 0)
    return found.first(where: { AX.bool($0, kAXFocusedAttribute) == true }) ?? found.first
  }

  private func pollBox() {
    guard let w = claudeWindows(onlyPid: onlyPid).first(where: { $0.id == boxWin }) else { emitBox(nil, nil); return }
    if w.min { return }
    var rect: CGRect? = nil
    if let el = boxEl, let f = AX.frame(el), f.width > 0, AX.str(el, kAXRoleAttribute) != "" {
      rect = f
    } else if DispatchTime.now().uptimeNanoseconds - boxLastFind.uptimeNanoseconds > 1_000_000_000 {
      boxLastFind = .now()
      boxEl = findBox()
      if let el = boxEl { rect = AX.frame(el) }
    }
    emitBox(rect, w.rect)
  }

  private func emitBox(_ rect: CGRect?, _ win: CGRect?) {
    let r: Any = rect.map { ["x": Int($0.minX.rounded()), "y": Int($0.minY.rounded()), "w": Int($0.width.rounded()), "h": Int($0.height.rounded())] } ?? NSNull()
    let wv: Any = win.map { ["x": Int($0.minX.rounded()), "y": Int($0.minY.rounded()), "w": Int($0.width.rounded()), "h": Int($0.height.rounded())] } ?? NSNull()
    let key = "\(boxWin)|\(r)|\(wv)"
    if key == lastBox { return }
    lastBox = key
    IO.emit(["box": ["hwnd": Int(boxWin), "rect": r, "win": wv]])
  }

  private func command(_ line: String) {
    let parts = line.split(separator: " ").map(String.init)
    switch parts.first ?? "" {
    case "box":
      let id = CGWindowID(parts.count > 1 ? UInt32(parts[1]) ?? 0 : 0)
      if id != boxWin {
        boxWin = id
        boxEl = nil
        boxLastFind = DispatchTime(uptimeNanoseconds: 0)
        lastBox = ""
        if id != 0 { pollBox() }
      }
    case "burst":
      burstUntil = .now() + .milliseconds(2500)
    case "quit":
      exit(0)
    default:
      break // follow / pause: Orbit moves its own orb on macOS
    }
  }
}
