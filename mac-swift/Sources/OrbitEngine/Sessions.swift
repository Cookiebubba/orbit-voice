// Claude Code Desktop's sessions on disk, read-only (src/sessions.js, rule for rule): one metadata
// file per session under ~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/
// local_<id>.json, and the transcript, Claude Code's own log, under ~/.claude/projects/<encoded cwd>/
// <cliSessionId>.jsonl. `home` and `now` are injectable (tests, the oracle).
import Foundation
import OrbitIntent
import OrbitKit

public struct DesktopSession: Equatable, Sendable {
  public var id: String
  public var cliSessionId: String
  public var title: String
  public var cwd: String
  public var project: String
  public var branch: String?
  public var model: String?
  public var permissionMode: String?
  public var lastFocusedAt: Double
  public var lastActivityAt: Double
  public var createdAt: Double
  public var isArchived: Bool

  public var json: JSONValue {
    ["id": .string(id), "cliSessionId": .string(cliSessionId), "title": .string(title), "cwd": .string(cwd), "project": .string(project),
     "branch": branch.map { .string($0) } ?? .null, "model": model.map { .string($0) } ?? .null, "permissionMode": permissionMode.map { .string($0) } ?? .null,
     "lastFocusedAt": .number(lastFocusedAt), "lastActivityAt": .number(lastActivityAt), "createdAt": .number(createdAt), "isArchived": .bool(isArchived)]
  }
}

public final class Sessions: @unchecked Sendable {
  public let home: URL
  let now: @Sendable () -> Double

  public init(home: URL = FileManager.default.homeDirectoryForCurrentUser, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
    self.home = home
    self.now = now
  }

  /** Every claude-code-sessions folder Claude desktop uses on a Mac (sessionRootCandidates). */
  public var rootCandidates: [URL] { [home.appendingPathComponent("Library/Application Support/Claude/claude-code-sessions")] }
  public var projectsDir: URL { home.appendingPathComponent(".claude/projects") }
  public var roots: [URL] { rootCandidates.filter { FileManager.default.fileExists(atPath: $0.path) } }

  static let cliId = JSRegExp("^[A-Za-z0-9_-]{1,100}$")
  static let localFile = JSRegExp(#"^local_.*\.json$"#)

  func listDir(_ dir: URL) -> [(name: String, isDir: Bool, isFile: Bool)] {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
    // (fs.readdirSync order: the file system's, which is sorted by name on APFS.)
    return names.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }.map { n in
      var d: ObjCBool = false
      let exists = FileManager.default.fileExists(atPath: dir.appendingPathComponent(n).path, isDirectory: &d)
      return (n, exists && d.boolValue, exists && !d.boolValue)
    }
  }

  static func str(_ v: JSONValue?) -> String { v?.stringValue ?? "" }
  static func num(_ v: JSONValue?) -> Double { if case .number(let n)? = v, n.isFinite { return n }; return 0 }

  /** listDesktopSessions(): all session metadata, newest focus first. */
  public func list(includeArchived: Bool = false) -> [DesktopSession] {
    var byId: [String: DesktopSession] = [:]
    var order: [String] = []
    for root in roots {
      for s in readRoot(root, includeArchived) {
        if let prev = byId[s.id] {
          if s.lastActivityAt > prev.lastActivityAt || s.lastFocusedAt > prev.lastFocusedAt { byId[s.id] = s }
        } else {
          byId[s.id] = s
          order.append(s.id)
        }
      }
    }
    let sessions = order.compactMap { byId[$0] }
    // A stable sort, as JavaScript's.
    return sessions.enumerated().sorted { a, b in
      if a.element.lastFocusedAt != b.element.lastFocusedAt { return a.element.lastFocusedAt > b.element.lastFocusedAt }
      if a.element.lastActivityAt != b.element.lastActivityAt { return a.element.lastActivityAt > b.element.lastActivityAt }
      return a.offset < b.offset
    }.map(\.element)
  }

