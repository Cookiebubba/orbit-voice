// Runs Orbit's Node core (mac-swift/sidecar/sidecar.mjs) as a child process and speaks its JSON line
// channel (see mac-swift/README.md "Sidecar channel"). stdout lines starting with the channel mark
// are messages; anything else the core prints (stderr, stray stdout) goes to the log handler.
import Foundation

public enum SidecarChannel {
  public static let mark = "\u{1}ORB "

  /** One stdout line → a message, or nil if it isn't a channel line. */
  public static func parse(line: String) -> JSONValue? {
    guard line.hasPrefix(mark) else { return nil }
    return try? JSONValue.parse(String(line.dropFirst(mark.count)))
  }

  /** The `ready` message → where the bridge is. */
  public static func endpoints(from msg: JSONValue) -> BridgeEndpoints? {
    guard msg["t"]?.stringValue == "ready", let b = msg["base"]?.stringValue, let base = URL(string: b), base.host == "127.0.0.1" else { return nil }
    var auth: [String: URL] = [:]
    for (k, v) in msg["auth"]?.objectValue ?? [:] {
      if let s = v.stringValue, let u = URL(string: s), u.host == "127.0.0.1", u.port == base.port { auth[k] = u }
    }
    return auth["main"] == nil ? nil : BridgeEndpoints(base: base, auth: auth)
  }
}

/** Splits a byte stream into lines (the channel can arrive in any chunking). */
public struct LineSplitter: Sendable {
  private var buf = Data()
  public init() {}
  public mutating func feed(_ d: Data) -> [String] {
    buf.append(d)
    var out: [String] = []
    while let nl = buf.firstIndex(of: 0x0A) {
      out.append(String(decoding: buf[buf.startIndex..<nl], as: UTF8.self))
      buf.removeSubrange(buf.startIndex...nl)
    }
    if buf.count > 4 << 20 { buf.removeAll() } // a runaway line: drop it rather than grow forever
    return out
  }
}

public final class Sidecar: @unchecked Sendable {
  public struct Config: Sendable {
    public var node: URL
    public var script: URL
    public var coreDir: URL
    public var profileDir: URL
    public var port: Int
    public var sealKey: Data
    public var extraEnv: [String: String]
    public init(node: URL, script: URL, coreDir: URL, profileDir: URL, port: Int, sealKey: Data, extraEnv: [String: String] = [:]) {
      self.node = node; self.script = script; self.coreDir = coreDir; self.profileDir = profileDir; self.port = port; self.sealKey = sealKey; self.extraEnv = extraEnv
    }
  }

  public var onReady: (@Sendable (BridgeEndpoints) -> Void)?
  public var onMessage: (@Sendable (JSONValue) -> Void)?
  public var onLog: (@Sendable (String) -> Void)?
  public var onExit: (@Sendable (Int32) -> Void)?

  private let config: Config
  private var process: Process?
  private var stdin: FileHandle?
  private let lock = NSLock()
  public private(set) var endpoints: BridgeEndpoints?

  public init(config: Config) { self.config = config }

  public var isRunning: Bool { lock.withLock { process?.isRunning ?? false } }
  public var pid: Int32 { lock.withLock { process?.processIdentifier ?? 0 } }

  public func start() throws {
    let p = Process()
    p.executableURL = config.node
    p.arguments = [config.script.path]
    var env = ProcessInfo.processInfo.environment.filter { k, _ in
      // The core needs PATH/HOME (to find Claude Code); nothing of Node's own config from the user's shell.
      !k.hasPrefix("NODE_") && !k.hasPrefix("npm_")
    }
    env["ORBIT_PROFILE_DIR"] = config.profileDir.path
    env["ORBIT_CORE_DIR"] = config.coreDir.path
    env["PORT"] = String(config.port)
    for (k, v) in config.extraEnv { env[k] = v }
    p.environment = env
    let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = errPipe
    let splitter = Locked(LineSplitter())
    let errSplitter = Locked(LineSplitter())
    outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      guard !d.isEmpty else { h.readabilityHandler = nil; return }
      let lines = splitter.update { $0.feed(d) }
      for line in lines { self?.handle(line: line) }
    }
    errPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      guard !d.isEmpty else { h.readabilityHandler = nil; return }
      for line in errSplitter.update({ $0.feed(d) }) where !line.isEmpty { self?.onLog?(line) }
    }
    p.terminationHandler = { [weak self] proc in self?.onExit?(proc.terminationStatus) }
    try p.run()
    lock.withLock {
      process = p
      stdin = inPipe.fileHandleForWriting
    }
    send(["t": "init", "sealKey": .string(config.sealKey.base64EncodedString())])
  }

  private func handle(line: String) {
    guard let msg = SidecarChannel.parse(line: line) else {
      if !line.isEmpty { onLog?(line) }
      return
    }
    if msg["t"]?.stringValue == "ready", let e = SidecarChannel.endpoints(from: msg) {
      lock.withLock { endpoints = e }
      onReady?(e)
    }
    onMessage?(msg)
  }

  public func send(_ msg: JSONValue) {
    guard let h = lock.withLock({ stdin }) else { return }
    var d = msg.data()
    d.append(0x0A)
    try? h.write(contentsOf: d)
  }

  /** Asks it to quit, then makes sure: SIGTERM after `grace`, SIGKILL after twice that. */
  public func stop(grace: TimeInterval = 1.5) {
    guard let p = lock.withLock({ process }), p.isRunning else { return }
    send(["t": "quit"])
    try? lock.withLock { stdin }?.close()
    let deadline = Date().addingTimeInterval(grace)
    while p.isRunning && Date() < deadline { usleep(20_000) }
    if p.isRunning { p.terminate() }
    let kill = Date().addingTimeInterval(grace)
    while p.isRunning && Date() < kill { usleep(20_000) }
    if p.isRunning { Darwin.kill(p.processIdentifier, SIGKILL) }
  }
}
