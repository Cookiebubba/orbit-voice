// The settings schema against src/config.js itself (run in node when it's installed), and the
// Settings model's optimistic save / bridge round trip / live events.
import Foundation
import XCTest
@testable import OrbitKit

enum Repo {
  /** The repo root (mac-swift/..), from this file's path. */
  static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

  static var node: String? {
    var c = [String]()
    if let n = ProcessInfo.processInfo.environment["ORBIT_NODE"] { c.append(n) }
    let nvm = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
    if let vs = try? FileManager.default.contentsOfDirectory(atPath: nvm.path) { c += vs.sorted().reversed().map { nvm.appendingPathComponent("\($0)/bin/node").path } }
    c += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    return c.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  /** Runs an ES module script with node in the repo; its stdout. */
  static func runNode(_ script: String, args: [String] = []) throws -> String {
    guard let node else { throw XCTSkip("node not installed") }
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-test-\(UUID().uuidString).mjs")
    try script.write(to: file, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: file) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [file.path] + args
    p.currentDirectoryURL = root
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    try p.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
  }
}

final class SettingsSchemaTests: XCTestCase {
  func testDefaultsAreConfigJsDefaults() throws {
    let configURL = Repo.root.appendingPathComponent("src/config.js").absoluteString
    let out = try Repo.runNode("import { DEFAULTS, LIMITS } from '\(configURL)'; console.log(JSON.stringify({ DEFAULTS, LIMITS, keys: Object.keys(DEFAULTS) }));")
    let v = try JSONValue.parse(out.trimmingCharacters(in: .whitespacesAndNewlines))
    XCTAssertEqual(v["keys"], .array(SettingsSchema.specs.map { .string($0.key) }), "same keys, same order")
    XCTAssertEqual(v["DEFAULTS"]?.objectValue, SettingsSchema.defaults)
    XCTAssertEqual(v["LIMITS"]?["minSpeed"]?.doubleValue, SettingsSchema.minSpeed)
    XCTAssertEqual(v["LIMITS"]?["maxSpeed"]?.doubleValue, SettingsSchema.maxSpeed)
  }

  /** The same inputs through config.js updateSettings and SettingsSchema.sanitize. */
  func testSanitizeMatchesConfigJs() throws {
    var cases: [JSONValue] = []
    let samples: [JSONValue] = [true, false, "true", "false", "yes", 1, 0, 2, 7, 8, -1, 0.5, 1.234, 1.2345, 3, 0.705, 9.99, 10, "1.25", " 2 ", "", "abc",
                                "always", "tap", "speak", "off", "qubit", "none", "buddy", "EVE", "eve-2", "a b", "haiku", "fable", "opus", "auto", "claude", "grok",
                                "moonshine", "parakeet-v2", "api-key", "/usr/local/bin/claude", "/x/notclaude", "relative/claude", "//share/claude",
                                ["Discord.exe", "discord.exe", "bad/name", 3], .null, ["a": 1]]
    for spec in SettingsSchema.specs where spec.kind != .object && spec.postable {
      for s in samples { cases.append([.string(spec.key), s]) }
    }
    let configURL = Repo.root.appendingPathComponent("src/config.js").absoluteString
    let script = """
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import { initConfig, updateSettings, getSetting } from '\(configURL)';
    const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const store = { kind: 'test', get: () => '', set() {} };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sanitize-'));
    const out = cases.map(([k, v]) => {
      fs.rmSync(path.join(dir, 'settings.json'), { force: true });
      initConfig({ dir, secrets: store, brainSecrets: store });
      updateSettings({ [k]: v });
      return getSetting(k);
    });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(JSON.stringify(out));
    """
    let input = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-cases-\(UUID().uuidString).json")
    try JSONValue.array(cases).data().write(to: input)
    defer { try? FileManager.default.removeItem(at: input) }
    let out = try Repo.runNode(script, args: [input.path])
    guard let results = try JSONValue.parse(out.trimmingCharacters(in: .whitespacesAndNewlines)).arrayValue else { return XCTFail("no output") }
    XCTAssertEqual(results.count, cases.count)
    var mismatches = 0
    for (c, js) in zip(cases, results) {
      let key = c[0]!.stringValue!, value = c[1]!
      let swift = SettingsSchema.sanitize(key, value) ?? SettingsSchema.byKey[key]!.defaultValue
      if swift != js {
        mismatches += 1
        XCTFail("\(key) = \(value): config.js keeps \(js), Swift \(swift)")
      }
    }
    XCTAssertEqual(mismatches, 0)
  }

