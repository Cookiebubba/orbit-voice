// "Orbit anywhere" accessibility helper for macOS: the same JSON protocol as src/platform/win/uia.ps1
// (scan, read, selection, act, hit), plus a few requests the Claude desktop driver uses (windows,
// peek, raise). Long-lived; one JSON request per line on stdin, one JSON answer per line on stdout,
// tagged with the request's id. Nothing here moves the mouse or brings a window forward, except
// "raise" and act's "borrow" method (both only on the user's request; see hands.js).
//
// {"op":"scan","hwnd":id,"maxNodes":2000,"values":false,"skip":["Chat messages"]}
//   -> {"ok":true,"fw":"Chrome|Cocoa","nodes":[<node>,...],"truncated":false,"ms":..}
//   <node>: see AX.node (uia.ps1's fields with UI Automation's type names, plus the Mac's role/sr/tog/sel/exp).
//   skip: names of groups whose contents aren't wanted (the group itself is listed).
// {"op":"read","hwnd":id,"maxChars":6000} -> {"ok":true,"title":"..","lines":[..],"truncated":false,"focused":{"t","n"}|null}
// {"op":"selection","hwnd":id} -> {"ok":true,"kind":"text","text":"..","from":{"t","n"}} | {"kind":"items","items":[..]} | {"kind":"none"}
// {"op":"act","hwnd":id,"i":n,"rid":"..","t":"Button","action":"set_text|type|press|toggle|select|expand|collapse|focus|show","value":"..","method":"value|borrow"}
//   -> {"ok":true,"via":"ax-value|ax-insert|ax-press|..","verified":bool,"stoleFocus":bool,"registered":true|false|null}
// {"op":"hit","hwnd":id,"points":[[x,y],...]} -> {"ok":true,"hits":[{"on":bool,"pid":p},...]}
// {"op":"windows","bundle":"com.x"|"pid":p} -> {"ok":true,"windows":[{"hwnd","title","min","x","y","w","h","focused"},...]} (front first)
// {"op":"peek","hwnd":id,"i":n} -> {"ok":true,"node":<node>|null} (one node of the last scan, read again now)
// {"op":"raise","hwnd":id} -> {"ok":true,"switched":bool,"how":".."}
// {"op":"front"} -> {"ok":true,"win":<win>}
// Errors: {"id":n,"ok":false,"error":"no_window|stale|disabled|password|not_supported|access_denied|bad_request|failed","message":".."}

import AppKit
import ApplicationServices

final class AxServer {
  private var lastScan: [Int: [AXUIElement]] = [:]
  private var lastScanRaw: [Int: [AX.Raw]] = [:]

  func run() {
    IO.readLines { [weak self] line in
      guard let self = self else { return }
      guard let req = IO.parseJSON(line) else { return }
      let id = req["id"] ?? NSNull()
      var res: [String: Any]
      if !AX.trusted && req.str("op") != "ping" {
        res = Self.fail("access_denied", "Orbit needs Accessibility permission (System Settings > Privacy & Security > Accessibility).")
      } else {
        res = self.handle(req)
      }
      res["id"] = id
      IO.emit(res)
    }
  }

  static func fail(_ code: String, _ message: String) -> [String: Any] { ["ok": false, "error": code, "message": message] }
  static func ok(_ extra: [String: Any] = [:]) -> [String: Any] { var d: [String: Any] = ["ok": true]; for (k, v) in extra { d[k] = v }; return d }

  private func handle(_ req: [String: Any]) -> [String: Any] {
    switch req.str("op") {
    case "ping": return Self.ok(["ax": AX.trusted])
    case "scan": return scan(req)
    case "read": return read(req)
    case "selection": return selection(req)
    case "act": return act(req)
    case "hit": return hit(req)
    case "windows": return windows(req)
    case "peek": return peek(req)
    case "raise":
      let r = Wins.switchTo(CGWindowID(req.int("hwnd")))
      if let e = r["error"] as? String { return Self.fail(e, "That window is gone.") }
      return Self.ok(r)
    case "front": return Self.ok(["win": Wins.front()])
    default: return Self.fail("bad_request", "unknown op")
    }
  }

