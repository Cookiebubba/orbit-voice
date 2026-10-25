// WebSockets for the bridge (RFC 6455), as the core's `ws` has them: the server side of /voice (the
// page's call; client frames masked, a 1 MB message limit, no extensions) and a client for xAI's
// realtime API (frames masked, the handshake checked, an HTTP refusal's status and body kept). One
// frame codec for both. Text and binary messages, fragmentation, ping/pong, the closing handshake.
import CryptoKit
import Foundation
import Network

public enum WSOpcode: UInt8, Sendable {
  case continuation = 0, text = 1, binary = 2, close = 8, ping = 9, pong = 10
}

public struct WSFrame: Equatable, Sendable {
  public var fin: Bool
  public var opcode: UInt8
  public var payload: Data
  public init(fin: Bool = true, opcode: UInt8, payload: Data) {
    self.fin = fin
    self.opcode = opcode
    self.payload = payload
  }
}

public enum WSError: Error, Equatable {
  /** (close code, reason) the reader closes the connection with. */
  case protocolError(UInt16, String)
}

/** Frames to and from bytes. */
public enum WSCodec {
  public static let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  public static func accept(key: String) -> String {
    Data(Insecure.SHA1.hash(data: Data((key + guid).utf8))).base64EncodedString()
  }

  /** One frame on the wire; `mask` for a client's frames. */
  public static func encode(_ f: WSFrame, mask: Bool) -> Data {
    var out = Data()
    out.append((f.fin ? 0x80 : 0) | (f.opcode & 0x0F))
    let n = f.payload.count
    let m: UInt8 = mask ? 0x80 : 0
    if n < 126 {
      out.append(m | UInt8(n))
    } else if n <= 0xFFFF {
      out.append(m | 126)
      out.append(UInt8(n >> 8))
      out.append(UInt8(n & 0xFF))
    } else {
      out.append(m | 127)
      for s in stride(from: 56, through: 0, by: -8) { out.append(UInt8((UInt64(n) >> UInt64(s)) & 0xFF)) }
    }
    if mask {
      var key = [UInt8](repeating: 0, count: 4)
      _ = SecRandomCopyBytes(kSecRandomDefault, 4, &key)
      out.append(contentsOf: key)
      var p = [UInt8](f.payload)
      for i in 0..<p.count { p[i] ^= key[i & 3] }
      out.append(contentsOf: p)
    } else {
      out.append(f.payload)
    }
    return out
  }

  /**
   * Reads frames as bytes arrive. `masked`: frames must be masked (from a client) or must not be
   * (from a server). `maxPayload`: the largest message (a fragmented one counts whole).
   */
  public struct Reader {
    var buf = Data()
    let masked: Bool
    let maxPayload: Int
    var fragments = Data()
    var fragmentOpcode: UInt8?
    public init(masked: Bool, maxPayload: Int) {
      self.masked = masked
      self.maxPayload = maxPayload
    }

    public mutating func feed(_ d: Data) { buf.append(d) }

    /** The next whole message or control frame (data frames reassembled), nil if more bytes are needed. */
    public mutating func next() throws -> WSFrame? {
      while true {
        guard let f = try frame() else { return nil }
        let op = f.opcode
        if op >= 8 {
          // Control frames: at most 125 bytes, never fragmented.
          if f.payload.count > 125 || !f.fin { throw WSError.protocolError(1002, "Invalid control frame") }
          return f
        }
        if op == 0 {
          guard let first = fragmentOpcode else { throw WSError.protocolError(1002, "Invalid opcode 0") }
          if fragments.count + f.payload.count > maxPayload { throw WSError.protocolError(1009, "Max payload size exceeded") }
          fragments.append(f.payload)
          if f.fin {
            let whole = WSFrame(opcode: first, payload: fragments)
            fragments = Data()
            fragmentOpcode = nil
            return whole
          }
          continue
        }
        if op != 1 && op != 2 { throw WSError.protocolError(1002, "Invalid opcode \(op)") }
        if fragmentOpcode != nil { throw WSError.protocolError(1002, "Invalid opcode \(op)") }
        if f.fin { return f }
        if f.payload.count > maxPayload { throw WSError.protocolError(1009, "Max payload size exceeded") }
        fragmentOpcode = op
        fragments = f.payload
      }
    }

