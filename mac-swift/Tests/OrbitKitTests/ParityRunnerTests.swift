import Foundation
import XCTest
@testable import OrbitKit

final class ParityRunnerTests: XCTestCase {
  func testArithmetic() {
    XCTAssertEqual(ParityRunner.arithmetic("1 + 2 * 3"), 7)
    XCTAssertEqual(ParityRunner.arithmetic("(1 + 2) * 3"), 9)
    XCTAssertEqual(ParityRunner.arithmetic("-4 / 2 + 10"), 8)
    XCTAssertEqual(ParityRunner.arithmetic("200.5 + 41 / 2"), 221)
    XCTAssertEqual(ParityRunner.arithmetic("1e3 - 1"), 999)
    XCTAssertNil(ParityRunner.arithmetic("1 + process.exit()"))
    XCTAssertNil(ParityRunner.arithmetic("1 +"))
    XCTAssertNil(ParityRunner.arithmetic("(1"))
    XCTAssertNil(ParityRunner.arithmetic("1 / 0"))
  }

  func testLoadsEveryCaseWithUniqueIds() throws {
    let r = ParityRunner(paths: .init(repo: repoRoot, node: URL(fileURLWithPath: "/usr/bin/true")))
    let cases = try r.loadCases()
    XCTAssertGreaterThan(cases.count, 100)
    XCTAssertEqual(Set(cases.map(\.id)).count, cases.count)
    let areas = Set(cases.map(\.area))
    for a in ["bridge", "settings", "avatar", "onboarding", "window", "voice"] { XCTAssertTrue(areas.contains(a), a) }
    for c in cases { XCTAssertFalse(c.raw["steps"]?.arrayValue?.isEmpty ?? true, c.id) }
  }

  func testRawHTTPParsesChunkedBodies() throws {
    let raw = Data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/html\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n".utf8)
    let r = try RawHTTP.parse(raw)
    XCTAssertEqual(r.status, 200)
    XCTAssertEqual(r.headers["content-type"], "text/html")
    XCTAssertEqual(String(decoding: r.body, as: UTF8.self), "hello world")
  }

  func testFakeClaudeRecordReading() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("parity-rec-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let lines = [
      #"{"kind":"start","model":"haiku"}"#,
      #"{"kind":"turn","text":"[Orbit warm-up, not the user]","reply":"OK"}"#,
      #"{"kind":"turn","text":"tell claude to add tests","reply":"<tool>{\"name\": \"draft_prompt\", \"arguments\": {}}</tool>"}"#,
      #"{"kind":"turn","text":"[Tool result: draft_prompt] {}","reply":"Drafted."}"#,
    ]
    try lines.joined(separator: "\n").write(to: dir.appendingPathComponent("fake-claude.jsonl"), atomically: true, encoding: .utf8)
    let rec = ParityRunner.readRecord(dir, "fake-claude")
    XCTAssertEqual(rec["turns"]?.arrayValue?.count, 2)
    XCTAssertEqual(rec["toolCalls"], ["draft_prompt"])
    XCTAssertEqual(rec["toolResults"], ["draft_prompt"])
    XCTAssertEqual(rec["starts"]?.arrayValue?.first?["model"], "haiku")
  }
}