  func readRoot(_ root: URL, _ includeArchived: Bool) -> [DesktopSession] {
    var out: [DesktopSession] = []
    for account in listDir(root) where account.isDir {
      let accountDir = root.appendingPathComponent(account.name)
      for org in listDir(accountDir) where org.isDir {
        let orgDir = accountDir.appendingPathComponent(org.name)
        for f in listDir(orgDir) where f.isFile && Self.localFile.test(f.name) {
          guard let data = try? Data(contentsOf: orgDir.appendingPathComponent(f.name)), case .object(let meta)? = try? JSONValue.parse(data) else { continue }
          // A damaged or unexpected file is skipped, never trusted: the CLI id becomes part of a path.
          guard case .string(let cli)? = meta["cliSessionId"], Self.cliId.test(cli) else { continue }
          let archived = JSValue.truthy(meta["isArchived"]?.any)
          if archived && !includeArchived { continue }
          let cwd = Self.str(meta["cwd"])
          let origin = Self.str(meta["originCwd"])
          let base = ((origin.isEmpty ? cwd : origin) as NSString).lastPathComponent
          let title = JS.slice(Self.str(meta["title"]), 0, 300)
          let id = Self.str(meta["sessionId"])
          out.append(DesktopSession(
            id: id.isEmpty ? String(f.name.dropLast(".json".count)) : id,
            cliSessionId: cli,
            title: title.isEmpty ? "(untitled)" : title,
            cwd: cwd,
            project: base.isEmpty ? "(no folder)" : base,
            branch: Self.str(meta["branch"]).isEmpty ? nil : Self.str(meta["branch"]),
            model: Self.str(meta["model"]).isEmpty ? nil : Self.str(meta["model"]),
            permissionMode: Self.str(meta["permissionMode"]).isEmpty ? nil : Self.str(meta["permissionMode"]),
            lastFocusedAt: Self.num(meta["lastFocusedAt"]),
            lastActivityAt: Self.num(meta["lastActivityAt"]) != 0 ? Self.num(meta["lastActivityAt"]) : Self.num(meta["createdAt"]),
            createdAt: Self.num(meta["createdAt"]),
            isArchived: archived))
        }
      }
    }
    return out
  }

  static let nonAlnum = JSRegExp("[^a-zA-Z0-9]", "g")

  /** findTranscript(): the .jsonl transcript for a CLI session id. */
  public func findTranscript(_ cliSessionId: String, cwd: String?) -> URL? {
    if let cwd, !cwd.isEmpty {
      let guess = projectsDir.appendingPathComponent(Self.nonAlnum.replace(cwd, "-")).appendingPathComponent("\(cliSessionId).jsonl")
      if FileManager.default.fileExists(atPath: guess.path) { return guess }
    }
    for dir in listDir(projectsDir) where dir.isDir {
      let p = projectsDir.appendingPathComponent(dir.name).appendingPathComponent("\(cliSessionId).jsonl")
      if FileManager.default.fileExists(atPath: p.path) { return p }
    }
    return nil
  }

  static let normRE = JSRegExp("[^a-z0-9]+", "g")
  static func normalize(_ s: String?) -> String { JS.trim(normRE.replace(JS.lower(s ?? ""), " ")) }

  /** findSessionByTitle(): the session with exactly this title (case and punctuation aside). */
  public func findByTitle(_ title: String?, accept: (DesktopSession) -> Bool = { _ in true }) -> DesktopSession? {
    let t = Self.normalize(title)
    if t.isEmpty { return nil }
    return list().first { Self.normalize($0.title) == t && accept($0) }
  }

  /** resolveSession(): a session from a loose spoken query (a title or id fragment, or nothing). */
  public func resolve(_ query: String?, windowTitle: String? = nil) -> DesktopSession? {
    let all = list()
    guard let first = all.first else { return nil }
    let q = Self.normalize(query)
    if q.isEmpty || ["current", "this", "this one", "latest", "active", "open"].contains(q) {
      if let w = windowTitle, !w.isEmpty, let hit = all.first(where: { Self.normalize($0.title) == Self.normalize(w) }) { return hit }
      return first
    }
    let raw = query ?? ""
    if let byId = all.first(where: { $0.id.contains(raw) || $0.cliSessionId.hasPrefix(raw) }) { return byId }
    if let exact = all.first(where: { Self.normalize($0.title) == q }) { return exact }
    let words = q.split(separator: " ", omittingEmptySubsequences: false).map(String.init).filter { JS.length($0) > 1 }
    var best: DesktopSession?
    var bestScore = 0
    for s in all {
      let hay = "\(Self.normalize(s.title)) \(Self.normalize(s.project))"
      let score = words.filter { hay.contains($0) }.count
      if score > bestScore {
        best = s
        bestScore = score
      }
    }
    return best
  }

  // MARK: transcripts

