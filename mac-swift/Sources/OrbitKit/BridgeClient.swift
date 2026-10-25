// The bridge's HTTP API (src/server.js), as the Electron page uses it: sign in once with the
// per-launch link, keep the session cookie, and send the Origin the bridge accepts on POSTs.
//
// The bridge's rules (src/server.js handle()):
//   - Host must be 127.0.0.1:<port> or localhost:<port> (URLSession sends the URL's own host:port).
//   - Every /api/ call needs the orbit_session cookie, which GET /auth?t=<token> sets on a 302. We
//     follow no redirects there: we only want the cookie, not the page it points at.
//   - POSTs must carry Origin http://<host>:<port> (sameOrigin), and nothing may say it is cross-site
//     (notCrossSite reads Sec-Fetch-Site, which URLSession never sends).
// The cookie and any key passed to setXaiKey/setBrainKey are never logged or printed.
import Foundation

public struct BridgeError: Error, Equatable, Sendable, CustomStringConvertible {
  public var status: Int
  /** The bridge's own sentence (`error`/`message`), safe to show. */
  public var message: String
  public init(status: Int, message: String) { self.status = status; self.message = message }
  public var description: String { "bridge HTTP \(status): \(message)" }
}

// MARK: - Route payloads

/** GET /api/config */
public struct BridgeConfig: Sendable, Equatable {
  public var version: String
  public var hasKey: Bool
  public var keyStorage: String
  public var settings: [String: JSONValue]
  public var limits: [String: JSONValue]
  public var defaults: [String: JSONValue]
  public init(json: JSONValue) {
    version = json["version"]?.stringValue ?? "dev"
    hasKey = json["hasKey"]?.boolValue ?? false
    keyStorage = json["keyStorage"]?.stringValue ?? "none"
    settings = json["settings"]?.objectValue ?? [:]
    limits = json["limits"]?.objectValue ?? [:]
    defaults = json["defaults"]?.objectValue ?? [:]
  }
}

/** GET /api/voice?engine= */
public struct VoiceList: Sendable, Equatable {
  public struct Voice: Sendable, Equatable, Identifiable { public var id: String; public var name: String; public var gender: String }
  public var voice: String
  public var speed: Double
  public var minSpeed: Double
  public var maxSpeed: Double
  public var voices: [Voice]
  public var engine: String
  public init(json: JSONValue) {
    voice = json["voice"]?.stringValue ?? ""
    speed = json["speed"]?.doubleValue ?? 1
    minSpeed = json["minSpeed"]?.doubleValue ?? 0.7
    maxSpeed = json["maxSpeed"]?.doubleValue ?? 1.5
    voices = (json["voices"]?.arrayValue ?? []).map { Voice(id: $0["id"]?.stringValue ?? "", name: $0["name"]?.stringValue ?? "", gender: $0["gender"]?.stringValue ?? "other") }
    engine = json["engine"]?.stringValue ?? "grok"
  }
}

/** A model download's state (GET /api/claude-voice). */
public struct DownloadState: Sendable, Equatable {
  public var state: String // idle | downloading | ready | error
  public var percent: Int
  public var error: String
  public var mb: Int
  public init(json: JSONValue?) {
    state = json?["state"]?.stringValue ?? "idle"
    percent = json?["percent"]?.intValue ?? 0
    error = json?["error"]?.stringValue ?? ""
    mb = json?["mb"]?.intValue ?? 0
  }
}

/** GET /api/claude-voice */
public struct ClaudeVoiceStatus: Sendable, Equatable {
  public var models: DownloadState
  public var mb: Int
  public var claudeFound: Bool
  public var stt: [String: DownloadState]
  public init(json: JSONValue) {
    models = DownloadState(json: json["models"])
    mb = json["mb"]?.intValue ?? 0
    claudeFound = json["claudeFound"]?.boolValue ?? false
    stt = (json["stt"]?.objectValue ?? [:]).mapValues { DownloadState(json: $0) }
  }
}

/** GET /api/brain */
public struct BrainStatus: Sendable, Equatable {
  public var found: Bool
  public var path: String?
  public var source: String? // settings | path | claude-desktop
  public var hasKey: Bool
  public var signedIn: Bool?
  public init(json: JSONValue) {
    found = json["found"]?.boolValue ?? false
    path = json["path"]?.stringValue
    source = json["source"]?.stringValue
    hasKey = json["hasKey"]?.boolValue ?? false
    signedIn = json["signedIn"]?.boolValue
  }
}

