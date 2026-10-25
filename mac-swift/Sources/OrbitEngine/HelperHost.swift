// A long-lived JSON-lines child: Orbit's macOS helper in its "ax" mode (src/platform/win/uia.js's
// createUiaHost, which the macOS port reuses for it), and in test builds the parity suite's stand-in
// desktop. Requests carry an id and are matched to answers by it; started on the first request,
// stopped after 10 idle minutes; a request that takes too long gets a "timeout" answer and the child
// is restarted (an app that hangs the accessibility API can't block the next request); a child that
// keeps stopping (more than 6 starts a minute) is given up on.
import Foundation
import OrbitKit

public final class HelperHost: @unchecked Sendable {
  public typealias Launch = () throws -> Process
  let launch: Launch
  let idleSeconds: Double
  let requestSeconds: Double
  let onError: @Sendable (String) -> Void
  /** What a request gets when no child can run (e.g. the helper is missing). */
  let unavailable: JSONValue

  private let lock = NSLock()
  private var child: Process?
  private var stdin: FileHandle?
  private var nextId = 1
  private var pending: [Int: (JSONValue) -> Void] = [:]
  private var starts: [Date] = []
  private var idleTimer: DispatchWorkItem?
  private var stderrText = ""

  public init(launch: @escaping Launch, idleSeconds: Double = 600, requestSeconds: Double = 15, unavailable: JSONValue = ["ok": false, "error": "unavailable", "message": "Orbit's macOS helper is missing."], onError: @escaping @Sendable (String) -> Void = { _ in }) {
    self.launch = launch
    self.idleSeconds = idleSeconds
    self.requestSeconds = requestSeconds
    self.unavailable = unavailable
    self.onError = onError
  }

  /** The helper's `mode` process: `<bin> <mode> --parent-pid <this pid>` (macOS counts it as Orbit). */
  public static func helper(bin: URL, mode: String) -> Launch {
    {
      let p = Process()
      p.executableURL = bin
      p.arguments = [mode, "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
      return p
    }
  }

  public var running: Bool { lock.withLock { child?.isRunning ?? false } }

  private func finishAll(_ error: String) {
    let waiting = lock.withLock { () -> [(Int, (JSONValue) -> Void)] in
      let w = pending.map { ($0.key, $0.value) }
      pending.removeAll()
      return w
    }
    for (id, done) in waiting { done(["id": .number(Double(id)), "ok": false, "error": .string(error)]) }
  }

  private func kill() {
    let c: Process? = lock.withLock {
      let c = child
      child = nil
      try? stdin?.close()
      stdin = nil
      return c
    }
    if let c, c.isRunning { c.terminate() }
  }

  /** Starts the child if needed (lock held by the caller). Nil if it can't run. */
  private func startLocked() -> FileHandle? {
    if let c = child, c.isRunning, let s = stdin { return s }
    let now = Date()
    starts = starts.filter { now.timeIntervalSince($0) < 60 } + [now]
    if starts.count > 6 {
      onError("The macOS helper keeps stopping.")
      return nil
    }
    let p: Process
    do { p = try launch() } catch {
      onError("The macOS helper could not start: \(String(describing: error).prefix(160))")
      return nil
    }
    let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = errPipe
    let buffer = Locked(Data())
    outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil; return }
      let lines: [Data] = buffer.update { b in
        b.append(d)
        var out: [Data] = []
        while let nl = b.firstIndex(of: 10) {
          out.append(Data(b[b.startIndex..<nl]))
          b = Data(b[(nl + 1)...])
        }
        return out
      }
      guard let self else { return }
      for line in lines {
        guard let j = try? JSONValue.parse(line), let id = j["id"]?.intValue else { continue }
        if let done = self.lock.withLock({ self.pending.removeValue(forKey: id) }) { done(j) }
      }
    }
    errPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil; return }
      self?.lock.withLock { if (self?.stderrText.count ?? 0) < 4000 { self?.stderrText += String(decoding: d, as: UTF8.self) } }
    }
    p.terminationHandler = { [weak self] proc in
      guard let self else { return }
      let (was, waiting, err) = self.lock.withLock { () -> (Bool, Bool, String) in
        let was = self.child === proc
        if was { self.child = nil; self.stdin = nil }
        return (was, !self.pending.isEmpty, self.stderrText)
      }
      if was && waiting {
        if proc.terminationStatus != 0 { self.onError("The macOS helper stopped (exit \(proc.terminationStatus)). \(err.split(separator: "\n").first ?? "")".trimmingCharacters(in: .whitespaces)) }
        self.finishAll("helper_exited")
      }
    }
    do { try p.run() } catch {
      onError("The macOS helper could not start: \(String(describing: error).prefix(160))")
      return nil
    }
    child = p
    stdin = inPipe.fileHandleForWriting
    stderrText = ""
    return stdin
  }

  private func touch() {
    lock.withLock {
      idleTimer?.cancel()
      let item = DispatchWorkItem { [weak self] in
        guard let self else { return }
        if self.lock.withLock({ self.pending.isEmpty }) { self.kill() }
      }
      idleTimer = item
      DispatchQueue.global().asyncAfter(deadline: .now() + idleSeconds, execute: item)
    }
  }

  /** One request ({op, ...args}); the child's answer ({ok, ...} or {ok: false, error}). */
  public func request(_ op: String, _ args: [String: JSONValue] = [:], timeout: Double? = nil) async -> JSONValue {
    await withCheckedContinuation { (cont: CheckedContinuation<JSONValue, Never>) in
      let once = Locked(false)
      let resume: (JSONValue) -> Void = { v in if !once.update({ let was = $0; $0 = true; return was }) { cont.resume(returning: v) } }
      let (handle, id) = lock.withLock { () -> (FileHandle?, Int) in
        let h = startLocked()
        let id = nextId
        nextId += 1
        if h != nil { pending[id] = resume }
        return (h, id)
      }
      guard let handle else { return resume(unavailable) }
      touch()
      let limit = timeout ?? requestSeconds
      DispatchQueue.global().asyncAfter(deadline: .now() + limit) { [weak self] in
        guard let self, let done = self.lock.withLock({ self.pending.removeValue(forKey: id) }) else { return }
        done(["id": .number(Double(id)), "ok": false, "error": "timeout", "message": "That app took too long to answer."])
        self.kill() // it may be stuck inside that app: start fresh next time
        self.finishAll("timeout")
      }
      var msg = args
      msg["op"] = .string(op)
      msg["id"] = .number(Double(id))
      do {
        try handle.write(contentsOf: Data((JSONText.of(.object(msg)) + "\n").utf8))
      } catch {
        if let done = lock.withLock({ pending.removeValue(forKey: id) }) { done(["id": .number(Double(id)), "ok": false, "error": "helper_exited"]) }
      }
    }
  }

  public func stop() {
    lock.withLock { idleTimer?.cancel() }
    finishAll("stopped")
    kill()
  }
}