    mutating func frame() throws -> WSFrame? {
      let b = [UInt8](buf.prefix(14))
      guard b.count >= 2 else { return nil }
      if b[0] & 0x70 != 0 { throw WSError.protocolError(1002, "RSV1 must be clear") }
      let fin = b[0] & 0x80 != 0
      let op = b[0] & 0x0F
      let isMasked = b[1] & 0x80 != 0
      if isMasked != masked { throw WSError.protocolError(1002, masked ? "MASK must be set" : "MASK must be clear") }
      var len = Int(b[1] & 0x7F)
      var at = 2
      if len == 126 {
        guard b.count >= 4 else { return nil }
        len = Int(b[2]) << 8 | Int(b[3])
        at = 4
      } else if len == 127 {
        guard b.count >= 10 else { return nil }
        var v: UInt64 = 0
        for i in 2..<10 { v = v << 8 | UInt64(b[i]) }
        if v > UInt64(Int.max / 2) { throw WSError.protocolError(1009, "Max payload size exceeded") }
        len = Int(v)
        at = 10
      }
      if op < 8 && len > maxPayload { throw WSError.protocolError(1009, "Max payload size exceeded") }
      let keyLen = isMasked ? 4 : 0
      guard buf.count >= at + keyLen + len else { return nil }
      let start = buf.startIndex
      var payload = [UInt8](buf[(start + at + keyLen)..<(start + at + keyLen + len)])
      if isMasked {
        let key = [UInt8](buf[(start + at)..<(start + at + 4)])
        for i in 0..<payload.count { payload[i] ^= key[i & 3] }
      }
      buf = Data(buf[(start + at + keyLen + len)...])
      return WSFrame(fin: fin, opcode: op, payload: Data(payload))
    }
  }

  /** A close frame's code and reason (1005: none given). */
  public static func closeInfo(_ payload: Data) -> (code: UInt16, reason: String) {
    guard payload.count >= 2 else { return (1005, "") }
    let b = [UInt8](payload)
    return (UInt16(b[0]) << 8 | UInt16(b[1]), String(decoding: b[2...], as: UTF8.self))
  }

  static func closePayload(_ code: UInt16?, _ reason: String) -> Data {
    guard let code else { return Data() }
    var d = Data([UInt8(code >> 8), UInt8(code & 0xFF)])
    d.append(Data(reason.utf8.prefix(123)))
    return d
  }
}

/**
 * One WebSocket (either end), on a connection whose handshake is done: messages in and out, the
 * closing handshake, ping answered with pong. Callbacks come on the connection's queue.
 */
public final class BridgeWebSocket: @unchecked Sendable {
  public enum State: Int, Sendable { case connecting = 0, open = 1, closing = 2, closed = 3 }

  public var onMessage: (@Sendable (_ data: Data, _ isBinary: Bool) -> Void)?
  public var onClose: (@Sendable (_ code: UInt16, _ reason: String) -> Void)?
  public var onError: (@Sendable (String) -> Void)?

  let conn: NWConnection
  let queue: DispatchQueue
  let isClient: Bool
  private var reader: WSCodec.Reader
  private var closed = false
  private var closeSent = false
  private var closeTimer: DispatchWorkItem?
  private let stateLock = NSLock()
  private var _state = State.open

  public var readyState: State { stateLock.withLock { _state } }
  private func setState(_ s: State) { stateLock.withLock { _state = s } }

  init(conn: NWConnection, queue: DispatchQueue, isClient: Bool, maxPayload: Int, initial: Data = Data()) {
    self.conn = conn
    self.queue = queue
    self.isClient = isClient
    reader = WSCodec.Reader(masked: !isClient, maxPayload: maxPayload)
    if !initial.isEmpty { reader.feed(initial) }
  }

