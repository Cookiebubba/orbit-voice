// A child process kept open and talked to line by line (Claude voice's `claude -p` in stream-json
// mode): stdin stays open for writes, stdout and stderr arrive as they come, and the end is reported
// once both are read and it has exited. Its own process group, ended as a tree (ChildProcess.killTree).
import Darwin
import Foundation
import OrbitKit

/** What Claude voice needs of its Claude Code process (the real one, or a stand-in in tests). */
public protocol StreamChild: AnyObject, Sendable {
  /** Called with each piece of stdout / stderr, and once when it's gone. Set before `start`. */
  var onStdout: (@Sendable (Data) -> Void)? { get set }
  var onStderr: (@Sendable (Data) -> Void)? { get set }
  var onClose: (@Sendable () -> Void)? { get set }
  /** The process id (0 for a stand-in). */
  var pid: Int32 { get }
  func start()
  func write(_ data: Data)
  func closeStdin()
  func killTree(sync: Bool)
}

public final class StreamProcess: StreamChild, @unchecked Sendable {
  public var onStdout: (@Sendable (Data) -> Void)?
  public var onStderr: (@Sendable (Data) -> Void)?
  public var onClose: (@Sendable () -> Void)?
  public private(set) var pid: Int32 = 0
  private let exe: String
  private let args: [String]
  private let cwd: String
  private let env: [String: String]
  private let lock = NSLock()
  private var stdinFd: Int32 = -1
  private let writes = DispatchQueue(label: "orbit.stream-process.stdin")
  private var exited = false

  public init(_ exe: String, _ args: [String], cwd: String, env: [String: String]) {
    self.exe = exe
    self.args = args
    self.cwd = cwd
    self.env = env
  }

  /** Starts it; a failure to start is reported as stderr and an end. */
  public func start() {
    var fa: posix_spawn_file_actions_t? = nil
    var attr: posix_spawnattr_t? = nil
    posix_spawn_file_actions_init(&fa)
    posix_spawnattr_init(&attr)
    defer {
      posix_spawn_file_actions_destroy(&fa)
      posix_spawnattr_destroy(&attr)
    }
    var inP: [Int32] = [-1, -1], outP: [Int32] = [-1, -1], errP: [Int32] = [-1, -1]
    guard pipe(&inP) == 0, pipe(&outP) == 0, pipe(&errP) == 0 else { return failed("Couldn't start Claude Code: \(String(cString: strerror(errno)))") }
    posix_spawn_file_actions_adddup2(&fa, inP[0], 0)
    posix_spawn_file_actions_adddup2(&fa, outP[1], 1)
    posix_spawn_file_actions_adddup2(&fa, errP[1], 2)
    posix_spawn_file_actions_addchdir_np(&fa, cwd)
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
    close(inP[0])
    close(outP[1])
    close(errP[1])
    guard rc == 0 else {
      close(inP[1]); close(outP[0]); close(errP[0])
      return failed("Couldn't start Claude Code: spawn \(exe) \(String(cString: strerror(rc)))")
    }
    pid = child
    _ = fcntl(inP[1], F_SETNOSIGPIPE, 1)
    lock.withLock { stdinFd = inP[1] }
    let group = DispatchGroup()
    for (fd, isOut) in [(outP[0], true), (errP[0], false)] {
      group.enter()
      Thread.detachNewThread { [weak self] in
        var buf = [UInt8](repeating: 0, count: 65536)
        while true {
          let n = read(fd, &buf, buf.count)
          if n > 0 {
            let d = Data(buf[0..<n])
            if isOut { self?.onStdout?(d) } else { self?.onStderr?(d) }
          } else if n < 0 && errno == EINTR {
            continue
          } else {
            break
          }
        }
        close(fd)
        group.leave()
      }
    }
    group.enter()
    Thread.detachNewThread { [weak self] in
      var st: Int32 = 0
      while waitpid(child, &st, 0) < 0 && errno == EINTR {}
      if let self { self.lock.withLock { self.exited = true } }
      group.leave()
    }
    group.notify(queue: .global()) { [weak self] in
      guard let self else { return }
      self.closeStdin()
      self.onClose?()
    }
  }

  private func failed(_ why: String) {
    onStderr?(Data(why.utf8))
    onClose?()
  }

  public func write(_ data: Data) {
    writes.async { [weak self] in
      guard let self else { return }
      let fd = self.lock.withLock { self.stdinFd }
      guard fd >= 0 else { return }
      data.withUnsafeBytes { raw in
        var off = 0
        while off < raw.count {
          let n = Darwin.write(fd, raw.baseAddress! + off, raw.count - off)
          if n > 0 { off += n } else if n < 0 && errno == EINTR { continue } else { break }
        }
      }
    }
  }

  public func closeStdin() {
    writes.async { [weak self] in
      guard let self else { return }
      let fd = self.lock.withLock { () -> Int32 in
        defer { self.stdinFd = -1 }
        return self.stdinFd
      }
      if fd >= 0 { close(fd) }
    }
  }

  public func killTree(sync: Bool) {
    guard pid > 0 else { return }
    if lock.withLock({ exited }) && !sync { return }
    let pgid = pid
    if kill(-pgid, sync ? SIGKILL : SIGTERM) != 0 {
      kill(pgid, sync ? SIGKILL : SIGTERM)
      return
    }
    if !sync { DispatchQueue.global().asyncAfter(deadline: .now() + 2) { _ = kill(-pgid, SIGKILL) } }
  }
}