  struct Noise {
    let open: String
    let close: String
    let keepInner: Bool
  }
  static let noise = [
    Noise(open: "<system-reminder>", close: "</system-reminder>", keepInner: false),
    Noise(open: "<pasted_content", close: "</pasted_content", keepInner: true),
    Noise(open: "<command-", close: "</command-", keepInner: false),
    Noise(open: "<local-command-", close: "</local-command-", keepInner: false),
  ]

  /** cutBlocks(): a linear scan (on UTF-16, as the JS indexOf). */
  static func cutBlocks(_ text: String, _ tag: Noise) -> String {
    let t = Array(text.utf16), open = Array(tag.open.utf16), close = Array(tag.close.utf16)
    func indexOf(_ needle: [UInt16], from: Int) -> Int {
      guard !needle.isEmpty, from <= t.count - needle.count else { return -1 }
      var i = max(0, from)
      while i <= t.count - needle.count {
        if t[i] == needle[0] && Array(t[i..<(i + needle.count)]) == needle { return i }
        i += 1
      }
      return -1
    }
    var out: [UInt16] = []
    var pos = 0
    while true {
      let start = indexOf(open, from: pos)
      if start < 0 { break }
      let openEnd = tag.open.hasSuffix(">") ? start + open.count - 1 : indexOf([62], from: start + open.count)
      let end = openEnd < 0 ? -1 : indexOf(close, from: openEnd)
      let closeEnd = end < 0 ? -1 : tag.close.hasSuffix(">") ? end + close.count - 1 : indexOf([62], from: end + close.count)
      if closeEnd < 0 { break }
      out += t[pos..<start]
      if tag.keepInner { out += t[(openEnd + 1)..<end] }
      pos = closeEnd + 1
    }
    out += t[min(pos, t.count)...]
    return String(utf16CodeUnits: out, count: out.count)
  }

  static func stripNoise(_ text: String) -> String {
    var t = text
    for tag in noise { t = cutBlocks(t, tag) }
    return JS.trim(t)
  }

  static func clip(_ text: String, _ max: Int) -> String {
    JS.length(text) > max ? "\(JS.slice(text, 0, max))… [\(JS.length(text) - max) more chars]" : text
  }

  public struct Tail: Sendable {
    public var state: String
    public var turns: [JSONValue]
    public var lastKind: String?
    public var ageMs: Double
    public var lastTool: JSONValue?
    public var json: JSONValue {
      ["state": .string(state), "turns": .array(turns), "lastKind": lastKind.map { .string($0) } ?? .null, "ageMs": ageMs.isFinite ? .number(ageMs) : .null, "lastTool": lastTool ?? .null]
    }
  }

