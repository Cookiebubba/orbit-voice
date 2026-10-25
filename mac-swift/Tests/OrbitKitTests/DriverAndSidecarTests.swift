import Foundation
import XCTest
@testable import OrbitKit

/** The repo root, from this file's place (mac-swift/Tests/OrbitKitTests/...). */
let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

/** A Node to run the core with: $ORBIT_NODE, else the usual places. */
func findNode() -> URL? {
  let env = ProcessInfo.processInfo.environment
  var c = [env["ORBIT_NODE"]].compactMap { $0 }
  if let home = env["HOME"] {
    let nvm = URL(fileURLWithPath: home).appendingPathComponent(".nvm/versions/node")
    if let vs = try? FileManager.default.contentsOfDirectory(atPath: nvm.path) {
      c += vs.sorted(by: >).map { nvm.appendingPathComponent($0).appendingPathComponent("bin/node").path }
    }
  }
  c += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
  return c.map { URL(fileURLWithPath: $0) }.first { FileManager.default.isExecutableFile(atPath: $0.path) }
}

final class HTTPParseTests: XCTestCase {
  func testParsesARequestWithBodyAndQuery() throws {
    let raw = "POST /parity/act?x=1&y=two HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Parity-Token: abc\r\nContent-Length: 5\r\n\r\nhello"
    let r = try XCTUnwrap(try HTTPParse.request(Data(raw.utf8)))
    XCTAssertEqual(r.method, "POST")
    XCTAssertEqual(r.path, "/parity/act")
    XCTAssertEqual(r.query, ["x": "1", "y": "two"])
    XCTAssertEqual(r.headers["x-parity-token"], "abc")
    XCTAssertEqual(String(decoding: r.body, as: UTF8.self), "hello")
  }

  func testWaitsForTheRestOfTheBody() throws {
    XCTAssertNil(try HTTPParse.request(Data("POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc".utf8)))
    XCTAssertNil(try HTTPParse.request(Data("GET / HTTP/1.1\r\nHost: x".utf8)))
  }

  func testRefusesHugeBodiesAndGarbage() {
    XCTAssertThrowsError(try HTTPParse.request(Data("POST / HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n".utf8)))
    XCTAssertThrowsError(try HTTPParse.request(Data("NONSENSE\r\n\r\n".utf8)))
    XCTAssertThrowsError(try HTTPParse.request(Data("POST / HTTP/1.1\r\nContent-Length: -4\r\n\r\n".utf8)))
  }

  func testSerializesWithLengthAndClose() {
    let d = HTTPParse.serialize(.json(["ok": true]))
    let s = String(decoding: d, as: UTF8.self)
    XCTAssertTrue(s.hasPrefix("HTTP/1.1 200 OK\r\n"))
    XCTAssertTrue(s.contains("connection: close\r\n"))
    XCTAssertTrue(s.contains("content-length: 11\r\n"))
    XCTAssertTrue(s.hasSuffix("{\"ok\":true}"))
  }
}

final class FakeDelegate: ParityDriverDelegate, @unchecked Sendable {
  var acts: [(String, JSONValue)] = []
  func parityHello() async -> JSONValue { ["app": "swift"] }
  func parityState() async -> ParityState { var s = ParityState(); s.voice.phase = .listening; return s }
  func parityAct(action: String, args: JSONValue) async -> JSONValue { acts.append((action, args)); return ["ok": true] }
}

final class ParityDriverTests: XCTestCase {
  let token = "0123456789abcdef0123"
  func req(_ method: String, _ path: String, token: String?, body: String = "") -> HTTPRequest {
    var h: [String: String] = [:]
    if let token { h["x-parity-token"] = token }
    return HTTPRequest(method: method, path: path, query: [:], headers: h, body: Data(body.utf8))
  }

  func testNeedsTheToken() async throws {
    let d = FakeDelegate()
    let drv = ParityDriver(token: token, delegate: d)
    let r1 = await drv.handle(req("GET", "/parity/hello", token: nil))
    let r2 = await drv.handle(req("GET", "/parity/hello", token: "wrong"))
    let r3 = await drv.handle(req("GET", "/parity/hello", token: token + "x"))
    XCTAssertEqual([r1.status, r2.status, r3.status], [403, 403, 403])
    let ok = await drv.handle(req("GET", "/parity/hello", token: token))
    XCTAssertEqual(ok.status, 200)
    XCTAssertEqual(try JSONValue.parse(ok.body)["app"], "swift")
    withExtendedLifetime(d) {}
  }

