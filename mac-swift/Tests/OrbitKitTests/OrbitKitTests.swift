import XCTest
@testable import OrbitKit

final class OrbitKitTests: XCTestCase {
  func testVersionIsAString() { XCTAssertFalse(OrbitKit.version.isEmpty) }
}
