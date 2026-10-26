// Claude Code runs (the child process), the speech-model downloads, and the engine's voice and
// second-brain routes end to end: a stand-in Claude Code (a shell script) and a stand-in xAI here.
import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import OrbitBridge
@testable import OrbitEngine
@testable import OrbitKit

final class ChildProcessTests: XCTestCase {
  func testInputGoesInAndOutputCodeAndFolderComeBack() async throws {
    let cat = try ChildProcess("/bin/cat", [], cwd: "/", env: [:], stdin: Data("hello, Claude".utf8))
    let r = await cat.finished()
    XCTAssertEqual(String(decoding: r.stdout, as: UTF8.self), "hello, Claude")
    XCTAssertEqual(r.code, 0)
    let sh = await ChildProcess.run("/bin/sh", ["-c", "pwd; echo oops >&2; echo \"$ONLY\"; exit 3"], cwd: "/usr", env: ["ONLY": "this"], stdin: nil, timeout: 10)
    XCTAssertEqual(sh?.code, 3)
    XCTAssertEqual(String(decoding: sh?.stdout ?? Data(), as: UTF8.self), "/usr\nthis\n")
    XCTAssertEqual(String(decoding: sh?.stderr ?? Data(), as: UTF8.self), "oops\n")
    let env = await ChildProcess.run("/usr/bin/env", [], cwd: "/", env: ["A": "1"], stdin: nil, timeout: 10)
    XCTAssertEqual(String(decoding: env?.stdout ?? Data(), as: UTF8.self), "A=1\n", "only the environment it was given")
    XCTAssertThrowsError(try ChildProcess("/no/such/claude", [], cwd: "/", env: [:], stdin: nil))
  }

