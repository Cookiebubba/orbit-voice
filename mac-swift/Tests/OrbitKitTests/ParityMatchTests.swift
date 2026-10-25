import Foundation
import XCTest
@testable import OrbitKit

/** The Swift matchers against the cases the Node runner checks too (parity/test/match-cases.json). */
final class ParityMatchTests: XCTestCase {
  func testSharedCases() throws {
    let data = try Data(contentsOf: repoRoot.appendingPathComponent("parity/test/match-cases.json"))
    let cases = try XCTUnwrap(JSONValue.parse(data)["cases"]?.arrayValue)
    XCTAssertGreaterThan(cases.count, 50)
    for c in cases {
      let name = c["name"]?.stringValue ?? "?"
      let r = ParityMatch.match(c["actual"], c["expect"] ?? .null, vars: c["vars"] ?? .object([:]))
      XCTAssertEqual(r == nil, c["pass"]?.boolValue, "\(name): \(r ?? "matched but should not have")")
    }
  }

  func testInterpolationKeepsTypesForWholeValues() {
    let vars: JSONValue = ["f": ["w": 300], "s": "x"]
    XCTAssertEqual(ParityMatch.interpolate("${f.w}", vars), 300)
    XCTAssertEqual(ParityMatch.interpolate("w=${f.w} ${s}", vars), "w=300 x")
    XCTAssertEqual(ParityMatch.interpolate(["a": ["${s}"]], vars), ["a": ["x"]])
  }
}
