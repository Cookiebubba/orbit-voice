// The engine's bridge end to end, on a real port: sign-in, the guards, the routes it answers, the
// static pages, and what it passes to the core (a stand-in core here, which echoes what it got).
import Foundation
import Network
import XCTest
@testable import OrbitBridge
@testable import OrbitEngine
@testable import OrbitKit

final class EngineBridgeTests: XCTestCase {
  var root: URL!
  var engine: Engine!
  var port: Int!
  var core: BridgeServer?
  var corePort: UInt16 = 0
  let coreToken = String(repeating: "c", count: 64)
  let calls = Locked<[String]>([])

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-engine-\(UUID().uuidString)")
    let pub = root.appendingPathComponent("core/public")
    try FileManager.default.createDirectory(at: pub.appendingPathComponent("assets"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("core/resources/models"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("core/src"), withIntermediateDirectories: true)
    try "<!doctype html><title>Orbit</title>".write(to: pub.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
    try "<!doctype html>qubit".write(to: pub.appendingPathComponent("qubit.html"), atomically: true, encoding: .utf8)
    try "<!doctype html>wake".write(to: pub.appendingPathComponent("wake.html"), atomically: true, encoding: .utf8)
    try "console.log(1)".write(to: pub.appendingPathComponent("assets/app.js"), atomically: true, encoding: .utf8)
    try "secret".write(to: root.appendingPathComponent("core/src/server.js"), atomically: true, encoding: .utf8)
    try "{}".write(to: root.appendingPathComponent("core/package.json"), atomically: true, encoding: .utf8)
    try Data(repeating: 7, count: 300_000).write(to: root.appendingPathComponent("core/resources/models/vosk-model-small-en-us-0.15.tar.gz"))

    port = Int(try XCTUnwrap(FreePort.pick()))
    engine = try Engine(paths: .init(profile: root.appendingPathComponent("profile"), core: root.appendingPathComponent("core")), port: port, sealKey: Data(repeating: 9, count: 32), version: "9.9.9")
    engine.loadSettings(env: [:])
    try await engine.start()

    // The stand-in core: answers every request with what it got.
    corePort = try XCTUnwrap(FreePort.pick())
    let calls = self.calls
    let c = try BridgeServer(port: corePort) { r in
      let fields = Dictionary(r.fields.map { ($0.name.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
      calls.update { $0.append("\(r.method) \(r.target)") }
      let echo: [String: Any] = ["method": r.method, "target": r.target, "headers": fields, "body": String(decoding: r.body, as: UTF8.self)]
      return .response(BridgePolicy.json(r.path == "/api/teapot" ? 418 : 200, echo))
    }
    try await c.start()
    core = c
  }

  override func tearDown() async throws {
    engine?.stop()
    core?.stop()
    try? FileManager.default.removeItem(at: root)
  }

  var host: String { "127.0.0.1:\(port!)" }
  var origin: String { "http://\(host)" }
  var cookie: String { "orbit_session=\(engine.policy.accessToken)" }

  func send(_ method: String, _ path: String, headers: [String: String] = [:], body: Data? = nil, signedIn: Bool = true) async throws -> RawHTTP.Response {
    var h = headers
    if h["host"] == nil { h["host"] = host }
    if signedIn && h["cookie"] == nil { h["cookie"] = cookie }
    if method == "POST" && h["origin"] == nil { h["origin"] = origin }
    return try await RawHTTP.send(port: port, method: method, path: path, headers: h, body: body, timeout: 10)
  }

  func json(_ r: RawHTTP.Response) throws -> JSONValue { try JSONValue.parse(r.body) }

  func expectStatus(_ want: Int, _ method: String, _ path: String, headers: [String: String] = [:], body: Data? = nil, signedIn: Bool = true, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) async throws {
    let got = try await send(method, path, headers: headers, body: body, signedIn: signedIn).status
    XCTAssertEqual(got, want, "\(method) \(path) \(message)", file: file, line: line)
  }

  // MARK: sign-in and guards

  func testOnlyItsOwnHostAndSignedInWindows() async throws {
    try await expectStatus(421, "GET", "/api/config", headers: ["host": "evil.example"])
    try await expectStatus(421, "GET", "/", headers: ["host": "127.0.0.1:1"])
    let bad = try await send("GET", "/auth?t=" + String(repeating: "0", count: 64), signedIn: false)
    XCTAssertEqual(bad.status, 403)
    XCTAssertTrue(String(decoding: bad.body, as: UTF8.self).contains("expired"))
    let good = try await send("GET", "/auth?t=\(engine.policy.accessToken)&view=qubit", signedIn: false)
    XCTAssertEqual(good.status, 302)
    XCTAssertEqual(good.headers["location"], "/qubit.html")
    XCTAssertEqual(good.headers["set-cookie"], "orbit_session=\(engine.policy.accessToken); HttpOnly; SameSite=Strict; Path=/")
    let plainLocation = try await send("GET", "/auth?t=\(engine.policy.accessToken)", signedIn: false).headers["location"]
    XCTAssertEqual(plainLocation, "/")
    try await expectStatus(401, "GET", "/api/config", signedIn: false)
    try await expectStatus(403, "GET", "/api/config", headers: ["sec-fetch-site": "cross-site"])
    try await expectStatus(403, "POST", "/api/settings", headers: ["origin": "http://evil.example"], body: Data("{}".utf8))
    try await expectStatus(403, "POST", "/api/settings", headers: ["origin": ""], body: Data("{}".utf8))
    XCTAssertEqual(engine.endpoints.auth["mouse"]?.absoluteString, "http://\(host)/auth?t=\(engine.policy.accessToken)&view=mouse")
  }

  // MARK: what the engine answers

  func testConfigSettingsAndTheirEvents() async throws {
    let changes = Locked<[[String]]>([])
    let prewarms = Locked(0)
    engine.onSettingsChanged = { changed, _ in changes.update { $0.append(changed) } }
    engine.onPrewarm = { prewarms.update { $0 += 1 } }
    let c = try json(try await send("GET", "/api/config"))
    XCTAssertEqual(c["version"], "9.9.9")
    XCTAssertEqual(c["hasKey"], .bool(false))
    XCTAssertEqual(c["keyStorage"], "macos-keychain")
    XCTAssertEqual(c.at(path: "limits.minSpeed"), 0.7)
    XCTAssertEqual(c.at(path: "settings.hotkeyLabel"), .string(SettingsSchema.hotkeyLabel(HotkeyAccelerator.defaultAccelerator)))
    XCTAssertNil(c.at(path: "settings.orbPosition"))
    XCTAssertEqual(c.at(path: "defaults.orbPosition"), .null)

    let r = try await send("POST", "/api/settings", body: Data(#"{"speed":"1.234","voice":"REX","wakeHotkey":"Control+K","orbPosition":[1,2],"nope":1}"#.utf8))
    XCTAssertEqual(r.status, 200)
    let s = try json(r)
    XCTAssertEqual(s["speed"], 1.23)
    XCTAssertEqual(s["voice"], "rex")
    XCTAssertEqual(s["wakeHotkey"], .string(HotkeyAccelerator.defaultAccelerator), "the shell's, not the page's")
    XCTAssertEqual(changes.get(), [["voice", "speed"]])
    XCTAssertEqual(prewarms.get(), 1)
    let saved = try JSONValue.parse(Data(contentsOf: root.appendingPathComponent("profile/settings.json")))
    XCTAssertEqual(saved.objectValue, ["voice": "rex", "speed": 1.23, "voiceEngine": "claude"], "only what differs from the defaults, and the engine (always)")
    // The same again changes nothing.
    _ = try await send("POST", "/api/settings", body: Data(#"{"speed":1.23}"#.utf8))
    XCTAssertEqual(changes.get().count, 1)
  }

  func testKeys() async throws {
    let changed = Locked(0)
    engine.onKeyChanged = { changed.update { $0 += 1 } }
    let junk = try await send("POST", "/api/key", body: Data(#"{"key":"short"}"#.utf8))
    XCTAssertEqual(junk.status, 400)
    XCTAssertEqual(try json(junk)["error"], "That does not look like an xAI API key.")
    try await expectStatus(400, "POST", "/api/key", body: Data(#"{"key":12345678901234567890123}"#.utf8), "1.2345678901234568e+22 has a +")
    let ok = try await send("POST", "/api/key", body: Data(#"{"key":"  xai-0123456789abcdefghijklmnop  "}"#.utf8))
    XCTAssertEqual(ok.status, 200)
    XCTAssertEqual(try json(ok)["hasKey"], .bool(true))
    XCTAssertEqual(engine.xaiKey.get(), "xai-0123456789abcdefghijklmnop")
    XCTAssertEqual(changed.get(), 1)
    let config = try json(try await send("GET", "/api/config"))
    XCTAssertEqual(config["hasKey"], .bool(true))

    try await expectStatus(400, "POST", "/api/brain/key", body: Data(#"{"key":"nope"}"#.utf8))
    let b = try await send("POST", "/api/brain/key", body: Data(#"{"key":"sk-ant-api03-abcdefghijklmnopqrstu"}"#.utf8))
    XCTAssertEqual(try json(b)["hasKey"], .bool(true))
    XCTAssertEqual(engine.brainKey.get(), "sk-ant-api03-abcdefghijklmnopqrstu")
    let removed = try json(try await send("POST", "/api/brain/key", body: Data(#"{"key":""}"#.utf8)))
    XCTAssertEqual(removed["hasKey"], .bool(false))
    XCTAssertEqual(engine.brainKey.get(), "")
  }

  func testLogsAndUsage() async throws {
    engine.log.info("test", "hello with xai-abcdefghijk")
    engine.log.append(core: ["at": "2026-10-25T10:00:00.000Z", "level": "warn", "source": "core", "message": "from node"])
    let l = try json(try await send("GET", "/api/logs"))
    XCTAssertEqual(l["dir"]?.stringValue, root.appendingPathComponent("profile/logs").path)
    let messages = l["entries"]?.arrayValue?.compactMap { $0["message"]?.stringValue } ?? []
    XCTAssertTrue(messages.contains("hello with xai-***"))
    let today = { () -> String in let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX"); return f.string(from: Date()) }()
    try Data(#"{"\#(today)":90,"1999-01-01":60}"#.utf8).write(to: root.appendingPathComponent("profile/usage.json"))
    let u = try json(try await send("GET", "/api/usage"))
    XCTAssertEqual(u.at(path: "today.minutes"), 1.5)
    XCTAssertEqual(u.at(path: "today.cost"), 0.12)
    XCTAssertEqual(u["costPerMinute"], 0.08)
  }

  func testEventsStreamToListeners() async throws {
    let reader = try await StreamReader.open(port: port, request: "GET /api/events HTTP/1.1\r\nHost: \(host)\r\nCookie: \(cookie)\r\n\r\n")
    defer { reader.close() }
    let first = try await reader.waitFor("\n\n", timeout: 5)
    XCTAssertTrue(first.contains("content-type: text/event-stream"))
    let withStatus = first.contains("claude.status") ? first : try await reader.waitFor("claude.status", timeout: 5)
    XCTAssertTrue(withStatus.contains(#"data: {"type":"claude.status","working":[]}"#))
    _ = try await send("POST", "/api/settings", body: Data(#"{"voice":"ara"}"#.utf8))
    let ev = try await reader.waitFor("settings.changed", timeout: 5)
    XCTAssertTrue(ev.contains(#""changed":["voice"]"#))
    XCTAssertFalse(ev.contains("orbPosition"))
  }

  // MARK: static pages

  func testStaticPagesAndTheirPolicies() async throws {
    let index = try await send("GET", "/", signedIn: false)
    XCTAssertEqual(index.status, 200)
    XCTAssertEqual(index.headers["content-type"], "text/html; charset=utf-8")
    XCTAssertTrue(index.headers["content-security-policy"]?.contains("ws://127.0.0.1:\(port!)") ?? false)
    XCTAssertEqual(index.headers["x-frame-options"], "DENY")
    XCTAssertEqual(index.headers["cache-control"], "no-store")
    let wake = try await send("GET", "/wake.html", signedIn: false)
    XCTAssertEqual(wake.headers["x-frame-options"], "SAMEORIGIN")
    XCTAssertTrue(wake.headers["content-security-policy"]?.contains("'wasm-unsafe-eval'") ?? false)
    let dotted = try await send("GET", "/x/../wake.html", signedIn: false).headers["x-frame-options"]
    XCTAssertEqual(dotted, "SAMEORIGIN", "dot segments resolved first")
    let js = try await send("GET", "/assets/app.js", signedIn: false)
    XCTAssertEqual(js.headers["content-type"], "text/javascript; charset=utf-8")
    XCTAssertNil(js.headers["content-security-policy"])
    XCTAssertEqual(String(decoding: js.body, as: UTF8.self), "console.log(1)")
    for p in ["/..%2fsrc/server.js", "/%2e%2e/src/server.js", "/assets", "/nope.html", "/..\\src\\server.js"] {
      try await expectStatus(404, "GET", p, signedIn: false)
    }
    try await expectStatus(400, "GET", "/%zz", signedIn: false)
    try await expectStatus(405, "POST", "/", body: Data())
    let head = try await send("HEAD", "/qubit.html", signedIn: false)
    XCTAssertEqual(head.headers["content-length"], "20")
    XCTAssertTrue(head.body.isEmpty)
    let model = try await send("GET", "/models/vosk-model-small-en-us-0.15.tar.gz", signedIn: false)
    XCTAssertEqual(model.status, 200)
    XCTAssertEqual(model.headers["content-type"], "application/gzip")
    XCTAssertEqual(model.body.count, 300_000)
    let missing = try await send("GET", "/models/other.tar.gz", signedIn: false)
    XCTAssertEqual(missing.status, 404)
    XCTAssertEqual(String(decoding: missing.body, as: UTF8.self), "model not installed")
  }

  func testKeepAliveAnswersEachRequestOnOneConnection() async throws {
    let reader = try await StreamReader.open(port: port, request: "GET /qubit.html HTTP/1.1\r\nHost: \(host)\r\n\r\nGET /assets/app.js HTTP/1.1\r\nHost: \(host)\r\nConnection: close\r\n\r\n")
    defer { reader.close() }
    let all = try await reader.readToEnd(timeout: 5)
    XCTAssertEqual(all.components(separatedBy: "HTTP/1.1 200 OK").count, 3)
    XCTAssertTrue(all.contains("qubit"))
    XCTAssertTrue(all.hasSuffix("console.log(1)"))
  }

  // MARK: passing on to the core

  func testWhatIsntHereGoesToTheCoreSignedInAsTheCore() async throws {
    try await expectStatus(503, "GET", "/api/sessions", "no core yet")
    engine.setCore(port: corePort, token: coreToken)
    let r = try await send("POST", "/api/switch?x=1", headers: ["sec-fetch-site": "same-origin"], body: Data(#"{"title":"A"}"#.utf8))
    XCTAssertEqual(r.status, 200)
    let e = try json(r)
    XCTAssertEqual(e["target"], "/api/switch?x=1")
    XCTAssertEqual(e.at(path: "headers.host")?.stringValue, "127.0.0.1:\(corePort)")
    XCTAssertEqual(e.at(path: "headers.origin")?.stringValue, "http://127.0.0.1:\(corePort)")
    XCTAssertEqual(e.at(path: "headers.cookie")?.stringValue, "orbit_session=\(coreToken)")
    XCTAssertEqual(e.at(path: "headers.connection")?.stringValue, "close")
    XCTAssertEqual(e["body"], #"{"title":"A"}"#)
    try await expectStatus(418, "GET", "/api/teapot", "the core's answer, as it is")
    // Not signed in: the bridge refuses it itself.
    try await expectStatus(401, "GET", "/api/sessions", signedIn: false)
    // A helper's orbit-hands and a connector's sign-in: the core checks those; no session is added.
    let hands = try json(try await send("POST", "/mcp/hands/abc", headers: ["authorization": "Bearer t", "origin": ""], body: Data("{}".utf8), signedIn: false))
    XCTAssertNil(hands.at(path: "headers.cookie"))
    XCTAssertEqual(hands.at(path: "headers.authorization")?.stringValue, "Bearer t")
    let callback = try json(try await send("GET", "/oauth/callback?state=s", signedIn: false))
    XCTAssertEqual(callback["target"], "/oauth/callback?state=s")
    // The voice socket: only Orbit's own signed-in windows get through.
    // (Raw requests: the test client always asks to close, which an upgrade can't.)
    func upgrade(_ extra: String) async throws -> String {
      let r = try await StreamReader.open(port: port, request: "GET /voice HTTP/1.1\r\nHost: \(host)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\(extra)\r\n")
      defer { r.close() }
      return try await r.waitFor("\r\n\r\n", timeout: 5)
    }
    let voiceCalls = { self.calls.get().filter { $0 == "GET /voice" }.count }
    let noSession = try await upgrade("Origin: \(origin)\r\n")
    let otherSite = try await upgrade("Origin: http://evil.example\r\nCookie: \(cookie)\r\n")
    let noOrigin = try await upgrade("Cookie: \(cookie)\r\n")
    XCTAssertTrue(noSession.hasPrefix("HTTP/1.1 401"), "not signed in")
    XCTAssertTrue(otherSite.hasPrefix("HTTP/1.1 401"), "another site")
    XCTAssertTrue(noOrigin.hasPrefix("HTTP/1.1 401"), "no origin")
    XCTAssertEqual(voiceCalls(), 0)
    _ = try await upgrade("Origin: \(origin)\r\nCookie: \(cookie)\r\n")
    XCTAssertEqual(voiceCalls(), 1, "passed on to the core")
    // The core gone: a plain 502.
    core?.stop()
    try await Task.sleep(nanoseconds: 200_000_000)
    try await expectStatus(502, "GET", "/api/sessions")
  }
}

struct StreamTimeout: Error, CustomStringConvertible {
  let message: String
  var description: String { message }
}

/** A raw connection that reads as it comes (for streams and keep-alive). */
final class StreamReader: @unchecked Sendable {
  let conn: NWConnection
  private let buf = Locked(Data())
  private let done = Locked(false)

  init(conn: NWConnection) { self.conn = conn }

  static func open(port: Int, request: String) async throws -> StreamReader {
    let c = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!, using: .tcp)
    let r = StreamReader(conn: c)
    c.start(queue: .global())
    c.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
    r.read()
    return r
  }

  func read() {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, err in
      guard let self else { return }
      if let data { self.buf.update { $0.append(data) } }
      if complete || err != nil { self.done.set(true) } else { self.read() }
    }
  }

  var text: String { String(decoding: buf.get(), as: UTF8.self) }

  func waitFor(_ needle: String, timeout: Double) async throws -> String {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if text.contains(needle) { return text }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw StreamTimeout(message: "never saw \(needle): \(text.prefix(300))")
  }

  func readToEnd(timeout: Double) async throws -> String {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end && !done.get() { try await Task.sleep(nanoseconds: 20_000_000) }
    return text
  }

  func close() { conn.cancel() }
}
