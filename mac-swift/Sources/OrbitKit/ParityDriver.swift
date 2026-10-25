// The parity driver (../../parity/PROTOCOL.md): GET /parity/hello, GET /parity/state, POST
// /parity/act, on 127.0.0.1:$ORBIT_PARITY_PORT, each with the x-parity-token header. Only a test
// build starts it (build-app.sh --test bakes ORBIT_PARITY_ALLOWED into Info.plist); a release build
// never listens.
import Foundation

public protocol ParityDriverDelegate: AnyObject, Sendable {
  func parityHello() async -> JSONValue
  func parityState() async -> ParityState
  func parityAct(action: String, args: JSONValue) async -> JSONValue
}

public final class ParityDriver: @unchecked Sendable {
  public static let actions: Set<String> = [
    "voice.hotkey", "voice.sleep", "voice.wake", "voice.type", "voice.hangup", "mic.play", "cursor.set", "pointer",
    "avatar.eval", "avatar.command", "settings.ui", "settings.read", "window.show", "window.minimize", "perms.set",
    "onboarding.next", "quit",
  ]

  private let token: String
  private weak var delegate: ParityDriverDelegate?
  private var server: MiniHTTPServer?

  public init(token: String, delegate: ParityDriverDelegate) {
    self.token = token
    self.delegate = delegate
  }

  /** Is the driver allowed in this build and asked for in this launch? Returns (port, token). */
  public static func config(info: [String: Any]? = Bundle.main.infoDictionary, env: [String: String] = ProcessInfo.processInfo.environment) -> (UInt16, String)? {
    guard (info?["OrbitParityAllowed"] as? Bool) == true || (info?["OrbitParityAllowed"] as? String) == "1" else { return nil }
    guard let p = env["ORBIT_PARITY_PORT"].flatMap(UInt16.init), p > 1024, let t = env["ORBIT_PARITY_TOKEN"], t.count >= 16 else { return nil }
    return (p, t)
  }

  public func start(port: UInt16) async throws {
    let s = try MiniHTTPServer(port: port) { [weak self] req in
      guard let self else { return .json(["error": "gone"], status: 500) }
      return await self.handle(req)
    }
    try await s.start()
    server = s
  }

  public func stop() { server?.stop() }

  /** Routing, public for tests. */
  public func handle(_ req: HTTPRequest) async -> HTTPResponse {
    guard Self.tokenMatches(req.headers["x-parity-token"], token) else { return .json(["error": "forbidden"], status: 403) }
    guard let d = delegate else { return .json(["error": "not ready"], status: 500) }
    switch (req.method, req.path) {
    case ("GET", "/parity/hello"): return .json(await d.parityHello())
    case ("GET", "/parity/state"): return .json(JSONValue.from(await d.parityState()))
    case ("POST", "/parity/act"):
      guard let body = try? JSONValue.parse(req.body), let action = body["action"]?.stringValue else { return .json(["ok": false, "error": "bad request"], status: 400) }
      guard Self.actions.contains(action) else { return .json(["ok": false, "error": .string("unknown action \(action)")], status: 400) }
      return .json(await d.parityAct(action: action, args: body["args"] ?? .object([:])))
    case (_, "/parity/hello"), (_, "/parity/state"), (_, "/parity/act"): return .json(["error": "method not allowed"], status: 405)
    default: return .json(["error": "not found"], status: 404)
    }
  }

  /** Constant-time comparison. */
  public static func tokenMatches(_ given: String?, _ want: String) -> Bool {
    guard let g = given, !want.isEmpty else { return false }
    let a = Array(g.utf8), b = Array(want.utf8)
    guard a.count == b.count else { return false }
    var diff: UInt8 = 0
    for i in 0..<a.count { diff |= a[i] ^ b[i] }
    return diff == 0
  }
}
