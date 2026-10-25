// The Claude desktop app's window on macOS (src/platform/mac/desktop.js, the macOS port's, step for
// step): through the helper's "ax" mode (a snapshot of a window's tree, then one action on one
// element), reported with UI Automation's names, answering with desktop.ps1's JSON. It never moves the
// mouse, presses keys or touches the clipboard; the one change of focus is the one asked for.
//
// run(mode, args) takes desktop.js's arguments (["-TitleB64", "...", "-ExpectNew", "-FrontHwnd", "123"])
// and gives one result object. The oracle replays the JS driver's own requests and answers to this one
// (parity/oracle/desktop.mjs): the same requests in the same order, the same results.
import CryptoKit
import Foundation
import OrbitIntent
import OrbitKit

public final class ClaudeDesktop: @unchecked Sendable {
  public static let bundleID = "com.anthropic.claudefordesktop"
  public typealias Request = @Sendable (String, [String: JSONValue]) async -> JSONValue?
  public typealias Sleep = @Sendable (Int) async -> Void

  let request: Request
  let onlyPid: Int
  let sleep: Sleep
  let bundle: String

  public init(request: @escaping Request, onlyPid: Int = 0, sleep: @escaping Sleep = { ms in try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }, bundle: String = ClaudeDesktop.bundleID) {
    self.request = request
    self.onlyPid = onlyPid
    self.sleep = sleep
    self.bundle = bundle
  }

  // MARK: arguments

  static let switches: Set<String> = ["Rects", "ExpectNew", "DryRun", "Fill", "Filled", "Clear"]

  /** parseArgs(): desktop.ps1-style arguments as a dictionary (switches as "true"). */
  public static func parseArgs(_ args: [String]) -> [String: String] {
    var o: [String: String] = [:]
    var i = 0
    while i < args.count {
      let a = args[i]
      if a.hasPrefix("-") {
        let k = String(a.dropFirst())
        if switches.contains(k) {
          o[k] = "true"
        } else {
          o[k] = i + 1 < args.count ? args[i + 1] : ""
          i += 1
        }
      }
      i += 1
    }
    return o
  }

  static func decode(_ b64: String?) -> String {
    // Buffer.from(s, 'base64') is lenient: it ignores what isn't base64 and stops at padding.
    let clean = (b64 ?? "").filter { $0.isLetter && $0.isASCII || $0.isNumber && $0.isASCII || $0 == "+" || $0 == "/" || $0 == "-" || $0 == "_" }
      .replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    var s = clean
    if s.count % 4 == 1 { s.removeLast() }
    while s.count % 4 != 0 { s += "=" }
    guard let d = Data(base64Encoded: s) else { return "" }
    return String(decoding: d, as: UTF8.self)
  }

  // MARK: the tree

  /** One element of a scan (the helper's node, as it sent it). */
  struct Node {
    let i: Int
    let p: Int
    let raw: [String: JSONValue]
    var t: String { raw["t"]?.stringValue ?? "" }
    /** nameOf(): String(n ?? '') */
    var name: String { Self.string(raw["n"]) }
    var c: String { Self.string(raw["c"]) }
    var pat: String { Self.string(raw["pat"]) }
    var role: String? { raw["role"]?.stringValue }
    var sr: String? { raw["sr"]?.stringValue }
    var isButton: Bool { t == "Button" }
    var pressable: Bool { pat.contains("I") || pat.contains("T") || pat.contains("S") }
    var enabled: Bool { raw["en"]?.doubleValue != 0 }
    /** (tog: null counts too: the JS checks `tog !== undefined`.) */
    var isToggle: Bool { pat.contains("T") || raw["tog"] != nil }
    var pressed: Bool { Self.number(raw["tog"]) == 1 }
    var focused: Bool { JSValue.truthy(raw["foc"]?.any) }
    var selected: Bool { JSValue.truthy(raw["sel"]?.any) }
    var off: Bool { JSValue.truthy(raw["off"]?.any) }
    var readOnly: Bool { JSValue.truthy(raw["ro"]?.any) }
    var value: String { Self.string(raw["v"]) }
    var rect: JSONValue {
      guard case .array(let r)? = raw["r"], r.count >= 4, let w = r[2].doubleValue, let h = r[3].doubleValue, w > 0, h > 0 else { return .null }
      return ["x": r[0], "y": r[1], "w": r[2], "h": r[3]]
    }
    var area: Double {
      guard case .array(let r)? = raw["r"], r.count >= 4 else { return 0 }
      return max(0, r[2].doubleValue ?? 0) * max(0, r[3].doubleValue ?? 0)
    }
    func hasClass(_ cls: String) -> Bool { " \(c) ".contains(" \(cls) ") }

    /** String(v ?? ''), as JS converts what JSON holds. */
    static func string(_ v: JSONValue?) -> String {
      switch v {
      case nil, .null?: return ""
      case .string(let s)?: return s
      case .number(let n)?: return JSNumber.string(n)
      case .bool(let b)?: return b ? "true" : "false"
      case .array(let a)?: return a.map { string($0) }.joined(separator: ",")
      case .object?: return "[object Object]"
      }
    }
    /** Number(v). */
    static func number(_ v: JSONValue?) -> Double {
      switch v {
      case .number(let n)?: return n
      case .bool(let b)?: return b ? 1 : 0
      case .string(let s)?: return JSNumber.parse(s)
      case nil: return .nan
      case .null?: return 0
      default: return .nan
      }
    }
  }

  final class Tree {
    let nodes: [Node]
    var kids: [[Int]]
    var end: [Int]

    init(_ raw: [JSONValue]) {
      nodes = raw.enumerated().map { k, v in Node(i: v["i"]?.intValue ?? k, p: v["p"]?.intValue ?? -1, raw: v.objectValue ?? [:]) }
      kids = nodes.map { _ in [] }
      for n in nodes where n.p >= 0 && n.p < kids.count { kids[n.p].append(n.i) }
      end = nodes.map(\.i)
      for k in stride(from: nodes.count - 1, through: 0, by: -1) {
        let n = nodes[k]
        if n.p >= 0, n.p < end.count, end[n.p] < end[k] { end[n.p] = end[k] }
      }
    }
    var root: Node? { nodes.first }
    func parent(_ n: Node?) -> Node? { guard let n, n.p >= 0, n.p < nodes.count else { return nil }; return nodes[n.p] }
    func children(_ n: Node?) -> [Node] { guard let n, n.i < kids.count else { return [] }; return kids[n.i].map { nodes[$0] } }
    func descendants(_ n: Node?) -> [Node] {
      guard let n, n.i + 1 <= end[n.i] else { return [] }
      return Array(nodes[(n.i + 1)...min(end[n.i], nodes.count - 1)])
    }
    func within(_ n: Node?, _ a: Node?) -> Bool { guard let n, let a else { return false }; return n.i >= a.i && n.i <= end[a.i] }
    func ancestors(_ n: Node?, max: Int = 80) -> [Node] {
      var out: [Node] = []
      var p = parent(n)
      while let q = p, out.count < max {
        out.append(q)
        p = parent(q)
      }
      return out
    }
    func depth(_ n: Node) -> Int { ancestors(n).count }
  }

  // MARK: the names desktop.ps1 matches (kept identical)

