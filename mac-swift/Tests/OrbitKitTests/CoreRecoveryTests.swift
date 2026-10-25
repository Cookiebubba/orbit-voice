// What Orbit Native does when its core stops by itself: relaunch, unless it keeps stopping.
import Foundation
import XCTest
@testable import OrbitKit

final class CoreRecoveryTests: XCTestCase {
  var dir: URL!
  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-recovery-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }
  override func tearDown() { try? FileManager.default.removeItem(at: dir) }

  func testRelaunchesThenGivesUpWhenItKeepsStopping() {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    // Each stop is a new process: a fresh CoreRecovery reads what the last one wrote.
    for i in 0..<CoreRecovery.maxRestarts {
      XCTAssertEqual(CoreRecovery(profileDir: dir).coreStopped(at: t0.addingTimeInterval(Double(i) * 30)), .relaunch, "stop \(i + 1)")
    }
    XCTAssertEqual(CoreRecovery(profileDir: dir).coreStopped(at: t0.addingTimeInterval(120)), .giveUp)
  }

  func testOldStopsDoNotCount() {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let r = CoreRecovery(profileDir: dir)
    for i in 0..<CoreRecovery.maxRestarts { _ = r.coreStopped(at: t0.addingTimeInterval(Double(i))) }
    // Long after: the earlier ones have aged out of the window.
    XCTAssertEqual(r.coreStopped(at: t0.addingTimeInterval(CoreRecovery.window + 10)), .relaunch)
  }

  func testRunningWellForgetsStops() {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let r = CoreRecovery(profileDir: dir)
    for i in 0..<CoreRecovery.maxRestarts { _ = r.coreStopped(at: t0.addingTimeInterval(Double(i))) }
    r.ranWell(at: t0.addingTimeInterval(CoreRecovery.window + 10))
    XCTAssertEqual(r.stops(), [])
    XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("core-restarts.json").path))
    XCTAssertEqual(r.coreStopped(at: t0.addingTimeInterval(CoreRecovery.window + 11)), .relaunch)
  }

  func testAGarbledFileReadsAsNoStops() throws {
    try Data("not json".utf8).write(to: dir.appendingPathComponent("core-restarts.json"))
    XCTAssertEqual(CoreRecovery(profileDir: dir).stops(), [])
    XCTAssertEqual(CoreRecovery(profileDir: dir).coreStopped(), .relaunch)
  }

  func testRelaunchScriptWaitsThenOpensQuietly() {
    let s = CoreRecovery.relaunchScript(pid: 4242, bundle: URL(fileURLWithPath: "/Applications/Orbit's Native.app"))
    XCTAssertEqual(s, "while kill -0 4242 2>/dev/null; do sleep 0.2; done; open -n -g '/Applications/Orbit'\\''s Native.app' --args --orbit-restarted")
  }
}
