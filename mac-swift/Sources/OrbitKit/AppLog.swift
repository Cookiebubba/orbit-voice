// Orbit Native's own log (profile/logs/native.log), next to the core's. Short lines: time, level,
// scope, message. Never keys, prompts or transcripts: callers log counts, states and reasons.
import Foundation

public final class AppLog: @unchecked Sendable {
  private var handle: FileHandle?
  private let lock = NSLock()
  private let fmt: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
  public init() {}

  public func open(dir: URL) {
    let logs = dir.appendingPathComponent("logs")
    try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
    let f = logs.appendingPathComponent("native.log")
    // Keep it small: start over past 2 MB.
    if let size = (try? FileManager.default.attributesOfItem(atPath: f.path)[.size]) as? Int, size > 2 << 20 { try? FileManager.default.removeItem(at: f) }
    if !FileManager.default.fileExists(atPath: f.path) { FileManager.default.createFile(atPath: f.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
    lock.withLock {
      handle = try? FileHandle(forWritingTo: f)
      _ = try? handle?.seekToEnd()
    }
  }

  public func info(_ scope: String, _ msg: String) { write("INFO", scope, msg) }
  public func warn(_ scope: String, _ msg: String) { write("WARN", scope, msg) }
  /** A line from the core's stderr (the core's own log already keeps user words out). */
  public func raw(_ scope: String, _ msg: String) { write("CORE", scope, String(msg.prefix(500))) }

  private func write(_ level: String, _ scope: String, _ msg: String) {
    let line = "\(fmt.string(from: Date())) \(level) [\(scope)] \(msg)\n"
    lock.withLock { try? handle?.write(contentsOf: Data(line.utf8)) }
    if ProcessInfo.processInfo.environment["ORBIT_LOG_STDERR"] == "1" { FileHandle.standardError.write(Data(line.utf8)) }
  }
}
