// HTTP/1.1 messages for Orbit's bridge (the Swift side of src/server.js): requests parsed as bytes
// arrive (one connection may carry several, keep-alive), and responses written back. Loopback only,
// so the limits are generous for Orbit's own pages and tight for anything else.
import Foundation

public struct BridgeRequest: Sendable {
  public var method: String
  /** The request target as sent ("/api/config?x=1"). */
  public var target: String
  /** The decoded-path-free path ("/api/config"), as Node's URL.pathname: percent escapes kept. */
  public var path: String
  /** The raw query string, without "?" ("" if none). */
  public var rawQuery: String
  /** Header fields in the order they came (names as sent). */
  public var fields: [(name: String, value: String)]
  public var body: Data
  public var version: String

  /** A header by name (case-insensitive); the first one. */
  public func header(_ name: String) -> String? {
    let n = name.lowercased()
    return fields.first { $0.name.lowercased() == n }?.value
  }

  /** The first value of a query parameter, decoded as URLSearchParams would. */
  public func query(_ name: String) -> String? {
    for pair in rawQuery.split(separator: "&", omittingEmptySubsequences: true) {
      let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      if Self.formDecode(String(kv[0])) == name { return kv.count > 1 ? Self.formDecode(String(kv[1])) : "" }
    }
    return nil
  }

  public var queryItems: [(String, String)] {
    rawQuery.split(separator: "&", omittingEmptySubsequences: true).map { pair in
      let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      return (Self.formDecode(String(kv[0])), kv.count > 1 ? Self.formDecode(String(kv[1])) : "")
    }
  }

  /** application/x-www-form-urlencoded decoding ("+" is a space), as URLSearchParams does. */
  static func formDecode(_ s: String) -> String {
    let spaced = s.replacingOccurrences(of: "+", with: " ")
    return spaced.removingPercentEncoding ?? spaced
  }

  /** Does the client want the connection kept open after this request? */
  public var keepAlive: Bool {
    let c = (header("connection") ?? "").lowercased()
    if version == "HTTP/1.0" { return c.contains("keep-alive") }
    return !c.contains("close")
  }

  public var isWebSocketUpgrade: Bool {
    (header("upgrade") ?? "").lowercased() == "websocket" && (header("connection") ?? "").lowercased().contains("upgrade")
  }

  /** The request head again (for passing it on), with some fields replaced or removed. */
  public func head(replacing: [String: String?], adding extra: [(String, String)] = []) -> Data {
    let lower = Dictionary(uniqueKeysWithValues: replacing.map { ($0.key.lowercased(), $0.value) })
    var out = "\(method) \(target) \(version)\r\n"
    var done = Set<String>()
    for f in fields {
      let n = f.name.lowercased()
      if let r = lower[n] {
        if let v = r, !done.contains(n) { out += "\(f.name): \(v)\r\n" }
        done.insert(n)
      } else {
        out += "\(f.name): \(f.value)\r\n"
      }
    }
    for (k, v) in lower where !done.contains(k) { if let v { out += "\(k): \(v)\r\n" } }
    for (k, v) in extra { out += "\(k): \(v)\r\n" }
    out += "\r\n"
    return Data(out.utf8)
  }
}

public enum HTTPParseError: Error, Equatable { case malformed, headTooLarge, bodyTooLarge }

/**
 * Takes bytes as they arrive and gives back whole requests. The body is read by Content-Length or
 * chunked transfer coding; `maxBody` caps it (a bigger one is refused, as Node's readJson gives up).
 */
public struct HTTPRequestParser: Sendable {
  public static let maxHead = 64 * 1024
  public let maxBody: Int
  private var buffer = Data()

  public init(maxBody: Int = 1 << 20) { self.maxBody = maxBody }

  public mutating func feed(_ data: Data) { buffer.append(data) }

  /** Bytes received after the last whole request (e.g. a WebSocket's first frames). */
  public mutating func takeRest() -> Data {
    defer { buffer = Data() }
    return buffer
  }