  // ---- finding the window ----

  private func window(_ req: [String: Any]) -> (el: AXUIElement, pid: pid_t, frame: CGRect)? {
    let h = req.int("hwnd")
    guard h > 0, let c = Wins.cg().first(where: { Int($0.id) == h }) else { return nil }
    guard let el = AX.window(c.id, pid: c.pid) else { return nil }
    return (el, c.pid, AX.frame(el) ?? c.bounds)
  }

  private static let chromiumMarks = ["Electron Framework.framework", "Chromium Embedded Framework.framework", "Google Chrome Framework.framework", "Microsoft Edge Framework.framework", "Brave Browser Framework.framework", "Chromium Framework.framework"]
  private var chromiumCache: [pid_t: Bool] = [:]
  private func isChromium(_ pid: pid_t) -> Bool {
    if let c = chromiumCache[pid] { return c }
    var yes = false
    if let url = NSRunningApplication(processIdentifier: pid)?.bundleURL {
      let fw = url.appendingPathComponent("Contents/Frameworks")
      yes = Self.chromiumMarks.contains { FileManager.default.fileExists(atPath: fw.appendingPathComponent($0).path) }
    }
    chromiumCache[pid] = yes
    return yes
  }

  /** Chromium's page tree for this window, built on request: wait (up to about 3 s) until it shows. */
  private func waitForWebTree(_ el: AXUIElement) {
    func hasPage(_ e: AXUIElement, _ depth: Int) -> Bool {
      if depth > 12 { return false }
      let v = AX.many(e, [kAXRoleAttribute, kAXChildrenAttribute])
      let kids = (v[1] as? [AXUIElement]) ?? []
      if (v[0] as? String) == "AXWebArea" && !kids.isEmpty { return true }
      return kids.contains { hasPage($0, depth + 1) }
    }
    for _ in 0..<10 where !hasPage(el, 0) { Thread.sleep(forTimeInterval: 0.3) }
  }

  // ---- scan ----

  private func walk(_ root: AXUIElement, max: Int, values: Bool, frame: CGRect, skip: Set<String>, nodes: inout [[String: Any]], els: inout [AXUIElement], raws: inout [AX.Raw]) -> Bool {
    // Depth-first with an explicit stack (deep web pages), parents before children.
    var stack: [(AXUIElement, Int, Int)] = [(root, -1, 0)]
    var seen = Set<Int>()
    while let (e, parent, depth) = stack.popLast() {
      if nodes.count >= max { return true }
      let h = Int(bitPattern: UInt(CFHash(e)))
      if seen.contains(h), els.contains(where: { CFEqual($0, e) }) { continue } // (a cycle in a broken tree)
      seen.insert(h)
      let r = AX.raw(e)
      let me = nodes.count
      nodes.append(AX.node(e, r, index: me, parent: parent, values: values, window: frame))
      els.append(e)
      raws.append(r)
      if depth > 80 { continue }
      if !skip.isEmpty, skip.contains(AX.name(r)) { continue }
      for c in r.children.reversed() { stack.append((c, me, depth + 1)) }
    }
    return false
  }

