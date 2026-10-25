// What the engine asks of the Claude window (src/desktop.js on a Mac): the driver's modes with their
// arguments built as desktop.js builds them, one window action at a time (overlapping pastes or clicks
// would interleave), reads and Stop straight through, and a word to the shell around every change of
// the prompt box (the avatar stands on it). The driver is ClaudeDesktop on the helper's "ax" host, or
// in a test build the parity suite's stand-in desktop.
import Foundation
import OrbitIntent
import OrbitKit

public protocol DesktopDriver: Sendable {
  func run(_ mode: String, _ args: [String]) async -> JSONValue
}

extension ClaudeDesktop: DesktopDriver {}

public final class Desktop: @unchecked Sendable {
  public static let maxPromptChars = 8000
  public static let appActions = ["status", "folders", "sidebar", "tab", "panel", "scroll", "load_earlier", "model", "permission", "rename", "archive", "delete"]
  static let readOnly: Set<String> = ["status", "folders"]

  let driver: DesktopDriver?
  let unsupported: String
  let log: EngineLog?
  /** The Claude window the orb follows (the shell's), so the tools act on the window you're in. */
  public var frontHint: @Sendable () -> Int = { 0 }
  /** ORBIT_DRY_RUN_SENDS=1 (tests): fills and clears the box instead of sending. */
  public var dryRunSends = false
  private let queue = SerialQueue()
  private let boxWork = Locked<[UUID: @Sendable (String) -> Void]>([:])

  /** `driver` nil: no helper in this copy (every call says so plainly). */
  public init(driver: DesktopDriver?, log: EngineLog? = nil, unsupported: String = Desktop.helperMissing) {
    self.driver = driver
    self.log = log
    self.unsupported = unsupported
  }

  /** desktopUnsupportedMessage('darwin'). */
  public static let helperMissing = "Orbit can't reach the Claude app on this Mac: its helper is missing from this copy of Orbit (reinstall Orbit). Until then it can't type, send, press Stop, switch sessions or answer Claude's prompts, but it can still hear what your sessions are doing. Tell the user that in one short sentence; if it helps, read the prompt out so they can type or paste it themselves."

