// A child process for running Claude Code (and the login shell), as the core runs them: its own
// process group (so it and everything it starts, such as ripgrep, can be ended together), signals
// back at their defaults, no descriptors inherited but its own three, input written and closed,
// output read to the end. killTree is system.js's: SIGTERM to the group, SIGKILL 2 s later.
import Darwin
import Foundation
import OrbitKit

public struct ChildResult: Sendable, Equatable {
  /** The exit code, or nil when a signal ended it (Node's `close` code). */
  public var code: Int32?
  public var signal: Int32?
  public var stdout: Data
  public var stderr: Data
  public init(code: Int32?, signal: Int32? = nil, stdout: Data = Data(), stderr: Data = Data()) {
    self.code = code
    self.signal = signal
    self.stdout = stdout
    self.stderr = stderr
  }
}

/** A started child: its result when it has ended and its output is read, and a way to end it. */
public protocol RunningChild: AnyObject, Sendable {
  func finished() async -> ChildResult
  func killTree(sync: Bool)
}

/** Starts a child (the real one, or a stand-in in tests): exe, args, cwd, env, what goes in on stdin (nil: nothing). */
public typealias ChildSpawner = @Sendable (_ exe: String, _ args: [String], _ cwd: String, _ env: [String: String], _ stdin: Data?) throws -> RunningChild

public struct SpawnError: Error, CustomStringConvertible {
  public let description: String
}

public final class ChildProcess: RunningChild, @unchecked Sendable {
  public let pid: pid_t
  private let lock = NSLock()
  private var result: ChildResult?
  private var waiters: [CheckedContinuation<ChildResult, Never>] = []
  private var exited = false

  /** Every child still running, ended with the app (killAll). */
  private static let live = Locked<[pid_t: ChildProcess]>([:])

  public static let spawner: ChildSpawner = { exe, args, cwd, env, stdin in try ChildProcess(exe, args, cwd: cwd, env: env, stdin: stdin) }

  /**
   * Starts `exe` (a path, not looked up on PATH). Output beyond `maxOut`/`maxErr` bytes is read and
   * dropped. Throws a SpawnError when it can't start.
   */
  public init(_ exe: String, _ args: [String], cwd: String, env: [String: String], stdin: Data?, maxOut: Int = 2_000_000, maxErr: Int = 20_000) throws {
    var fa: posix_spawn_file_actions_t? = nil
    var attr: posix_spawnattr_t? = nil
    posix_spawn_file_actions_init(&fa)
    posix_spawnattr_init(&attr)
    defer {
      posix_spawn_file_actions_destroy(&fa)
      posix_spawnattr_destroy(&attr)
    }
    var outPipe: [Int32] = [-1, -1], errPipe: [Int32] = [-1, -1], inPipe: [Int32] = [-1, -1]
    guard pipe(&outPipe) == 0, pipe(&errPipe) == 0 else { throw SpawnError(description: String(cString: strerror(errno))) }
    if stdin != nil, pipe(&inPipe) != 0 { throw SpawnError(description: String(cString: strerror(errno))) }
    let closeAll = { for fd in outPipe + errPipe + inPipe where fd >= 0 { close(fd) } }

    if stdin != nil {
      posix_spawn_file_actions_adddup2(&fa, inPipe[0], 0)
    } else {
      posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
    }
    posix_spawn_file_actions_adddup2(&fa, outPipe[1], 1)
    posix_spawn_file_actions_adddup2(&fa, errPipe[1], 2)
    posix_spawn_file_actions_addchdir_np(&fa, cwd)
    // Its own process group; only the three descriptors above; signals at their defaults, none blocked.
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
    posix_spawnattr_setpgroup(&attr, 0)
    var all = sigset_t(), none = sigset_t()
    sigfillset(&all)
    sigemptyset(&none)
    posix_spawnattr_setsigdefault(&attr, &all)
    posix_spawnattr_setsigmask(&attr, &none)

    let argv: [UnsafeMutablePointer<CChar>?] = ([exe] + args).map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { for p in argv + envp { free(p) } }
    var child: pid_t = 0
    let rc = posix_spawn(&child, exe, &fa, &attr, argv, envp)
    guard rc == 0 else {
      closeAll()
      throw SpawnError(description: "spawn \(exe) \(String(cString: strerror(rc)))")
    }
    pid = child
    close(outPipe[1])
    close(errPipe[1])
    if stdin != nil { close(inPipe[0]) }
    Self.live.update { $0[child] = self }

    let group = DispatchGroup()
    let out = Locked(Data()), err = Locked(Data())
    for (fd, sink, cap) in [(outPipe[0], out, maxOut), (errPipe[0], err, maxErr)] {
      group.enter()
      Thread.detachNewThread {
        Self.drain(fd, into: sink, cap: cap)
        group.leave()
      }
    }
    if let stdin {
      let fd = inPipe[1]
      _ = fcntl(fd, F_SETNOSIGPIPE, 1) // a child that stops reading must not take Orbit down
      Thread.detachNewThread {
        stdin.withUnsafeBytes { raw in
          var off = 0
          while off < raw.count {
            let n = write(fd, raw.baseAddress! + off, raw.count - off)
            if n > 0 { off += n } else if n < 0 && errno == EINTR { continue } else { break }
          }
        }
        close(fd)
      }
    }
    let status = Locked<Int32>(0)
    group.enter()
    Thread.detachNewThread { [weak self] in
      var st: Int32 = 0
      while waitpid(child, &st, 0) < 0 && errno == EINTR {}
      status.set(st)
      if let self { self.lock.withLock { self.exited = true } }
      group.leave()
    }
    group.notify(queue: .global()) { [weak self] in
      let st = status.get()
      let normal = st & 0x7f == 0
      let r = ChildResult(code: normal ? (st >> 8) & 0xff : nil, signal: normal ? nil : st & 0x7f, stdout: out.get(), stderr: err.get())
      Self.live.update { _ = $0.removeValue(forKey: child) }
      guard let self else { return }
      let ws = self.lock.withLock { () -> [CheckedContinuation<ChildResult, Never>] in
        self.result = r
        defer { self.waiters = [] }
        return self.waiters
      }
      for w in ws { w.resume(returning: r) }
    }
  }