  /** Starts reading (call once the callbacks are set). */
  public func start() {
    queue.async { [self] in
      process()
      receive()
    }
  }

  func receive() {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, complete, err in
      guard let self else { return }
      if let data, !data.isEmpty {
        self.reader.feed(data)
        self.process()
      }
      if err != nil || complete {
        self.finish(code: 1006, reason: "")
        return
      }
      if !self.closed { self.receive() }
    }
  }

  func process() {
    while !closed {
      let f: WSFrame?
      do {
        f = try reader.next()
      } catch WSError.protocolError(let code, let reason) {
        onError?(reason)
        sendClose(code: code, reason: "")
        finish(code: code, reason: "")
        return
      } catch {
        return
      }
      guard let f else { return }
      switch f.opcode {
      case WSOpcode.text.rawValue:
        guard String(data: f.payload, encoding: .utf8) != nil else {
          onError?("Invalid UTF-8 sequence")
          sendClose(code: 1007, reason: "")
          finish(code: 1007, reason: "")
          return
        }
        onMessage?(f.payload, false)
      case WSOpcode.binary.rawValue:
        onMessage?(f.payload, true)
      case WSOpcode.ping.rawValue:
        write(WSFrame(opcode: WSOpcode.pong.rawValue, payload: f.payload))
      case WSOpcode.pong.rawValue:
        break
      case WSOpcode.close.rawValue:
        let info = WSCodec.closeInfo(f.payload)
        // The other end started (or answered) the closing handshake.
        if !closeSent { sendClose(code: info.code == 1005 ? nil : info.code, reason: "") }
        finish(code: info.code, reason: info.reason)
        return
      default:
        break
      }
    }
  }

  func write(_ f: WSFrame) {
    conn.send(content: WSCodec.encode(f, mask: isClient), completion: .contentProcessed { [weak self] err in
      if err != nil { self?.queue.async { self?.finish(code: 1006, reason: "") } }
    })
  }

  func sendClose(code: UInt16?, reason: String) {
    guard !closeSent else { return }
    closeSent = true
    write(WSFrame(opcode: WSOpcode.close.rawValue, payload: WSCodec.closePayload(code, reason)))
  }

  /** A text message (dropped unless open). */
  public func send(_ text: String) {
    queue.async { [self] in
      guard readyState == .open else { return }
      write(WSFrame(opcode: WSOpcode.text.rawValue, payload: Data(text.utf8)))
    }
  }

  /** Starts the closing handshake (the connection ends when the other side answers, or after 30 s). */
  public func close(code: UInt16? = nil, reason: String = "") {
    queue.async { [self] in
      guard !closed, readyState == .open else { return }
      setState(.closing)
      sendClose(code: code, reason: reason)
      let t = DispatchWorkItem { [weak self] in self?.finish(code: code ?? 1005, reason: reason) }
      closeTimer = t
      queue.asyncAfter(deadline: .now() + 30, execute: t)
    }
  }

  /** Ends it now (no handshake). */
  public func terminate() { queue.async { [self] in finish(code: 1006, reason: "") } }

  func finish(code: UInt16, reason: String) {
    guard !closed else { return }
    closed = true
    setState(.closed)
    closeTimer?.cancel()
    // The server ends the TCP connection; a client waits for the server to (as ws does).
    if isClient {
      queue.asyncAfter(deadline: .now() + 1) { [conn] in conn.cancel() }
    } else {
      conn.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [conn] _ in conn.cancel() })
    }
    onClose?(code, reason)
  }
}

/**
 * A WebSocket client (xAI's realtime API): the opening handshake over TLS, then a BridgeWebSocket.
 * `onRefused(status, body)` if the server answers the upgrade with something else.
 */
public final class WebSocketClient: @unchecked Sendable {
  public var onOpen: (@Sendable (BridgeWebSocket) -> Void)?
  public var onRefused: (@Sendable (_ status: Int, _ body: String) -> Void)?
  public var onError: (@Sendable (String) -> Void)?
  let url: URL
  let headers: [(String, String)]
  let queue = DispatchQueue(label: "orbit.ws-client")
  var conn: NWConnection?
  var socket: BridgeWebSocket?
  private var cancelled = false

