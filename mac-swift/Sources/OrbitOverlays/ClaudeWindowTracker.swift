// Runs the macOS helper's claude-window mode (orbit-helper claude-window --parent-pid <pid> [--pid
// <claude pid>]), which reports Claude's windows whenever they change and, for the avatar, where the
// watched window's prompt box is (JSON lines; the protocol and the logic are OrbitKit's
// ClaudeTrackerCore). Restarts the helper if it dies, re-sending the last commands; gives up after
// five crashes in a minute (and says why).
//
// ORBIT_TEST_CLAUDE_PID (developer builds and tests): only that process is "Claude" (a stand-in
// window), so tests never touch the real Claude app. ORBIT_CLAUDE_HELPER (the same): a stand-in
// helper speaking the same protocol (OverlayDemo's, which reports its stand-in window without the
// accessibility API).
//
// Without Accessibility for Orbit the helper sees no windows: the tracker reports none, and the home
// avatar stays hidden (as Electron's; it floats free only when there's no helper at all).
import AppKit
import Foundation
import OrbitKit

@MainActor
public final class ClaudeWindowTracker {
  public let core = ClaudeTrackerCore()
  private let helperPath: String
  private let testPid: Int
  private var process: Process?
  private var stdin: FileHandle?
  private var stopped = true
  private var generation = 0
  public var onChange: (ClaudeState) -> Void = { _ in }
  public var onBox: (BoxReport) -> Void = { _ in }
  public var onError: (String) -> Void = { _ in }
  public var log: (String) -> Void = { _ in }

  /** The pid that is "Claude" in tests (ORBIT_TEST_CLAUDE_PID), or 0 for the real Claude app. */
  public static var testClaudePid: Int {
    let env = ProcessInfo.processInfo.environment
    return Int(env["ORBIT_TEST_CLAUDE_PID"] ?? env["ORBIT_CLAUDE_PID"] ?? "") ?? 0
  }

  /**
   * The helper to run: ORBIT_CLAUDE_HELPER, else the app's own (Contents/Resources/mac/orbit-helper),
   * else one next to the executable. nil when there's none.
   */
  public static func defaultHelperPath() -> String? {
    let fm = FileManager.default
    var candidates: [String] = []
    if let h = ProcessInfo.processInfo.environment["ORBIT_CLAUDE_HELPER"], !h.isEmpty { candidates.append(h) }
    if let r = Bundle.main.resourcePath { candidates.append((r as NSString).appendingPathComponent("mac/orbit-helper")) }
    if let e = Bundle.main.executableURL?.deletingLastPathComponent() { candidates.append(e.appendingPathComponent("orbit-helper").path) }
    return candidates.first { fm.isExecutableFile(atPath: $0) }
  }

  public init(helperPath: String, testPid: Int = ClaudeWindowTracker.testClaudePid) {
    self.helperPath = helperPath
    self.testPid = testPid
    core.write = { [weak self] line in self?.write(line) }
    core.onChange = { [weak self] s in self?.onChange(s) }
    core.onBox = { [weak self] b in self?.onBox(b) }
  }

  public var current: ClaudeState { core.current }
  public var running: Bool { !stopped }

  public func start() {
    guard stopped else { return }
    stopped = false
    core.resetRestarts()
    launch()
  }

  public func stop() {
    stopped = true
    core.stop()
    generation += 1
    if let p = process, p.isRunning { p.terminate() }
    process = nil
    stdin = nil
  }

  public func watchBox(_ hwnd: Int) { core.watchBox(hwnd) }
  public func burst() { core.burst() }

  private func write(_ line: String) {
    guard let h = stdin else { return } // restarting: replayed by started()
    try? h.write(contentsOf: Data((line + "\n").utf8))
  }

  private func launch() {
    generation += 1
    let gen = generation
    let p = Process()
    p.executableURL = URL(fileURLWithPath: helperPath)
    var args = ["claude-window", "--parent-pid", String(getpid())]
    if testPid > 0 { args += ["--pid", String(testPid)] }
    p.arguments = args
    let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = errPipe
    let lines = LineSplitter { [weak self] line in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, self.generation == gen else { return }
          self.core.handle(line: line)
        }
      }
    }
    outPipe.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil } else { lines.feed(d) }
    }
    let errText = ErrTail()
    errPipe.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil } else { errText.feed(d) }
    }
    p.terminationHandler = { [weak self] proc in
      let code = proc.terminationStatus
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, self.generation == gen else { return }
          self.exited(code: code, err: errText.text)
        }
      }
    }
    do {
      try p.run()
    } catch {
      onError("The Claude window watcher could not start: \(String(describing: error).prefix(160))")
      stopped = true
      return
    }
    process = p
    stdin = inPipe.fileHandleForWriting
    log("claude-window helper started\(testPid > 0 ? " (stand-in pid \(testPid))" : "")")
    core.started()
  }

  private func exited(code: Int32, err: String) {
    process = nil
    stdin = nil
    if stopped { return }
    guard let delay = core.exited(at: MainClock.shared.now) else {
      onError("The Claude window watcher keeps stopping (exit \(code)). \(err.split(separator: "\n").first ?? "")".trimmingCharacters(in: .whitespaces))
      return
    }
    MainClock.shared.after(delay) { [weak self] in
      guard let self, !self.stopped, self.process == nil else { return }
      self.launch()
    }
  }
}

/** Bytes in, whole lines out (on the reading thread). */
private final class LineSplitter: @unchecked Sendable {
  private let lock = NSLock()
  private var buf = Data()
  private let emit: @Sendable (String) -> Void
  init(_ emit: @escaping @Sendable (String) -> Void) { self.emit = emit }
  func feed(_ d: Data) {
    lock.lock()
    buf.append(d)
    var out: [String] = []
    while let i = buf.firstIndex(of: 0x0A) {
      let line = buf[buf.startIndex..<i]
      buf.removeSubrange(buf.startIndex...i)
      if let s = String(data: line, encoding: .utf8), !s.isEmpty { out.append(s) }
    }
    if buf.count > 1 << 20 { buf.removeAll() } // a runaway line: drop it
    lock.unlock()
    for l in out { emit(l) }
  }
}

/** The last few KB of the helper's stderr, for the "keeps stopping" message. */
private final class ErrTail: @unchecked Sendable {
  private let lock = NSLock()
  private var s = ""
  func feed(_ d: Data) {
    lock.lock()
    if s.count < 4000 { s += String(decoding: d, as: UTF8.self) }
    lock.unlock()
  }
  var text: String {
    lock.lock()
    defer { lock.unlock() }
    return s
  }
}
