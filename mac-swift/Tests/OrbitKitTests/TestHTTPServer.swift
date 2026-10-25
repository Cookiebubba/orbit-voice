// A tiny HTTP/1.1 server on 127.0.0.1 for tests (a fake bridge, a fake GitHub). One request per
// connection, then it closes: enough for the client code under test, and never the network.
import Foundation
import Network

final class TestHTTPServer: @unchecked Sendable {
  struct Request: Sendable {
    var method: String
    var path: String
    var query: [String: String]
    /** Lower-cased names. */
    var headers: [String: String]
    var body: Data
  }

  struct Response: Sendable {
    var status: Int
    var headers: [String: String]
    var body: Data
    init(status: Int = 200, headers: [String: String] = [:], body: Data = Data()) { self.status = status; self.headers = headers; self.body = body }
    static func json(_ text: String, status: Int = 200, headers: [String: String] = [:]) -> Response {
      Response(status: status, headers: headers.merging(["Content-Type": "application/json"]) { a, _ in a }, body: Data(text.utf8))
    }
    static func text(_ text: String, status: Int = 200) -> Response { Response(status: status, headers: ["Content-Type": "text/plain"], body: Data(text.utf8)) }
  }

  private let listener: NWListener
  private let queue = DispatchQueue(label: "test-http")
  private let lock = NSLock()
  private var _requests: [Request] = []
  private(set) var port: UInt16 = 0
  var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

  var requests: [Request] { lock.lock(); defer { lock.unlock() }; return _requests }

  init(_ handler: @escaping @Sendable (Request) -> Response) throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
    params.allowLocalEndpointReuse = true
    listener = try NWListener(using: params)
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.signal() }
      if case .failed = state { ready.signal() }
    }
    listener.newConnectionHandler = { [weak self] conn in
      guard let self else { return }
      conn.start(queue: self.queue)
      self.read(conn, Data(), handler)
    }
    listener.start(queue: queue)
    _ = ready.wait(timeout: .now() + 5)
    guard let p = listener.port?.rawValue, p != 0 else { throw NSError(domain: "TestHTTPServer", code: 1) }
    port = p
  }

  func stop() { listener.cancel() }

  private func read(_ conn: NWConnection, _ buf: Data, _ handler: @escaping @Sendable (Request) -> Response) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, err in
      guard let self else { return }
      var all = buf
      if let data { all.append(data) }
      if let req = Self.parse(all) {
        self.lock.lock(); self._requests.append(req); self.lock.unlock()
        let r = handler(req)
        var head = "HTTP/1.1 \(r.status) X\r\n"
        var headers = r.headers
        headers["Content-Length"] = headers["Content-Length"] ?? String(r.body.count)
        headers["Connection"] = "close"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(r.body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
        return
      }
      if done || err != nil { conn.cancel(); return }
      self.read(conn, all, handler)
    }
  }

  private static func parse(_ data: Data) -> Request? {
    guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let head = String(decoding: data[..<end.lowerBound], as: UTF8.self)
    var lines = head.components(separatedBy: "\r\n")
    let first = lines.removeFirst().split(separator: " ")
    guard first.count >= 2 else { return nil }
    var headers = [String: String]()
    for l in lines {
      guard let c = l.firstIndex(of: ":") else { continue }
      headers[l[..<c].lowercased()] = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
    }
    let length = Int(headers["content-length"] ?? "0") ?? 0
    let body = data[end.upperBound...]
    guard body.count >= length else { return nil }
    let target = String(first[1])
    let comps = URLComponents(string: "http://x" + target)
    var query = [String: String]()
    for q in comps?.queryItems ?? [] { query[q.name] = q.value ?? "" }
    return Request(method: String(first[0]), path: comps?.path ?? target, query: query, headers: headers, body: Data(body.prefix(length)))
  }
}