  private func scan(_ req: [String: Any]) -> [String: Any] {
    let t0 = DispatchTime.now()
    guard let w = window(req) else { return Self.fail("no_window", "That window is gone.") }
    let max = Swift.max(1, Swift.min(30000, req.int("maxNodes", 2000)))
    let values = req.bool("values")
    let skip = Set((req["skip"] as? [String]) ?? [])
    let chromium = isChromium(w.pid)
    if chromium && AX.enableWebTree(w.pid) { Thread.sleep(forTimeInterval: 0.7) }
    var nodes: [[String: Any]] = [], els: [AXUIElement] = [], raws: [AX.Raw] = []
    var truncated = walk(w.el, max: max, values: values, frame: w.frame, skip: skip, nodes: &nodes, els: &els, raws: &raws)
    // Chromium builds its page's tree only once asked (and a new window's page a moment after it
    // loads): until a web area with content shows, look again, for up to about 3 seconds.
    var tries = 0
    while chromium && tries < 10 && !raws.contains(where: { $0.role == "AXWebArea" && !$0.children.isEmpty }) {
      tries += 1
      Thread.sleep(forTimeInterval: 0.3)
      nodes = []; els = []; raws = []
      truncated = walk(w.el, max: max, values: values, frame: w.frame, skip: skip, nodes: &nodes, els: &els, raws: &raws)
    }
    let h = req.int("hwnd")
    lastScan[h] = els
    lastScanRaw[h] = raws
    if lastScan.count > 24 {
      let alive = Set(Wins.cg().map { Int($0.id) })
      for k in lastScan.keys where !alive.contains(k) { lastScan.removeValue(forKey: k); lastScanRaw.removeValue(forKey: k) }
    }
    if var root = nodes.first { root["fw"] = chromium ? "Chrome" : "Cocoa"; nodes[0] = root }
    return Self.ok(["fw": chromium ? "Chrome" : "Cocoa", "nodes": nodes, "truncated": truncated, "ms": ms(since: t0)])
  }

  private func peek(_ req: [String: Any]) -> [String: Any] {
    let h = req.int("hwnd"), i = req.int("i", -1)
    guard let els = lastScan[h], i >= 0, i < els.count else { return Self.ok(["node": NSNull()]) }
    let e = els[i]
    let r = AX.raw(e)
    if r.role.isEmpty { return Self.ok(["node": NSNull()]) }
    let frame = window(req)?.frame
    let parent = -1
    return Self.ok(["node": AX.node(e, r, index: i, parent: parent, values: true, window: frame)])
  }

  // ---- read ----

  private static let contentTypes: Set<String> = ["Text", "ListItem", "TreeItem", "DataItem", "Hyperlink", "HeaderItem", "Document", "Edit", "TabItem", "Header", "MenuItem", "StatusBar", "TitleBar"]

  private func read(_ req: [String: Any]) -> [String: Any] {
    let t0 = DispatchTime.now()
    guard let w = window(req) else { return Self.fail("no_window", "That window is gone.") }
    let maxChars = Swift.max(200, Swift.min(40000, req.int("maxChars", 6000)))
    if isChromium(w.pid) {
      if AX.enableWebTree(w.pid) { Thread.sleep(forTimeInterval: 0.7) }
      waitForWebTree(w.el)
    }
    var lines: [String] = []
    var chars = 0, truncated = false, count = 0
    var last: String? = nil
    var stack: [(AXUIElement, Bool)] = [(w.el, false)]
    while let (e, under) = stack.popLast() {
      count += 1
      if count > 20000 { truncated = true; break }
      let r = AX.raw(e)
      let t = AX.controlType(role: r.role, subrole: r.subrole)
      // A button's own caption and the window's title-bar buttons are controls, not content.
      let skipUnder = under || ["Button", "CheckBox", "RadioButton", "SplitButton", "TitleBar"].contains(t)
      for c in r.children.reversed() { stack.append((c, skipUnder)) }
      if CFEqual(e, w.el) || under { continue }
      if AX.isPassword(r) { continue }
      if let f = r.rect, f.width <= 0 || f.height <= 0 || !f.intersects(w.frame) { continue } // scrolled away, collapsed
      guard Self.contentTypes.contains(t) else { continue }
      if r.role == "AXHeading" { continue } // its text is its child's
      let name = AX.name(r).trimmingCharacters(in: .whitespacesAndNewlines)
      var line: String
      if t == "Edit" {
        let v = AX.valueText(r) ?? ""
        if v.isEmpty && name.isEmpty { continue }
        line = (name.isEmpty ? "" : name + ": ") + v
      } else if t == "Document" {
        continue // a web page's text comes from its elements
      } else {
        if name.isEmpty { continue }
        line = name
      }
      line = line.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
      if line.isEmpty || line == last { continue }
      last = line
      if chars + line.count > maxChars {
        lines.append(String(line.prefix(Swift.max(0, maxChars - chars))))
        truncated = true
        break
      }
      lines.append(line)
      chars += line.count + 1
    }
    return Self.ok(["title": cut(AX.str(w.el, kAXTitleAttribute), 300), "lines": lines, "truncated": truncated, "focused": focusedInfo(w.pid), "ms": ms(since: t0)])
  }