  /** Date.parse for the ISO timestamps transcripts carry (NaN when it can't). */
  static func parseDate(_ s: String) -> Double {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return (d.timeIntervalSince1970 * 1000).rounded() }
    f.formatOptions = [.withInternetDateTime]
    if let d = f.date(from: s) { return d.timeIntervalSince1970 * 1000 }
    return .nan
  }

  /** readTranscriptTail(): the tail of a transcript as a compact list of turns. */
  public func readTail(_ file: URL, lastN: Int = 8, includeTools: Bool = false, maxCharsPerMessage: Int = 1500, maxBytes: Int = 4 * 1024 * 1024) throws -> Tail {
    let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
    let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
    let readBytes = min(size, maxBytes)
    let fh = try FileHandle(forReadingFrom: file)
    defer { try? fh.close() }
    try fh.seek(toOffset: UInt64(size - readBytes))
    let buf = try fh.read(upToCount: readBytes) ?? Data()
    var lines = String(decoding: buf, as: UTF8.self).components(separatedBy: "\n")
    if readBytes < size && !lines.isEmpty { lines.removeFirst() } // the first line is probably partial

    var turns: [JSONValue] = []
    var lastKind: String?
    var lastAt: String?
    var lastTool: JSONValue?
    for line in lines {
      if JS.trim(line).isEmpty { continue }
      guard let rec = try? JSONValue.parse(Data(line.utf8)), case .object(let r) = rec else { continue }
      if JSValue.truthy(r["isSidechain"]?.any) { continue }
      let type = r["type"]?.stringValue
      if type == "system" && r["subtype"]?.stringValue == "stop_hook_summary" {
        lastKind = "stopped"
        if let ts = r["timestamp"], JSValue.truthy(ts.any) { lastAt = ts.stringValue ?? lastAt }
        continue
      }
      guard case .object(let msg)? = r["message"] else { continue }
      if type == "user" || type == "assistant", case .string(let ts)? = r["timestamp"], !ts.isEmpty { lastAt = ts }
      var content: [JSONValue]
      if case .string(let s)? = msg["content"] { content = [["type": "text", "text": .string(s)]] } else if case .array(let a)? = msg["content"] { content = a } else { content = [] }
      content = content.filter { c in
        guard case .object = c else { return false }
        return c["type"]?.stringValue != "text" || c["text"]?.stringValue != nil
      }
      let at = r["timestamp"] ?? .null
      if type == "user" {
        if content.contains(where: { $0["type"]?.stringValue == "tool_result" }) {
          lastKind = "tool_result"
          continue
        }
        let text = Self.stripNoise(content.filter { $0["type"]?.stringValue == "text" }.compactMap { $0["text"]?.stringValue }.joined(separator: "\n"))
        if text.isEmpty { continue }
        var turn: [String: JSONValue] = ["role": "user", "text": .string(Self.clip(text, maxCharsPerMessage))]
        if r["timestamp"] != nil { turn["at"] = at }
        turns.append(.object(turn))
        lastKind = "user"
      } else if type == "assistant" {
        for c in content {
          let ct = c["type"]?.stringValue
          if ct == "text", let t = c["text"]?.stringValue, !JS.trim(t).isEmpty {
            var turn: [String: JSONValue] = ["role": "claude", "text": .string(Self.clip(JS.trim(t), maxCharsPerMessage))]
            if r["timestamp"] != nil { turn["at"] = at }
            turns.append(.object(turn))
            lastKind = "assistant_text"
          } else if ct == "tool_use" {
            if includeTools {
              var turn: [String: JSONValue] = ["role": "tool", "text": .string(Self.describeToolUse(c))]
              if r["timestamp"] != nil { turn["at"] = at }
              turns.append(.object(turn))
            }
            lastKind = "tool_use"
            lastTool = ["name": .string(JS.slice(Self.jsString(c["name"]), 0, 120)), "id": .string(c["id"]?.stringValue.map { JS.slice($0, 0, 100) } ?? ""), "at": r["timestamp"]?.stringValue.map { .string($0) } ?? .null]
          }
        }
      }
    }
    // Is Claude still mid-turn? A stop marker or Claude's own text at the end means no.
    let ageMs = lastAt.map { now() - Self.parseDate($0) } ?? .infinity
    let looksBusy = lastKind != nil && lastKind != "assistant_text" && lastKind != "stopped"
    let state = looksBusy ? (ageMs < 10 * 60 * 1000 ? "working" : "stopped mid-task or waiting") : "idle (finished its last reply)"
    return Tail(state: state, turns: Array(turns.suffix(lastN)), lastKind: lastKind, ageMs: ageMs, lastTool: lastKind == "tool_use" ? lastTool : nil)
  }

  /** String(v ?? fallback) for a tool's name. */
  static func jsString(_ v: JSONValue?, _ fallback: String = "") -> String {
    switch v {
    case nil, .null?: return fallback
    case .string(let s)?: return s
    case .number(let n)?: return JSNumber.string(n)
    case .bool(let b)?: return b ? "true" : "false"
    case .array(let a)?: return a.map { jsString($0) }.joined(separator: ",")
    case .object?: return "[object Object]"
    }
  }

  static func describeToolUse(_ c: JSONValue) -> String {
    let i = c["input"]?.objectValue ?? [:]
    var detail: JSONValue = .null
    for k in ["description", "command", "file_path", "pattern", "url", "query", "prompt"] where JSValue.truthy(i[k]?.any) {
      detail = i[k]!
      break
    }
    let name = JS.slice(jsString(c["name"], "tool"), 0, 120)
    return JSValue.truthy(detail.any) ? "\(name): \(clip(jsString(detail), 140))" : name
  }

  /** ago(): "5s ago", "3m ago", "2h ago", "4d ago" or "unknown". */
  public func ago(_ ms: Double) -> String {
    if ms == 0 || ms.isNaN { return "unknown" }
    let s = EngineConfig.round((now() - ms) / 1000)
    if s < 60 { return "\(JSNumber.string(s))s ago" }
    if s < 3600 { return "\(JSNumber.string(EngineConfig.round(s / 60)))m ago" }
    if s < 86400 { return "\(JSNumber.string(EngineConfig.round(s / 3600)))h ago" }
    return "\(JSNumber.string(EngineConfig.round(s / 86400)))d ago"
  }
}
