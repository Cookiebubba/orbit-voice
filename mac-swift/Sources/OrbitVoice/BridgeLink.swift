// Talking to the bridge as Orbit's own window does: the sign-in cookie (traded for the per-launch
// token at /auth?t=..., redirects off, Set-Cookie kept), the Origin it accepts (src/server.js
// allowedOrigins: http://127.0.0.1:PORT), /api/config, the /voice WebSocket and the /api/events stream.
import Foundation
import OrbitKit

public final class BridgeLink: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  public let endpoints: BridgeEndpoints
  private let lock = NSLock()
  private var cookieValue: String?
  private lazy var session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.httpShouldSetCookies = false
    c.httpCookieAcceptPolicy = .never
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: c, delegate: self, delegateQueue: nil)
  }()

  public init(endpoints: BridgeEndpoints) { self.endpoints = endpoints }

  /** What the bridge accepts as Origin: its own address. */
  public var origin: String {
    let b = endpoints.base
    return "\(b.scheme ?? "http")://\(b.host ?? "127.0.0.1")\(b.port.map { ":\($0)" } ?? "")"
  }

  /** "orbit_session=…" for the Cookie header (signs in once per launch of the bridge). */
  public func cookie() async throws -> String {
    if let c = lock.withLock({ cookieValue }) { return c }
    guard let auth = endpoints.auth["main"] else { throw URLError(.userAuthenticationRequired) }
    var req = URLRequest(url: auth)
    req.httpShouldHandleCookies = false
    let (_, resp) = try await session.data(for: req)
    guard let h = resp as? HTTPURLResponse, h.statusCode == 302 || h.statusCode == 200,
          let set = h.value(forHTTPHeaderField: "Set-Cookie"),
          let pair = set.split(separator: ";").first.map(String.init), pair.hasPrefix("orbit_session=") else {
      throw URLError(.userAuthenticationRequired)
    }
    lock.withLock { cookieValue = pair }
    return pair
  }

  /** Forget the cookie (the bridge restarted: its token changed). */
  public func signOut() { lock.withLock { cookieValue = nil } }

  /** The sign-in link's 302 isn't followed: only its cookie matters. */
  public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? { nil }

  public func request(_ path: String) async throws -> URLRequest {
    var req = URLRequest(url: endpoints.base.appendingPathComponent(path))
    req.setValue(try await cookie(), forHTTPHeaderField: "Cookie")
    req.setValue(origin, forHTTPHeaderField: "Origin")
    req.httpShouldHandleCookies = false
    return req
  }

  public func getJSON(_ path: String) async throws -> JSONValue {
    let (d, r) = try await session.data(for: try await request(path))
    guard (r as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    return try JSONValue.parse(d)
  }

  public func getData(_ path: String) async throws -> Data {
    let (d, r) = try await session.data(for: try await request(path))
    guard (r as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    return d
  }

  /** The /voice socket's request: ws://host/voice[?announce=1] with the cookie and Origin. */
  public func voiceRequest(announce: Bool) async throws -> URLRequest {
    var c = URLComponents(url: endpoints.base, resolvingAgainstBaseURL: false)!
    c.scheme = endpoints.base.scheme == "https" ? "wss" : "ws"
    c.path = "/voice"
    c.query = announce ? "announce=1" : nil
    var req = URLRequest(url: c.url!)
    req.setValue(try await cookie(), forHTTPHeaderField: "Cookie")
    req.setValue(origin, forHTTPHeaderField: "Origin")
    req.httpShouldHandleCookies = false
    return req
  }

  /**
   * The bridge's live events (/api/events, server-sent events), one JSON object each, until the
   * task is cancelled. Reconnects by itself (like EventSource) after a drop.
   */
  public func events(_ handle: @escaping @Sendable (JSONValue) -> Void) -> Task<Void, Never> {
    Task.detached { [self] in
      var parser = SSEParser()
      while !Task.isCancelled {
        do {
          var req = try await request("api/events")
          req.timeoutInterval = 24 * 3600
          req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
          let (bytes, resp) = try await session.bytes(for: req)
          if (resp as? HTTPURLResponse)?.statusCode == 401 { signOut() }
          for try await line in bytes.lines {
            for data in parser.feed(line) { if let v = try? JSONValue.parse(data) { handle(v) } }
          }
        } catch {}
        if Task.isCancelled { break }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
      }
    }
  }
}

/**
 * Server-sent events, line by line. The bridge writes every event as a single data line
 * (broadcast in src/server.js), and URLSession's `lines` drops the blank lines between events,
 * so each data line is one event.
 */
public struct SSEParser: Sendable {
  public init() {}
  public mutating func feed(_ line: String) -> [String] {
    guard line.hasPrefix("data:") else { return [] }
    var v = String(line.dropFirst(5))
    if v.hasPrefix(" ") { v.removeFirst() }
    return [v]
  }
}
