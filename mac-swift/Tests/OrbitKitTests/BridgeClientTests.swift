// BridgeClient against a fake bridge that keeps the real bridge's rules (src/server.js handle()):
// the sign-in cookie, the Host check, Origin on POSTs, and the SSE stream.
import Foundation
import XCTest
@testable import OrbitKit

final class FakeBridge: @unchecked Sendable {
  let token = String(repeating: "ab", count: 32)
  private let lock = NSLock()
  private var settings: [String: JSONValue] = ["avatar": "buddy", "speed": 1, "wakeHotkey": "Control+Alt+G"]
  private var eventsServed = 0
  var server: TestHTTPServer!

  init() throws {
    server = try TestHTTPServer { [unowned self] req in self.handle(req) }
  }

  var base: URL { server.base }
  var authURL: URL { URL(string: "\(base)/auth?t=\(token)")! }
  var origin: String { "http://127.0.0.1:\(server.port)" }

  func handle(_ req: TestHTTPServer.Request) -> TestHTTPServer.Response {
    guard req.headers["host"] == "127.0.0.1:\(server.port)" else { return .init(status: 421) }
    if req.method == "GET" && req.path == "/auth" {
      guard req.query["t"] == token else { return .text("expired", status: 403) }
      return .init(status: 302, headers: ["Set-Cookie": "orbit_session=\(token); HttpOnly; SameSite=Strict; Path=/", "Location": "/"])
    }
    guard req.path.hasPrefix("/api/") else { return .text("page") }
    guard req.headers["cookie"]?.contains("orbit_session=\(token)") == true else { return .json(#"{"error":"not signed in"}"#, status: 401) }
    if req.method == "POST" && req.headers["origin"] != origin { return .json(#"{"error":"forbidden"}"#, status: 403) }
    lock.lock(); defer { lock.unlock() }
    switch "\(req.method) \(req.path)" {
    case "GET /api/config":
      return .json(JSONValue.object(["version": "1.3.0", "hasKey": false, "keyStorage": "env-file", "settings": .object(settings), "limits": ["minSpeed": 0.7, "maxSpeed": 1.5], "defaults": [:]]).text)
    case "POST /api/settings":
      let patch = (try? JSONValue.parse(req.body))?.objectValue ?? [:]
      for (k, v) in patch where k != "wakeHotkey" { settings[k] = v }
      return .json(JSONValue.object(settings).text)
    case "POST /api/key":
      let key = (try? JSONValue.parse(req.body))?["key"]?.stringValue ?? ""
      return key.count >= 20 ? .json(#"{"hasKey":true}"#) : .json(#"{"error":"That does not look like an xAI API key."}"#, status: 400)
    case "POST /api/switch":
      return .json(#"{"ok":false,"message":"Open the Claude app first."}"#, status: 409)
    case "GET /api/sessions":
      return .json(#"{"sessions":[{"id":"1","title":"Fix the bug","badge":"","project":"orbit","lastActive":"2m","working":true,"open":true}],"openInApp":"Fix the bug","canSwitch":true}"#)
    case "GET /api/events":
      eventsServed += 1
      // Each connection sends one event then ends: the client must reconnect for the next.
      let body = ": ping\n\ndata: {\"type\":\"claude.status\",\"working\":[]}\n\ndata: {\"type\":\"n\",\"n\":\(eventsServed)}\n\n"
      return .init(status: 200, headers: ["Content-Type": "text/event-stream"], body: Data(body.utf8))
    default:
      return .json(#"{"error":"not found"}"#, status: 404)
    }
  }
}

final class BridgeClientTests: XCTestCase {
  func testSignsInWithCookieAndSendsOriginOnPosts() async throws {
    let fake = try FakeBridge()
    defer { fake.server.stop() }
    let client = BridgeClient(base: fake.base, authURL: fake.authURL)
    let cfg = try await client.config()
    XCTAssertEqual(cfg.version, "1.3.0")
    XCTAssertEqual(cfg.settings["avatar"], "buddy")
    let isIn = await client.signedIn
    XCTAssertTrue(isIn)
    let saved = try await client.updateSettings(["avatar": "qubit"])
    XCTAssertEqual(saved["avatar"], "qubit")
    let post = fake.server.requests.last { $0.method == "POST" }!
    XCTAssertEqual(post.headers["origin"], fake.origin)
    XCTAssertNil(post.headers["sec-fetch-site"])
    // The auth request itself is not followed to "/" (no redirect).
    XCTAssertFalse(fake.server.requests.contains { $0.path == "/" })
  }

  func testBadSignInLinkThrows() async {
    let fake = try! FakeBridge()
    defer { fake.server.stop() }
    let client = BridgeClient(base: fake.base, authURL: URL(string: "\(fake.base)/auth?t=nope")!)
    do { _ = try await client.config(); XCTFail("signed in with a bad token") } catch let e as BridgeError { XCTAssertEqual(e.status, 403) } catch { XCTFail("\(error)") }
  }

  func testErrorsCarryTheBridgesSentence() async throws {
    let fake = try FakeBridge()
    defer { fake.server.stop() }
    let client = BridgeClient(base: fake.base, authURL: fake.authURL)
    do { try await client.setXaiKey("short"); XCTFail() } catch let e as BridgeError {
      XCTAssertEqual(e.status, 400)
      XCTAssertEqual(e.message, "That does not look like an xAI API key.")
    }
    try await client.setXaiKey("xai-FAKE-not-a-real-key-000000000000")
    let sw = try await client.switchSession(title: "x")
    XCTAssertFalse(sw.ok)
    XCTAssertEqual(sw.message, "Open the Claude app first.")
    let s = try await client.sessions()
    XCTAssertEqual(s.sessions.first?.title, "Fix the bug")
    XCTAssertEqual(s.openInApp, "Fix the bug")
    XCTAssertTrue(s.sessions.first!.working)
  }

  func testEventsReconnect() async throws {
    let fake = try FakeBridge()
    defer { fake.server.stop() }
    let client = BridgeClient(base: fake.base, authURL: fake.authURL)
    var ns = [Int]()
    var types = [String]()
    for await e in client.events(retry: .milliseconds(50)) {
      types.append(e["type"]?.stringValue ?? "")
      if let n = e["n"]?.intValue { ns.append(n) }
      if ns.count == 3 { break }
    }
    XCTAssertEqual(ns, [1, 2, 3])
    XCTAssertEqual(types.filter { $0 == "claude.status" }.count, 3)
  }

  func testSSEParser() {
    var p = SSEParser()
    XCTAssertNil(p.feed(line: ": comment"))
    XCTAssertNil(p.feed(line: "data: {\"a\":1}\r"))
    XCTAssertNil(p.feed(line: "data:2"))
    XCTAssertEqual(p.feed(line: "").map { String(decoding: $0, as: UTF8.self) }, "{\"a\":1}\n2")
    XCTAssertNil(p.feed(line: ""))
  }
}