  private func focusedElement(_ pid: pid_t) -> AXUIElement? {
    guard let f = AX.attr(AX.app(pid), kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() else { return nil }
    return (f as! AXUIElement)
  }

  /** The control with keyboard focus in that app: { t, n } (never its value). */
  private func focusedInfo(_ pid: pid_t) -> Any {
    guard let f = focusedElement(pid) else { return NSNull() }
    let r = AX.raw(f)
    var d: [String: Any] = ["t": AX.controlType(role: r.role, subrole: r.subrole)]
    let n = AX.name(r)
    if !n.isEmpty && r.role != "AXStaticText" { d["n"] = cut(n, 200) }
    if AX.isPassword(r) { d["pw"] = 1 }
    return d
  }

  // ---- selection ----

  private func selection(_ req: [String: Any]) -> [String: Any] {
    guard let w = window(req) else { return Self.fail("no_window", "That window is gone.") }
    let maxChars = Swift.max(100, Swift.min(40000, req.int("maxChars", 8000)))
    var candidates: [AXUIElement] = []
    if let f = focusedElement(w.pid) { candidates.append(f) }
    // Text-bearing elements in the window (web pages keep their selection on the web area).
    var stack: [AXUIElement] = [w.el]
    var n = 0
    while let e = stack.popLast(), n < 4000 {
      n += 1
      let v = AX.many(e, [kAXRoleAttribute, kAXChildrenAttribute])
      let role = (v[0] as? String) ?? ""
      if ["AXTextArea", "AXTextField", "AXWebArea", "AXStaticText"].contains(role) && role != "AXStaticText" { candidates.append(e) }
      if candidates.count > 40 { break }
      for c in ((v[1] as? [AXUIElement]) ?? []).reversed() { stack.append(c) }
    }
    for e in candidates {
      let r = AX.raw(e)
      if AX.isPassword(r) { continue }
      if let s = AX.attr(e, kAXSelectedTextAttribute) as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return Self.ok(["kind": "text", "text": cut(String(s.prefix(maxChars)).replacingOccurrences(of: "\r\n", with: "\n"), 40000), "from": ["t": AX.controlType(role: r.role, subrole: r.subrole), "n": cut(AX.name(r), 120)]])
      }
    }
    // Selected rows or list items (a file, a mailbox).
    var names: [String] = []
    stack = [w.el]
    n = 0
    while let e = stack.popLast(), n < 6000, names.count < 20 {
      n += 1
      let v = AX.many(e, [kAXRoleAttribute, kAXChildrenAttribute, kAXSelectedRowsAttribute, kAXSelectedChildrenAttribute])
      for s in ((v[2] as? [AXUIElement]) ?? []) + ((v[3] as? [AXUIElement]) ?? []) {
        let name = rowName(s)
        if !name.isEmpty && !names.contains(name) { names.append(cut(name, 200)) }
      }
      for c in ((v[1] as? [AXUIElement]) ?? []).reversed() { stack.append(c) }
    }
    if !names.isEmpty { return Self.ok(["kind": "items", "items": names]) }
    return Self.ok(["kind": "none"])
  }

  private func rowName(_ e: AXUIElement) -> String {
    let r = AX.raw(e)
    let own = AX.name(r)
    if !own.isEmpty { return own }
    // A table row's text is in its cells.
    var parts: [String] = []
    var stack = r.children
    var n = 0
    while let c = stack.popLast(), n < 40, parts.count < 4 {
      n += 1
      let cr = AX.raw(c)
      let nm = AX.name(cr).trimmingCharacters(in: .whitespacesAndNewlines)
      if !nm.isEmpty { parts.append(nm) } else { stack.append(contentsOf: cr.children.reversed()) }
    }
    return parts.joined(separator: " ")
  }

