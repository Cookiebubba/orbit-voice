// The bridge's security model, as src/server.js has it:
//   - it listens on 127.0.0.1 only and answers only Orbit's own windows: every API call and the voice
//     socket need a random per-launch token, held in an HttpOnly cookie only Orbit's windows get;
//   - Host must be 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding);
//   - state-changing requests and the voice socket must come from Orbit's own Origin, and read-only
//     calls are refused when the browser marks them cross-site (CSRF defence).
import Foundation
import Security

public struct BridgePolicy: Sendable {
  public static let host = "127.0.0.1"
  public static let sessionCookie = "orbit_session"

  public let port: Int
  /** 64 hex characters, new on every launch. */
  public let accessToken: String

  public init(port: Int, accessToken: String = BridgePolicy.newToken()) {
    self.port = port
    self.accessToken = accessToken
  }

  /** 32 random bytes as hex (crypto.randomBytes(32).toString('hex')). */
  public static func newToken() -> String {
    var b = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, 32, &b)
    return b.map { String(format: "%02x", $0) }.joined()
  }

  public var allowedHosts: Set<String> { ["\(Self.host):\(port)", "localhost:\(port)"] }
  public var allowedOrigins: Set<String> { Set(allowedHosts.map { "http://\($0)" }) }
  public var base: String { "http://\(Self.host):\(port)" }

  public func hostAllowed(_ r: BridgeRequest) -> Bool { r.header("host").map { allowedHosts.contains($0) } ?? false }
  public func sameOrigin(_ r: BridgeRequest) -> Bool { r.header("origin").map { allowedOrigins.contains($0) } ?? false }
  /** Browsers label every request with Sec-Fetch-Site; anything another site initiated is refused. */
  public func notCrossSite(_ r: BridgeRequest) -> Bool { !["cross-site", "same-site"].contains(r.header("sec-fetch-site") ?? "") }

  /**
   * The session cookie, if it holds this launch's token. As Node's /(?:^|;\s*)orbit_session=([a-f0-9]{64})/:
   * the first such cookie whose value starts with 64 lower-case hex characters, those compared in
   * constant time.
   */
  public func hasValidSession(_ r: BridgeRequest) -> Bool {
    guard let cookie = r.header("cookie") else { return false }
    let isHex: (Character) -> Bool = { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    for (i, part) in cookie.split(separator: ";", omittingEmptySubsequences: false).enumerated() {
      // At the very start no space may come first; after a ";" any amount may.
      let p = i == 0 ? Substring(part) : part.drop(while: { $0.isWhitespace })
      let prefix = Self.sessionCookie + "="
      guard p.hasPrefix(prefix) else { continue }
      let value = p.dropFirst(prefix.count).prefix(64)
      guard value.count == 64, value.allSatisfy(isHex) else { continue }
      return Self.constantTimeEqual(String(value), accessToken)
    }
    return false
  }

  public func tokenMatches(_ value: String?) -> Bool { Self.constantTimeEqual(value ?? "", accessToken) }

  static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    guard x.count == y.count else { return false }
    var diff: UInt8 = 0
    for i in 0..<x.count { diff |= x[i] ^ y[i] }
    return diff == 0
  }

  /** The one-time link that signs a window in (authUrl in server.js). */
  public func authURL(view: String = "main") -> String {
    "\(base)/auth?t=\(accessToken)\(["orb", "buddy", "qubit", "mouse"].contains(view) ? "&view=\(view)" : "")"
  }

  public static let authLocations = ["orb": "/#orb", "buddy": "/buddy.html", "qubit": "/qubit.html", "mouse": "/mouse.html"]

  public static let securityHeaders: [(String, String)] = [
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("x-frame-options", "DENY"),
    ("cross-origin-resource-policy", "same-origin"),
  ]

  public var contentSecurityPolicy: String {
    [
      "default-src 'self'",
      "script-src 'self'",
      "frame-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws://\(Self.host):\(port) ws://localhost:\(port)",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].joined(separator: "; ")
  }

  /** The hidden wake-word page: the offline recognizer needs eval, WebAssembly and a blob worker. */
  public static let wakeCSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "connect-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "form-action 'none'",
  ].joined(separator: "; ")

  public static let mime: [String: String] = [
    "html": "text/html; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "svg": "image/svg+xml",
    "png": "image/png",
    "ico": "image/x-icon",
    "woff2": "font/woff2",
    "mp3": "audio/mpeg",
  ]

  // MARK: responses

  public static func json(_ status: Int, _ body: Any) -> BridgeResponse {
    let data = (try? JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data("{}".utf8)
    return BridgeResponse(status: status, fields: [("content-type", "application/json"), ("cache-control", "no-store")], body: data)
  }

  public static func plain(_ status: Int, _ text: String = "", fields: [(String, String)] = []) -> BridgeResponse {
    BridgeResponse(status: status, fields: fields, body: Data(text.utf8))
  }

  /** A JSON body as Node's readJson reads it: an object, else {} (also when too big or broken). */
  public static func readJSON(_ body: Data, max: Int = 64 * 1024) -> [String: Any] {
    guard body.count <= max, !body.isEmpty else { return [:] }
    return ((try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])) as? [String: Any]) ?? [:]
  }
}
