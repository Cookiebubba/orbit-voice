// The bridge's WebSockets: the frame codec (masking, lengths, fragments, the 1 MB limit, control
// frames), and the server and client end to end on a real port: messages both ways, ping, closing,
// a refused upgrade's status and body.
import Foundation
import XCTest
@testable import OrbitBridge
@testable import OrbitKit

final class WebSocketTests: XCTestCase {
  func testFramesBothWays() throws {
    for n in [0, 5, 125, 126, 65535, 65536, 200_000] {
      let payload = Data((0..<n).map { UInt8($0 % 251) })
      for mask in [true, false] {
        var r = WSCodec.Reader(masked: mask, maxPayload: 1 << 20)
        r.feed(WSCodec.encode(WSFrame(opcode: 2, payload: payload), mask: mask))
        XCTAssertEqual(try r.next(), WSFrame(opcode: 2, payload: payload), "\(n) bytes, mask \(mask)")
        XCTAssertNil(try r.next())
      }
    }
    // Arriving a byte at a time.
    var r = WSCodec.Reader(masked: true, maxPayload: 1 << 20)
    let bytes = WSCodec.encode(WSFrame(opcode: 1, payload: Data("hello".utf8)), mask: true)
    for b in bytes.dropLast() {
      r.feed(Data([b]))
      XCTAssertNil(try r.next())
    }
    r.feed(Data([bytes.last!]))
    XCTAssertEqual(try r.next()?.payload, Data("hello".utf8))
  }

  func testFragmentsLimitsAndRules() throws {
    var r = WSCodec.Reader(masked: true, maxPayload: 10)
    r.feed(WSCodec.encode(WSFrame(fin: false, opcode: 1, payload: Data("hel".utf8)), mask: true))
    r.feed(WSCodec.encode(WSFrame(opcode: 9, payload: Data("p".utf8)), mask: true)) // a ping in between
    r.feed(WSCodec.encode(WSFrame(fin: true, opcode: 0, payload: Data("lo".utf8)), mask: true))
    XCTAssertEqual(try r.next(), WSFrame(opcode: 9, payload: Data("p".utf8)))
    XCTAssertEqual(try r.next(), WSFrame(opcode: 1, payload: Data("hello".utf8)))
    r.feed(WSCodec.encode(WSFrame(opcode: 1, payload: Data(count: 11)), mask: true))
    XCTAssertThrowsError(try r.next()) { XCTAssertEqual($0 as? WSError, .protocolError(1009, "Max payload size exceeded")) }
    var unmasked = WSCodec.Reader(masked: true, maxPayload: 100)
    unmasked.feed(WSCodec.encode(WSFrame(opcode: 1, payload: Data("x".utf8)), mask: false))
    XCTAssertThrowsError(try unmasked.next()) { XCTAssertEqual($0 as? WSError, .protocolError(1002, "MASK must be set")) }
    var stray = WSCodec.Reader(masked: true, maxPayload: 100)
    stray.feed(WSCodec.encode(WSFrame(opcode: 0, payload: Data("x".utf8)), mask: true))
    XCTAssertThrowsError(try stray.next())
    XCTAssertEqual(WSCodec.closeInfo(Data([0x03, 0xE8]) + Data("bye".utf8)).code, 1000)
    XCTAssertEqual(WSCodec.closeInfo(Data()).code, 1005)
    XCTAssertEqual(WSCodec.accept(key: "dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
  }

  func testServerAndClientEndToEnd() async throws {
    let port = try XCTUnwrap(FreePort.pick())
    let serverGot = Locked<[String]>([])
    let serverClosed = Locked<UInt16?>(nil)
    let server = try BridgeServer(port: port) { r in
      if r.path == "/nope" { return .response(BridgeResponse(status: 401, fields: [("content-type", "text/plain")], body: Data("go away".utf8))) }
      return .webSocket { ws in
        ws.onMessage = { data, _ in
          let t = String(decoding: data, as: UTF8.self)
          serverGot.update { $0.append(t) }
          ws.send("echo: \(t)")
          if t == "bye" { ws.close(code: 1000, reason: "done") }
        }
        ws.onClose = { code, _ in serverClosed.set(code) }
      }
    }
    try await server.start()
    defer { server.stop() }

    let got = Locked<[String]>([])
    let closed = Locked<(UInt16, String)?>(nil)
    let opened = expectation(description: "open")
    let client = WebSocketClient(url: URL(string: "ws://127.0.0.1:\(port)/voice")!, headers: [("Authorization", "Bearer test")])
    let sock = Locked<BridgeWebSocket?>(nil)
    client.onOpen = { ws in
      ws.onMessage = { d, _ in got.update { $0.append(String(decoding: d, as: UTF8.self)) } }
      ws.onClose = { c, r in closed.set((c, r)) }
      sock.set(ws)
      opened.fulfill()
    }
    client.connect()
    await fulfillment(of: [opened], timeout: 5)
    let big = String(repeating: "x", count: 70_000)
    sock.get()?.send("hello")
    sock.get()?.send(big)
    sock.get()?.send("bye")
    for _ in 0..<200 where closed.get() == nil { try await Task.sleep(nanoseconds: 20_000_000) }
    XCTAssertEqual(serverGot.get(), ["hello", big, "bye"])
    XCTAssertEqual(got.get(), ["echo: hello", "echo: \(big)", "echo: bye"])
    XCTAssertEqual(closed.get()?.0, 1000)
    XCTAssertEqual(closed.get()?.1, "done")
    for _ in 0..<100 where serverClosed.get() == nil { try await Task.sleep(nanoseconds: 20_000_000) }
    XCTAssertEqual(serverClosed.get(), 1000)

    // A refused upgrade: its status and body come back.
    let refused = expectation(description: "refused")
    let why = Locked<(Int, String)?>(nil)
    let c2 = WebSocketClient(url: URL(string: "ws://127.0.0.1:\(port)/nope")!)
    c2.onRefused = { s, b in why.set((s, b)); refused.fulfill() }
    c2.connect()
    await fulfillment(of: [refused], timeout: 5)
    XCTAssertEqual(why.get()?.0, 401)
    XCTAssertEqual(why.get()?.1, "go away")
  }

  func testAMessageOverTheLimitClosesWith1009() async throws {
    let port = try XCTUnwrap(FreePort.pick())
    let server = try BridgeServer(port: port, maxBody: 1 << 20) { _ in .webSocket { ws in ws.onMessage = { _, _ in } } }
    try await server.start()
    defer { server.stop() }
    let closed = Locked<UInt16?>(nil)
    let opened = expectation(description: "open")
    let client = WebSocketClient(url: URL(string: "ws://127.0.0.1:\(port)/voice")!)
    let sock = Locked<BridgeWebSocket?>(nil)
    client.onOpen = { ws in
      ws.onClose = { c, _ in closed.set(c) }
      sock.set(ws)
      opened.fulfill()
    }
    client.connect()
    await fulfillment(of: [opened], timeout: 5)
    sock.get()?.send(String(repeating: "y", count: (1 << 20) + 10))
    for _ in 0..<250 where closed.get() == nil { try await Task.sleep(nanoseconds: 20_000_000) }
    XCTAssertEqual(closed.get(), 1009)
  }
}