  /** The next whole request, nil if more bytes are needed. */
  public mutating func next() throws -> BridgeRequest? {
    guard let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
      if buffer.count > Self.maxHead { throw HTTPParseError.headTooLarge }
      return nil
    }
    if headEnd.lowerBound - buffer.startIndex > Self.maxHead { throw HTTPParseError.headTooLarge }
    let headText = String(decoding: buffer[buffer.startIndex..<headEnd.lowerBound], as: UTF8.self)
    var lines = headText.components(separatedBy: "\r\n")
    let first = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
    guard first.count == 3, first[2].hasPrefix("HTTP/1."), first[0].allSatisfy({ $0.isLetter }) else { throw HTTPParseError.malformed }
    var fields: [(String, String)] = []
    for l in lines where !l.isEmpty {
      guard let i = l.firstIndex(of: ":"), i != l.startIndex else { throw HTTPParseError.malformed }
      let name = String(l[..<i])
      guard !name.contains(" ") else { throw HTTPParseError.malformed }
      fields.append((name, l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)))
    }
    let lower = { (n: String) in fields.first { $0.0.lowercased() == n }?.1 }
    let bodyStart = headEnd.upperBound
    var body = Data()
    var consumedTo = bodyStart
    if (lower("transfer-encoding") ?? "").lowercased().contains("chunked") {
      var at = bodyStart
      while true {
        guard let lineEnd = buffer[at...].range(of: Data("\r\n".utf8)) else { return nil }
        let sizeText = String(decoding: buffer[at..<lineEnd.lowerBound], as: UTF8.self).split(separator: ";")[0].trimmingCharacters(in: .whitespaces)
        guard let size = Int(sizeText, radix: 16), size >= 0 else { throw HTTPParseError.malformed }
        let dataStart = lineEnd.upperBound
        if size == 0 {
          // The final empty line, or trailers (ignored) and then it.
          guard buffer.endIndex - dataStart >= 2 else { return nil }
          if buffer[dataStart] == 13, buffer[dataStart + 1] == 10 {
            consumedTo = dataStart + 2
          } else {
            guard let blank = buffer[dataStart...].range(of: Data("\r\n\r\n".utf8)) else { return nil }
            consumedTo = blank.upperBound
          }
          break
        }
        guard body.count + size <= maxBody else { throw HTTPParseError.bodyTooLarge }
        guard buffer.endIndex - dataStart >= size + 2 else { return nil }
        body.append(buffer[dataStart..<(dataStart + size)])
        at = dataStart + size + 2
      }
    } else {
      let lengthText = lower("content-length") ?? "0"
      guard let length = Int(lengthText), length >= 0 else { throw HTTPParseError.malformed }
      guard length <= maxBody else { throw HTTPParseError.bodyTooLarge }
      guard buffer.endIndex - bodyStart >= length else { return nil }
      body = Data(buffer[bodyStart..<(bodyStart + length)])
      consumedTo = bodyStart + length
    }
    let target = String(first[1])
    let q = target.firstIndex(of: "?")
    let path = q.map { String(target[..<$0]) } ?? target
    let rawQuery = q.map { String(target[target.index(after: $0)...]) } ?? ""
    let req = BridgeRequest(method: String(first[0]).uppercased(), target: target, path: path, rawQuery: rawQuery, fields: fields, body: body, version: String(first[2]))
    buffer = Data(buffer[consumedTo...])
    return req
  }
}

/** A response: status, header fields in order, and a body (or none, for HEAD). */
public struct BridgeResponse: Sendable {
  public var status: Int
  public var fields: [(name: String, value: String)]
  public var body: Data

  public init(status: Int, fields: [(String, String)] = [], body: Data = Data()) {
    self.status = status
    self.fields = fields.map { (name: $0.0, value: $0.1) }
    self.body = body
  }

  public func header(_ name: String) -> String? {
    let n = name.lowercased()
    return fields.first { $0.name.lowercased() == n }?.value
  }

  public static let reasons: [Int: String] = [
    101: "Switching Protocols", 200: "OK", 202: "Accepted", 204: "No Content", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    409: "Conflict", 413: "Payload Too Large", 421: "Misdirected Request", 426: "Upgrade Required",
    431: "Request Header Fields Too Large", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
  ]

  /**
   * The bytes on the wire. `headOnly`: a HEAD request's answer (the length of the body it would
   * have, no body). `keepAlive`: whether the connection stays open after it.
   */
  public func serialize(headOnly: Bool = false, keepAlive: Bool) -> Data {
    var head = "HTTP/1.1 \(status) \(Self.reasons[status] ?? "Status")\r\n"
    var hasLength = false
    for f in fields {
      let n = f.name.lowercased()
      if n == "connection" { continue }
      if n == "content-length" { hasLength = true }
      head += "\(f.name): \(f.value)\r\n"
    }
    if !hasLength { head += "content-length: \(body.count)\r\n" }
    head += "connection: \(keepAlive ? "keep-alive" : "close")\r\n\r\n"
    var out = Data(head.utf8)
    if !headOnly { out.append(body) }
    return out
  }
}
