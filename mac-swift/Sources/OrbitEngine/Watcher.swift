// Watches recently active Claude Code sessions and notices when Claude finishes a turn, or waits on
// the user (src/watcher.js, rule for rule). Cheap by design: every 2 s it only stats the transcripts
// of sessions active in the last 3 hours, and reads a small tail only when one changed.
// Events: claude.status {working}, claude.waiting {id, title, kind, tool, toolId, check},
// claude.finished {id, title, summary}. `tick(now:)` is public for tests and the oracle.
import Foundation
import OrbitKit

public final class SessionWatcher: @unchecked Sendable {
  static let tickMs = 2000.0
  static let relistMs = 15_000.0
  static let hotWindowMs = 3.0 * 60 * 60 * 1000
  static let maxWatched = 12
  static let settleMs = 6000.0
  static let questionTools: Set<String> = ["AskUserQuestion"]
  static let planTools: Set<String> = ["ExitPlanMode"]
  static let waitChecksMs = [2500.0, 12_000]

  final class Tracked {
    let file: URL
    var mtime: Double = 0
    var size: Int = 0
    var working = false
    var kind: String?
    var changedAt: Double = 0
    var lastText = ""
    var first = true
    var lastTool: JSONValue?
    var waitChecks = 0
    var title = ""
    init(file: URL) { self.file = file }
  }

  let sessions: Sessions
  let log: EngineLog?
  private let lock = NSRecursiveLock()
  private var listeners: [UUID: @Sendable (JSONValue) -> Void] = [:]
  private var tracked: [String: Tracked] = [:]
  private var watched: [DesktopSession] = []
  private var listedAt = 0.0
  private var lastStatusKey = ""
  private var timer: DispatchSourceTimer?
  let clock: @Sendable () -> Double

  public init(sessions: Sessions, log: EngineLog? = nil, clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
    self.sessions = sessions
    self.log = log
    self.clock = clock
  }

  @discardableResult
  public func on(_ fn: @escaping @Sendable (JSONValue) -> Void) -> () -> Void {
    let id = UUID()
    lock.withLock { listeners[id] = fn }
    return { [weak self] in _ = self?.lock.withLock { self?.listeners.removeValue(forKey: id) } }
  }

  func emit(_ evt: JSONValue) {
    let fns = lock.withLock { Array(listeners.values) }
    for fn in fns { fn(evt) }
  }

  func refreshList(_ now: Double) {
    if now - listedAt < Self.relistMs { return }
    listedAt = now
    watched = Array(sessions.list().filter { now - $0.lastActivityAt < Self.hotWindowMs || (tracked[$0.id]?.working ?? false) }.prefix(Self.maxWatched))
  }

  func inspect(_ s: DesktopSession, _ now: Double) {
    var t = tracked[s.id]
    if t == nil {
      guard let file = sessions.findTranscript(s.cliSessionId, cwd: s.cwd) else { return }
      t = Tracked(file: file)
      tracked[s.id] = t
    }
    guard let t else { return }
    t.title = s.title
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: t.file.path) else { return }
    let mtime = ((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
    let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
    if mtime != t.mtime || size != t.size {
      t.mtime = mtime
      t.size = size
      t.changedAt = now
      if let tail = try? sessions.readTail(t.file, lastN: 4, maxCharsPerMessage: 600, maxBytes: 256 * 1024) {
        t.kind = tail.lastKind
        let tool = tail.lastTool
        if tool == nil || tool?["id"] != t.lastTool?["id"] { t.waitChecks = 0 } // a new call (or none): check it afresh
        t.lastTool = tool
        if let lastClaude = tail.turns.reversed().first(where: { $0["role"]?.stringValue == "claude" }), let text = lastClaude["text"]?.stringValue { t.lastText = text }
        let busy = tail.state == "working"
        // On first sight, only count it as working if it was active very recently.
        if busy && (!t.first || tail.ageMs < 2 * 60 * 1000) { t.working = true }
      }
      t.first = false
    }
    if !t.working { return }
    // Blocked on the user? Reported once for a question or a plan, twice at most for any other tool.
    if t.kind == "tool_use", let tool = t.lastTool {
      let name = tool["name"]?.stringValue ?? ""
      let kind = Self.questionTools.contains(name) ? "question" : Self.planTools.contains(name) ? "plan" : "tool"
      let checks = kind == "tool" ? Self.waitChecksMs : Array(Self.waitChecksMs.prefix(1))
      // A session that never asks permission (bypass mode) only waits on questions and plans.
      let asks = kind != "tool" || s.permissionMode != "bypassPermissions"
      if asks && t.waitChecks < checks.count && now - t.changedAt >= checks[t.waitChecks] {
        t.waitChecks += 1
        emit(["type": "claude.waiting", "id": .string(s.id), "title": .string(s.title), "kind": .string(kind), "tool": .string(name), "toolId": tool["id"] ?? .null, "check": .number(Double(t.waitChecks))])
      }
    }
    let finished = t.kind == "stopped" || (t.kind == "assistant_text" && now - t.changedAt >= Self.settleMs)
    if finished {
      t.working = false
      emit(["type": "claude.finished", "id": .string(s.id), "title": .string(s.title), "summary": .string(t.lastText)])
    }
  }

  /** One look (the timer's every 2 s). */
  public func tick(now: Double? = nil) {
    let n = now ?? clock()
    let status: JSONValue? = lock.withLock {
      refreshList(n)
      for s in watched { inspect(s, n) }
      let working = workingLocked()
      let key = working.compactMap { $0["id"]?.stringValue }.joined(separator: ",")
      if key != lastStatusKey {
        lastStatusKey = key
        return ["type": "claude.status", "working": .array(working)]
      }
      return nil
    }
    if let status { emit(status) }
  }

  func workingLocked() -> [JSONValue] {
    watched.filter { tracked[$0.id]?.working ?? false }.map { ["id": .string($0.id), "title": .string($0.title)] }
  }

  /** Sessions Claude is working in now: [{id, title}]. */
  public func working() -> [JSONValue] { lock.withLock { workingLocked() } }

  public func start() {
    lock.withLock {
      guard timer == nil else { return }
      let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
      t.schedule(deadline: .now(), repeating: Self.tickMs / 1000)
      t.setEventHandler { [weak self] in self?.tick() }
      timer = t
      t.resume()
    }
  }

  public func stop() {
    lock.withLock {
      timer?.cancel()
      timer = nil
    }
  }
}