  func testClampsAndRefusals() {
    XCTAssertEqual(SettingsSchema.sanitize("speed", 3), 1.5)
    XCTAssertEqual(SettingsSchema.sanitize("speed", 0.1), 0.7)
    XCTAssertEqual(SettingsSchema.sanitize("voiceVolume", 0.555), 0.56)
    XCTAssertEqual(SettingsSchema.sanitize("orbPulseAmount", 0.5), 0.1)
    XCTAssertNil(SettingsSchema.sanitize("costPerMinute", 10))
    XCTAssertNil(SettingsSchema.sanitize("listenMode", "sometimes"))
    XCTAssertNil(SettingsSchema.sanitize("buddySize", 2.5))
    XCTAssertNil(SettingsSchema.sanitize("avatarThrow", "yes"))
    XCTAssertEqual(SettingsSchema.sanitize("halfDuplex", "yes"), false)
    XCTAssertNil(SettingsSchema.sanitize("nope", 1))
  }

  func testHotkeyLabels() {
    XCTAssertEqual(SettingsSchema.hotkeyLabel("Control+Alt+G"), "⌃⌥G")
    XCTAssertEqual(SettingsSchema.hotkeyLabel("Command+Shift+k"), "⇧⌘K")
    XCTAssertEqual(SettingsSchema.hotkeyLabel("F5"), "F5")
    XCTAssertEqual(SettingsSchema.keyCaps("Control+Alt+Space"), ["⌃", "⌥", "Space"])
  }

  func testHotkeyRecorder() {
    XCTAssertEqual(HotkeyRecorder.accelerator(keyCode: 0x05, modifiers: [.control, .option]).accelerator, "Control+Alt+G")
    XCTAssertEqual(HotkeyRecorder.accelerator(keyCode: 0x60, modifiers: []).accelerator, "F5")
    XCTAssertNotNil(HotkeyRecorder.accelerator(keyCode: 0x05, modifiers: [.shift]).error)
    XCTAssertEqual(HotkeyRecorder.accelerator(keyCode: nil, modifiers: [.command]).partial, ["Command"])
    XCTAssertNotNil(HotkeyRecorder.accelerator(keyCode: 0x3F, modifiers: [.control]).error) // fn: not usable
  }
}

/** A bridge in memory that sanitizes like config.js. */
actor MemoryTransport: SettingsTransport {
  var settings: [String: JSONValue] = SettingsSchema.defaults
  var posts: [[String: JSONValue]] = []
  var fail = false
  func setFail(_ f: Bool) { fail = f }
  func config() async throws -> BridgeConfig {
    BridgeConfig(json: .object(["version": "1.3.0", "hasKey": true, "keyStorage": "macos-keychain", "settings": .object(settings)]))
  }
  func updateSettings(_ patch: [String: JSONValue]) async throws -> [String: JSONValue] {
    if fail { throw BridgeError(status: 500, message: "down") }
    posts.append(patch)
    for (k, v) in patch { if let c = SettingsSchema.sanitize(k, v) { settings[k] = c } }
    return settings
  }
}

@MainActor
final class SettingsModelTests: XCTestCase {
  func testLoadSetAndEvents() async {
    let t = MemoryTransport()
    let m = SettingsModel(transport: t)
    await m.load()
    XCTAssertTrue(m.loaded)
    XCTAssertTrue(m.hasKey)
    XCTAssertEqual(m.string("avatar"), "buddy")
    XCTAssertEqual(m.hotkeyLabel, "⌥⌘G")

    // Clamped here before it's sent, as the bridge would.
    let r = await m.set("speed", 2.4)
    XCTAssertEqual(r, .saved(1.5))
    let posts = await t.posts
    XCTAssertEqual(posts.last, ["speed": 1.5])

    // Refused here: nothing sent.
    let bad = await m.set("listenMode", "sometimes")
    if case .refused = bad {} else { XCTFail("\(bad)") }
    let hk = await m.set("wakeHotkey", "Control+K")
    if case .refused = hk {} else { XCTFail("\(hk)") }
    let n = await t.posts.count
    XCTAssertEqual(n, 1)

    // Changed elsewhere (settings.changed).
    m.apply(event: ["type": "settings.changed", "changed": ["avatar"], "settings": ["avatar": "qubit", "wakeHotkey": "Command+Shift+O"]])
    XCTAssertEqual(m.string("avatar"), "qubit")
    XCTAssertEqual(m.hotkeyLabel, "⇧⌘O")
    XCTAssertEqual(m.assistantName, "Grok")
    m.apply(event: ["type": "settings.changed", "settings": ["voiceEngine": "claude"]])
    XCTAssertEqual(m.assistantName, "Orbit")
  }