  static func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }

  func hintArgs() -> [String] {
    let h = frontHint()
    return h > 0 ? ["-FrontHwnd", String(h)] : []
  }

  /** runPs(): one mode, with the front-window hint; a run longer than timeout + 5 s is given up on. */
  func run(_ mode: String, _ args: [String] = [], timeout: Double = 20) async -> JSONValue {
    guard let driver else { return ["ok": false, "error": "unsupported_platform", "message": .string(unsupported)] }
    let full = args + hintArgs()
    let result = await withTaskGroup(of: JSONValue?.self) { g -> JSONValue in
      g.addTask { await driver.run(mode, full) }
      g.addTask {
        try? await Task.sleep(nanoseconds: UInt64((timeout + 5) * 1e9))
        return nil
      }
      let first = await g.next() ?? nil
      g.cancelAll()
      return first ?? ["ok": false, "error": "script_failed", "message": "timed out"]
    }
    if result["ok"] != .bool(true) {
      let err = result["error"]?.stringValue ?? ""
      let detail = result["message"]?.stringValue
      if ["script_failed", "script_exception"].contains(err) { log?.error("claude-window", "\(mode): \(err)", detail) } else { log?.warn("claude-window", "\(mode): \(err)", detail) }
    }
    return result
  }

  // MARK: the calls (desktop.js)

  public func info(rects: Bool = false) async -> JSONValue { await run("info", rects ? ["-Rects"] : []) }
  public func listSidebarSessions() async -> JSONValue { await run("list") }

  public func switchSession(_ title: String) async -> JSONValue {
    let clean = JS.slice(JS.trim(title), 0, 300)
    if clean.isEmpty { return ["ok": false, "error": "empty_title"] }
    return await queue.run { await self.run("switch", ["-TitleB64", Self.b64(clean)]) }
  }

  public func newSession(project: String = "") async -> JSONValue {
    let clean = JS.slice(JS.trim(project), 0, 200)
    return await queue.run { await self.run("new", clean.isEmpty ? [] : ["-ProjectB64", Self.b64(clean)]) }
  }

  public func claudeApp(_ action: String, value: String = "", title: String = "") async -> JSONValue {
    if !Self.appActions.contains(action) { return ["ok": false, "error": "bad_action"] }
    var args = ["-Action", action]
    let v = JS.slice(JS.trim(value), 0, 200)
    let t = JS.slice(JS.trim(title), 0, 300)
    if !v.isEmpty { args += ["-ValueB64", Self.b64(v)] }
    if !t.isEmpty { args += ["-TitleB64", Self.b64(t)] }
    let final = args
    if Self.readOnly.contains(action) { return await run("app", final) }
    return await queue.run { await self.run("app", final, timeout: 15) }
  }

  /** Not queued: it touches no prompt box, and a stop shouldn't wait for a draft being typed. */
  public func stopClaude(expectTitle: String? = nil) async -> JSONValue {
    await run("stop", expectTitle.map { ["-ExpectTitleB64", Self.b64($0)] } ?? [], timeout: 10)
  }

  public func pendingPrompt(expectTitle: String? = nil) async -> JSONValue {
    await run("pending", expectTitle.map { ["-ExpectTitleB64", Self.b64($0)] } ?? [])
  }

  public func answerPrompt(key: String, choice: String, option: Double = 0, expectTitle: String? = nil) async -> JSONValue {
    var args = ["-KeyB64", Self.b64(key), "-Choice", choice]
    if choice == "option" { args += ["-Option", String(max(0, Int(option.isFinite ? option.rounded(.down) : 0)))] }
    if let expectTitle, !expectTitle.isEmpty { args += ["-ExpectTitleB64", Self.b64(expectTitle)] }
    let final = args
    return await queue.run { await self.run("answer", final, timeout: 15) }
  }

  public struct Target: Sendable {
    public var expectTitle: String?
    public var expectNew = false
    public var expectFolder: String?
    public init(expectTitle: String? = nil, expectNew: Bool = false, expectFolder: String? = nil) {
      self.expectTitle = expectTitle; self.expectNew = expectNew; self.expectFolder = expectFolder
    }
  }

  /** Put `text` in the target session's box and press Send (`filled`: only if the box holds exactly it). */
  public func send(_ text: String, to t: Target = Target(), dryRun: Bool = false, filled: Bool = false) async -> JSONValue {
    await promptBox(text, t, extra: (filled ? ["-Filled"] : []) + (dryRun || dryRunSends ? ["-DryRun"] : []))
  }

  /** Type a draft in without sending it; `replace`: Orbit's earlier draft, which may be overwritten. */
  public func fill(_ text: String, to t: Target = Target(), replace: String? = nil) async -> JSONValue {
    await promptBox(text, t, extra: ["-Fill"] + (replace.map { ["-PrevB64", Self.b64(JS.trim($0))] } ?? []))
  }

  /** Empty the box only if it still holds exactly `text` (Orbit's draft): never the user's typing. */
  public func clear(_ text: String, to t: Target = Target()) async -> JSONValue { await promptBox(text, t, extra: ["-Clear"]) }

  /** `fn(phase)`: "start" when Orbit is about to change the prompt box, "done" after. */
  @discardableResult
  public func onPromptBoxWork(_ fn: @escaping @Sendable (String) -> Void) -> () -> Void {
    let id = UUID()
    boxWork.update { $0[id] = fn }
    return { [boxWork] in boxWork.update { $0.removeValue(forKey: id) } }
  }

  func tellBoxWork(_ phase: String) { for fn in boxWork.get().values { fn(phase) } }

  func promptBox(_ text: String, _ t: Target, extra: [String]) async -> JSONValue {
    let clean = JS.trim(text)
    if clean.isEmpty { return ["ok": false, "error": "empty_text"] }
    if JS.length(clean) > Self.maxPromptChars { return ["ok": false, "error": "too_long", "message": .string("Prompt is over \(Self.maxPromptChars) characters.")] }
    var args = ["-TextB64", Self.b64(clean)] + extra
    if let e = t.expectTitle, !e.isEmpty {
      args += ["-ExpectTitleB64", Self.b64(e)]
    } else if t.expectNew {
      args.append("-ExpectNew")
      if let f = t.expectFolder, !f.isEmpty { args += ["-ExpectFolderB64", Self.b64(f)] }
    }
    let final = args
    return await queue.run {
      self.tellBoxWork("start")
      let r = await self.run("send", final, timeout: t.expectNew ? 30 : 20)
      self.tellBoxWork("done")
      return r
    }
  }
}

/** Runs async jobs one after another, in the order they came (desktop.js enqueue). */
final class SerialQueue: @unchecked Sendable {
  private var tail: Task<Void, Never>?
  private let lock = NSLock()

  func run<T: Sendable>(_ job: @escaping @Sendable () async -> T) async -> T {
    let (prev, mine): (Task<Void, Never>?, Task<T, Never>) = lock.withLock {
      let prev = tail
      let mine = Task { () -> T in
        await prev?.value
        return await job()
      }
      tail = Task { _ = await mine.value }
      return (prev, mine)
    }
    _ = prev
    return await mine.value
  }
}

/**
 * The parity suite's stand-in desktop (ORBIT_FAKE_DESKTOP, test builds only): the same JavaScript
 * module the Electron build loads, run by Node in a child (parity/fixtures/fake-desktop-host.mjs)
 * and asked over JSON lines. Never in a release build.
 */
public final class FakeDesktopDriver: DesktopDriver, @unchecked Sendable {
  let host: HelperHost
  public init(node: URL, hostScript: URL, module: URL, env: [String: String]) {
    host = HelperHost(launch: {
      let p = Process()
      p.executableURL = node
      p.arguments = [hostScript.path, module.path]
      p.environment = env
      return p
    }, idleSeconds: 3600, requestSeconds: 60)
  }
  public func run(_ mode: String, _ args: [String]) async -> JSONValue {
    let r = await host.request("run", ["mode": .string(mode), "args": .array(args.map { .string($0) })])
    if let result = r["result"] { return result }
    return ["ok": false, "error": "script_failed", "message": .string(r["error"]?.stringValue ?? "the stand-in desktop did not answer")]
  }
  public func stop() { host.stop() }
}
