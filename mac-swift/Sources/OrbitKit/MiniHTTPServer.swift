// A tiny HTTP/1.1 server on 127.0.0.1 (Network.framework), for the parity driver. One request per
// connection (the runners send `connection: close`), bodies by Content-Length only, 1 MB at most.
// Never listens beyond loopback.
import Foundation
import Network

public struct HTTPRequest: Sendable {
  public var method: String
  public var path: String
  public var query: [String: String]
  public var headers: [String: String] // lower-cased names
  public var body: Data
}

public struct HTTPResponse: Sendable {
  public var status: Int
  public var headers: [String: String]
  public var body: Data
  public init(status: Int, headers: [String: String] = [:], body: Data = Data()) { self.status = status; self.headers = headers; self.body = body }
  public static func json(_ v: JSONValue, status: Int = 200) -> HTTPResponse {
    HTTPResponse(status: status, headers: ["content-type": "application/json"], body: v.data())
  }
}

public enum HTTPParse {
  /** Parses a full request, or nil if more bytes are needed. Throws on a malformed or too large one. */
  public static func request(_ data: Data, maxBody: Int = 1 << 20) throws -> HTTPRequest? {
    guard let headEnd = data.range(of: Data("\r\n\r\n".utf8)) else {
      if data.count > 64 * 1024 { throw HTTPError.tooLarge }
      return nil
    }
    let head = String(decoding: data[data.startIndex..<headEnd.lowerBound], as: UTF8.self)
    var lines = head.components(separatedBy: "\r\n")
    let first = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
    guard first.count >= 2 else { throw HTTPError.malformed }
    var headers: [String: String] = [:]
    for l in lines {
      guard let i = l.firstIndex(of: ":") else { continue }
      headers[l[..<i].trimmingCharacters(in: .whitespaces).lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
    }
    let length = Int(headers["content-length"] ?? "0") ?? -1
    guard length >= 0 else { throw HTTPError.malformed }
    guard length <= maxBody else { throw HTTPError.tooLarge }
    let bodyStart = headEnd.upperBound
    guard data.count - (bodyStart - data.startIndex) >= length else { return nil }
    let target = String(first[1])
    var comps = URLComponents(string: "http://x" + target)
    if comps == nil { comps = URLComponents() }
    var query: [String: String] = [:]
    for q in comps?.queryItems ?? [] { query[q.name] = q.value ?? "" }
    return HTTPRequest(method: String(first[0]).uppercased(), path: comps?.path ?? target, query: query, headers: headers, body: data[bodyStart..<(bodyStart + length)])
  }

  public static func serialize(_ r: HTTPResponse) -> Data {
    let reason = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large", 500: "Internal Server Error"][r.status] ?? "Status"
    var head = "HTTP/1.1 \(r.status) \(reason)\r\n"
    var h = r.headers
    h["content-length"] = String(r.body.count)
    h["connection"] = "close"
    h["cache-control"] = "no-store"
    for (k, v) in h.sorted(by: { $0.key < $1.key }) { head += "\(k): \(v)\r\n" }
    head += "\r\n"
    return Data(head.utf8) + r.body
  }
}

public enum HTTPError: Error { case malformed, tooLarge }

public final class MiniHTTPServer: @unchecked Sendable {
  public typealias Handler = @Sendable (HTTPRequest) async -> HTTPResponse
  private let listener: NWListener
  private let handler: Handler
  private let queue = DispatchQueue(label: "orbit.minihttp")
  public let port: UInt16

  public init(port: UInt16, handler: @escaping Handler) throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
    params.allowLocalEndpointReuse = true
    listener = try NWListener(using: params)
    self.handler = handler
    self.port = port
  }

  /** Starts listening; returns once ready (or throws if the port is taken). */
  public func start() async throws {
    let ready: AsyncStream<Result<Void, Error>> = AsyncStream { cont in
      listener.stateUpdateHandler = { st in
        switch st {
        case .ready: cont.yield(.success(())); cont.finish()
        case .failed(let e): cont.yield(.failure(e)); cont.finish()
        default: break
        }
      }
    }
    listener.newConnectionHandler = { [weak self] c in self?.serve(c) }
    listener.start(queue: queue)
    for await r in ready { try r.get(); return }
  }

  public func stop() { listener.cancel() }

  private func serve(_ c: NWConnection) {
    // Loopback peers only (the listener is bound to 127.0.0.1; this is belt and braces).
    if case .hostPort(let host, _) = c.endpoint, "\(host)" != "127.0.0.1" && "\(host)" != "::1" { c.cancel(); return }
    c.start(queue: queue)
    receive(c, Data())
  }

  private func receive(_ c: NWConnection, _ acc: Data) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
      guard let self else { return c.cancel() }
      var buf = acc
      if let data { buf.append(data) }
      do {
        if let req = try HTTPParse.request(buf) {
          let h = self.handler
          Task {
            let res = await h(req)
            c.send(content: HTTPParse.serialize(res), completion: .contentProcessed { _ in c.cancel() })
          }
        } else if done || err != nil {
          c.cancel()
        } else {
          self.receive(c, buf)
        }
      } catch {
        let res = HTTPResponse.json(["error": .string(error is HTTPError && (error as! HTTPError) == .tooLarge ? "too large" : "bad request")], status: error is HTTPError && (error as! HTTPError) == .tooLarge ? 413 : 400)
        c.send(content: HTTPParse.serialize(res), completion: .contentProcessed { _ in c.cancel() })
      }
    }
  }
}
