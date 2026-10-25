// Orbit's error and event log (src/log.js): the last 300 entries in memory (so the voice can read
// recent problems with a tool, and Settings shows them), and <profile>/logs/orbit.log as JSON lines
// (rotated to orbit.1.log past 1 MB) for bug reports.
//
// Never prompt text, transcript content or keys: callers pass short descriptions, and anything that
// looks like a secret is scrubbed before it's kept. Entries the Node core makes (while parts of it
// still run) arrive already scrubbed and are kept the same way, so there is one log, one writer.
import Foundation
import OrbitKit

public final class EngineLog: @unchecked Sendable {
  public static let maxMemory = 300
  public static let maxFileBytes = 1024 * 1024
  public enum Level: String, Sendable { case info, warn, error }

  public let dir: URL?
  private let lock = NSLock()
  private var entries: [JSONValue] = []
  private let now: @Sendable () -> Date

  /** `profile`: the profile folder (the log goes in its logs/); nil keeps it in memory only. */
  public init(profile: URL?, now: @escaping @Sendable () -> Date = { Date() }) {
    self.now = now
    if let p = profile {
      let d = p.appendingPathComponent("logs")
      dir = (try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)) != nil ? d : nil
    } else {
      dir = nil
    }
  }

  /** JavaScript's \s, exactly, for a character class (ICU's \s differs). */
  static let ws = #"\t\n\u000B\f\r    -     　﻿"#
  static let scrubRules: [(NSRegularExpression, String)] = [
    (try! NSRegularExpression(pattern: #"xai-[A-Za-z0-9_-]{8,}"#), "xai-***"),
    (try! NSRegularExpression(pattern: #"sk-ant-[A-Za-z0-9_-]{8,}"#), "sk-ant-***"),
    (try! NSRegularExpression(pattern: "Bearer[\(ws)]+[A-Za-z0-9._~+/=-]+", options: [.caseInsensitive]), "Bearer ***"),
    (try! NSRegularExpression(pattern: "(api[_-]?key|token|secret|password)([\"'\(ws):=]+)[^\(ws)\"',}]+", options: [.caseInsensitive]), "$1$2***"),
  ]

  /** log.js scrub(): secrets masked, then cut to 1000 UTF-16 units. */
  public static func scrub(_ text: String) -> String {
    var s = text
    for (re, template) in scrubRules {
      s = re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: template)
    }
    let ns = s as NSString
    return ns.length > 1000 ? ns.substring(to: 1000) : s
  }

  static func iso(_ d: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: d)
  }

  @discardableResult
  public func write(_ level: Level, _ source: String, _ message: String, _ detail: String? = nil) -> JSONValue {
    var e: [String: JSONValue] = ["at": .string(Self.iso(now())), "level": .string(level.rawValue), "source": .string(source), "message": .string(Self.scrub(message))]
    if let detail, !detail.isEmpty { e["detail"] = .string(Self.scrub(detail)) }
    let entry = JSONValue.object(e)
    keep(entry)
    return entry
  }

  public func info(_ source: String, _ message: String, _ detail: String? = nil) { write(.info, source, message, detail) }
  public func warn(_ source: String, _ message: String, _ detail: String? = nil) { write(.warn, source, message, detail) }
  public func error(_ source: String, _ message: String, _ detail: String? = nil) { write(.error, source, message, detail) }

  /** An entry the Node core made (already scrubbed there; scrubbed again, it changes nothing). */
  public func append(core entry: JSONValue) {
    guard case .object(var o) = entry, let level = o["level"]?.stringValue, Level(rawValue: level) != nil,
          o["at"]?.stringValue != nil, o["source"]?.stringValue != nil, let m = o["message"]?.stringValue else { return }
    o["message"] = .string(Self.scrub(m))
    if let d = o["detail"]?.stringValue { o["detail"] = .string(Self.scrub(d)) }
    keep(.object(o.filter { ["at", "level", "source", "message", "detail"].contains($0.key) }))
  }

  private func keep(_ entry: JSONValue) {
    lock.withLock {
      entries.append(entry)
      if entries.count > Self.maxMemory { entries.removeFirst(entries.count - Self.maxMemory) }
      guard let dir else { return }
      let file = dir.appendingPathComponent("orbit.log")
      if let size = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber, size.intValue > Self.maxFileBytes {
        let old = dir.appendingPathComponent("orbit.1.log")
        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: file, to: old)
      }
      let line = Data((Self.lineJSON(entry) + "\n").utf8)
      if let h = try? FileHandle(forWritingTo: file) {
        _ = try? h.seekToEnd()
        try? h.write(contentsOf: line)
        try? h.close()
      } else {
        try? line.write(to: file)
      }
    }
  }

  /** One entry as log.js writes it: its keys in order (at, level, source, message, detail). */
  static func lineJSON(_ e: JSONValue) -> String {
    var parts: [String] = []
    for k in ["at", "level", "source", "message", "detail"] {
      guard let v = e[k] else { continue }
      parts.append("\(JSONText.of(.string(k))):\(JSONText.of(v))")
    }
    return "{" + parts.joined(separator: ",") + "}"
  }

  /** recentLog(): newest last, at least `minLevel`, within `since`, the last `limit`. */
  public func recent(limit: Int = 20, minLevel: Level = .warn, since: TimeInterval = 24 * 3600) -> [JSONValue] {
    let rank: [String: Int] = ["info": 0, "warn": 1, "error": 2]
    let floor = now().addingTimeInterval(-since)
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let list = lock.withLock { entries }.filter { e in
      guard let l = e["level"]?.stringValue, (rank[l] ?? -1) >= rank[minLevel.rawValue]!, let at = e["at"]?.stringValue, let d = parser.date(from: at) else { return false }
      return d >= floor
    }
    return Array(list.suffix(limit))
  }
}
