// The parity suite (../../parity/cases) run by the Swift runner against the Swift build:
//   scripts/build-app.sh --test && swift test --filter OrbitParityTests
// ORBIT_PARITY_AREA (comma list) and ORBIT_PARITY_CASE (a regex on ids) pick cases. A failing case fails the test with its reason; cases needing a feature the build doesn't have are listed,
// not failed. The results also go to parity/out/matrix-<app>-xctest.json.
import Foundation
import XCTest
@testable import OrbitKit

let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func nodeBinary() -> URL? {
  let env = ProcessInfo.processInfo.environment
  var c = [env["ORBIT_NODE"]].compactMap { $0 }
  let nvm = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
  if let vs = try? FileManager.default.contentsOfDirectory(atPath: nvm.path) { c += vs.sorted(by: >).map { nvm.appendingPathComponent("\($0)/bin/node").path } }
  c += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
  return c.map(URL.init(fileURLWithPath:)).first { FileManager.default.isExecutableFile(atPath: $0.path) }
}

final class OrbitParityTests: XCTestCase {
  func testParitySuite() async throws {
    let env = ProcessInfo.processInfo.environment
    let which = "swift"
    guard let node = nodeBinary() else { throw XCTSkip("no node for the test doubles") }
    let paths = ParityRunner.Paths(repo: repo, swiftApp: env["ORBIT_PARITY_SWIFT_APP"].map(URL.init(fileURLWithPath:)), node: node)
    if which == "swift", !FileManager.default.fileExists(atPath: paths.swiftApp.appendingPathComponent("Contents/Info.plist").path) {
      throw XCTSkip("build the test app first: scripts/build-app.sh --test")
    }
    let runner = ParityRunner(paths: paths)
    var cases = try runner.loadCases()
    if let areas = env["ORBIT_PARITY_AREA"]?.split(separator: ",").map(String.init) { cases = cases.filter { areas.contains($0.area) } }
    if let re = env["ORBIT_PARITY_CASE"].flatMap({ try? NSRegularExpression(pattern: $0) }) {
      cases = cases.filter { re.firstMatch(in: $0.id, range: NSRange($0.id.startIndex..., in: $0.id)) != nil }
    }
    XCTAssertFalse(cases.isEmpty)
    var rows: [JSONValue] = []
    var counts: [String: (pass: Int, total: Int)] = [:]
    for c in cases {
      let r = await runner.run(c, app: which)
      counts[c.area, default: (0, 0)].total += 1
      if r.status == "pass" { counts[c.area]!.pass += 1 }
      rows.append(["id": .string(c.id), "area": .string(c.area), which: ["status": .string(r.status), "ms": .number(Double(r.ms)), "error": r.error.map { .string($0) } ?? .null]])
      if r.status == "fail" || r.status == "error" { XCTFail("\(c.id): \(r.error ?? "")") }
      print("\(r.status.uppercased()) \(c.id) (\(r.ms) ms)\(r.error.map { ": \($0)" } ?? "")")
    }
    let summary = JSONValue.object(counts.mapValues { ["pass": .number(Double($0.pass)), "total": .number(Double($0.total))] })
    let out = repo.appendingPathComponent("parity/out")
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    try? JSONValue.object(["at": .string(ISO8601DateFormatter().string(from: Date())), "runner": "swift", "apps": [.string(which)], "cases": .array(rows), "summary": [which: summary]]).data(pretty: true).write(to: out.appendingPathComponent("matrix-\(which)-xctest.json"))
    for (area, n) in counts.sorted(by: { $0.key < $1.key }) { print("\(area): \(n.pass)/\(n.total)") }
  }
}