/** POST /api/brain/test and /api/brain/login */
public struct BrainResult: Sendable, Equatable {
  public var ok: Bool
  public var seconds: Double?
  public var error: String?
  public var needsSignIn: Bool
  public init(json: JSONValue) {
    ok = json["ok"]?.boolValue ?? false
    seconds = json["seconds"]?.doubleValue
    error = json["error"]?.stringValue
    needsSignIn = json["needsSignIn"]?.boolValue ?? false
  }
}

/** One row of GET /api/sessions */
public struct SessionRow: Sendable, Equatable, Identifiable {
  public var id: String
  public var title: String
  public var badge: String
  public var project: String
  public var lastActive: String
  public var working: Bool
  public var open: Bool
  public init(id: String, title: String, badge: String = "", project: String = "", lastActive: String = "", working: Bool = false, open: Bool = false) {
    self.id = id; self.title = title; self.badge = badge; self.project = project; self.lastActive = lastActive; self.working = working; self.open = open
  }
  public init(json: JSONValue) {
    self.init(id: json["id"]?.stringValue ?? json["title"]?.stringValue ?? "", title: json["title"]?.stringValue ?? "", badge: json["badge"]?.stringValue ?? "",
              project: json["project"]?.stringValue ?? "", lastActive: json["lastActive"]?.stringValue ?? "", working: json["working"]?.boolValue ?? false, open: json["open"]?.boolValue ?? false)
  }
}

/** GET /api/sessions */
public struct SessionsList: Sendable, Equatable {
  public var sessions: [SessionRow]
  public var openInApp: String?
  public var canSwitch: Bool
  public init(sessions: [SessionRow], openInApp: String?, canSwitch: Bool) { self.sessions = sessions; self.openInApp = openInApp; self.canSwitch = canSwitch }
  public init(json: JSONValue) {
    sessions = (json["sessions"]?.arrayValue ?? []).map(SessionRow.init(json:))
    openInApp = json["openInApp"]?.stringValue
    canSwitch = json["canSwitch"]?.boolValue ?? false
  }
}

/** POST /api/switch: ok, sessionTitle, or a message why not. */
public struct SwitchResult: Sendable, Equatable {
  public var ok: Bool
  public var sessionTitle: String?
  public var message: String?
}

/** GET /api/usage */
public struct UsageSummary: Sendable, Equatable {
  public struct Period: Sendable, Equatable { public var minutes: Double; public var cost: Double }
  public var today: Period
  public var month: Period
  public init(json: JSONValue) {
    func p(_ j: JSONValue?) -> Period { Period(minutes: j?["minutes"]?.doubleValue ?? 0, cost: j?["cost"]?.doubleValue ?? 0) }
    today = p(json["today"]); month = p(json["month"])
  }
}

/** GET /api/logs */
public struct LogsInfo: Sendable, Equatable {
  public var dir: String?
  public var entries: [JSONValue]
  public init(json: JSONValue) { dir = json["dir"]?.stringValue; entries = json["entries"]?.arrayValue ?? [] }
}

// MARK: - The client

/** Follows no redirects: /auth answers 302 with the cookie, and the page it points at isn't wanted. */
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? { nil }
}