  func testItsOwnGroupEndsWithEverythingItStarted() async throws {
    let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-child-\(UUID().uuidString)").path
    defer { try? FileManager.default.removeItem(atPath: pidFile) }
    let c = try ChildProcess("/bin/sh", ["-c", "sleep 30 & echo $! > '\(pidFile)'; wait"], cwd: "/", env: [:], stdin: nil)
    XCTAssertEqual(getpgid(c.pid), c.pid, "it leads a process group of its own")
    var grandchild: pid_t = 0
    for _ in 0..<100 where grandchild == 0 {
      grandchild = pid_t((try? String(contentsOfFile: pidFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    XCTAssertGreaterThan(grandchild, 0)
    let started = Date()
    c.killTree(sync: false)
    let r = await c.finished()
    XCTAssertNil(r.code, "ended by a signal")
    XCTAssertLessThan(Date().timeIntervalSince(started), 3)
    var gone = false
    for _ in 0..<150 where !gone {
      gone = kill(grandchild, 0) != 0
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    XCTAssertTrue(gone, "what it started ended too")
  }

  func testATimeLimitOrACancelEndsIt() async throws {
    let started = Date()
    let r = await ChildProcess.run("/bin/sleep", ["5"], cwd: "/", env: [:], stdin: nil, timeout: 0.3)
    XCTAssertNil(r)
    XCTAssertLessThan(Date().timeIntervalSince(started), 3)
    let c = try ChildProcess("/bin/sleep", ["5"], cwd: "/", env: [:], stdin: nil)
    let t = Task { await ChildProcess.within(30, c) }
    try await Task.sleep(nanoseconds: 200_000_000)
    t.cancel()
    let res = await t.value
    XCTAssertNil(res)
    XCTAssertLessThan(Date().timeIntervalSince(started), 4)
  }
}

final class VoiceModelsTests: XCTestCase {
  var dir: URL!

  override func setUp() async throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-vm-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

  /** A .tar.bz2 of `files` under `top`, made with the system's tar. */
  func archive(_ top: String, _ files: [String]) throws -> Data {
    let src = dir.appendingPathComponent("src-\(UUID().uuidString)")
    for f in files {
      let u = src.appendingPathComponent(top).appendingPathComponent(f)
      try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data("model \(f)".utf8).write(to: u)
    }
    let out = dir.appendingPathComponent("\(top).tar.bz2")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
    p.arguments = ["-cjf", out.path, "-C", src.path, top]
    try p.run()
    p.waitUntilExit()
    XCTAssertEqual(p.terminationStatus, 0)
    return try Data(contentsOf: out)
  }

  static func sha(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

  func serve(_ files: [String: Data]) -> VoiceModels.Fetcher {
    { url in
      guard let d = files[url.lastPathComponent] else { return (404, nil) }
      return (200, AsyncThrowingStream { c in
        var at = 0
        while at < d.count {
          c.yield(d.subdata(in: at..<min(d.count, at + 1000)))
          at += 1000
        }
        c.finish()
      })
    }
  }

  func testDownloadsVerifiesUnpacksAndMarks() async throws {
    let vad = Data("vad model".utf8)
    let tts = try archive("tts-dir", ["model.fp32.onnx", "voices.bin"])
    let catalog = [
      SpeechModelFile(id: "vad", file: "vad.onnx", url: "https://example.invalid/vad.onnx", sha256: Self.sha(vad), size: vad.count),
      SpeechModelFile(id: "tts", file: "tts-dir.tar.bz2", dir: "tts-dir", url: "https://example.invalid/tts-dir.tar.bz2", sha256: Self.sha(tts), size: tts.count),
    ]
    let root = dir.appendingPathComponent("models").path
    let logs = Locked<[String]>([])
    let m = VoiceModels(root: root, fetch: serve(["vad.onnx": vad, "tts-dir.tar.bz2": tts]), log: { l in logs.update { $0.append(l) } }, voiceCatalog: catalog)
    let first = m.startDownload()
    XCTAssertEqual(m.status()["state"], "downloading", "downloading from the moment it starts")
    let second = m.startDownload()
    try await first?.value
    try await second?.value
    let fm = FileManager.default
    XCTAssertTrue(fm.fileExists(atPath: "\(root)/vad.onnx"))
    XCTAssertTrue(fm.fileExists(atPath: "\(root)/tts-dir/voices.bin"), "unpacked")
    XCTAssertFalse(fm.fileExists(atPath: "\(root)/tts-dir.tar.bz2"), "the archive goes once unpacked")
    XCTAssertFalse(fm.fileExists(atPath: "\(root)/vad.onnx.part"))
    let marker = try JSONValue.parse(Data(contentsOf: URL(fileURLWithPath: "\(root)/verified.json")))
    XCTAssertEqual(marker["models"], .array(catalog.map { .string($0.sha256) }))
    XCTAssertEqual(m.status(), ["state": "ready", "percent": 100, "error": ""])
    XCTAssertEqual(logs.get(), ["Claude voice: vad model ready", "Claude voice: tts model ready"])
  }

  func testAChoiceOfSpeechToTextAndAFileThatFailsItsCheck() async throws {
    let pack = try archive("stt-dir", ["model.int8.onnx", "tokens.txt"])
    let choice = SttChoice(id: "parakeet-110m", label: "Parakeet 110M", bundled: false, maxSeconds: 28,
                           download: SpeechModelFile(id: "parakeet-110m", file: "stt-dir.tar.bz2", dir: "stt-dir", url: "https://example.invalid/stt-dir.tar.bz2", sha256: Self.sha(pack), size: pack.count),
                           files: ["model.int8.onnx", "tokens.txt"])
    let root = dir.appendingPathComponent("models").path
    let m = VoiceModels(root: root, fetch: serve(["stt-dir.tar.bz2": pack]), sttCatalog: [VoiceModels.stt[0], choice])
    XCTAssertFalse(m.sttReady("parakeet-110m"))
    try await m.downloadStt("parakeet-110m")
    XCTAssertTrue(m.sttReady("parakeet-110m"))
    XCTAssertEqual(m.sttStatus()["parakeet-110m"]?["state"], "ready")
    try await m.downloadStt("parakeet-110m") // (there already: nothing fetched)

    let bad = SttChoice(id: "parakeet-110m", label: "Parakeet 110M", bundled: false, maxSeconds: 28,
                        download: SpeechModelFile(id: "x", file: "stt-dir.tar.bz2", dir: "other-dir", url: "https://example.invalid/stt-dir.tar.bz2", sha256: String(repeating: "0", count: 64), size: pack.count),
                        files: ["model.int8.onnx"])
    let m2 = VoiceModels(root: dir.appendingPathComponent("models2").path, fetch: serve(["stt-dir.tar.bz2": pack]), sttCatalog: [bad])
    do {
      try await m2.downloadStt("parakeet-110m")
      XCTFail("a file that fails its check is refused")
    } catch {
      XCTAssertEqual(VoiceModels.message(error), "Parakeet 110M failed its checksum")
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("models2/stt-dir.tar.bz2.part").path), "and not kept")
    XCTAssertEqual(m2.sttStatus()["parakeet-110m"]?["error"], "Parakeet 110M failed its checksum")
    XCTAssertThrowsError(try m2.startStt("whisper"))
  }
}

final class EngineVoiceBrainTests: XCTestCase {
  var root: URL!
  var engine: Engine!
  var port: Int!
  var xai: BridgeServer?
  let xaiCalls = Locked<[(String, String, String)]>([])
  let xaiVoices = Locked<(Int, String)>((200, "{}"))
  var claude: String!

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-engine-vb-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("core/public"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("bin"), withIntermediateDirectories: true)
    // The stand-in Claude Code: its sign-in status, and an answer after ORBIT_FAKE_SLEEP seconds.
    claude = root.appendingPathComponent("bin/claude").path
    try """
    #!/bin/sh
    if [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; fi
    cat > /dev/null
    sleep "${ORBIT_FAKE_SLEEP:-0}"
    echo '{"type":"result","subtype":"success","is_error":false,"result":"ready","total_cost_usd":0.001,"num_turns":1}'
    """.write(toFile: claude, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: claude)

    port = Int(try XCTUnwrap(FreePort.pick()))
    engine = try Engine(paths: .init(profile: root.appendingPathComponent("profile"), core: root.appendingPathComponent("core")), port: port, sealKey: Data(repeating: 9, count: 32), version: "9.9.9")
    engine.loadSettings(env: [:])
    // (Its own home: a Claude Code installed on this Mac, in ~/.local/bin or the Claude app's data, isn't found.)
    engine.brain = BrainRunner(baseEnv: ["PATH": "/usr/bin:/bin"], home: root.path, shellPath: { [] })
    try await engine.start()

    // The stand-in xAI: its voice list (as set) and text to speech.
    let xaiPort = try XCTUnwrap(FreePort.pick())
    let calls = xaiCalls, voices = xaiVoices
    let x = try BridgeServer(port: xaiPort) { r in
      calls.update { $0.append((r.path, r.header("authorization") ?? "", String(decoding: r.body, as: UTF8.self))) }
      if r.path == "/v1/tts/voices" {
        let (status, body) = voices.get()
        return .response(BridgeResponse(status: status, fields: [("content-type", "application/json")], body: Data(body.utf8)))
      }
      return .response(BridgeResponse(status: 200, fields: [("content-type", "audio/mpeg")], body: Data("ID3-mp3".utf8)))
    }
    try await x.start()
    xai = x
    engine.xaiAPI = URL(string: "http://127.0.0.1:\(xaiPort)/v1")!
  }

  override func tearDown() async throws {
    engine?.stop()
    xai?.stop()
    try? FileManager.default.removeItem(at: root)
  }

  var host: String { "127.0.0.1:\(port!)" }

  func send(_ method: String, _ path: String, _ body: String? = nil, timeout: Double = 15) async throws -> RawHTTP.Response {
    var h = ["host": host, "cookie": "orbit_session=\(engine.policy.accessToken)"]
    if method == "POST" { h["origin"] = "http://\(host)" }
    return try await RawHTTP.send(port: port, method: method, path: path, headers: h, body: body.map { Data($0.utf8) }, timeout: timeout)
  }

  func json(_ method: String, _ path: String, _ body: String? = nil) async throws -> (Int, JSONValue) {
    let r = try await send(method, path, body)
    return (r.status, try JSONValue.parse(r.body))
  }

  func testVoicesForEitherEngine() async throws {
    var (status, v) = try await json("GET", "/api/voice?engine=claude")
    XCTAssertEqual(status, 200)
    XCTAssertEqual(v["engine"], "claude")
    XCTAssertEqual(v["voices"]?.arrayValue?.count, 8)
    XCTAssertEqual(v["voices"]?[2], ["id": "2", "name": "Voice 3", "gender": "other"])
    XCTAssertEqual(v["voice"], .string(JSTruthy.string(engine.config["claudeVoice"])))
    XCTAssertEqual(v["minSpeed"], 0.7)

    xaiVoices.set((500, "nope"))
    (_, v) = try await json("GET", "/api/voice?engine=grok")
    XCTAssertEqual(v["engine"], "grok")
    XCTAssertEqual(v["voices"]?.arrayValue?.compactMap { $0["id"]?.stringValue }, ["eve", "ara", "rex", "sal", "leo"], "xAI down: the five Orbit knows")
    xaiVoices.set((200, #"{"voices":[{"voice_id":"una","name":"Una","gender":"female"},{"voice_id":"bad id"},{"voice_id":"zed","gender":5}]}"#))
    (_, v) = try await json("GET", "/api/voice?engine=grok")
    XCTAssertEqual(v["voices"], [["id": "una", "name": "Una", "gender": "female"], ["id": "zed", "name": "zed", "gender": "5"]])
    xaiVoices.set((500, "nope"))
    (_, v) = try await json("GET", "/api/voice?engine=grok")
    XCTAssertEqual(v["voices"]?.arrayValue?.count, 2, "kept for an hour")
    _ = try await send("POST", "/api/key", #"{"key":"xai-abcdefghijklmnopqrstuvwxyz"}"#)
    (_, v) = try await json("GET", "/api/voice?engine=grok")
    XCTAssertEqual(v["voices"]?.arrayValue?.count, 5, "a new key: asked again")
    XCTAssertTrue(xaiCalls.get().last?.1 == "Bearer xai-abcdefghijklmnopqrstuvwxyz")
  }

  func testPreviews() async throws {
    let r = try await send("POST", "/api/voice/preview", #"{"voice":"ara","speed":9}"#)
    XCTAssertEqual(r.status, 200)
    XCTAssertEqual(r.headers["content-type"], "audio/mpeg")
    XCTAssertEqual(String(decoding: r.body, as: UTF8.self), "ID3-mp3")
    let sent = try JSONValue.parse(xaiCalls.get().last?.2 ?? "")
    XCTAssertEqual(sent, ["text": "Hi, I'm Ara. This is how I'll sound when we talk.", "voice_id": "ara", "language": "en", "speed": 1.5])
    _ = try await send("POST", "/api/voice/preview", #"{"voice":"no good!"}"#)
    XCTAssertEqual(try JSONValue.parse(xaiCalls.get().last?.2 ?? "")["voice_id"], engine.config["voice"], "a voice that isn't one: the setting's")

    var (status, v) = try await json("POST", "/api/claude-voice/preview", #"{"voice":2}"#)
    XCTAssertEqual(status, 409, "no models yet")
    XCTAssertEqual(v["error"], "Download the speech models first (Voice engine, above).")
    (status, v) = try await json("GET", "/api/claude-voice")
    XCTAssertEqual(status, 200)
    XCTAssertEqual(v["mb"], .number(Double(VoiceModels.mb)))
    XCTAssertEqual(v["models"]?["state"], "idle")
    XCTAssertEqual(v["claudeFound"], .bool(false))
    XCTAssertEqual(v["stt"]?["parakeet-v2"]?["mb"], 460)
    (status, _) = try await json("POST", "/api/claude-voice/stt-download", #"{"id":"whisper"}"#)
    XCTAssertEqual(status, 400)
    XCTAssertEqual(Engine.wavFile([0, 1, -1, 0.5], rate: 24000).count, 44 + 8)
  }

  func testSecondBrainStatusTestAndSignIn() async throws {
    var (_, b) = try await json("GET", "/api/brain")
    XCTAssertEqual(b["found"], .bool(false))
    XCTAssertEqual(b["signedIn"], .null)
    engine.config.update(["brainClaudePath": .string(claude)])
    (_, b) = try await json("GET", "/api/brain")
    XCTAssertEqual(b, ["found": true, "path": .string(claude), "source": "settings", "hasKey": false, "signedIn": true])

    let (status, t) = try await json("POST", "/api/brain/test")
    XCTAssertEqual(status, 200)
    XCTAssertEqual(t["ok"], .bool(true), "\(t)")
    XCTAssertNotNil(t["seconds"]?.doubleValue)

    engine.config.update(["brainConnection": "api-key"])
    var (_, r) = try await json("POST", "/api/brain/test")
    XCTAssertEqual(r, ["ok": false, "error": "Add your Anthropic API key first."])
    let (loginStatus, login) = try await json("POST", "/api/brain/login")
    XCTAssertEqual(loginStatus, 400)
    XCTAssertEqual(login["error"], "The second brain is set to use an API key.")
    (_, b) = try await json("GET", "/api/brain")
    XCTAssertEqual(b["signedIn"], .null, "not asked with an API key")
    engine.config.update(["brainConnection": "claude-code"])

    // One test at a time.
    engine.brain.baseEnv["ORBIT_FAKE_SLEEP"] = "2"
    let (p, h, tok) = (port!, host, engine.policy.accessToken)
    let slow = Task {
      try await RawHTTP.send(port: p, method: "POST", path: "/api/brain/test", headers: ["host": h, "cookie": "orbit_session=\(tok)", "origin": "http://\(h)"], body: nil, timeout: 15)
    }
    try await Task.sleep(nanoseconds: 300_000_000)
    (_, r) = try await json("POST", "/api/brain/test")
    XCTAssertEqual(r["error"], "A connection test is already running.")
    let done = try JSONValue.parse(try await slow.value.body)
    XCTAssertEqual(done["ok"], .bool(true))
  }

  func testAConnectionTestStopsWhenThePageGoesAway() async throws {
    engine.config.update(["brainClaudePath": .string(claude)])
    engine.brain.baseEnv["ORBIT_FAKE_SLEEP"] = "60"
    // A client that asks, then goes away.
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port)).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    XCTAssertEqual(ok, 0)
    let req = "POST /api/brain/test HTTP/1.1\r\nHost: \(host)\r\nCookie: orbit_session=\(engine.policy.accessToken)\r\nOrigin: http://\(host)\r\nContent-Length: 0\r\n\r\n"
    _ = req.withCString { write(fd, $0, strlen($0)) }
    for _ in 0..<100 where !engine.brainTestRunning.get() { try await Task.sleep(nanoseconds: 20_000_000) }
    XCTAssertTrue(engine.brainTestRunning.get())
    close(fd)
    var stopped = false
    for _ in 0..<250 where !stopped {
      stopped = !engine.brainTestRunning.get()
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    XCTAssertTrue(stopped, "the run is stopped when the page goes away")
  }
}
