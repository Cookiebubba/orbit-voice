// The voice session in the engine, end to end on real ports: a signed-in page on /voice, the relay,
// and a stand-in Grok (an in-process WebSocket server) that sees the key's header and what the relay
// sends; and the sessions routes, with no Claude window to reach.
import Foundation
import XCTest
@testable import OrbitBridge
@testable import OrbitEngine
@testable import OrbitKit

final class EngineVoiceTests: XCTestCase {
  var root: URL!
  var engine: Engine!
  var port: Int!
  var grok: BridgeServer?

  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-engine-voice-\(UUID().uuidString)")
    for d in ["core/public", "core/resources/models", "home"] {
      try FileManager.default.createDirectory(at: root.appendingPathComponent(d), withIntermediateDirectories: true)
    }
    port = Int(try XCTUnwrap(FreePort.pick()))
    engine = try Engine(paths: .init(profile: root.appendingPathComponent("profile"), core: root.appendingPathComponent("core")), port: port, sealKey: Data(repeating: 9, count: 32), version: "9.9.9")
    engine.loadSettings(env: [:])
    engine.config.update(["anywhere": false, "voiceEngine": "grok"])
  }

  override func tearDown() async throws {
    engine?.stop()
    grok?.stop()
    try? FileManager.default.removeItem(at: root)
  }

  var cookie: String { "orbit_session=\(engine.policy.accessToken)" }
  var origin: String { "http://127.0.0.1:\(port!)" }

  func wait(_ what: String, _ ok: @escaping @Sendable () -> Bool) async throws {
    var n = 0
    while !ok() && n < 250 {
      n += 1
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    let done = ok()
    XCTAssertTrue(done, "waited for \(what)")
  }

  func testACallGoesThroughTheSwiftRelayToGrokAndBack() async throws {
    // The stand-in Grok: what it's sent, the key's header, and a short reply to the session's setup.
    let grokPort = try XCTUnwrap(FreePort.pick())
    let got = Locked<[JSONValue]>([])
    let auth = Locked<String?>(nil)
    let grokClosed = Locked(false)
    let g = try BridgeServer(port: grokPort) { r in
      auth.set(r.header("authorization"))
      return .webSocket { ws in
        ws.onMessage = { data, _ in
          guard let m = try? JSONValue.parse(data) else { return }
          got.update { $0.append(m) }
          if m["type"]?.stringValue == "session.update" && got.get().filter({ $0["type"]?.stringValue == "session.update" }).count == 1 {
            for e: JSONValue in [
              ["type": "response.created", "response": ["id": "r1"]],
              ["type": "response.output_audio_transcript.delta", "response_id": "r1", "item_id": "m1", "delta": "Hello from the stand-in."],
              ["type": "response.done", "response": ["id": "r1", "status": "completed", "output": []]],
            ] { ws.send(JSONText.of(e)) }
          }
        }
        ws.onClose = { _, _ in grokClosed.set(true) }
      }
    }
    try await g.start()
    grok = g
    try engine.xaiKey.set("xai-test-key-00000000000000000000")
    engine.enableVoice(desktop: Desktop(driver: nil, log: engine.log), realtimeURL: "ws://127.0.0.1:\(grokPort)/v1/realtime", home: root.appendingPathComponent("home"))
    try await engine.start()

    // A page that isn't Orbit's own signed-in window is refused.
    let refused = expectation(description: "refused")
    let stranger = WebSocketClient(url: URL(string: "ws://127.0.0.1:\(port!)/voice")!, headers: [("Origin", "http://evil.example"), ("Cookie", cookie)])
    stranger.onRefused = { status, _ in
      XCTAssertEqual(status, 401)
      refused.fulfill()
    }
    stranger.connect()
    await fulfillment(of: [refused], timeout: 5)

    // Orbit's page: the relay connects to Grok, sets the session up, and Grok's words come through.
    let page = WebSocketClient(url: URL(string: "ws://127.0.0.1:\(port!)/voice")!, headers: [("Origin", origin), ("Cookie", cookie)])
    let pageGot = Locked<[JSONValue]>([])
    let pageClosed = Locked(false)
    let sock = Locked<BridgeWebSocket?>(nil)
    page.onOpen = { ws in
      ws.onMessage = { d, _ in if let m = try? JSONValue.parse(d) { pageGot.update { $0.append(m) } } }
      ws.onClose = { _, _ in pageClosed.set(true) }
      sock.set(ws)
    }
    page.connect()
    try await wait("Grok's words on the page") { pageGot.get().contains { $0["delta"]?.stringValue == "Hello from the stand-in." } }
    XCTAssertEqual(auth.get(), "Bearer xai-test-key-00000000000000000000")
    let setup = try XCTUnwrap(got.get().first { $0["type"]?.stringValue == "session.update" })
    XCTAssertFalse((setup["session"]?["instructions"]?.stringValue ?? "").isEmpty, "the voice is told who it is")
    XCTAssertFalse((setup["session"]?["tools"]?.arrayValue ?? []).isEmpty, "and given its tools")

    // The page's audio goes to Grok as it is; anything else the page sends isn't passed on.
    sock.get()?.send(#"{"type":"input_audio_buffer.append","audio":"AAAAAAAA"}"#)
    sock.get()?.send(#"{"type":"session.update","session":{"instructions":"not from a page"}}"#)
    try await wait("the audio at Grok") { got.get().contains { $0["type"]?.stringValue == "input_audio_buffer.append" } }
    XCTAssertFalse(got.get().contains { $0["session"]?["instructions"]?.stringValue == "not from a page" })

    // The page hangs up: the relay closes Grok's socket too.
    sock.get()?.send(#"{"type":"ui.bye","reason":"user"}"#)
    sock.get()?.close()
    try await wait("Grok's socket closed") { grokClosed.get() }
  }

  func testTheSessionsRoutesWithNoClaudeWindow() async throws {
    engine.enableVoice(desktop: Desktop(driver: nil, log: engine.log), home: root.appendingPathComponent("home"))
    try await engine.start()
    let h = ["host": "127.0.0.1:\(port!)", "cookie": cookie]
    let list = try await RawHTTP.send(port: port, method: "GET", path: "/api/sessions", headers: h, body: nil, timeout: 10)
    XCTAssertEqual(list.status, 200)
    let j = try JSONValue.parse(list.body)
    XCTAssertEqual(j["canSwitch"], .bool(false))
    XCTAssertEqual(j["openInApp"], .null)
    XCTAssertEqual(j["sessions"]?.arrayValue?.count, 0)

    let sw = try await RawHTTP.send(port: port, method: "POST", path: "/api/switch", headers: h.merging(["origin": origin, "content-type": "application/json"]) { a, _ in a }, body: Data(#"{"title":"Fix the login bug"}"#.utf8), timeout: 10)
    XCTAssertEqual(sw.status, 409)
    XCTAssertEqual(try JSONValue.parse(sw.body)["error"]?.stringValue, "unsupported_platform")
  }
}