public actor BridgeClient {
  public let base: URL
  private let authURL: URL
  private let origin: String
  private var cookie: String? // "orbit_session=<hex>": never logged
  private let session: URLSession
  private let streamSession: URLSession

  /** `authURL`: the bridge's sign-in link (BridgeEndpoints.auth["main"]). */
  public init(base: URL, authURL: URL) {
    self.base = base
    self.authURL = authURL
    var o = "\(base.scheme ?? "http")://\(base.host ?? "127.0.0.1")"
    if let p = base.port { o += ":\(p)" }
    origin = o
    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpShouldSetCookies = false // the cookie is ours to send, only to this bridge
    cfg.httpCookieAcceptPolicy = .never
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.timeoutIntervalForRequest = 60
    cfg.connectionProxyDictionary = [:] // 127.0.0.1 only, never through a proxy
    session = URLSession(configuration: cfg, delegate: NoRedirects(), delegateQueue: nil)
    let scfg = cfg.copy() as! URLSessionConfiguration
    scfg.timeoutIntervalForRequest = 90 // the bridge pings every 25 s; silence past this is a dead link
    scfg.timeoutIntervalForResource = 7 * 24 * 3600
    streamSession = URLSession(configuration: scfg, delegate: NoRedirects(), delegateQueue: nil)
  }

  public init(endpoints: BridgeEndpoints, view: String = "main") {
    self.init(base: endpoints.base, authURL: endpoints.auth[view] ?? endpoints.auth["main"] ?? endpoints.base)
  }

  public var signedIn: Bool { cookie != nil }

  /** GET the sign-in link and keep the session cookie from its 302. */
  public func signIn() async throws {
    var req = URLRequest(url: authURL)
    req.httpMethod = "GET"
    let (_, resp) = try await session.data(for: req)
    guard let http = resp as? HTTPURLResponse else { throw BridgeError(status: 0, message: "no response") }
    guard (200..<400).contains(http.statusCode), let raw = http.value(forHTTPHeaderField: "Set-Cookie"),
          let pair = raw.split(separator: ";").first.map({ String($0).trimmingCharacters(in: .whitespaces) }), pair.hasPrefix("orbit_session=") else {
      throw BridgeError(status: http.statusCode, message: "The bridge refused the sign-in link.")
    }
    cookie = pair
  }

  private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) -> URLRequest {
    var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { comps.queryItems = query }
    var req = URLRequest(url: comps.url!)
    req.httpMethod = method
    if let cookie { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
    if method != "GET" {
      req.setValue(origin, forHTTPHeaderField: "Origin")
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = body ?? Data("{}".utf8)
    }
    return req
  }

  /** A request with the session cookie; signs in first (and once more on a 401: a new launch). */
  public func send(_ method: String, _ path: String, query: [URLQueryItem] = [], json: JSONValue? = nil) async throws -> (Data, HTTPURLResponse) {
    if cookie == nil { try await signIn() }
    let body = json?.data()
    var (data, resp) = try await session.data(for: makeRequest(method, path, query: query, body: body))
    if (resp as? HTTPURLResponse)?.statusCode == 401 {
      try await signIn()
      (data, resp) = try await session.data(for: makeRequest(method, path, query: query, body: body))
    }
    guard let http = resp as? HTTPURLResponse else { throw BridgeError(status: 0, message: "no response") }
    return (data, http)
  }

  /** JSON in, JSON out; a non-2xx answer throws with the bridge's own sentence. */
  public func call(_ method: String, _ path: String, query: [URLQueryItem] = [], json: JSONValue? = nil) async throws -> JSONValue {
    let (data, http) = try await send(method, path, query: query, json: json)
    let value = (try? JSONValue.parse(data)) ?? .null
    guard (200..<300).contains(http.statusCode) else {
      throw BridgeError(status: http.statusCode, message: value["error"]?.stringValue ?? value["message"]?.stringValue ?? "HTTP \(http.statusCode)")
    }
    return value
  }

  public func get(_ path: String, query: [URLQueryItem] = []) async throws -> JSONValue { try await call("GET", path, query: query) }
  public func post(_ path: String, _ body: JSONValue = [:]) async throws -> JSONValue { try await call("POST", path, json: body) }

  // MARK: typed routes

  public func config() async throws -> BridgeConfig { BridgeConfig(json: try await get("/api/config")) }

  /** POST /api/settings: the bridge sanitizes, saves and answers with every public setting. */
  public func updateSettings(_ patch: [String: JSONValue]) async throws -> [String: JSONValue] {
    try await post("/api/settings", .object(patch)).objectValue ?? [:]
  }

  /** POST /api/key (the xAI key). Never logged. */
  public func setXaiKey(_ key: String) async throws { _ = try await post("/api/key", ["key": .string(key)]) }
  /** POST /api/brain/key (the optional Anthropic key; "" removes it). Never logged. */
  public func setBrainKey(_ key: String) async throws -> Bool { try await post("/api/brain/key", ["key": .string(key)])["hasKey"]?.boolValue ?? false }

  public func voices(engine: String) async throws -> VoiceList { VoiceList(json: try await get("/api/voice", query: [URLQueryItem(name: "engine", value: engine)])) }

  /** A spoken sample (audio bytes): Grok's through xAI, Claude voice's made on this Mac. */
  public func voicePreview(engine: String, voice: String, speed: Double) async throws -> Data {
    let path = engine == "claude" ? "/api/claude-voice/preview" : "/api/voice/preview"
    let (data, http) = try await send("POST", path, json: ["voice": .string(voice), "speed": .number(speed)])
    guard http.statusCode == 200 else {
      let v = (try? JSONValue.parse(data)) ?? .null
      throw BridgeError(status: http.statusCode, message: v["error"]?.stringValue ?? "Preview failed.")
    }
    return data
  }

  public func claudeVoice() async throws -> ClaudeVoiceStatus { ClaudeVoiceStatus(json: try await get("/api/claude-voice")) }
  public func claudeVoiceDownload() async throws -> DownloadState { DownloadState(json: try await post("/api/claude-voice/download")["models"]) }
  public func sttDownload(_ id: String) async throws -> [String: DownloadState] {
    (try await post("/api/claude-voice/stt-download", ["id": .string(id)])["stt"]?.objectValue ?? [:]).mapValues { DownloadState(json: $0) }
  }

  public func brain() async throws -> BrainStatus { BrainStatus(json: try await get("/api/brain")) }
  public func brainLogin() async throws -> BrainResult { BrainResult(json: try await call("POST", "/api/brain/login", json: [:])) }
  public func brainTest() async throws -> BrainResult { BrainResult(json: try await call("POST", "/api/brain/test", json: [:])) }

  public func sessions() async throws -> SessionsList { SessionsList(json: try await get("/api/sessions")) }
  /** POST /api/switch: 409 is an answer here (the message says why), not a failure. */
  public func switchSession(title: String) async throws -> SwitchResult {
    let (data, http) = try await send("POST", "/api/switch", json: ["title": .string(title)])
    let v = (try? JSONValue.parse(data)) ?? .null
    return SwitchResult(ok: http.statusCode == 200 && (v["ok"]?.boolValue ?? true), sessionTitle: v["sessionTitle"]?.stringValue, message: v["message"]?.stringValue ?? v["error"]?.stringValue)
  }

  public func usage() async throws -> UsageSummary { UsageSummary(json: try await get("/api/usage")) }
  public func logs() async throws -> LogsInfo { LogsInfo(json: try await get("/api/logs")) }

  // MARK: live events

  /**
   * GET /api/events as a stream of events (`{type, ...}`). Reconnects by itself (signing in again if
   * the bridge restarted) until the stream's consumer stops iterating.
   */
  public nonisolated func events(retry: Duration = .milliseconds(500), maxRetry: Duration = .seconds(5)) -> AsyncStream<JSONValue> {
    AsyncStream { continuation in
      let task = Task { await self.runEvents(continuation, retry: retry, maxRetry: maxRetry) }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  private func runEvents(_ out: AsyncStream<JSONValue>.Continuation, retry: Duration, maxRetry: Duration) async {
    var wait = retry
    while !Task.isCancelled {
      do {
        if cookie == nil { try await signIn() }
        let (bytes, resp) = try await streamSession.bytes(for: makeRequest("GET", "/api/events"))
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { cookie = nil; throw BridgeError(status: 401, message: "not signed in") }
        guard status == 200 else { throw BridgeError(status: status, message: "events refused") }
        wait = retry
        var parser = SSEParser()
        var line = [UInt8]()
        for try await b in bytes {
          if b == 0x0A {
            if let data = parser.feed(line: String(decoding: line, as: UTF8.self)), let v = try? JSONValue.parse(data) { out.yield(v) }
            line.removeAll(keepingCapacity: true)
          } else { line.append(b) }
        }
      } catch {}
      if Task.isCancelled { break }
      try? await Task.sleep(for: wait)
      wait = min(wait * 2, maxRetry)
    }
    out.finish()
  }
}

/** Server-sent events, a line at a time (the event's `data:` lines joined; comments skipped). */
public struct SSEParser: Sendable {
  private var data: [String] = []
  public init() {}
  /** Feed one line (without its \n). Returns an event's data when a blank line ends it. */
  public mutating func feed(line raw: String) -> Data? {
    let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
    if line.isEmpty {
      defer { data.removeAll() }
      return data.isEmpty ? nil : Data(data.joined(separator: "\n").utf8)
    }
    if line.hasPrefix(":") { return nil }
    if line.hasPrefix("data:") {
      var v = line.dropFirst(5)
      if v.first == " " { v = v.dropFirst() }
      data.append(String(v))
    }
    return nil
  }
}