  static let apos = "\u{2019}"
  static let stopNames = ["Stop", "Stop response", "Stop generating", "Stop Claude", "Interrupt"]
  static let allowOnce = ["Allow once", "Allow", "Yes", "Approve", "Accept", "Run", "Continue"]
  static let allowSession = ["Allow for this session", "Allow for this chat", "Allow for this task", "Yes, for this session", "Allow all for this website"]
  static let allowAlways = ["Always allow", "Allow always", "Always allow for this website", "Yes, and don't ask again", "Yes, and don\(apos)t ask again", "Allow for all scheduled runs"]
  static let deny = ["Deny", "Don't allow", "Don\(apos)t allow", "Reject", "Decline", "No", "Keep planning", "Stay in background"]
  static let strong = ["Allow once", "Allow", "Always allow", "Allow always", "Allow for this session", "Approve", "Deny", "Don't allow", "Don\(apos)t allow", "Reject"]
  static let questionActions = ["Submit", "Next", "Skip"]
  static let commandRegions = ["The command Claude wants to run", "Claude\(apos)s description and the command Claude wants to run", "Claude's description and the command Claude wants to run", "What Claude is asking to do"]
  static let permLike = JSRegExp(#"^(ask( before edits| permissions)?|accept edits|edit automatically|auto( mode|-accept edits)?|plan mode|bypass permissions|default)$"#, "i")
  static let panels: [(String, String)] = [("terminal", "Terminal"), ("changes", "Changes"), ("browser", "Browser"), ("files", "Files"), ("rail", "Hide session rail")]

  static let alwaysRE = JSRegExp("^Always allow", "i")
  static let acceptAndRE = JSRegExp("^Accept and ", "i")
  static let allowForRE = JSRegExp("^Allow for ", "i")
  static let denyRE = JSRegExp("^Deny", "i")
  static let noCommaRE = JSRegExp("^No, ", "i")

  /** answerKind(): how a button answers a permission card. */
  public static func answerKind(_ name: String) -> String? {
    let n = JS.trim(name)
    if n.isEmpty { return nil }
    if allowAlways.contains(n) || alwaysRE.test(n) || acceptAndRE.test(n) { return "allow_always" }
    if allowSession.contains(n) || allowForRE.test(n) { return "allow_session" }
    if allowOnce.contains(n) { return "allow_once" }
    if deny.contains(n) || denyRE.test(n) || noCommaRE.test(n) { return "deny" }
    return nil
  }

  static let normCR = JSRegExp("\r", "g")
  static let normSingle = JSRegExp("[\u{2018}\u{2019}\u{201A}\u{2032}]", "g")
  static let normDouble = JSRegExp("[\u{201C}\u{201D}\u{201E}\u{2033}]", "g")
  static let normSpaces = JSRegExp("[\u{A0}\u{2007}\u{202F}]", "g")
  static let normRuns = JSRegExp("[ \t]+", "g")
  static let normLines = JSRegExp(" ?\n ?", "g")

  /** normText(): the same text whatever the line endings, spacing or quote marks. */
  public static func normText(_ t: String) -> String {
    var s = normCR.replace(t, "")
    s = normSingle.replace(s, "'")
    s = normDouble.replace(s, "\"")
    s = normSpaces.replace(s, " ")
    s = normRuns.replace(s, " ")
    s = normLines.replace(s, "\n")
    return JS.trim(s)
  }
  static func same(_ a: String, _ b: String) -> Bool { normText(a) == normText(b) }

  static let spacesRE = JSRegExp(#"\s+"#, "g")
  static func clip(_ s: String, _ n: Int) -> String {
    let t = JS.trim(spacesRE.replace(s, " "))
    return JS.length(t) > n ? JS.slice(t, 0, n) + "..." : t
  }
  static func key16(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description }

  // MARK: windows and their pages

  enum PageState { case unknown, none, found(Page) }
  struct Page {
    let doc: Node
    let kind: String
  }

  final class Win {
    let hwnd: JSONValue
    let name: String
    let min: Bool
    let z: Int
    var tree: Tree?
    var full = false
    var page: PageState = .unknown
    var title: String?
    var kind: String?
    var sidebar = false
    init(hwnd: JSONValue, name: String, min: Bool, z: Int) { self.hwnd = hwnd; self.name = name; self.min = min; self.z = z }
    var doc: Node? { if case .found(let p) = page { return p.doc }; return nil }
    var pageKind: String? { if case .found(let p) = page { return p.kind }; return nil }
  }

  func claudeWindows() async -> (error: JSONValue?, running: Bool, wins: [Win]) {
    let r = await request("windows", onlyPid != 0 ? ["pid": .number(Double(onlyPid))] : ["bundle": .string(bundle)])
    guard let r, JSValue.truthy(r["ok"]?.any) else { return (r ?? .null, false, []) }
    var wins: [Win] = []
    for w in r["windows"]?.arrayValue ?? [] {
      let sr = w["sr"]
      let srOk = sr?.stringValue == "AXStandardWindow" || !JSValue.truthy(sr?.any)
      guard srOk, Node.number(w["w"]) >= 200, Node.number(w["h"]) >= 150, JSValue.truthy(w["title"]?.any) else { continue }
      let min = JSValue.truthy(w["min"]?.any) || w["onscreen"] == .bool(false)
      wins.append(Win(hwnd: w["hwnd"] ?? .null, name: Node.string(w["title"]), min: min, z: wins.count))
    }
    return (nil, JSValue.truthy(r["running"]?.any), wins)
  }

  func scan(_ w: Win, full: Bool = false) async -> Bool {
    var args: [String: JSONValue] = ["hwnd": w.hwnd, "values": true, "maxNodes": 20000]
    if !full { args["skip"] = ["Chat messages"] }
    let r = await request("scan", args)
    guard let r, JSValue.truthy(r["ok"]?.any) else {
      w.tree = nil
      return false
    }
    w.tree = Tree(r["nodes"]?.arrayValue ?? [])
    w.full = full
    return true
  }

  static let codeTitle = JSRegExp(" - Claude Code$")

  /** Claude's own page in a window (desktop.ps1 Find-AppDocument). */
  func findAppDocument(_ w: Win) -> Page? {
    guard let T = w.tree else { return nil }
    let docs = T.nodes.filter { $0.t == "Document" }
    var best: Node?
    var bestScore = -1.0
    var pop: [Node] = []
    for d in docs {
      let named = d.name == "Claude" || Self.codeTitle.test(d.name)
      let hasSidebar = T.descendants(d).contains { $0.t == "Group" && $0.name == "Sidebar" }
      if hasSidebar || named {
        let score = (hasSidebar ? 1e12 : 0) + d.area
        if score > bestScore {
          best = d
          bestScore = score
        }
      } else if !w.name.isEmpty && w.name != "Claude" && d.name == w.name {
        pop.append(d)
      }
    }
    if let best { return Page(doc: best, kind: "main") }
    if pop.isEmpty { return nil }
    let depths = pop.map { T.depth($0) }
    let top = depths.min()!
    let at = pop.enumerated().filter { depths[$0.offset] == top }.map(\.element)
    if at.count != 1 { return nil }
    let doc = at[0]
    let inside = { (b: Node) in self.ownDoc(T, b)?.i == doc.i }
    let header = T.descendants(doc).contains { $0.isButton && $0.name == "\(w.name), rename session" && inside($0) }
    let back = T.descendants(doc).contains { $0.isButton && $0.name == "Open in main window" && inside($0) }
    if !header || !back { return nil }
    return Page(doc: doc, kind: "popout")
  }

  func ownDoc(_ T: Tree, _ n: Node?) -> Node? {
    if n?.t == "Document" { return n }
    return T.ancestors(n).first { $0.t == "Document" }
  }

  /** desktop.ps1 Use-Window: page found, title read. false if no page. */
  func useWindow(_ w: Win, full: Bool = false, rescan: Bool = false) async -> Bool {
    if w.tree == nil || rescan || (full && !w.full) {
      if !(await scan(w, full: full)) { return false }
      w.page = .unknown
    }
    if case .unknown = w.page { w.page = findAppDocument(w).map { .found($0) } ?? .none }
    guard case .found(let page) = w.page else { return false }
    w.title = sessionTitle(w)
    w.kind = page.kind
    w.sidebar = page.kind == "main" && w.tree!.descendants(page.doc).contains { $0.t == "Group" && $0.name == "Sidebar" }
    return true
  }

  func sessionTitle(_ w: Win) -> String? {
    let n = w.doc?.name ?? ""
    let suffix = " - Claude Code"
    if n.hasSuffix(suffix) && JS.length(n) > JS.length(suffix) { return JS.slice(n, 0, -JS.length(suffix)) }
    if w.pageKind == "popout" && !n.isEmpty && n != "Claude" { return n }
    return nil
  }

  func inApp(_ w: Win, _ n: Node?) -> Bool {
    guard let doc = w.doc, let T = w.tree else { return false }
    return ownDoc(T, n)?.i == doc.i
  }
  func appNodes(_ w: Win) -> [Node] { w.doc.map { w.tree!.descendants($0) } ?? [] }

  func usableWindows() async -> (error: JSONValue?, all: [Win], wins: [Win], running: Bool) {
    let cw = await claudeWindows()
    if let e = cw.error { return (e, [], [], false) }
    var usable: [Win] = []
    for w in cw.wins where await useWindow(w) { usable.append(w) }
    return (nil, cw.wins, usable, cw.running)
  }

  func selectFront(_ wins: [Win], _ frontHint: String?) -> Win? {
    let n = Node.number(frontHint.map { .string($0) })
    let hint = n.isNaN || n == 0 ? 0 : n
    if hint != 0, let w = wins.first(where: { $0.hwnd.doubleValue == hint && !$0.min }) { return w }
    return wins.first { !$0.min } ?? wins.first
  }

  func windowList(_ wins: [Win], _ front: Win) -> JSONValue {
    .array(wins.prefix(12).map { w in
      ["id": w.hwnd, "title": w.title.map { .string($0) } ?? .null, "kind": w.kind.map { .string($0) } ?? .null, "front": .bool(w === front), "minimized": .bool(w.min)]
    })
  }

  func showWindow(_ w: Win) async -> Bool {
    let r = await request("raise", ["hwnd": w.hwnd])
    return JSValue.truthy(r?["ok"]?.any) && JSValue.truthy(r?["switched"]?.any)
  }

  // MARK: the page's parts

  func promptBox(_ w: Win) -> Node? {
    let boxes = appNodes(w).filter { $0.t == "Edit" && $0.name == "Prompt" }
    return boxes.first { $0.focused } ?? boxes.first
  }

  static let trailingSpace = JSRegExp(#"\s+$"#)
  func boxText(_ box: Node?) -> String {
    let v = Self.trailingSpace.replace(box?.value ?? "", "")
    if JS.trim(v) == "/" { return "" }
    return v
  }

  /** Claude's Send (or Stop) button on the prompt box's row (desktop.ps1 Get-SendButton). */
  func sendButton(_ w: Win, _ box: Node, anyState: Bool = false, names: [String] = ["Send"]) -> Node? {
    guard case .object(let b0) = box.rect, let bx = b0["x"]?.doubleValue, let by = b0["y"]?.doubleValue, let bw = b0["w"]?.doubleValue, let bh = b0["h"]?.doubleValue else { return nil }
    let right = bx + bw
    let bottom = by + bh
    var best: Node?
    var bestDist = Double.infinity
    for b in appNodes(w) {
      guard b.isButton, names.contains(b.name), anyState || b.enabled else { continue }
      guard case .object(let r) = b.rect, let rx = r["x"]?.doubleValue, let ry = r["y"]?.doubleValue, let rh = r["h"]?.doubleValue else { continue }
      let cy = ry + rh / 2
      if cy < by - 40 || cy > bottom + 80 { continue }
      let dx = abs(rx - right)
      if rx < bx || dx > 200 { continue }
      let d = abs(cy - bottom) + dx
      if d < bestDist {
        best = b
        bestDist = d
      }
    }
    return best
  }

  func inSidebarTree(_ w: Win, _ n: Node) -> Bool { w.tree!.ancestors(n).contains { $0.t == "Group" && $0.name == "Sidebar" } }

  /** A session row's own button: named after a session with a "More options for <title>" button. */
  func inSessionRow(_ w: Win, _ n: Node) -> Bool {
    let name = n.name
    if name.isEmpty { return false }
    let prefix = "More options for "
    for b in appNodes(w) {
      let m = b.name
      guard b.isButton, m.hasPrefix(prefix) else { continue }
      let t = String(m.dropFirst(prefix.count))
      if !t.isEmpty && (name == t || name.hasPrefix("\(t) ")) { return true }
    }
    return false
  }
  func sidebarButton(_ w: Win, _ b: Node) -> Bool { inApp(w, b) && inSidebarTree(w, b) && !inSessionRow(w, b) && !b.name.hasPrefix("More options for ") }

  struct SessionRow {
    let title: String
    let button: Node
    let label: String
  }

  func sidebarSessions(_ w: Win) -> [SessionRow] {
    var out: [SessionRow] = []
    var seen = Set<String>()
    let prefix = "More options for "
    for b in appNodes(w) {
      let n = b.name
      guard b.isButton, n.hasPrefix(prefix), inSidebarTree(w, b) else { continue }
      let t = String(n.dropFirst(prefix.count))
      if t.isEmpty || seen.contains(t) { continue }
      var match: Node?
      for up in w.tree!.ancestors(b, max: 3) {
        for s in w.tree!.children(up) {
          let sn = s.name
          if s.isButton && !sn.isEmpty && (sn == t || sn.hasPrefix("\(t) ")) && !sn.hasPrefix("More options") && s.pressable {
            match = s
            break
          }
        }
        if match != nil { break }
      }
      if let match {
        seen.insert(t)
        out.append(SessionRow(title: t, button: match, label: match.name))
      }
    }
    return out
  }

  func sidebarButtonNamed(_ w: Win, _ name: String) -> Node? {
    appNodes(w).first { $0.isButton && $0.name == name && $0.enabled && sidebarButton(w, $0) && $0.pressable }
  }

  struct FolderButton {
    let folder: String
    let group: String
    let button: Node
  }

  func newInFolderButtons(_ w: Win) -> [FolderButton] {
    var out: [FolderButton] = []
    let prefix = "New session in "
    for b in appNodes(w) {
      let n = b.name
      guard b.isButton, n.hasPrefix(prefix) else { continue }
      let rest = String(n.dropFirst(prefix.count))
      let sep = ", added to "
      let r = rest.range(of: sep, options: .backwards)
      let folder = r.map { String(rest[..<$0.lowerBound]) } ?? rest
      let group = r.map { String(rest[$0.upperBound...]) } ?? ""
      if !folder.isEmpty && sidebarButton(w, b) && b.pressable { out.append(FolderButton(folder: folder, group: group, button: b)) }
    }
    return out
  }

  /** A new session that hasn't started yet: (folder) or nil (desktop.ps1 Get-NewSessionPage). */
  func newSessionPage(_ w: Win, _ title: String?) -> (folder: String?, found: Bool) {
    let none: (String?, Bool) = (nil, false)
    if title != nil { return none }
    if w.doc?.name != "Claude" { return none }
    if promptBox(w) == nil { return none }
    var heading: Node?
    for t in appNodes(w) {
      if t.t != "Text" || t.role == "AXHeading" || t.name != "New session" || t.off { continue }
      let inside = w.tree!.ancestors(t, max: 40).contains { $0.t != "Document" && ["Sidebar", "Chat messages"].contains($0.name) }
      if !inside {
        heading = t
        break
      }
    }
    if heading == nil { return none }
    let prefix = "Folder: "
    for b in appNodes(w) {
      let n = b.name
      if b.isButton && n.hasPrefix(prefix) && JS.length(n) > JS.length(prefix) { return (JS.trim(String(n.dropFirst(prefix.count))), true) }
    }
    return (nil, true)
  }

  // MARK: cards

  /** Text inside an element, in order, leaving out button labels (desktop.ps1 Get-Texts). */
  func texts(_ w: Win, _ el: Node, _ max: Int = 12) -> [String] {
    let sub = w.tree!.descendants(el)
    let skip = Set(sub.filter(\.isButton).map(\.name))
    var out: [String] = []
    for t in sub {
      if t.t != "Text" || t.role == "AXHeading" { continue }
      let n = Self.clip(t.name, 400)
      if !n.isEmpty && !skip.contains(n) { out.append(n) }
      if out.count >= max { break }
    }
    return out
  }
  func buttonsIn(_ w: Win, _ el: Node) -> [Node] { w.tree!.descendants(el).filter(\.isButton) }
  func answerButtons(_ w: Win, _ el: Node) -> [Node] { buttonsIn(w, el).filter { Self.answerKind($0.name) != nil } }
  func beforeDoc(_ w: Win, _ n: Node) -> [Node] {
    var out: [Node] = []
    for a in w.tree!.ancestors(n, max: 60) {
      if a.t == "Document" { break }
      out.append(a)
    }
    return out
  }
  func containers(_ w: Win, _ n: Node, _ max: Int) -> [Node] { Array(beforeDoc(w, n).prefix(max)) }

  func findCards(_ w: Win) -> [Node] {
    var cards: [Node] = []
    for b in appNodes(w) {
      guard b.isButton else { continue }
      let name = b.name
      let mine = Self.answerKind(name)
      if !(mine != nil || Self.questionActions.contains(name) || b.hasClass("epitaxy-answer-option")) { continue }
      var card = beforeDoc(w, b).prefix(30).first { $0.hasClass("epitaxy-approval-card") }
      if card == nil && Self.strong.contains(name) {
        // By structure: the nearest container holding this button and one that answers the other way.
        for p in containers(w, b, 4) {
          let other = buttonsIn(w, p).contains { o in Self.strong.contains(o.name) && (Self.answerKind(o.name) == "deny") != (mine == "deny") }
          if other {
            card = p
            break
          }
        }
        // That is the row of buttons; the card is the nearest container above it with text of its own.
        if let c = card, texts(w, c, 1).isEmpty {
          let count = answerButtons(w, c).count
          for up in containers(w, c, 3) {
            if answerButtons(w, up).count != count { break }
            if !texts(w, up, 1).isEmpty {
              card = up
              break
            }
          }
        }
      }
      if card == nil && Self.questionActions.contains(name) {
        for p in containers(w, b, 5) {
          let toggles = buttonsIn(w, p).filter { $0.name != "Other" && $0.isToggle }
          if toggles.count >= 2 {
            card = p
            break
          }
        }
      }
      guard let c = card, !sidebarButton(w, b), inApp(w, c) else { continue }
      if !cards.contains(where: { $0.i == c.i }) { cards.append(c) }
    }
    return cards.sorted { $0.i < $1.i }
  }

  static let pageCount = JSRegExp(#"^\d+ of \d+$"#)

  func readCard(_ w: Win, _ card: Node) -> JSONValue {
    let buttons = buttonsIn(w, card)
    var isQ = card.hasClass("epitaxy-question-card")
    var opts = buttons.filter { $0.hasClass("epitaxy-answer-option") }
    if opts.isEmpty {
      let names = buttons.map(\.name)
      let toggles = buttons.filter { $0.name != "Other" && $0.isToggle }
      if toggles.count >= 2 && (names.contains("Skip") || names.contains("Submit") || names.contains("Next")) {
        isQ = true
        opts = toggles
      }
    }
    if isQ || !opts.isEmpty {
      var q = Self.clip(card.name, 400)
      let all = texts(w, card, 40)
      if q.isEmpty, let f = all.first { q = f }
      let page = all.first { Self.pageCount.test($0) } ?? ""
      let choices: [JSONValue] = opts.enumerated().map { k, o in
        let t = texts(w, o, 3)
        return ["n": .number(Double(k + 1)), "label": .string(t.first ?? Self.clip(o.name, 200)), "description": .string(t.count > 1 ? t[1] : ""), "selected": .bool(o.pressed)]
      }
      let radio = w.tree!.descendants(card).contains { $0.hasClass("epitaxy-radio-mark") }
      let acts = buttons.filter { Self.questionActions.contains($0.name) }.map(\.name)
      let sig = "question|\(q)|\(page)|\(choices.map { $0["label"]?.stringValue ?? "" }.joined(separator: "|"))"
      let multi = !choices.isEmpty && !radio && opts.contains { $0.hasClass("epitaxy-answer-option") }
      return ["kind": "question", "question": .string(q), "choices": .array(choices), "multiSelect": .bool(multi), "page": page.isEmpty ? .null : .string(page), "canSkip": .bool(acts.contains("Skip")), "key": .string(Self.key16(sig))]
    }
    var options: [JSONValue] = []
    for b in buttons {
      if let k = Self.answerKind(b.name), b.enabled { options.append(["id": .string(k), "label": .string(Self.clip(b.name, 80))]) }
    }
    var detail = ""
    for g in w.tree!.descendants(card) where g.t == "Group" && Self.commandRegions.contains(g.name) {
      detail = Self.clip(texts(w, g, 20).joined(separator: " "), 600)
      break
    }
    let txt = texts(w, card, 20).filter { !$0.isEmpty && !(!detail.isEmpty && detail.contains($0)) }
    let title = Self.clip(txt.prefix(3).joined(separator: " "), 300)
    if detail.isEmpty && txt.count > 3 { detail = Self.clip(txt.dropFirst(3).joined(separator: " "), 600) }
    let sig = "permission|\(title)|\(detail)|\(options.map { $0["label"]?.stringValue ?? "" }.joined(separator: "|"))"
    return ["kind": "permission", "title": .string(title), "detail": .string(detail), "options": .array(options), "key": .string(Self.key16(sig))]
  }

  func pending(_ w: Win) -> (card: Node, info: JSONValue, count: Int)? {
    let cards = findCards(w)
    guard let c = cards.last else { return nil }
    return (c, readCard(w, c), cards.count)
  }
  func cardByKey(_ w: Win, _ key: String) -> (card: Node, info: JSONValue)? {
    for c in findCards(w) {
      let info = readCard(w, c)
      if info["key"]?.stringValue == key { return (c, info) }
    }
    return nil
  }

  // MARK: acting

  func act(_ w: Win, _ n: Node, _ action: String, _ value: String? = nil) async -> JSONValue? {
    var args: [String: JSONValue] = ["hwnd": w.hwnd, "i": .number(Double(n.i)), "rid": n.raw["rid"] ?? .null, "t": n.raw["t"] ?? .null, "action": .string(action)]
    if n.raw["rid"] == nil { args.removeValue(forKey: "rid") }
    if n.raw["t"] == nil { args.removeValue(forKey: "t") }
    if let value { args["value"] = .string(value) }
    let r = await request("act", args)
    return JSValue.truthy(r?["ok"]?.any) ? r : nil
  }
  func press(_ w: Win, _ n: Node) async -> Bool { await act(w, n, "press") != nil }
  @discardableResult
  func setBox(_ w: Win, _ box: Node, _ text: String) async -> JSONValue? {
    // Claude's editor is ProseMirror: the value goes in as Chromium sets a rich box's text.
    var args: [String: JSONValue] = ["hwnd": w.hwnd, "i": .number(Double(box.i)), "rid": box.raw["rid"] ?? .null, "t": box.raw["t"] ?? .null, "action": "set_text", "value": .string(text), "method": "value"]
    if box.raw["rid"] == nil { args.removeValue(forKey: "rid") }
    if box.raw["t"] == nil { args.removeValue(forKey: "t") }
    let r = await request("act", args)
    return JSValue.truthy(r?["ok"]?.any) ? r : nil
  }
  @discardableResult
  func refresh(_ w: Win, full: Bool = false) async -> Bool { await useWindow(w, full: full, rescan: true) }

  // MARK: the modes

  static func s(_ v: String?) -> JSONValue { v.map { .string($0) } ?? .null }

  public func run(_ mode: String, _ rawArgs: [String] = []) async -> JSONValue {
    let a = Self.parseArgs(rawArgs)
    let all = await usableWindows()
    if let e = all.error {
      if e["error"]?.stringValue == "access_denied" {
        return ["ok": false, "error": "accessibility_denied", "message": "Orbit needs Accessibility permission to use the Claude app: System Settings > Privacy & Security > Accessibility, turn on Orbit."]
      }
      let msg = e["message"].flatMap { JSValue.truthy($0.any) ? Node.string($0) : nil } ?? e["error"].flatMap { JSValue.truthy($0.any) ? Node.string($0) : nil } ?? "The macOS helper did not answer."
      return ["ok": false, "error": "script_failed", "message": .string(JS.slice(msg, 0, 300))]
    }
    if !all.running || all.all.isEmpty { return ["ok": false, "error": "claude_window_not_found", "message": "The Claude desktop app is not open (or its window is closed)."] }
    let wins = all.wins
    if wins.isEmpty { return ["ok": false, "error": "claude_page_not_found", "message": "The Claude window is open, but its page isn't showing (still loading?)."] }
    let front = selectFront(wins, a["FrontHwnd"])!
    var title = front.title
    let windows = windowList(wins, front)

    switch mode {
    case "info":
      let w = front
      let box = promptBox(w)
      let page = newSessionPage(w, title)
      var sendRect: JSONValue = .null
      if a["Rects"] != nil, let box, let sb = sendButton(w, box, anyState: true) { sendRect = sb.rect }
      let working = box.map { sendButton(w, $0, names: Self.stopNames) != nil } ?? false
      return ["ok": true, "sessionTitle": Self.s(title), "newSession": .bool(page.found), "folder": page.found ? Self.s(page.folder) : .null, "promptBoxFound": .bool(box != nil),
              "promptText": box.map { .string(boxText($0)) } ?? .null, "windowId": w.hwnd, "windows": windows, "promptBoxRect": box?.rect ?? .null,
              "windowRect": w.doc?.rect ?? .null, "sendButtonRect": sendRect, "claudeWorking": .bool(working)]

    case "list":
      var openIn: [String: JSONValue] = [:]
      for w in wins { if let t = w.title, !t.isEmpty, openIn[t] == nil { openIn[t] = w.hwnd } }
      var rows: [JSONValue] = []
      var seen = Set<String>()
      for w in [front] + wins.filter({ $0 !== front }) where w.sidebar {
        for s in sidebarSessions(w) where !seen.contains(s.title) {
          seen.insert(s.title)
          let inWin = openIn[s.title]
          rows.append(["title": .string(s.title), "label": .string(s.label), "open": .bool(inWin != nil), "front": .bool(s.title == title), "window": inWin ?? w.hwnd])
        }
      }
      for w in wins {
        if let t = w.title, !t.isEmpty, !seen.contains(t) {
          seen.insert(t)
          rows.append(["title": .string(t), "label": .string(t), "open": true, "front": .bool(w === front), "window": w.hwnd])
        }
      }
      return ["ok": true, "sessionTitle": Self.s(title), "sessions": .array(rows), "windowId": front.hwnd, "windows": windows]

    case "switch":
      return await switchTo(a, wins, front, title)
    case "new":
      return await newSession(a, wins, front, title)
    case "pending", "answer":
      return await pendingOrAnswer(mode, a, wins, front, &title)
    case "stop":
      return await stop(a, wins, front, &title)
    case "app":
      return await appAction(a, front, title)
    case "send":
      return await send(a, wins, front, title)
    default:
      return ["ok": false, "error": "bad_mode", "message": .string("Unknown mode \(mode).")]
    }
  }

  func switchTo(_ a: [String: String], _ wins: [Win], _ front: Win, _ title: String?) async -> JSONValue {
    let want = JS.trim(Self.decode(a["TitleB64"]))
    if want.isEmpty { return ["ok": false, "error": "empty_title"] }
    if title == want { return ["ok": true, "switched": false, "sessionTitle": Self.s(title), "windowId": front.hwnd, "message": "That session is already open."] }
    var shown = wins.first { $0.title == want }
    var hit: SessionRow?
    var hitWin: Win?
    if shown == nil {
      let bars = ([front] + wins.filter { $0 !== front }).filter(\.sidebar)
      var allRows: [(s: SessionRow, w: Win)] = []
      for w in bars { for s in sidebarSessions(w) { allRows.append((s, w)) } }
      var pick = allRows.first { $0.s.title == want }
      if pick == nil { pick = allRows.first { JS.lower($0.s.title).contains(JS.lower(want)) } }
      if let p = pick {
        hit = p.s
        hitWin = p.w
        if p.s.title == title { return ["ok": true, "switched": false, "sessionTitle": Self.s(title), "windowId": front.hwnd, "message": "That session is already open."] }
        if let other = wins.first(where: { $0.title == p.s.title }) {
          shown = other
          hit = nil
        }
      } else {
        shown = wins.first { ($0.title.map { JS.lower($0).contains(JS.lower(want)) } ?? false) && !($0.title ?? "").isEmpty }
        if shown == nil { return ["ok": false, "error": "session_not_in_sidebar", "message": "Couldn't find that session in Claude's sidebar. It may be archived or scrolled out of the list.", "sessionTitle": Self.s(title)] }
      }
    }
    if let shown {
      if shown === front { return ["ok": true, "switched": true, "broughtForward": true, "sessionTitle": Self.s(shown.title), "windowId": shown.hwnd] }
      if await showWindow(shown) { return ["ok": true, "switched": true, "broughtForward": true, "sessionTitle": Self.s(shown.title), "windowId": shown.hwnd] }
      return ["ok": false, "error": "window_not_raised", "message": "That session is open in another Claude window, but macOS didn't let Orbit bring it to the front. Click that window to use it.", "sessionTitle": Self.s(title)]
    }
    guard let hit, let hitWin else { return ["ok": false, "error": "switch_not_confirmed"] }
    if !(await press(hitWin, hit.button)) { return ["ok": false, "error": "switch_not_confirmed", "message": "Couldn't press that session in the sidebar.", "sessionTitle": Self.s(title)] }
    for _ in 0..<20 {
      await sleep(100)
      if !(await refresh(hitWin)) { continue }
      let now = hitWin.title
      if now == hit.title {
        if hitWin !== front, !(await showWindow(hitWin)) {
          return ["ok": false, "error": "window_not_raised", "message": "Opened the session in another Claude window, but macOS didn't let Orbit bring that window to the front. Click it to use it.", "sessionTitle": Self.s(title)]
        }
        return ["ok": true, "switched": true, "sessionTitle": Self.s(now), "windowId": hitWin.hwnd]
      }
    }
    return ["ok": false, "error": "switch_not_confirmed", "message": "Clicked the session in the sidebar, but the window didn't confirm the switch.", "sessionTitle": Self.s(hitWin.title)]
  }

  func newSession(_ a: [String: String], _ wins: [Win], _ front: Win, _ title: String?) async -> JSONValue {
    guard let target = front.sidebar ? front : wins.first(where: \.sidebar) else {
      return ["ok": false, "error": "new_button_not_found", "message": "Couldn't find Claude's New session button. Is the sidebar hidden?", "sessionTitle": Self.s(title)]
    }
    let ttitle = target.title
    var box = promptBox(target)
    if let b = box, !boxText(b).isEmpty { return ["ok": false, "error": "prompt_box_not_empty", "message": "The prompt box has text typed in it, so Orbit stayed in this session (so the draft isn't lost).", "sessionTitle": Self.s(ttitle)] }
    let want = (a["ProjectB64"].map { !$0.isEmpty } ?? false) ? JS.trim(Self.decode(a["ProjectB64"])) : ""
    var button: Node?
    if !want.isEmpty {
      let choices = newInFolderButtons(target)
      var names: [String] = []
      for c in choices where !names.contains(c.folder) { names.append(c.folder) }
      names = Array(names.prefix(15))
      let lw = JS.lower(want)
      var hits = choices.filter { JS.lower($0.folder) == lw || JS.lower($0.group) == lw }
      if hits.isEmpty { hits = choices.filter { JS.lower($0.folder).contains(lw) || JS.lower($0.group).contains(lw) } }
      if hits.isEmpty { return ["ok": false, "error": "project_not_in_sidebar", "message": "Claude's sidebar has no project folder by that name.", "projects": .array(names.map { .string($0) }), "sessionTitle": Self.s(ttitle)] }
      var folders: [String] = []
      for h in hits where !folders.contains(h.folder) { folders.append(h.folder) }
      if folders.count > 1 { return ["ok": false, "error": "project_ambiguous", "message": "More than one project folder matches that name.", "projects": .array(folders.prefix(15).map { .string($0) }), "sessionTitle": Self.s(ttitle)] }
      button = hits[0].button
    } else {
      let page = newSessionPage(target, ttitle)
      if page.found {
        if target !== front, !(await showWindow(target)) { return ["ok": false, "error": "window_not_raised", "message": "A new session is open in Claude's main window, but macOS didn't let Orbit bring it to the front.", "sessionTitle": Self.s(title)] }
        return ["ok": true, "created": false, "newSession": true, "folder": Self.s(page.folder), "windowId": target.hwnd, "message": "A new session is already open and empty."]
      }
      button = sidebarButtonNamed(target, "New")
    }
    guard let button else { return ["ok": false, "error": "new_button_not_found", "message": "Couldn't find Claude's New session button. Is the sidebar hidden?", "sessionTitle": Self.s(ttitle)] }
    _ = await press(target, button)
    for _ in 0..<30 {
      await sleep(100)
      if !(await refresh(target)) { continue }
      let now = target.title
      let page = newSessionPage(target, now)
      box = promptBox(target)
      if page.found, let b = box, boxText(b).isEmpty {
        if target !== front, !(await showWindow(target)) { return ["ok": false, "error": "window_not_raised", "message": "Started a new session in Claude's main window, but macOS didn't let Orbit bring it to the front.", "sessionTitle": Self.s(title)] }
        return ["ok": true, "created": true, "newSession": true, "folder": Self.s(page.folder), "windowId": target.hwnd]
      }
    }
    return ["ok": false, "error": "new_session_not_confirmed", "message": "Pressed New session, but Claude didn't show an empty new session.", "sessionTitle": Self.s(target.title)]
  }

  /** The front window, or the one window showing the expected session. */
  func expected(_ a: [String: String], _ wins: [Win], _ front: Win, _ missing: String) -> (target: Win?, error: String?, count: Int) {
    guard let e = a["ExpectTitleB64"], !e.isEmpty else { return (front, nil, 0) }
    let expect = Self.decode(e)
    let targets = wins.filter { $0.title == expect }
    if targets.count != 1 { return (nil, targets.isEmpty ? missing : "session_ambiguous", targets.count) }
    return (targets[0], nil, 1)
  }

  func pendingOrAnswer(_ mode: String, _ a: [String: String], _ wins: [Win], _ front: Win, _ title: inout String?) async -> JSONValue {
    let ex = expected(a, wins, front, "session_not_open")
    if let e = ex.error { return ["ok": false, "error": .string(e), "message": ex.count > 0 ? "That session is open in more than one Claude window." : "That session is not open in a Claude window.", "sessionTitle": Self.s(title)] }
    let w = ex.target!
    _ = await useWindow(w, full: true)
    title = w.title
    if mode == "pending" {
      let p = pending(w)
      return ["ok": true, "sessionTitle": Self.s(title), "windowId": w.hwnd, "pending": p?.info ?? .null, "count": .number(Double(p?.count ?? 0))]
    }
    let key = (a["KeyB64"].map { !$0.isEmpty } ?? false) ? Self.decode(a["KeyB64"]) : ""
    guard !key.isEmpty, let hitCard = cardByKey(w, key) else {
      let now = pending(w)
      return ["ok": false, "error": now != nil ? "prompt_changed" : "nothing_pending", "message": now != nil ? "What Claude is asking changed since it was read, so nothing was pressed." : "Claude isn't waiting on anything in this session now.", "pending": now?.info ?? .null, "sessionTitle": Self.s(title)]
    }
    let (card, info) = hitCard
    let choice = a["Choice"] ?? ""
    var pressedName = ""
    if info["kind"]?.stringValue == "permission" {
      if !["allow_once", "allow_session", "allow_always", "deny"].contains(choice) { return ["ok": false, "error": "bad_choice", "message": "This is a permission request: allow or deny it.", "sessionTitle": Self.s(title)] }
      guard let btn = buttonsIn(w, card).first(where: { $0.enabled && Self.answerKind($0.name) == choice }) else {
        return ["ok": false, "error": "choice_not_offered", "message": "Claude does not offer that answer here.", "options": info["options"] ?? .null, "sessionTitle": Self.s(title)]
      }
      pressedName = btn.name
      if !(await press(w, btn)) { return ["ok": false, "error": "not_pressable", "message": "That button can't be pressed from here.", "sessionTitle": Self.s(title)] }
    } else if choice == "skip" {
      guard let btn = buttonsIn(w, card).first(where: { $0.name == "Skip" }) else { return ["ok": false, "error": "choice_not_offered", "message": "This question has no Skip.", "sessionTitle": Self.s(title)] }
      pressedName = "Skip"
      _ = await press(w, btn)
    } else if choice == "option" {
      let n = Node.number(a["Option"].map { .string($0) })
      let option = n.isNaN || n == 0 ? 0 : Int(n.rounded(.down))
      let choices = info["choices"]?.arrayValue ?? []
      if option < 1 || option > choices.count { return ["ok": false, "error": "bad_option", "message": .string("There's no option \(option).") , "choices": info["choices"] ?? .null, "sessionTitle": Self.s(title)] }
      var opts = buttonsIn(w, card).filter { $0.hasClass("epitaxy-answer-option") }
      if opts.isEmpty { opts = buttonsIn(w, card).filter { $0.name != "Other" && $0.isToggle } }
      pressedName = choices[option - 1]["label"]?.stringValue ?? ""
      if option - 1 < opts.count {
        let o = opts[option - 1]
        if !o.pressed { _ = await press(w, o) }
      }
      var sent = false
      for _ in 0..<20 where !sent {
        await refresh(w, full: true)
        guard let again = cardByKey(w, key) else { break }
        if let sub = buttonsIn(w, again.card).first(where: { ["Submit", "Next"].contains($0.name) && $0.enabled }) {
          _ = await press(w, sub)
          sent = true
          break
        }
        await sleep(100)
      }
      if !sent { return ["ok": false, "error": "submit_not_found", "message": "Picked the option, but couldn't press Submit.", "sessionTitle": Self.s(title)] }
    } else {
      return ["ok": false, "error": "bad_choice", "message": "This is a question: pick an option, or skip it.", "choices": info["choices"] ?? .null, "sessionTitle": Self.s(title)]
    }
    var gone = false
    for _ in 0..<30 {
      await sleep(100)
      await refresh(w, full: true)
      if cardByKey(w, key) == nil {
        gone = true
        break
      }
    }
    let next = pending(w)
    return ["ok": true, "answered": true, "pressed": .string(pressedName), "confirmed": .bool(gone), "sessionTitle": Self.s(title), "next": next?.info ?? .null]
  }

  func stop(_ a: [String: String], _ wins: [Win], _ front: Win, _ title: inout String?) async -> JSONValue {
    let ex = expected(a, wins, front, "session_changed")
    if let e = ex.error { return ["ok": false, "error": .string(e), "message": "That session is not open in exactly one Claude window, so nothing was stopped.", "sessionTitle": Self.s(title)] }
    let w = ex.target!
    title = w.title
    guard let box = promptBox(w) else { return ["ok": false, "error": "prompt_box_not_found", "message": "No prompt box is visible, so there is no Stop button to press.", "sessionTitle": Self.s(title)] }
    guard let stopBtn = sendButton(w, box, names: Self.stopNames) else { return ["ok": false, "error": "not_working", "message": "Claude isn't working in this session (there's no Stop button), so there was nothing to stop.", "sessionTitle": Self.s(title)] }
    if !stopBtn.pat.contains("I") { return ["ok": false, "error": "stop_not_pressable", "message": "Claude's Stop button can't be pressed from here.", "sessionTitle": Self.s(title)] }
    if !(await press(w, stopBtn)) { return ["ok": false, "error": "stop_not_pressable", "message": "Claude's Stop button can't be pressed from here.", "sessionTitle": Self.s(title)] }
    var confirmed = false
    for _ in 0..<25 {
      await sleep(100)
      if !(await refresh(w)) { continue }
      if let b = promptBox(w), sendButton(w, b, names: Self.stopNames) == nil {
        confirmed = true
        break
      }
    }
    return ["ok": true, "stopped": true, "confirmed": .bool(confirmed), "sessionTitle": Self.s(title), "windowId": w.hwnd]
  }

  // MARK: app: Claude's own controls

  static let modelRE = JSRegExp("^Model: ")
  static let renameRE = JSRegExp("^rename", "i")
  static let archiveRE = JSRegExp("^archive", "i")
  static let deleteRE = JSRegExp("^delete", "i")

  func appAction(_ a: [String: String], _ w: Win, _ title: String?) async -> JSONValue {
    let action = a["Action"] ?? ""
    let value = (a["ValueB64"].map { !$0.isEmpty } ?? false) ? JS.trim(Self.decode(a["ValueB64"])) : ""
    _ = await useWindow(w, full: ["scroll", "load_earlier"].contains(action))
    func nodes() -> [Node] { appNodes(w) }
    func all(_ t: String) -> [Node] { nodes().filter { $0.t == t } }
    func buttons() -> [Node] { all("Button") }
    func menuItems() async -> [Node] {
      for _ in 0..<15 {
        await refresh(w, full: w.full)
        let items = all("MenuItem").filter { $0.enabled && !$0.name.isEmpty }
        if !items.isEmpty { return items }
        await sleep(100)
      }
      return []
    }
    func expand(_ b: Node) async -> Bool {
      if await act(w, b, "expand") != nil { return true }
      return await press(w, b)
    }
    func collapse(_ b: Node) async { _ = await act(w, b, "collapse") }
    func chatScroller() -> Node? { nodes().first { $0.t == "Group" && $0.name == "Chat messages" } }
    func findModelBtn() -> Node? { buttons().first { Self.modelRE.test($0.name) } }
    func findPermBtn() -> Node? { buttons().first { Self.permLike.test($0.name) && $0.pat.contains("E") } }

    let bs = buttons()
    let modelBtn = bs.first { Self.modelRE.test($0.name) }
    let permBtn = bs.first { Self.permLike.test($0.name) && $0.pat.contains("E") }
    let sideBtn = bs.first { ["Hide sidebar", "Show sidebar"].contains($0.name) }
    let modeGrp = nodes().first { $0.t == "Group" && $0.name == "Mode" }
    var tab: JSONValue = .null
    if let mg = modeGrp { for r in w.tree!.descendants(mg) where r.t == "RadioButton" && r.selected { tab = r.name == "Code" ? "code" : "chat" } }
    var panelState: [String: JSONValue] = [:]
    for (k, name) in Self.panels {
      if let b = bs.first(where: { $0.name == name && $0.isToggle }) { panelState[k] = .bool(b.pressed) }
    }
    let page = newSessionPage(w, title)
    let scroller = chatScroller()
    let status: JSONValue = ["ok": true, "sessionTitle": Self.s(title), "windowId": w.hwnd, "sidebar": sideBtn.map { .bool($0.name == "Hide sidebar") } ?? .null, "tab": tab,
                             "model": modelBtn.map { .string(JS.slice($0.name, 7)) } ?? .null, "permission": permBtn.map { .string($0.name) } ?? .null, "panels": .object(panelState),
                             "newSession": .bool(page.found), "folder": page.found ? Self.s(page.folder) : .null, "canScroll": .bool(scroller != nil), "canLoadEarlier": .bool(bs.contains { $0.name == "Load earlier messages" })]

    switch action {
    case "status":
      return status
    case "folders":
      let p = newSessionPage(w, title)
      return ["ok": true, "folders": .array(newInFolderButtons(w).map { ["folder": .string($0.folder), "group": .string($0.group)] }.prefix(30).map { $0 }), "newSession": .bool(p.found), "folder": p.found ? Self.s(p.folder) : .null, "sessionTitle": Self.s(title)]
    case "sidebar":
      guard let sb = sideBtn else { return ["ok": false, "error": "control_not_found", "message": "Couldn't find Claude's sidebar button."] }
      let shown = sb.name == "Hide sidebar"
      let want = value == "show" ? true : value == "hide" ? false : !shown
      if want != shown { _ = await press(w, sb) }
      var ok = false
      for _ in 0..<15 where !ok {
        await sleep(100)
        await refresh(w)
        ok = buttons().contains { $0.name == (want ? "Hide sidebar" : "Show sidebar") }
      }
      return ["ok": .bool(ok), "sidebar": .bool(want), "changed": .bool(want != shown), "error": ok ? .null : "not_confirmed", "sessionTitle": Self.s(title)]
    case "tab":
      let want = value == "chat" ? "Claude" : "Code"
      guard let mg = modeGrp, let r = w.tree!.descendants(mg).first(where: { ($0.t == "RadioButton" || $0.isButton) && $0.name == want }) else {
        return ["ok": false, "error": "control_not_found", "message": "Couldn't find Claude's Code / chat switch."]
      }
      if r.selected { return ["ok": true, "tab": .string(value), "changed": false, "sessionTitle": Self.s(title)] }
      _ = await press(w, r)
      var ok = false
      for _ in 0..<15 where !ok {
        await sleep(100)
        await refresh(w)
        ok = all("RadioButton").first { $0.name == want }?.selected ?? false
      }
      return ["ok": .bool(ok), "tab": .string(value), "changed": true, "error": ok ? .null : "not_confirmed"]
    case "panel":
      let parts = value.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
      let which = parts[0]
      let how = parts.count > 1 ? parts[1] : nil
      let name = Self.panels.first { $0.0 == which }?.1
      guard let name, let b = buttons().first(where: { $0.name == name && $0.isToggle }) else { return ["ok": false, "error": "control_not_found", "message": "Couldn't find that panel's button."] }
      let on = b.pressed
      let want = how == "on" ? true : how == "off" ? false : !on
      if want != on { _ = await press(w, b) }
      await sleep(150)
      await refresh(w)
      let now = buttons().first { $0.name == name && $0.isToggle }?.pressed ?? on
      return ["ok": .bool(now == want), "panel": .string(which), "on": .bool(now), "changed": .bool(want != on), "sessionTitle": Self.s(title)]
    case "scroll":
      guard let sc = chatScroller() else { return ["ok": false, "error": "control_not_found", "message": "Couldn't find the conversation to scroll."] }
      let view = { () -> JSONValue in let p = w.tree!.parent(sc)?.rect ?? .null; return p == .null ? sc.rect : p }()
      let msgs = w.tree!.descendants(sc).filter { $0.sr == "AXDocumentArticle" }
      if msgs.isEmpty { return ["ok": true, "before": 100, "after": 100, "atTop": true, "atBottom": true, "sessionTitle": Self.s(title)] }
      let visible: [Int] = msgs.enumerated().compactMap { k, m in
        guard case .object(let r) = m.rect, case .object(let v) = view, let ry = r["y"]?.doubleValue, let rh = r["h"]?.doubleValue, let vy = v["y"]?.doubleValue, let vh = v["h"]?.doubleValue else { return nil }
        return ry + rh > vy && ry < vy + vh ? k : nil
      }
      let pct = { (k: Int) -> Double in EngineConfigRound.round(Double(k) / Double(max(1, msgs.count - 1)) * 1000) / 10 }
      let first = visible.first ?? 0
      let last = visible.last ?? msgs.count - 1
      let before = pct(first)
      let to: Int
      switch value {
      case "top": to = 0
      case "bottom": to = msgs.count - 1
      case "down": to = min(msgs.count - 1, last + 1)
      default: to = max(0, first - 1)
      }
      _ = await act(w, msgs[to], "show")
      await sleep(150)
      return ["ok": true, "before": .number(before), "after": .number(pct(to)), "atTop": .bool(to == 0), "atBottom": .bool(to == msgs.count - 1), "sessionTitle": Self.s(title)]
    case "load_earlier":
      guard let b = buttons().first(where: { $0.name == "Load earlier messages" }) else { return ["ok": false, "error": "nothing_earlier", "message": "There are no earlier messages to load."] }
      return ["ok": .bool(await press(w, b)), "sessionTitle": Self.s(title)]
    case "model", "permission":
      guard let btn = action == "model" ? modelBtn : permBtn else {
        return ["ok": false, "error": "control_not_found", "message": .string(action == "model" ? "Couldn't find Claude's model picker." : "Couldn't find Claude's permission mode button.")]
      }
      let was = btn.name
      var rx: JSRegExp?
      if action == "permission" {
        let src = ["ask": "^(ask|default)", "accept_edits": "accept edits|edit automatically|auto-?accept", "plan": "plan", "bypass": "bypass"][value]
        guard let src else { return ["ok": false, "error": "bad_value", "message": "Unknown permission mode."] }
        rx = JSRegExp(src, "i")
        if rx!.test(was) { return ["ok": true, "changed": false, "permission": .string(was), "sessionTitle": Self.s(title)] }
      } else if JS.lower(was).contains(JS.lower(value)) {
        return ["ok": true, "changed": false, "model": .string(JS.slice(was, 7)), "sessionTitle": Self.s(title)]
      }
      let match = { (n: String) -> Bool in action == "model" ? JS.lower(n).contains(JS.lower(value)) : rx!.test(n) }
      if !(await expand(btn)) { return ["ok": false, "error": "not_pressable", "message": "That picker can't be opened from here."] }
      let items = await menuItems()
      let names = items.map(\.name).prefix(20)
      var hits = items.filter { match($0.name) }
      if hits.count > 1 && action == "model" {
        // JS sort (stable): the shortest name first.
        hits = [hits.enumerated().sorted { a, b in JS.length(a.element.name) != JS.length(b.element.name) ? JS.length(a.element.name) < JS.length(b.element.name) : a.offset < b.offset }[0].element]
      }
      if hits.count != 1 {
        if let again = buttons().first(where: { $0.name == was }) { await collapse(again) }
        return ["ok": false, "error": .string(hits.isEmpty ? "not_offered" : "ambiguous"), "message": .string(hits.isEmpty ? "Claude's picker has no choice like that." : "More than one choice matches that."), "options": .array(names.map { .string($0) }), "sessionTitle": Self.s(title)]
      }
      let picked = hits[0].name
      _ = await press(w, hits[0])
      var now = was
      for _ in 0..<20 {
        await sleep(100)
        await refresh(w)
        let b2 = action == "model" ? findModelBtn() : buttons().first { Self.permLike.test($0.name) }
        if let b2 { now = b2.name }
        if now != was { break }
      }
      return ["ok": .bool(now != was), "picked": .string(picked), "now": .string(action == "model" && Self.modelRE.test(now) ? JS.slice(now, 7) : now), "error": now != was ? .null : "not_confirmed", "sessionTitle": Self.s(title)]
    case "rename", "archive", "delete":
      let target = (a["TitleB64"].map { !$0.isEmpty } ?? false) ? JS.trim(Self.decode(a["TitleB64"])) : (title ?? "")
      if target.isEmpty { return ["ok": false, "error": "no_session", "message": "No session is open to do that to."] }
      func rowsNow() -> [String] { sidebarSessions(w).map(\.title) }
      let more = buttons().filter { $0.name == "More options for \(target)" }
      if action == "rename" {
        if value.isEmpty { return ["ok": false, "error": "no_name", "message": "Say what to call it."] }
        let hdr = buttons().first { $0.name == "\(target), rename session" }
        var opened = false
        if let hdr {
          opened = await press(w, hdr)
        } else if let m0 = more.first, await expand(m0) {
          let it = (await menuItems()).filter { Self.renameRE.test($0.name) }
          if let first = it.first { opened = await press(w, first) } else { await collapse(m0) }
        }
        if !opened { return ["ok": false, "error": "control_not_found", "message": "Couldn't find how to rename that session."] }
        var edit: Node?
        for _ in 0..<15 where edit == nil {
          await sleep(100)
          await refresh(w)
          edit = all("Edit").first { $0.name != "Prompt" && $0.name != "Find in page" && $0.value == target }
        }
        guard let edit else { return ["ok": false, "error": "rename_field_not_found", "message": "Opened the rename, but couldn't find its text field."] }
        _ = await act(w, edit, "set_text", value)
        await refresh(w)
        if let save = buttons().first(where: { ["Save", "Done", "Rename", "Confirm"].contains($0.name) }) {
          _ = await press(w, save)
        } else if let box = promptBox(w) {
          _ = await act(w, box, "focus")
        }
        var ok = false
        for _ in 0..<20 where !ok {
          await sleep(100)
          await refresh(w)
          ok = rowsNow().contains(value) || w.title == value
        }
        return ["ok": .bool(ok), "renamed": .bool(ok), "from": .string(target), "to": .string(value), "error": ok ? .null : "not_confirmed", "sessionTitle": Self.s(w.title)]
      }
      if more.isEmpty { return ["ok": false, "error": "session_not_in_sidebar", "message": "Couldn't find that session's options.", "sessionTitle": Self.s(title)] }
      // The sidebar row's own button when it's there (the header's is the open session's).
      let mb = more.filter { inSidebarTree(w, $0) }.last ?? more[0]
      if !(await expand(mb)) { return ["ok": false, "error": "not_pressable", "message": "That session's options can't be opened from here."] }
      let wantRE = action == "archive" ? Self.archiveRE : Self.deleteRE
      let it = (await menuItems()).filter { wantRE.test($0.name) }
      if it.isEmpty {
        if let again = buttons().first(where: { $0.name == "More options for \(target)" }) { await collapse(again) }
        return ["ok": false, "error": "not_offered", "message": "Claude doesn't offer that for this session.", "sessionTitle": Self.s(title)]
      }
      _ = await press(w, it[0])
      if action == "delete" {
        var confirm: Node?
        for _ in 0..<15 where confirm == nil {
          await sleep(100)
          await refresh(w)
          confirm = buttons().first { $0.name == "Delete" && $0.enabled }
        }
        guard let confirm else { return ["ok": false, "error": "confirm_not_found", "message": "Claude didn't show its delete confirmation, so nothing was deleted.", "sessionTitle": Self.s(title)] }
        _ = await press(w, confirm)
      }
      var gone = false
      for _ in 0..<20 where !gone {
        await sleep(100)
        await refresh(w)
        gone = !rowsNow().contains(target)
      }
      return ["ok": .bool(gone), "done": .string(action), "session": .string(target), "error": gone ? .null : "not_confirmed", "sessionTitle": Self.s(w.title)]
    default:
      return ["ok": false, "error": "bad_action", "message": "Unknown app action."]
    }
  }

  // MARK: send / fill / clear

  func send(_ a: [String: String], _ wins: [Win], _ front: Win, _ title0: String?) async -> JSONValue {
    var title = title0
    var target = front
    var expect: String?
    if let e = a["ExpectTitleB64"], !e.isEmpty {
      let x = Self.decode(e)
      expect = x
      let targets = wins.filter { $0.title == x }
      if targets.isEmpty { return ["ok": false, "error": "session_changed", "message": "The session this prompt was drafted for is no longer open in any Claude window, so nothing was sent.", "sessionTitle": Self.s(title)] }
      if targets.count > 1 { return ["ok": false, "error": "session_ambiguous", "message": "That session is open in more than one Claude window, so nothing was sent. Close one of them and ask again.", "sessionTitle": Self.s(title)] }
      target = targets[0]
    }
    let wantFolder: String? = (a["ExpectFolderB64"].map { !$0.isEmpty } ?? false) ? Self.decode(a["ExpectFolderB64"]) : nil
    let newPageOk = { (w: Win) -> Bool in
      if let t = w.title, !t.isEmpty { return false }
      let p = self.newSessionPage(w, nil)
      guard p.found, let f = p.folder, !f.isEmpty else { return false }
      return wantFolder == nil || f == wantFolder
    }
    let expectNew = a["ExpectNew"] != nil
    if expectNew {
      let targets = wins.filter(newPageOk)
      if targets.isEmpty { return ["ok": false, "error": "session_changed", "message": "The new session this prompt was drafted for is no longer open (or is now in a different folder), so nothing was sent.", "sessionTitle": Self.s(title)] }
      if targets.count > 1 { return ["ok": false, "error": "session_ambiguous", "message": "More than one Claude window shows a new session, so nothing was sent. Close one of them and ask again.", "sessionTitle": Self.s(title)] }
      target = targets[0]
    }
    let w = target
    title = w.title
    guard var box = promptBox(w) else { return ["ok": false, "error": "prompt_box_not_found", "message": "No prompt box is visible. Open a Code session in the Claude app.", "sessionTitle": Self.s(title)] }
    let text = Self.decode(a["TextB64"])
    if JS.trim(text).isEmpty { return ["ok": false, "error": "empty_text"] }
    let inBox = boxText(box)
    let clearBox = {
      if let b = self.promptBox(w) { await self.setBox(w, b, "") }
    }
    var boxNow: Node? = box
    /** Look again, and find the box again. */
    func again() async -> Node? {
      await refresh(w)
      boxNow = promptBox(w)
      if let b = boxNow { box = b }
      return boxNow
    }

    if a["Clear"] != nil {
      if !inBox.isEmpty && Self.same(inBox, text) {
        await setBox(w, box, "")
        return ["ok": true, "cleared": true, "sessionTitle": Self.s(title)]
      }
      return ["ok": true, "cleared": false, "sessionTitle": Self.s(title)]
    }

    if a["Filled"] != nil {
      if !Self.same(inBox, text) { return ["ok": false, "error": "prompt_box_changed", "message": "The text in Claude's prompt box isn't the draft any more (it was edited or cleared), so nothing was sent.", "sessionTitle": Self.s(title)] }
    } else {
      let mayReplace = (a["PrevB64"].map { !$0.isEmpty } ?? false) && !inBox.isEmpty && Self.same(inBox, Self.decode(a["PrevB64"]))
      if !inBox.isEmpty && !mayReplace { return ["ok": false, "error": "prompt_box_not_empty", "message": "The prompt box already has text in it, so nothing was typed there (to avoid wiping a draft).", "sessionTitle": Self.s(title)] }
      if box.readOnly { return ["ok": false, "error": "prompt_box_read_only", "message": "Claude's prompt box isn't accepting input right now.", "sessionTitle": Self.s(title)] }
      if mayReplace {
        await setBox(w, box, "")
        await sleep(60)
        let b = await again()
        if b == nil || !boxText(boxNow).isEmpty { return ["ok": false, "error": "prompt_box_not_cleared", "message": "Couldn't clear the earlier draft from Claude's prompt box, so the new one wasn't typed in (it would have been added to the old one).", "sessionTitle": Self.s(title)] }
      }
      await setBox(w, box, text)
      await sleep(250)
      _ = await again()
      let landed = boxNow.map { boxText($0) } ?? ""
      var probe = JS.trim(JS.trim(text).components(separatedBy: "\n")[0])
      if JS.length(probe) > 30 { probe = JS.slice(probe, 0, 30) }
      let alone = Self.same(landed, text) || JS.length(landed) <= JS.length(JS.trim(text)) + 20
      if !(!landed.isEmpty && Self.normText(landed).contains(Self.normText(probe)) && alone) {
        await clearBox()
        return ["ok": false, "error": "fill_not_verified", "message": "Couldn't confirm the text reached Claude's prompt box (on its own), so nothing was sent.", "sessionTitle": Self.s(title)]
      }
    }

    // The same session still open in this window, right before Send.
    await refresh(w)
    if let b = promptBox(w) { box = b }
    let still = w.title
    let stillOk: Bool
    if let expect { stillOk = still == expect } else if expectNew { stillOk = (still ?? "").isEmpty && newSessionPage(w, nil).found } else { stillOk = still == title }
    if !stillOk {
      if a["Filled"] == nil { await clearBox() }
      return ["ok": false, "error": "session_changed", "message": "The session changed while the prompt was being typed in, so nothing was sent.", "sessionTitle": Self.s(still)]
    }

    if a["Fill"] != nil { return ["ok": true, "filled": true, "sent": false, "sessionTitle": Self.s(title), "windowId": w.hwnd] }

    if a["DryRun"] != nil {
      await clearBox()
      return ["ok": true, "sent": false, "dryRun": true, "sessionTitle": Self.s(title), "windowId": w.hwnd]
    }

    guard let sendBtn = sendButton(w, box) else {
      let why = sendButton(w, box, names: Self.stopNames) != nil ? "claude_working" : sendButton(w, box, anyState: true) != nil ? "send_disabled" : "not_found"
      if a["Filled"] == nil { await clearBox() }
      let msg = ["claude_working": "Claude is still working in that session (its Stop button is where Send goes), so nothing was sent.", "send_disabled": "Claude's Send button is there but turned off, so nothing was sent."][why] ?? "Couldn't find Claude's Send button, so nothing was sent."
      return ["ok": false, "error": "send_button_not_found", "why": .string(why), "message": .string(msg), "draftKept": .bool(a["Filled"] != nil), "sessionTitle": Self.s(title)]
    }
    _ = await press(w, sendBtn)

    var confirmed = false
    for _ in 0..<20 {
      await sleep(100)
      if await again() != nil, boxText(boxNow).isEmpty {
        confirmed = true
        break
      }
    }
    if expectNew {
      var k = 0
      while k < 30 && (title ?? "").isEmpty {
        await sleep(100)
        await refresh(w)
        title = w.title
        k += 1
      }
    }
    return ["ok": true, "sent": true, "confirmed": .bool(confirmed), "sessionTitle": Self.s(title), "newSession": .bool(expectNew), "windowId": w.hwnd]
  }
}

/** JS Math.round for the driver's percentages. */
enum EngineConfigRound {
  static func round(_ x: Double) -> Double { (x + 0.5).rounded(.down) }
}
