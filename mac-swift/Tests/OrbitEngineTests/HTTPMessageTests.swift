// The bridge's HTTP messages: requests as bytes arrive, keep-alive, chunked bodies, limits.
import Foundation
import XCTest
@testable import OrbitBridge

final class HTTPMessageTests: XCTestCase {
  func testASimpleRequest() throws {
    var p = HTTPRequestParser()
    p.feed(Data("GET /api/config?x=1&y=a%20b+c HTTP/1.1\r\nHost: 127.0.0.1:4317\r\nCookie: a=b\r\n\r\n".utf8))
    let r = try XCTUnwrap(try p.next())
    XCTAssertEqual(r.method, "GET")
    XCTAssertEqual(r.path, "/api/config")
    XCTAssertEqual(r.rawQuery, "x=1&y=a%20b+c")
    XCTAssertEqual(r.query("y"), "a b c")
    XCTAssertNil(r.query("z"))
    XCTAssertEqual(r.header("HOST"), "127.0.0.1:4317")
    XCTAssertTrue(r.keepAlive)
    XCTAssertNil(try p.next())
  }

  func testBytesArriveInPieces() throws {
    var p = HTTPRequestParser()
    let whole = Data("POST /api/key HTTP/1.1\r\nHost: h\r\nContent-Length: 11\r\n\r\n{\"key\":\"x\"}".utf8)
    for i in 0..<(whole.count - 1) {
      p.feed(whole[i..<(i + 1)])
      XCTAssertNil(try p.next(), "byte \(i)")
    }
    p.feed(whole[(whole.count - 1)...])
    let r = try XCTUnwrap(try p.next())
    XCTAssertEqual(String(decoding: r.body, as: UTF8.self), #"{"key":"x"}"#)
  }

  func testTwoRequestsOnOneConnection() throws {
    var p = HTTPRequestParser()
    p.feed(Data("GET /a HTTP/1.1\r\nHost: h\r\n\r\nGET /b HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n".utf8))
    XCTAssertEqual(try p.next()?.path, "/a")
    let b = try XCTUnwrap(try p.next())
    XCTAssertEqual(b.path, "/b")
    XCTAssertFalse(b.keepAlive)
  }

  func testChunkedBodies() throws {
    var p = HTTPRequestParser()
    p.feed(Data("POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5;ext=1\r\npedia\r\n0\r\n\r\nGET /next HTTP/1.1\r\n\r\n".utf8))
    XCTAssertEqual(String(decoding: try XCTUnwrap(try p.next()).body, as: UTF8.self), "Wikipedia")
    XCTAssertEqual(try p.next()?.path, "/next")
    // With trailers.
    var q = HTTPRequestParser()
    q.feed(Data("POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\nX-T: 1\r\n\r\n".utf8))
    XCTAssertEqual(String(decoding: try XCTUnwrap(try q.next()).body, as: UTF8.self), "hi")
  }

  func testLimitsAndJunk() {
    var big = HTTPRequestParser(maxBody: 10)
    big.feed(Data("POST /x HTTP/1.1\r\nContent-Length: 11\r\n\r\n".utf8))
    XCTAssertThrowsError(try big.next()) { XCTAssertEqual($0 as? HTTPParseError, .bodyTooLarge) }
    var chunky = HTTPRequestParser(maxBody: 3)
    chunky.feed(Data("POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n".utf8))
    XCTAssertThrowsError(try chunky.next()) { XCTAssertEqual($0 as? HTTPParseError, .bodyTooLarge) }
    var head = HTTPRequestParser()
    head.feed(Data(("GET / HTTP/1.1\r\nX: " + String(repeating: "a", count: 70_000)).utf8))
    XCTAssertThrowsError(try head.next()) { XCTAssertEqual($0 as? HTTPParseError, .headTooLarge) }
    for junk in ["GET\r\n\r\n", "GET / FTP/1.0\r\n\r\n", "G=T / HTTP/1.1\r\n\r\n", "GET / HTTP/1.1\r\nno colon\r\n\r\n", "GET / HTTP/1.1\r\nContent-Length: -1\r\n\r\n", "GET / HTTP/1.1\r\nBad Name: x\r\n\r\n"] {
      var p = HTTPRequestParser()
      p.feed(Data(junk.utf8))
      XCTAssertThrowsError(try p.next(), junk) { XCTAssertEqual($0 as? HTTPParseError, .malformed) }
    }
  }

  func testWebSocketUpgradeAndTheBytesAfterIt() throws {
    var p = HTTPRequestParser()
    p.feed(Data("GET /voice HTTP/1.1\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n\r\n".utf8) + Data([0x81, 0x85, 0x61, 0x62, 0x63, 0x64]))
    let r = try XCTUnwrap(try p.next())
    XCTAssertTrue(r.isWebSocketUpgrade)
    XCTAssertEqual(p.takeRest(), Data([0x81, 0x85, 0x61, 0x62, 0x63, 0x64]))
  }

  func testPassingTheHeadOn() throws {
    var p = HTTPRequestParser()
    p.feed(Data("GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1:4317\r\nCookie: orbit_session=aaa; other=1\r\nOrigin: http://127.0.0.1:4317\r\nX-Keep: yes\r\n\r\n".utf8))
    let r = try XCTUnwrap(try p.next())
    let head = String(decoding: r.head(replacing: ["host": "127.0.0.1:5000", "cookie": "orbit_session=bbb", "origin": nil, "connection": "close"]), as: UTF8.self)
    XCTAssertEqual(head, "GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nCookie: orbit_session=bbb\r\nX-Keep: yes\r\nconnection: close\r\n\r\n")
  }

  func testResponsesOnTheWire() {
    let r = BridgeResponse(status: 200, fields: [("content-type", "text/plain")], body: Data("hi".utf8))
    XCTAssertEqual(String(decoding: r.serialize(keepAlive: true), as: UTF8.self), "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nhi")
    XCTAssertEqual(String(decoding: r.serialize(headOnly: true, keepAlive: false), as: UTF8.self), "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\n")
    XCTAssertTrue(String(decoding: BridgeResponse(status: 421).serialize(keepAlive: false), as: UTF8.self).hasPrefix("HTTP/1.1 421 Misdirected Request\r\n"))
  }
}

final class BridgePolicyTests: XCTestCase {
  let token = String(repeating: "ab", count: 32)
  var policy: BridgePolicy { BridgePolicy(port: 4317, accessToken: token) }