  func testStateAndActsAndErrors() async throws {
    let d = FakeDelegate()
    let drv = ParityDriver(token: token, delegate: d)
    let st = await drv.handle(req("GET", "/parity/state", token: token))
    XCTAssertEqual(try JSONValue.parse(st.body).at(path: "voice.phase"), "listening")
    let act = await drv.handle(req("POST", "/parity/act", token: token, body: #"{"action":"cursor.set","args":{"x":1,"y":2}}"#))
    XCTAssertEqual(act.status, 200)
    XCTAssertEqual(d.acts.first?.0, "cursor.set")
    XCTAssertEqual(d.acts.first?.1["x"], 1)
    let unknown = await drv.handle(req("POST", "/parity/act", token: token, body: #"{"action":"rm -rf"}"#))
    XCTAssertEqual(unknown.status, 400)
    let bad = await drv.handle(req("POST", "/parity/act", token: token, body: "nope"))
    XCTAssertEqual(bad.status, 400)
    let wrongMethod = await drv.handle(req("POST", "/parity/state", token: token))
    XCTAssertEqual(wrongMethod.status, 405)
    let missing = await drv.handle(req("GET", "/nope", token: token))
    XCTAssertEqual(missing.status, 404)
  }

  func testOnlyATestBuildWithPortAndTokenStartsIt() {
    let env = ["ORBIT_PARITY_PORT": "4521", "ORBIT_PARITY_TOKEN": token]
    XCTAssertNil(ParityDriver.config(info: [:], env: env), "a release build never listens")
    XCTAssertNil(ParityDriver.config(info: ["OrbitParityAllowed": true], env: [:]))
    XCTAssertNil(ParityDriver.config(info: ["OrbitParityAllowed": true], env: ["ORBIT_PARITY_PORT": "4521", "ORBIT_PARITY_TOKEN": "short"]))
    XCTAssertNil(ParityDriver.config(info: ["OrbitParityAllowed": true], env: ["ORBIT_PARITY_PORT": "80", "ORBIT_PARITY_TOKEN": token]))
    XCTAssertEqual(ParityDriver.config(info: ["OrbitParityAllowed": true], env: env)?.0, 4521)
  }

  func testServesOverRealHTTP() async throws {
    let d = FakeDelegate()
    let drv = ParityDriver(token: token, delegate: d)
    let port = UInt16.random(in: 47000...47900)
    try await drv.start(port: port)
    defer { drv.stop() }
    var r = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/parity/hello")!)
    r.setValue(token, forHTTPHeaderField: "x-parity-token")
    let (data, resp) = try await URLSession.shared.data(for: r)
    XCTAssertEqual((resp as? HTTPURLResponse)?.statusCode, 200)
    XCTAssertEqual(try JSONValue.parse(data)["app"], "swift")
  }
}

final class SidecarChannelTests: XCTestCase {
  func testOnlyMarkedLinesAreMessages() {
    XCTAssertNil(SidecarChannel.parse(line: "  Orbit bridge running:  http://127.0.0.1:4317"))
    XCTAssertNil(SidecarChannel.parse(line: "\u{1}ORB not json"))
    XCTAssertEqual(SidecarChannel.parse(line: "\u{1}ORB {\"t\":\"x\"}")?["t"], "x")
  }

  func testReadyNeedsLoopbackAndMatchingPorts() {
    let ok: JSONValue = ["t": "ready", "base": "http://127.0.0.1:4521", "auth": ["main": "http://127.0.0.1:4521/auth?t=ab", "qubit": "http://127.0.0.1:4521/auth?t=ab&view=qubit"]]
    let e = SidecarChannel.endpoints(from: ok)
    XCTAssertEqual(e?.base.port, 4521)
    XCTAssertEqual(e?.auth.count, 2)
    let elsewhere: JSONValue = ["t": "ready", "base": "http://example.com:4521", "auth": ["main": "http://example.com:4521/auth"]]
    XCTAssertNil(SidecarChannel.endpoints(from: elsewhere))
    let otherPort: JSONValue = ["t": "ready", "base": "http://127.0.0.1:4521", "auth": ["main": "http://127.0.0.1:9999/auth?t=ab"]]
    XCTAssertNil(SidecarChannel.endpoints(from: otherPort), "no main sign-in link on the bridge's own port")
  }

  func testLineSplitterHandlesAnyChunking() {
    var s = LineSplitter()
    XCTAssertEqual(s.feed(Data("ab".utf8)), [])
    XCTAssertEqual(s.feed(Data("c\nde\n\nf".utf8)), ["abc", "de", ""])
    XCTAssertEqual(s.feed(Data("g\n".utf8)), ["fg"])
  }
}

final class SidecarLiveTests: XCTestCase {
  /** The real core under the real Node: init → ready → the bridge answers → stop. */
  func testStartsTheBridgeAndStops() throws {
    guard let node = findNode() else { throw XCTSkip("no node") }
    let script = repoRoot.appendingPathComponent("mac-swift/sidecar/sidecar.mjs")
    guard FileManager.default.fileExists(atPath: repoRoot.appendingPathComponent("node_modules/ws").path) else { throw XCTSkip("npm ci not done") }
    let profile = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-sidecar-xctest-\(UUID().uuidString)")
    let port = Int.random(in: 47910...47990)
    var key = Data(count: 32)
    _ = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    let sc = Sidecar(config: .init(node: node, script: script, coreDir: repoRoot, profileDir: profile, port: port, sealKey: key))
    let ready = expectation(description: "ready")
    let box = Locked<BridgeEndpoints?>(nil)
    sc.onReady = { e in box.set(e); ready.fulfill() }
    try sc.start()
    wait(for: [ready], timeout: 30)
    let e = try XCTUnwrap(box.get())
    XCTAssertEqual(e.base.absoluteString, "http://127.0.0.1:\(port)")
    XCTAssertNotNil(e.auth["qubit"])
    XCTAssertTrue(sc.isRunning)
    let exited = expectation(description: "exit")
    sc.onExit = { _ in exited.fulfill() }
    sc.stop()
    wait(for: [exited], timeout: 5)
    XCTAssertFalse(sc.isRunning)
  }
}