  private static func drain(_ fd: Int32, into sink: Locked<Data>, cap: Int) {
    var buf = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(fd, &buf, buf.count)
      if n > 0 {
        sink.update { d in if d.count < cap { d.append(contentsOf: buf[0..<n]) } }
      } else if n < 0 && errno == EINTR {
        continue
      } else {
        break
      }
    }
    close(fd)
  }

  public func finished() async -> ChildResult {
    await withCheckedContinuation { (c: CheckedContinuation<ChildResult, Never>) in
      let done: ChildResult? = lock.withLock {
        if let result { return result }
        waiters.append(c)
        return nil
      }
      if let done { c.resume(returning: done) }
    }
  }

  /** End it and everything it started: SIGTERM to its group, SIGKILL 2 s later (`sync`: SIGKILL now). */
  public func killTree(sync: Bool = false) {
    if lock.withLock({ exited }) && !sync { return }
    let pgid = pid
    if kill(-pgid, sync ? SIGKILL : SIGTERM) != 0 {
      kill(pgid, sync ? SIGKILL : SIGTERM)
      return
    }
    if !sync {
      DispatchQueue.global().asyncAfter(deadline: .now() + 2) { _ = kill(-pgid, SIGKILL) }
    }
  }

  /** Orbit is quitting: every child still running goes now. */
  public static func killAll() {
    for c in live.get().values { c.killTree(sync: true) }
  }

  /** Run to the end (or `timeout` seconds, then end it): nil if it couldn't start or ran out of time. */
  public static func run(_ exe: String, _ args: [String], cwd: String, env: [String: String], stdin: Data?, timeout: Double) async -> ChildResult? {
    guard let c = try? ChildProcess(exe, args, cwd: cwd, env: env, stdin: stdin) else { return nil }
    return await within(timeout, c)
  }

  /** The child's result, or nil (and it's ended) if it takes longer than `seconds`; ended too if the task is cancelled. */
  public static func within(_ seconds: Double, _ c: RunningChild) async -> ChildResult? {
    await withTaskCancellationHandler {
      await withTaskGroup(of: ChildResult?.self) { g in
        g.addTask { await c.finished() }
        g.addTask {
          try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1e9))
          return nil
        }
        let first = await g.next() ?? nil
        if first == nil { c.killTree(sync: false) }
        g.cancelAll()
        return first
      }
    } onCancel: {
      c.killTree(sync: false)
    }
  }
}