  // ---- act ----

  private static let sendLike = try! NSRegularExpression(pattern: "\\b(send|submit|post|reply|comment|save|search|go|ok|run|start|ask|chat|message|continue)\\b|^$", options: [.caseInsensitive])

  private func inWeb(_ e: AXUIElement) -> Bool {
    var p: AXUIElement? = e
    for _ in 0..<60 {
      guard let cur = p else { return false }
      if AX.str(cur, kAXRoleAttribute) == "AXWebArea" { return true }
      if let up = AX.attr(cur, kAXParentAttribute), CFGetTypeID(up) == AXUIElementGetTypeID() { p = (up as! AXUIElement) } else { return false }
    }
    return false
  }

  /** Send-like buttons beside a text box (its row, a little above or below), and whether each was on. */
  private func nearbyButtons(_ e: AXUIElement) -> [(AXUIElement, Bool)] {
    guard let box = AX.frame(e) else { return [] }
    var up = e
    for _ in 0..<4 {
      if let p = AX.attr(up, kAXParentAttribute), CFGetTypeID(p) == AXUIElementGetTypeID() { up = p as! AXUIElement } else { break }
    }
    var out: [(AXUIElement, Bool)] = []
    var stack = AX.children(up)
    var n = 0
    while let c = stack.popLast(), n < 800, out.count < 40 {
      n += 1
      let r = AX.raw(c)
      stack.append(contentsOf: r.children)
      guard AX.controlType(role: r.role, subrole: r.subrole) == "Button", let f = r.rect else { continue }
      let nm = AX.name(r)
      if Self.sendLike.firstMatch(in: nm, range: NSRange(nm.startIndex..., in: nm)) == nil { continue }
      let beside = f.maxY >= box.minY - 80 && f.minY <= box.maxY + 80 && f.maxX >= box.minX - 240 && f.minX <= box.maxX + 240
      if beside { out.append((c, r.enabled)) }
    }
    return out
  }

