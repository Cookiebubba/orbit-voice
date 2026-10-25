// Claude Code's sessions on disk and the watcher against src/sessions.js and src/watcher.js: the
// oracle's made-up home folder and its script of reads, appends and clock ticks
// (parity/oracle/sessions.mjs), run here the same way: the same answers, the same events.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitKit

final class SessionsOracleTests: XCTestCase {
  func testTheSameSessionsTranscriptsAndEvents() throws {
    let url = Oracle.repo.appendingPathComponent("parity/oracle/fixtures/sessions.json")
    guard let data = try? Data(contentsOf: url) else { throw XCTSkip("no sessions oracle fixture (node parity/oracle/gen.mjs on a Mac)") }
    let f = try JSONValue.parse(data)
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-sessions-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: home) }
    for (rel, content) in f["files"]?.objectValue ?? [:] {
      let file = home.appendingPathComponent(rel)
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data((content.stringValue ?? "").utf8).write(to: file)
    }
    let clock = Locked(f["t0"]?.doubleValue ?? 0)
    let sessions = Sessions(home: home, now: { clock.get() })
    let watcher = SessionWatcher(sessions: sessions, clock: { clock.get() })
    let events = Locked<[JSONValue]>([])
    watcher.on { e in events.update { $0.append(e) } }
    let steps = f["steps"]?.arrayValue ?? []
    let results = f["results"]?.arrayValue ?? []
    XCTAssertEqual(steps.count, results.count)
    var wrong = 0
    for (k, st) in steps.enumerated() {
      let a = st["args"] ?? .null
      let got: JSONValue
      switch st["op"]?.stringValue {
      case "list":
        got = .array(sessions.list(includeArchived: a["includeArchived"]?.boolValue ?? false).map(\.json))
      case "resolve":
        got = sessions.resolve(a["query"]?.stringValue, windowTitle: a["windowTitle"]?.stringValue)?.json ?? .null
      case "byTitle":
        got = sessions.findByTitle(a["title"]?.stringValue)?.json ?? .null
      case "find":
        got = sessions.findTranscript(a["cli"]?.stringValue ?? "", cwd: a["cwd"]?.stringValue).map { .string(String($0.path.dropFirst(home.path.count + 1))) } ?? .null
      case "tail":
        let t = try sessions.readTail(home.appendingPathComponent(a["file"]?.stringValue ?? ""), lastN: a["lastN"]?.intValue ?? 8, includeTools: a["includeTools"]?.boolValue ?? false,
                                      maxCharsPerMessage: a["maxCharsPerMessage"]?.intValue ?? 1500, maxBytes: a["maxBytes"]?.intValue ?? 4 * 1024 * 1024)
        got = t.json
      case "ago":
        got = .string(sessions.ago(a["ms"]?.doubleValue ?? 0))
      case "append":
        let fh = try FileHandle(forWritingTo: home.appendingPathComponent(st["file"]?.stringValue ?? ""))
        try fh.seekToEnd()
        try fh.write(contentsOf: Data((st["content"]?.stringValue ?? "").utf8))
        try fh.close()
        got = .null
      case "tick":
        clock.set(st["now"]?.doubleValue ?? 0)
        events.set([])
        watcher.tick()
        got = .array(events.get())
      case "working":
        got = .array(watcher.working())
      default:
        got = .null
      }
      if got != results[k] {
        wrong += 1
        if wrong <= 10 { XCTFail("step \(k) \(st["op"]?.stringValue ?? "") \(a.text.prefix(120)):\n  Swift \(got.text.prefix(600))\n  JS    \(results[k].text.prefix(600))") }
      }
    }
    XCTAssertEqual(wrong, 0, "steps that differ")
  }
}