  func request(_ fields: [(String, String)]) -> BridgeRequest {
    BridgeRequest(method: "GET", target: "/", path: "/", rawQuery: "", fields: fields.map { (name: $0.0, value: $0.1) }, body: Data(), version: "HTTP/1.1")
  }

  func testHostsAndOrigins() {
    XCTAssertTrue(policy.hostAllowed(request([("Host", "127.0.0.1:4317")])))
    XCTAssertTrue(policy.hostAllowed(request([("Host", "localhost:4317")])))
    for h in ["127.0.0.1:4318", "evil.example", "LOCALHOST:4317", "127.0.0.1"] { XCTAssertFalse(policy.hostAllowed(request([("Host", h)])), h) }
    XCTAssertFalse(policy.hostAllowed(request([])))
    XCTAssertTrue(policy.sameOrigin(request([("Origin", "http://localhost:4317")])))
    XCTAssertFalse(policy.sameOrigin(request([("Origin", "https://127.0.0.1:4317")])))
    XCTAssertFalse(policy.sameOrigin(request([("Origin", "null")])))
    XCTAssertTrue(policy.notCrossSite(request([("Sec-Fetch-Site", "same-origin")])))
    XCTAssertTrue(policy.notCrossSite(request([("Sec-Fetch-Site", "none")])))
    XCTAssertTrue(policy.notCrossSite(request([])))
    XCTAssertFalse(policy.notCrossSite(request([("Sec-Fetch-Site", "cross-site")])))
    XCTAssertFalse(policy.notCrossSite(request([("Sec-Fetch-Site", "same-site")])))
  }

  /** As Node's /(?:^|;\s*)orbit_session=([a-f0-9]{64})/ then a constant-time compare. */
  func testTheSessionCookie() {
    let ok: [String] = ["orbit_session=\(token)", "a=1; orbit_session=\(token)", "a=1;orbit_session=\(token)", "a=1;   orbit_session=\(token); b=2",
                        "orbit_session=\(token)extra", "orbit_session=bad; orbit_session=\(token)"]
    for c in ok { XCTAssertTrue(policy.hasValidSession(request([("Cookie", c)])), c) }
    let no: [String] = ["", "orbit_session=\(token.uppercased())", "orbit_session=\(token.dropLast())", " orbit_session=\(token)", "xorbit_session=\(token)",
                        "orbit_session=\(String(repeating: "cd", count: 32))", "orbit_session = \(token)"]
    for c in no { XCTAssertFalse(policy.hasValidSession(request([("Cookie", c)])), c) }
    XCTAssertFalse(policy.hasValidSession(request([])))
    XCTAssertTrue(policy.tokenMatches(token))
    XCTAssertFalse(policy.tokenMatches(nil))
    XCTAssertFalse(policy.tokenMatches(token + "0"))
  }

  func testTokensAndLinks() {
    let t = BridgePolicy.newToken()
    XCTAssertEqual(t.count, 64)
    XCTAssertTrue(t.allSatisfy { $0.isHexDigit && !$0.isUppercase })
    XCTAssertNotEqual(t, BridgePolicy.newToken())
    XCTAssertEqual(policy.authURL(), "http://127.0.0.1:4317/auth?t=\(token)")
    XCTAssertEqual(policy.authURL(view: "qubit"), "http://127.0.0.1:4317/auth?t=\(token)&view=qubit")
    XCTAssertEqual(policy.authURL(view: "nope"), "http://127.0.0.1:4317/auth?t=\(token)")
    XCTAssertTrue(policy.contentSecurityPolicy.contains("connect-src 'self' ws://127.0.0.1:4317 ws://localhost:4317"))
    XCTAssertTrue(BridgePolicy.wakeCSP.contains("'wasm-unsafe-eval'"))
  }

  func testReadingJSONBodiesAsNodeDoes() {
    XCTAssertEqual(BridgePolicy.readJSON(Data(#"{"a":1}"#.utf8))["a"] as? Int, 1)
    XCTAssertTrue(BridgePolicy.readJSON(Data("not json".utf8)).isEmpty)
    XCTAssertTrue(BridgePolicy.readJSON(Data("[1]".utf8)).isEmpty)
    XCTAssertTrue(BridgePolicy.readJSON(Data((#"{"a":""# + String(repeating: "x", count: 70_000) + #""}"#).utf8)).isEmpty, "over 64 KB reads as {}")
  }
}
