// The Swift engine against the Node core's own answers (parity/oracle/fixtures, made by
// parity/oracle/gen.mjs from the JS): exactly the same, case for case.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitKit

enum Oracle {
  static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardizedFileURL
  static func fixture(_ name: String) throws -> JSONValue {
    let url = repo.appendingPathComponent("parity/oracle/fixtures/\(name).json")
    guard let data = try? Data(contentsOf: url) else { throw XCTSkip("no oracle fixture \(name) (node parity/oracle/gen.mjs on a Mac)") }
    return try JSONValue.parse(data)
  }

  /** Each case's input and the core's output. */
  static func cases(_ name: String) throws -> [(input: JSONValue, output: JSONValue)] {
    try (fixture(name)["cases"]?.arrayValue ?? []).map { ($0["input"] ?? .null, $0["output"] ?? .null) }
  }

  /** Node is here (the Mac this is tested on) and can run a snippet of the core: its stdout. */
  static func node(_ script: String) throws -> String {
    let nvm = NSHomeDirectory() + "/.nvm/versions/node"
    let installed: [String] = ((try? FileManager.default.contentsOfDirectory(atPath: nvm)) ?? []).sorted().reversed().map { "\(nvm)/\($0)/bin/node" }
    let candidates: [String] = [ProcessInfo.processInfo.environment["ORBIT_NODE"], "/opt/homebrew/bin/node", "/usr/local/bin/node"].compactMap { $0 } + installed
    guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { throw XCTSkip("node not installed") }
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-oracle-\(UUID().uuidString).mjs")
    try script.write(to: file, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: file) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [file.path]
    p.currentDirectoryURL = repo
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    try p.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

final class OracleTests: XCTestCase {
  func testSettingsAreSanitizedExactlyAsConfigJsDoes() throws {
    let f = try Oracle.fixture("settings")
    XCTAssertEqual(f["defaults"]?.objectValue, EngineConfig.defaults, "the defaults")
    let cases = try Oracle.cases("settings")
    XCTAssertGreaterThan(cases.count, 3000)
    var wrong = 0
    for c in cases {
      let got = JSONValue.object(EngineConfig.sanitize(c.input.objectValue ?? [:]))
      if got != c.output {
        wrong += 1
        if wrong <= 10 { XCTFail("sanitize(\(c.input.text)): Swift \(got.text), Node \(c.output.text)") }
      }
    }
    XCTAssertEqual(wrong, 0, "cases that differ")
  }

  /** Starting up on what an install may have: the voice engine it starts on and what its file says (main 04098cc). */
  func testStartingUpChoosesTheVoiceEngineAsConfigJsDoes() throws {
    let f = try Oracle.fixture("settings")
    for c in f["engineFor"]?.arrayValue ?? [] {
      XCTAssertEqual(EngineConfig.engineFor(saved: c["saved"]?.stringValue, hadFile: c["hadFile"] == .bool(true), hasKey: c["hasKey"] == .bool(true)), c["output"]?.stringValue, c.text)
    }
    let loads = f["loads"]?.arrayValue ?? []
    XCTAssertGreaterThan(loads.count, 8)
    // (The file's text is the engine's own JSON: compared as JSON, or both absent.)
    let asJSON = { (v: JSONValue?) -> JSONValue in v?.stringValue.map { (try? JSONValue.parse($0)) ?? .string($0) } ?? .null }
    for s in loads {
      let name = s["name"]?.stringValue ?? "?"
      let dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-load-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: dir) }
      let file = dir.appendingPathComponent("settings.json")
      if let raw = s["raw"]?.stringValue { try Data(raw.utf8).write(to: file) } else if let o = s["file"], !o.isNull { try Data(JSONText.of(o).utf8).write(to: file) }
      let read = { () -> JSONValue in (try? String(contentsOf: file, encoding: .utf8)).map { .string($0) } ?? .null }
      let config = EngineConfig(dir: dir)
      let loaded = config.load(env: [:], hasKey: !(s["key"]?.stringValue ?? "").isEmpty)
      XCTAssertEqual(JSONValue.object(loaded), s["settings"], "\(name): the settings")
      XCTAssertEqual(asJSON(read()), asJSON(s["afterLoad"]), "\(name): the file after starting")
      config.update(["speed": 1.3])
      XCTAssertEqual(asJSON(read()), asJSON(s["afterChange"]), "\(name): the file after a change")
      config.update(["voiceEngine": EngineConfig.defaults["voiceEngine"]!])
      XCTAssertEqual(asJSON(read()), asJSON(s["afterDefaultEngine"]), "\(name): the file with the default engine")
    }
  }

