// The Claude driver against the macOS port's own: every scenario the oracle recorded
// (parity/oracle/desktop.mjs) replayed: the Swift driver must send the same helper requests, in the
// same order, and come to the same results, given the same answers.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitKit

final class DesktopOracleTests: XCTestCase {
  func fixture() throws -> JSONValue {
    let url = Oracle.repo.appendingPathComponent("parity/oracle/fixtures/desktop.json")
    guard let data = try? Data(contentsOf: url) else { throw XCTSkip("no desktop oracle fixture (node parity/oracle/gen.mjs on a Mac, with the macOS port)") }
    return try JSONValue.parse(data)
  }

  /** Hands out the recorded answers in order, noting any request that isn't the recorded one. */
  final class Replay: @unchecked Sendable {
    let expected: [JSONValue]
    let responses: [JSONValue]
    let lock = NSLock()
    var at = 0
    var problems: [String] = []
    init(expected: [JSONValue], responses: [JSONValue]) { self.expected = expected; self.responses = responses }

    func request(_ op: String, _ args: [String: JSONValue]) -> JSONValue? {
      lock.withLock {
        guard at < expected.count else {
          problems.append("an extra request \(op) \(JSONValue.object(args).text.prefix(160))")
          return nil
        }
        let e = expected[at]
        at += 1
        if e["op"]?.stringValue != op || e["args"] != .object(args) {
          problems.append("request \(at): Swift \(op) \(JSONValue.object(args).text.prefix(200)), JS \(e["op"]?.stringValue ?? "") \(e["args"]?.text.prefix(200) ?? "")")
        }
        let r = responses[e["r"]?.intValue ?? 0]
        return r == .null ? nil : r
      }
    }
  }

  func testTheDriverMakesTheSameRequestsAndAnswers() async throws {
    let f = try fixture()
    let responses = f["responses"]?.arrayValue ?? []
    let scenarios = f["scenarios"]?.arrayValue ?? []
    XCTAssertGreaterThan(scenarios.count, 40)
    var steps = 0
    var wrong = 0
    for sc in scenarios {
      let name = sc["name"]?.stringValue ?? "?"
      for step in sc["steps"]?.arrayValue ?? [] {
        steps += 1
        let mode = step["mode"]?.stringValue ?? ""
        let args = (step["args"]?.arrayValue ?? []).compactMap(\.stringValue)
        let replay = Replay(expected: step["requests"]?.arrayValue ?? [], responses: responses)
        let d = ClaudeDesktop(request: { op, a in replay.request(op, a) }, onlyPid: sc["onlyPid"]?.intValue ?? 0, sleep: { _ in })
        let got = await d.run(mode, args)
        let want = step["result"] ?? .null
        var problems = replay.problems
        if replay.at != replay.expected.count { problems.append("only \(replay.at) of \(replay.expected.count) requests made") }
        if got != want { problems.append("result: Swift \(got.text.prefix(400)), JS \(want.text.prefix(400))") }
        if !problems.isEmpty {
          wrong += 1
          if wrong <= 12 { XCTFail("\(name) / \(mode) \(args.joined(separator: " ")):\n  " + problems.prefix(4).joined(separator: "\n  ")) }
        }
      }
    }
    XCTAssertGreaterThan(steps, 100)
    XCTAssertEqual(wrong, 0, "steps that differ")
  }

  func testArgumentsAndNamesAsDesktopPs1ReadsThem() {
    XCTAssertEqual(ClaudeDesktop.parseArgs(["-TitleB64", "eA==", "-ExpectNew", "-FrontHwnd", "12", "-Rects"]), ["TitleB64": "eA==", "ExpectNew": "true", "FrontHwnd": "12", "Rects": "true"])
    XCTAssertEqual(ClaudeDesktop.parseArgs(["stray", "-Action", "status"]), ["Action": "status"])
    XCTAssertEqual(ClaudeDesktop.parseArgs(["-Choice"]), ["Choice": ""])
    XCTAssertEqual(ClaudeDesktop.answerKind("Allow once"), "allow_once")
    XCTAssertEqual(ClaudeDesktop.answerKind("Always allow for this website"), "allow_always")
    XCTAssertEqual(ClaudeDesktop.answerKind("Allow for this session"), "allow_session")
    XCTAssertEqual(ClaudeDesktop.answerKind("No, keep going"), "deny")
    XCTAssertNil(ClaudeDesktop.answerKind("Send"))
    XCTAssertEqual(ClaudeDesktop.normText("it’s  \"fine\"\r\n ok"), ClaudeDesktop.normText("it's “fine”\nok"))
    XCTAssertEqual(ClaudeDesktop.decode(Data("hé".utf8).base64EncodedString()), "hé")
    XCTAssertEqual(ClaudeDesktop.decode(nil), "")
  }
}