  func testFailedSaveShowsTheOldValue() async {
    let t = MemoryTransport()
    let m = SettingsModel(transport: t)
    await m.load()
    await t.setFail(true)
    let r = await m.set("halfDuplex", true)
    XCTAssertEqual(r, .failed("down"))
    XCTAssertEqual(m.bool("halfDuplex"), false)
  }

  func testAppStateHandlesEvents() {
    let m = SettingsModel(transport: MemoryTransport())
    let app = AppStateModel(settings: m)
    var finished: [String] = []
    var woke = 0
    app.onFinished = { finished.append($0.title) }
    app.onWake = { woke += 1 }
    app.handle(["type": "claude.status", "working": [["id": "1", "title": "Fix"]]])
    XCTAssertEqual(app.claudeWorking.map(\.title), ["Fix"])
    app.handle(["type": "claude.finished", "id": "1", "title": "Fix", "summary": "done"])
    app.handle(["type": "orbit.wake"])
    app.handle(["type": "settings.changed", "settings": ["buddySize": 3]])
    XCTAssertEqual(finished, ["Fix"])
    XCTAssertEqual(woke, 1)
    XCTAssertEqual(m.int("buddySize"), 3)
  }

  func testLauncherWords() {
    XCTAssertEqual(LauncherStatus.status(phase: .off, asleep: false, muted: false, tap: false, draft: false), "Sleeping")
    XCTAssertEqual(LauncherStatus.status(phase: .listening, asleep: false, muted: true, tap: false, draft: false), "Muted")
    XCTAssertEqual(LauncherStatus.status(phase: .speaking, asleep: true, muted: false, tap: true, draft: true), "Waiting for your answer")
    XCTAssertEqual(LauncherStatus.hint(phase: .off, asleep: false, tap: false, draft: false, wakeWordOn: false, hotkey: "⌃⌥G"), "Click Qubit or press ⌃⌥G")
    XCTAssertNil(LauncherStatus.hint(phase: .listening, asleep: false, tap: false, draft: false, wakeWordOn: false, hotkey: "⌃⌥G"))
    let caps = (0..<5).map { VoiceCaption(id: "\($0)", who: $0 == 1 ? .note : .grok, text: "\($0)") } + [VoiceCaption(id: "n", who: .note, text: "last")]
    XCTAssertEqual(CaptionList.recent(caps).map(\.id), ["3", "4", "n"])
  }
}