  public init(url: URL, headers: [(String, String)] = []) {
    self.url = url
    self.headers = headers
  }

  public func connect() {
    guard let host = url.host, let scheme = url.scheme?.lowercased() else { return fail("Invalid URL") }
    let tls = scheme == "wss" || scheme == "https"
    let port = UInt16(url.port ?? (tls ? 443 : 80))
    let params: NWParameters = tls ? .tls : .tcp
    let c = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: params)
    conn = c
    var keyBytes = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, 16, &keyBytes)
    let key = Data(keyBytes).base64EncodedString()
    var path = url.path.isEmpty ? "/" : url.path
    if let q = url.query { path += "?" + q }
    var head = "GET \(path) HTTP/1.1\r\nHost: \(host)\(url.port.map { ":\($0)" } ?? "")\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n"
    for (k, v) in headers { head += "\(k): \(v)\r\n" }
    head += "\r\n"
    let request = Data(head.utf8)
    c.stateUpdateHandler = { [weak self] st in
      guard let self else { return }
      switch st {
      case .ready:
        c.send(content: request, completion: .contentProcessed { _ in })
        self.readHandshake(Data(), key: key)
      case .failed(let e), .waiting(let e):
        self.fail(e.localizedDescription)
      default:
        break
      }
    }
    c.start(queue: queue)
  }

  func fail(_ why: String) {
    guard !cancelled else { return }
    cancelled = true
    conn?.cancel()
    onError?(why)
  }

  func readHandshake(_ got: Data, key: String) {
    conn?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, err in
      guard let self, !self.cancelled else { return }
      var buf = got
      if let data { buf.append(data) }
      guard let end = buf.range(of: Data("\r\n\r\n".utf8)) else {
        if err != nil || complete { return self.fail(err?.localizedDescription ?? "The server closed the connection") }
        return self.readHandshake(buf, key: key)
      }
      let head = String(decoding: buf[buf.startIndex..<end.lowerBound], as: UTF8.self)
      let lines = head.components(separatedBy: "\r\n")
      let status = Int(lines.first?.split(separator: " ").dropFirst().first ?? "") ?? 0
      var fields: [String: String] = [:]
      for l in lines.dropFirst() {
        guard let colon = l.firstIndex(of: ":") else { continue }
        fields[l[..<colon].lowercased().trimmingCharacters(in: .whitespaces)] = l[l.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      }
      let rest = Data(buf[end.upperBound...])
      if status != 101 {
        // Refused: read what body it sends (up to a little), then report it.
        self.readBody(rest, status: status, length: Int(fields["content-length"] ?? "") ?? -1)
        return
      }
      guard fields["sec-websocket-accept"] == WSCodec.accept(key: key) else { return self.fail("Invalid Sec-WebSocket-Accept header") }
      let ws = BridgeWebSocket(conn: self.conn!, queue: self.queue, isClient: true, maxPayload: 100 << 20, initial: rest)
      self.socket = ws
      self.onOpen?(ws)
      ws.start()
    }
  }

  func readBody(_ got: Data, status: Int, length: Int) {
    if (length >= 0 && got.count >= length) || got.count >= 16 * 1024 {
      cancelled = true
      conn?.cancel()
      onRefused?(status, String(decoding: got.prefix(length >= 0 ? length : got.count), as: UTF8.self))
      return
    }
    conn?.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, complete, err in
      guard let self, !self.cancelled else { return }
      var buf = got
      if let data { buf.append(data) }
      if err != nil || complete {
        self.cancelled = true
        self.conn?.cancel()
        self.onRefused?(status, String(decoding: buf, as: UTF8.self))
        return
      }
      self.readBody(buf, status: status, length: length)
    }
  }

  /** Gives up on connecting (or ends the socket at once). */
  public func cancel() {
    queue.async { [self] in
      if let s = socket { s.terminate() } else { cancelled = true; conn?.cancel() }
    }
  }
}
