// The engine's state on disk: settings (load order, saving, listeners), the log, usage.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitKit

final class EngineStateTests: XCTestCase {
  var dir: URL!
  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-state-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }
  override func tearDown() { try? FileManager.default.removeItem(at: dir) }

  func testLoadOrderDefaultsThenEnvThenFile() throws {
    try Data(#"{"voice":"ara","avatar":"qubit","speed":9,"junk":1}"#.utf8).write(to: dir.appendingPathComponent("settings.json"))
    let env = dir.appendingPathComponent(".env")
    try "# a comment\nGROK_VOICE_MODEL='grok-test'\nGROK_VOICE=rex\n".write(to: env, atomically: true, encoding: .utf8)
    let c = EngineConfig(dir: dir)
    let s = c.load(env: ["GROK_VOICE_SPEED": "1.3", "GROK_VOICE": "sal"], dotEnv: env)
    XCTAssertEqual(s["voice"], "ara", "the file wins over the environment")
    XCTAssertEqual(s["speed"], 1.5, "clamped")
    XCTAssertEqual(s["model"], "grok-test", ".env")
    XCTAssertEqual(s["avatar"], "qubit")
    XCTAssertNil(s["junk"])
    XCTAssertEqual(Set(s.keys), Set(EngineConfig.keys))
  }

  func testLegacyBuddyOffMeansNoAvatar() throws {
    try Data(#"{"buddy":false}"#.utf8).write(to: dir.appendingPathComponent("settings.json"))
    XCTAssertEqual(EngineConfig(dir: dir).load(env: [:])["avatar"], "none")
    try Data(#"{"buddy":false,"avatar":"qubit"}"#.utf8).write(to: dir.appendingPathComponent("settings.json"))
    XCTAssertEqual(EngineConfig(dir: dir).load(env: [:])["avatar"], "qubit")
  }

  func testUpdateSavesOnlyWhatDiffersAndTellsListeners() throws {
    let c = EngineConfig(dir: dir)
    c.load(env: [:])
    let heard = Locked<[[String]]>([])
    let stop = c.onChange { changed, _ in heard.update { $0.append(changed) } }
    XCTAssertEqual(c.update(["voice": "Leo", "speed": 1]), ["voice"], "speed 1 is no change")
    XCTAssertEqual(c.update(["voice": "leo"]), [])
    XCTAssertEqual(c.update(["orbPosition": [10.4, 20.6], "anywhereUnderOrbit": ["Discord.exe", "discord.exe"]]), ["orbPosition", "anywhereUnderOrbit"])
    let saved = try JSONValue.parse(Data(contentsOf: dir.appendingPathComponent("settings.json")))
    XCTAssertEqual(saved.objectValue, ["voice": "leo", "orbPosition": [10, 21], "anywhereUnderOrbit": ["discord.exe"]])
    XCTAssertEqual(c.update(["voice": "eve"]), ["voice"])
    XCTAssertNil(try JSONValue.parse(Data(contentsOf: dir.appendingPathComponent("settings.json")))["voice"], "back to the default: not saved")
    stop()
    c.update(["voice": "rex"])
    XCTAssertEqual(heard.get(), [["voice"], ["orbPosition", "anywhereUnderOrbit"], ["voice"]])
    XCTAssertNil(c.publicSettings()["orbPosition"])
    XCTAssertEqual(c.publicSettings()["hotkeyLabel"], .string(SettingsSchema.hotkeyLabel(HotkeyAccelerator.defaultAccelerator)))
  }

  func testTheLogKeepsItsLastEntriesAndRotates() throws {
    let clock = Locked(Date(timeIntervalSince1970: 1_800_000_000))
    let log = EngineLog(profile: dir, now: { clock.get() })
    log.info("a", "old one")
    clock.set(Date(timeIntervalSince1970: 1_800_000_000 + 25 * 3600))
    log.warn("b", "token=abc123 here", "detail with sk-ant-xxxxxxxxxx")
    log.error("c", "boom")
    XCTAssertEqual(log.recent(minLevel: .info).count, 2, "a day back only")
    XCTAssertEqual(log.recent().map { $0["message"]?.stringValue }, ["token=*** here", "boom"])
    XCTAssertEqual(log.recent(minLevel: .error).count, 1)
    XCTAssertEqual(log.recent(limit: 1, minLevel: .info).first?["source"], "c")
    let file = dir.appendingPathComponent("logs/orbit.log")
    let lines = try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
    XCTAssertEqual(lines.count, 3)
    XCTAssertTrue(lines[1].hasPrefix(#"{"at":"2026-"#) || lines[1].hasPrefix(#"{"at":"20"#))
    XCTAssertTrue(lines[1].contains(#""level":"warn","source":"b","message":"token=*** here","detail":"detail with sk-ant-***"}"#))
    for i in 0..<400 { log.info("x", "entry \(i)") }
    XCTAssertEqual(log.recent(limit: 1000, minLevel: .info).count, EngineLog.maxMemory)
    // Past 1 MB the file moves to orbit.1.log.
    try Data(repeating: 65, count: EngineLog.maxFileBytes + 1).write(to: file)
    log.info("x", "after")
    XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("logs/orbit.1.log").path))
    XCTAssertEqual(try String(contentsOf: file, encoding: .utf8).split(separator: "\n").count, 1)
    // Core entries: kept, junk dropped.
    log.append(core: ["at": "2026-10-25T10:00:00.000Z", "level": "nope", "source": "s", "message": "m"])
    log.append(core: ["level": "info", "message": "no time"])
    XCTAssertEqual(try String(contentsOf: file, encoding: .utf8).split(separator: "\n").count, 1)
  }

  func testUsageAddsUpByDayAndMonth() throws {
    let clock = Locked(Date())
    let u = Usage(dir: dir, now: { clock.get() })
    u.add(seconds: 59.6)
    u.add(seconds: 60.4)
    u.add(seconds: -5)
    let s = u.summary(costPerMinute: 0.1)
    XCTAssertEqual(s.at(path: "today.minutes"), 2)
    XCTAssertEqual(s.at(path: "today.cost"), 0.2)
    XCTAssertEqual(s.at(path: "month.minutes"), 2)
  }
}