  func testTheLogIsScrubbedExactlyAsLogJsDoes() throws {
    for c in try Oracle.cases("scrub") {
      XCTAssertEqual(EngineLog.scrub(c.input.stringValue ?? ""), c.output.stringValue, "scrub(\(c.input.text.prefix(80)))")
    }
  }

  func testHotkeyLabelsAreAMacsAsSystemJsMakesThem() throws {
    for c in try Oracle.cases("hotkey") {
      XCTAssertEqual(SettingsSchema.hotkeyLabel(c.input.stringValue ?? ""), c.output.stringValue, c.input.text)
    }
  }
}

final class JSNumberTests: XCTestCase {
  func testNumberOfAString() {
    let cases: [(String, Double?)] = [("1.5", 1.5), ("  2 ", 2), ("0x10", 16), ("0X1f", 31), ("0b11", 3), ("0o7", 7), ("1e3", 1000), (".5", 0.5), ("5.", 5), ("+1", 1), ("-1", -1),
                                      ("Infinity", .infinity), ("-Infinity", -.infinity), ("abc", nil), ("1,5", nil), ("1e", nil), ("0x", nil), ("-0x10", nil), ("", 0), ("\t7\n", 7)]
    for (s, want) in cases {
      let got = JSNumber.parse(s)
      if let want { XCTAssertEqual(got, want, s) } else { XCTAssertTrue(got.isNaN, s) }
    }
  }

  func testStringOfANumber() {
    for (n, s) in [(1.0, "1"), (1.5, "1.5"), (-2.0, "-2"), (0.1, "0.1"), (1e21, "1e+21"), (1.5e-7, "1.5e-7"), (123456789012.0, "123456789012"),
                   (0.00001, "0.00001"), (0.000001, "0.000001"), (1e-7, "1e-7"), (123.456, "123.456"), (1e20, "100000000000000000000"), (2.5e22, "2.5e+22"), (-0.5, "-0.5")] {
      XCTAssertEqual(JSNumber.string(n), s)
    }
  }
}

final class SealedStoreTests: XCTestCase {
  var dir: URL!
  let key = Data((0..<32).map { UInt8($0 * 7 & 0xff) })
  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-sealed-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }
  override func tearDown() { try? FileManager.default.removeItem(at: dir) }

  func testRoundTripOwnerOnlyAndRemoval() throws {
    let s = SealedKeyStore(sealer: try Sealer(key: key), file: dir.appendingPathComponent("k.sealed"))
    XCTAssertEqual(s.get(), "")
    try s.set("xai-0123456789abcdefghij")
    XCTAssertEqual(s.get(), "xai-0123456789abcdefghij")
    let attrs = try FileManager.default.attributesOfItem(atPath: s.file.path)
    XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    let raw = try Data(contentsOf: s.file)
    XCTAssertEqual(raw.prefix(4), Data("ONS1".utf8))
    XCTAssertNil(raw.range(of: Data("xai-".utf8)), "never in the clear")
    try s.set("")
    XCTAssertFalse(FileManager.default.fileExists(atPath: s.file.path))
    // Another key can't read it; junk reads as nothing.
    try s.set("secret")
    XCTAssertEqual(SealedKeyStore(sealer: try Sealer(key: Data(repeating: 1, count: 32)), file: s.file).get(), "")
    try Data("junk".utf8).write(to: s.file)
    XCTAssertEqual(s.get(), "")
    XCTAssertThrowsError(try Sealer(key: Data(count: 16)))
  }

  /** The sidecar's sealer (Node) and this one read each other's files. */
  func testNodeAndSwiftReadEachOther() throws {
    let sealer = try Sealer(key: key)
    let fromSwift = try sealer.seal("from swift ✓").base64EncodedString()
    let out = try Oracle.node("""
      import { makeSealer } from '\(Oracle.repo.appendingPathComponent("mac-swift/sidecar/sidecar.mjs").absoluteString)';
      const s = makeSealer(Buffer.from('\(key.base64EncodedString())', 'base64'));
      process.stdout.write(JSON.stringify({ opened: s.open(Buffer.from('\(fromSwift)', 'base64')), sealed: s.seal('from node ✓').toString('base64') }));
      """)
    let v = try JSONValue.parse(out)
    XCTAssertEqual(v["opened"]?.stringValue, "from swift ✓")
    XCTAssertEqual(try sealer.open(Data(base64Encoded: try XCTUnwrap(v["sealed"]?.stringValue))!), "from node ✓")
  }
}