  private static func norm(_ s: String) -> String { s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n") }

  /** Did the app take the text? (See uia.ps1 Registered.) */
  private func registered(_ e: AXUIElement, _ watch: [(AXUIElement, Bool)], want: String?) -> Any {
    Thread.sleep(forTimeInterval: 0.35)
    let now = (AX.attr(e, kAXValueAttribute) as? String).map { Self.norm($0).trimmingCharacters(in: .whitespacesAndNewlines) }
    if let w = want, let n = now, n != Self.norm(w).trimmingCharacters(in: .whitespacesAndNewlines) { return false }
    var seen = 0, off = 0
    for (b, wasOn) in watch {
      guard let on = AX.bool(b, kAXEnabledAttribute) else { continue }
      if !wasOn && on { return true }
      seen += 1
      if !on { off += 1 }
    }
    if seen > 0 && off == seen, let n = now, !n.isEmpty { return false }
    return NSNull()
  }

  private func frontWindowId() -> Int { (Wins.front()["hwnd"] as? Int) ?? 0 }

  private func act(_ req: [String: Any]) -> [String: Any] {
    let h = req.int("hwnd"), i = req.int("i", -1)
    guard window(req) != nil else { return Self.fail("no_window", "That window is gone.") }
    guard let els = lastScan[h], i >= 0, i < els.count else { return Self.fail("stale", "That control isn't there any more.") }
    let e = els[i]
    if !req.str("rid").isEmpty && req.str("rid") != "\(CFHash(e))" { return Self.fail("stale", "That control changed.") }
    let r = AX.raw(e)
    if r.role.isEmpty { return Self.fail("stale", "That control isn't there any more.") }
    let type = AX.controlType(role: r.role, subrole: r.subrole)
    if !req.str("t").isEmpty && req.str("t") != type { return Self.fail("stale", "That control changed.") }
    if AX.isPassword(r) { return Self.fail("password", "Never a password field.") }
    if !r.enabled { return Self.fail("disabled", "That control is turned off.") }
    let action = req.str("action"), value = req.str("value")
    let fgBefore = frontWindowId()
    var via = "", verified = true
    var watch: [(AXUIElement, Bool)]? = nil
    var textBefore: String? = nil
    var insertErr = 0

    switch action {
    case "set_text", "type":
      guard AX.settable(e, kAXValueAttribute) || AX.settable(e, kAXSelectedTextAttribute) else { return Self.fail("not_supported", "That control doesn't take text.") }
      let before = AX.valueText(r) ?? ""
      textBefore = before
      let web = inWeb(e)
      watch = web ? nearbyButtons(e) : nil
      let rich = web && type == "Edit" && !r.children.isEmpty
      if req.str("method") == "borrow" { return borrow(e, pid: AX.pid(e), action: action, value: value, before: before, watch: watch ?? [], fgBefore: fgBefore) }
      let want = action == "type" ? before + value : value
      if req.str("method") == "value" {
        // The element's value set as a whole (what UI Automation's SetValue does on Windows; Claude's
        // own ProseMirror box reads the change from its page). The caller checks what landed.
        let err = AX.set(e, kAXValueAttribute, want as CFString)
        via = "ax-value"
        verified = err == .success && Self.norm(AX.str(e, kAXValueAttribute)).trimmingCharacters(in: .whitespacesAndNewlines) == Self.norm(want).trimmingCharacters(in: .whitespacesAndNewlines)
        if err != .success { var no = Self.fail("not_supported", "That box didn't take the text."); no["axError"] = Int(err.rawValue); return no }
      } else if rich || action == "type" {
        // Text through the editor's own input path (Chromium inserts it as typing would, with input
        // events: rich web editors take it), at the end (type) or over everything (set_text).
        let len = (before as NSString).length
        var range = action == "type" ? CFRange(location: len, length: 0) : CFRange(location: 0, length: len)
        if let rv = AXValueCreate(.cfRange, &range) { AX.set(e, kAXSelectedTextRangeAttribute, rv) }
        let err = AX.set(e, kAXSelectedTextAttribute, value as CFString)
        insertErr = Int(err.rawValue)
        via = "ax-insert"
        let now = Self.norm(AX.str(e, kAXValueAttribute))
        verified = err == .success && now.contains(Self.norm(value))
        if !verified && rich {
          var no = Self.fail("rich_box", "That box only takes real typing.")
          no["registered"] = false
          no["before"] = cut(before, 4000)
          no["axError"] = insertErr
          return no
        }
        if !verified && !rich {
          AX.set(e, kAXValueAttribute, want as CFString)
          via = "ax-value"
          verified = Self.norm(AX.str(e, kAXValueAttribute)) == Self.norm(want)
        }
      } else {
        AX.set(e, kAXValueAttribute, want as CFString)
        via = "ax-value"
        verified = Self.norm(AX.str(e, kAXValueAttribute)) == Self.norm(want)
      }
    case "press", "toggle":
      let acts = AX.actions(e)
      let before = (r.value as? NSNumber)?.intValue
      if acts.contains(kAXPressAction) { AX.perform(e, kAXPressAction); via = "ax-press" }
      else if acts.contains(kAXPickAction) { AX.perform(e, kAXPickAction); via = "ax-pick" }
      else if acts.contains(kAXConfirmAction) { AX.perform(e, kAXConfirmAction); via = "ax-confirm" }
      else { return Self.fail("not_supported", "That control can't be pressed.") }
      if action == "toggle", let b = before {
        Thread.sleep(forTimeInterval: 0.06)
        verified = (AX.attr(e, kAXValueAttribute) as? NSNumber)?.intValue != b
      }
    case "select":
      if AX.settable(e, kAXSelectedAttribute) {
        AX.set(e, kAXSelectedAttribute, kCFBooleanTrue)
        via = "ax-select"
      } else if AX.actions(e).contains(kAXPressAction) {
        AX.perform(e, kAXPressAction)
        via = "ax-press"
      } else { return Self.fail("not_supported", "That can't be picked.") }
      Thread.sleep(forTimeInterval: 0.06)
      let now = AX.raw(e)
      verified = now.selected == true || (now.role == "AXRadioButton" && (now.value as? NSNumber)?.intValue == 1) || now.selected == nil
    case "expand", "collapse":
      let expanded = r.expanded
      if action == "expand" && expanded == true || action == "collapse" && expanded == false { via = "ax-none"; break }
      if AX.settable(e, kAXExpandedAttribute) {
        AX.set(e, kAXExpandedAttribute, (action == "expand" ? kCFBooleanTrue : kCFBooleanFalse)!)
        via = "ax-expanded"
      } else if action == "collapse" && AX.actions(e).contains(kAXCancelAction) {
        AX.perform(e, kAXCancelAction)
        via = "ax-cancel"
      } else if AX.actions(e).contains(kAXShowMenuAction) && action == "expand" && r.role != "AXPopUpButton" {
        AX.perform(e, kAXShowMenuAction)
        via = "ax-showmenu"
      } else if AX.actions(e).contains(kAXPressAction) {
        AX.perform(e, kAXPressAction)
        via = "ax-press"
      } else { return Self.fail("not_supported", "That can't be opened or closed.") }
    case "focus":
      AX.set(e, kAXFocusedAttribute, kCFBooleanTrue)
      via = "ax-focus"
    case "show":
      AX.perform(e, "AXScrollToVisible")
      via = "ax-scroll"
    default:
      return Self.fail("bad_request", "unknown action")
    }
    Thread.sleep(forTimeInterval: 0.06)
    let fgAfter = frontWindowId()
    var res = Self.ok(["via": via, "verified": verified, "stoleFocus": fgAfter != fgBefore && fgAfter == h])
    if let w = watch { res["registered"] = registered(e, w, want: action == "type" ? nil : value) }
    if let b = textBefore { res["before"] = cut(b, 4000) }
    return res
  }

  /**
   * Typing as keystrokes with focus borrowed for a moment (only on the user's OK for this app): the
   * window comes forward, the box takes the focus, and the text goes in as Unicode key events posted
   * to that app only. The answer says which window was in front before ("fg"); the caller puts it back.
   */
  private func borrow(_ e: AXUIElement, pid: pid_t, action: String, value: String, before: String, watch: [(AXUIElement, Bool)], fgBefore: Int) -> [String: Any] {
    var res = Self.ok(["fg": fgBefore, "before": cut(before, 4000)])
    if let w = AX.attr(e, kAXWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
      let wid = AX.windowID(w as! AXUIElement)
      if wid != 0 { _ = Wins.switchTo(wid) }
    }
    AX.set(e, kAXFocusedAttribute, kCFBooleanTrue)
    var focused = false
    for _ in 0..<20 where !focused {
      Thread.sleep(forTimeInterval: 0.025)
      if let f = focusedElement(pid) { focused = CFEqual(f, e) }
    }
    let ours = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    if !focused || !ours {
      res["ok"] = false; res["error"] = "no_focus"; res["message"] = "The box didn't take the focus, so nothing was typed."
      return res
    }
    let len = (before as NSString).length
    var range = action == "type" ? CFRange(location: len, length: 0) : CFRange(location: 0, length: len)
    if let rv = AXValueCreate(.cfRange, &range) { AX.set(e, kAXSelectedTextRangeAttribute, rv) }
    Thread.sleep(forTimeInterval: 0.03)
    let src = CGEventSource(stateID: .privateState)
    let units = Array(value.replacingOccurrences(of: "\r\n", with: "\n").utf16)
    var at = 0
    while at < units.count {
      // Only while the box still has the focus: one chunk at a time, checked between chunks.
      if let f = focusedElement(pid), !CFEqual(f, e) {
        res["ok"] = false; res["error"] = "focus_lost"; res["message"] = "The focus moved away while typing, so Orbit stopped."
        return res
      }
      let end = Swift.min(units.count, at + 20)
      for u in units[at..<end] {
        if u == 0x0A {
          for down in [true, false] { CGEvent(keyboardEventSource: src, virtualKey: 0x24, keyDown: down)?.postToPid(pid) }
          continue
        }
        var ch = u
        for down in [true, false] {
          let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
          ev?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
          ev?.postToPid(pid)
        }
      }
      at = end
      Thread.sleep(forTimeInterval: 0.01)
    }
    let want = action == "type" ? before + value : value
    var ok = false
    for _ in 0..<50 where !ok {
      ok = Self.norm(AX.str(e, kAXValueAttribute)).trimmingCharacters(in: .whitespacesAndNewlines) == Self.norm(want).trimmingCharacters(in: .whitespacesAndNewlines)
      if !ok { Thread.sleep(forTimeInterval: 0.03) }
    }
    res["via"] = "borrow-keys"
    res["verified"] = ok
    res["stoleFocus"] = false
    res["registered"] = registered(e, watch, want: action == "type" ? nil : value)
    return res
  }

  // ---- hit ----

  private func hit(_ req: [String: Any]) -> [String: Any] {
    let h = req.int("hwnd")
    let list = Wins.cg(onscreenOnly: true)
    guard h > 0, list.contains(where: { Int($0.id) == h }) || Wins.cg().contains(where: { Int($0.id) == h }) else { return Self.fail("no_window", "That window is gone.") }
    var hits: [Any] = []
    for p in ((req["points"] as? [Any]) ?? []).prefix(16) {
      guard let xy = p as? [NSNumber], xy.count >= 2 else { hits.append(NSNull()); continue }
      let pt = CGPoint(x: xy[0].doubleValue, y: xy[1].doubleValue)
      // The topmost window there that anyone can see (Orbit's own click-through overlays included:
      // the caller leaves out its own pid).
      if let top = list.first(where: { $0.alpha > 0 && $0.bounds.contains(pt) && $0.layer < 1000 }) {
        hits.append(["on": Int(top.id) == h, "pid": Int(top.pid)])
      } else {
        hits.append(["on": false, "pid": 0])
      }
    }
    return Self.ok(["hits": hits])
  }

  // ---- windows of one app ----

  private func windows(_ req: [String: Any]) -> [String: Any] {
    var pids: [pid_t] = []
    if req.int("pid") > 0 { pids = [pid_t(req.int("pid"))] }
    else if !req.str("bundle").isEmpty { pids = NSRunningApplication.runningApplications(withBundleIdentifier: req.str("bundle")).map { $0.processIdentifier } }
    if pids.isEmpty { return Self.ok(["windows": [Any](), "running": false]) }
    let order = Wins.cg()
    let onscreen = Set(order.filter { $0.onscreen }.map { $0.id })
    let rank = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($0.element.id, $0.offset) })
    var out: [[String: Any]] = []
    for pid in pids {
      let a = AX.app(pid)
      let focusedId: CGWindowID = {
        if let w = AX.attr(a, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() { return AX.windowID(w as! AXUIElement) }
        return 0
      }()
      for (el, id) in AX.windows(of: pid) where id != 0 {
        let v = AX.many(el, [kAXTitleAttribute, kAXMinimizedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXSubroleAttribute])
        guard let p = AX.point(v[2]), let s = AX.size(v[3]) else { continue }
        let min = (v[1] as? NSNumber)?.boolValue ?? false
        out.append(["hwnd": Int(id), "pid": Int(pid), "title": (v[0] as? String) ?? "", "min": min, "onscreen": onscreen.contains(id), "sr": (v[4] as? String) ?? "",
                    "x": Int(p.x.rounded()), "y": Int(p.y.rounded()), "w": Int(s.width.rounded()), "h": Int(s.height.rounded()), "focused": id == focusedId, "z": rank[id] ?? 99999])
      }
    }
    out.sort { (a, b) in
      let am = a["min"] as! Bool, bm = b["min"] as! Bool
      if am != bm { return !am }
      return (a["z"] as! Int) < (b["z"] as! Int)
    }
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    return Self.ok(["windows": out, "running": true, "active": pids.contains(frontPid)])
  }
}
