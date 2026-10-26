// Orbit's engine in Swift: the bridge on 127.0.0.1 (src/server.js's HTTP API, unchanged for its
// clients) and what's behind it. It is being moved over from the Node core part by part (see
// mac-swift/README.md "Engine"): what's here is answered here; anything not yet moved is passed, as
// bytes, to the Node core running on an internal port, which the Swift side signs in to itself.
//
// Here now: sign-in, the static pages and the wake-word model, GET /api/config, POST /api/settings,
// POST /api/key, GET /api/logs, GET /api/usage, GET /api/events (the core's events merged in); Claude
// voice's speech models and voices (GET /api/claude-voice, its downloads and preview, GET /api/voice,
// POST /api/voice/preview); the second brain's status, sign-in, key and connection test (/api/brain*).
// The settings, the keys and the log are kept here only; the core gets the settings and key changes
// over the sidecar channel (see AppDelegate), and its log entries come here.
import Foundation
import OrbitBridge
import OrbitKit

public final class Engine: @unchecked Sendable {
  public struct Paths: Sendable {
    public var profile: URL
    /** The core folder (public/, resources/models, package.json): in the app bundle, Resources/core. */
    public var core: URL
    public var models: URL
    public init(profile: URL, core: URL, models: URL? = nil) {
      self.profile = profile
      self.core = core
      self.models = models ?? core.appendingPathComponent("resources/models")
    }
    var publicDir: URL { core.appendingPathComponent("public") }
  }

  public let paths: Paths
  public let policy: BridgePolicy
  public let version: String
  public let config: EngineConfig
  public let log: EngineLog
  public let usage: Usage
  public let xaiKey: SealedKeyStore
  public let brainKey: SealedKeyStore
  public let events = EventHub()
  /** Claude voice's speech models, in the profile's claude-voice-models. */
  public let voiceModels: VoiceModels
  /** Running Claude Code (second brain, sign-in). Tests swap its process for a stand-in. */
  public var brain = BrainRunner()
  /** xAI's REST API (voices, previews). */
  public var xaiAPI = URL(string: "https://api.x.ai/v1")!
  /** Speaks a Claude voice sample on this Mac (the app's OrbitSpeech): 24 kHz samples. */
  public var claudePreview: (@Sendable (_ text: String, _ sid: Int, _ speed: Double) async throws -> [Float])?
  /** What a brand-new install starts with beyond config.js's defaults (set before loadSettings; Orbit Native: Qubit). */
  public var firstRunSettings: [String: JSONValue] = [:]

  /** The voice session in Swift (/voice, the sessions routes, Claude's watcher), once it's switched on. */
  public private(set) var voice: EngineVoice?

  /** The Node core while parts of the engine still run there: its port and sign-in token. */
  private let core = Locked<(port: UInt16, token: String)?>(nil)
  private var server: BridgeServer?
  private var upstreamEvents: Task<Void, Never>?

  /** A setting changed here: the shell passes it to the core (and anything else that follows them). */
  public var onSettingsChanged: (@Sendable ([String], EngineConfig.Settings) -> Void)?
  /** A new xAI key was saved (the core drops what it cached for the old one). */
  public var onKeyChanged: (@Sendable () -> Void)?
  /** POST /api/settings came in, or the speech models are in: the core warms Claude voice up (as server.js does there). */
  public var onPrewarm: (@Sendable () -> Void)?
  /** A speech-to-text choice finished downloading: a live Claude voice call switches to it now. */
  public var onSttReady: (@Sendable () -> Void)?

  let voicesCache = Locked<(at: Date, voices: [JSONValue])?>(nil)
  let authCache = Locked<(at: Date, path: String, signedIn: JSONValue)?>(nil)
  let signInOpenedAt = Locked<Date?>(nil)
  let brainTestRunning = Locked(false)

  public init(paths: Paths, port: Int, sealKey: Data, version: String) throws {
    self.paths = paths
    self.version = version
    policy = BridgePolicy(port: port)
    config = EngineConfig(dir: paths.profile)
    log = EngineLog(profile: paths.profile)
    usage = Usage(dir: paths.profile)
    let sealer = try Sealer(key: sealKey)
    xaiKey = SealedKeyStore(sealer: sealer, file: paths.profile.appendingPathComponent("xai-key.sealed"))
    brainKey = SealedKeyStore(sealer: sealer, file: paths.profile.appendingPathComponent("anthropic-key.sealed"))
    let log = self.log
    voiceModels = VoiceModels(root: paths.profile.appendingPathComponent("claude-voice-models").path, log: { log.info("voice", $0) })
  }

  /** Loads the settings (before the core starts, so both read the same file the same way). */
  public func loadSettings(env: [String: String] = ProcessInfo.processInfo.environment) {
    // First run on a machine that used the dev version: bring the key over (initConfig does too).
    if xaiKey.get().isEmpty, let k = env["XAI_API_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines), !k.isEmpty { try? xaiKey.set(k) }
    // (A key saved means an install from before Claude voice was the default: it stays on Grok.)
    config.load(env: env, dotEnv: paths.core.appendingPathComponent(".env"), hasKey: !xaiKey.get().isEmpty, firstRun: firstRunSettings)
    config.onChange { [weak self] changed, all in
      guard let self else { return }
      var visible = all
      visible.removeValue(forKey: "orbPosition")
      visible.removeValue(forKey: "orbStickAnchor")
      self.events.broadcast(["type": "settings.changed", "changed": .array(changed.map { .string($0) }), "settings": .object(visible)])
      self.onSettingsChanged?(changed, all)
    }
  }

  /** The core is up on `port`, signed in with `token` (from its sign-in link). */
  public func setCore(port: UInt16, token: String) {
    core.set((port, token))
    upstreamEvents?.cancel()
    upstreamEvents = Task { [weak self] in await self?.followCoreEvents() }
  }

  /** Starts the bridge; throws if the port is taken. */
  public func start() async throws {
    let s = try BridgeServer(port: UInt16(policy.port)) { [weak self] r in
      guard let self else { return .response(BridgePolicy.plain(503)) }
      return await self.route(r)
    }
    try await s.start()
    server = s
    events.startPings()
    // Ask the login shell for its PATH now, so finding Claude Code doesn't wait for it later.
    let log = self.log
    Task.detached { _ = await MacSystem.loginShellPath(log: { log.info("app", $0) }) }
  }

  /**
   * The voice session runs here instead of in the core (before start()): the Claude window through
   * `desktop`; `realtimeURL` stands in for xAI's and `home` for the user's home folder (tests). The
   * core's own watcher events are dropped.
   */
  @discardableResult
  public func enableVoice(desktop: Desktop, realtimeURL: String? = nil, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> EngineVoice {
    let v = EngineVoice(engine: self, desktop: desktop, realtimeURL: realtimeURL, home: home)
    voice = v
    events.coreClaudeEvents = false
    v.start()
    // Claude voice warm once the login shell's PATH is in (Claude Code is usually found through it).
    let log = self.log
    Task.detached { [weak v] in
      _ = await MacSystem.loginShellPath(log: { log.info("app", $0) })
      v?.prewarm()
    }
    return v
  }

  /** POST /api/settings came in, or the speech models are in: Claude voice is warmed up. */
  func prewarm() {
    onPrewarm?()
    voice?.prewarm()
  }

  public func stop() {
    voice?.stop()
    upstreamEvents?.cancel()
    server?.stop()
    events.closeAll()
    ChildProcess.killAll() // a second-brain run still going ends with Orbit
  }

  public var endpoints: BridgeEndpoints {
    var auth: [String: URL] = [:]
    for v in ["main", "orb", "qubit", "buddy", "mouse"] { auth[v] = URL(string: policy.authURL(view: v))! }
    return BridgeEndpoints(base: URL(string: policy.base)!, auth: auth)
  }

  // MARK: routing (server.js handle)

  func route(_ r: BridgeRequest) async -> BridgeReply {
    if !policy.hostAllowed(r) { return .response(BridgeResponse(status: 421)) }
    let path = r.path
    if r.method == "GET", path == "/auth" {
      guard policy.tokenMatches(r.query("t")) else {
        return .response(BridgePolicy.plain(403, "This link has expired. Open Orbit from its window (or the link printed when it started).", fields: [("content-type", "text/plain")]))
      }
      return .response(BridgeResponse(status: 302, fields: [
        ("set-cookie", "\(BridgePolicy.sessionCookie)=\(policy.accessToken); HttpOnly; SameSite=Strict; Path=/"),
        ("location", BridgePolicy.authLocations[r.query("view") ?? ""] ?? "/"),
        ("cache-control", "no-store"),
        ("referrer-policy", "no-referrer"),
      ]))
    }
    // A connector's sign-in coming back, and a helper's orbit-hands: the core's (it checks them).
    if (r.method == "GET" && path == "/oauth/callback") || path.hasPrefix("/mcp/hands/") { return passToCore(r, session: false) }
    if path == "/voice" && r.isWebSocketUpgrade {
      // Only Orbit's own signed-in windows (the ws server's verifyClient): anything else is refused.
      guard policy.sameOrigin(r), policy.hasValidSession(r) else { return .response(BridgeResponse(status: 401)) }
      if let v = voice {
        let announce = r.query("announce") == "1"
        // Orbit Native hears and speaks on its own (Claude voice only): only words go back and forth.
        let localSpeech = r.query("speech") == "local"
        return .webSocket { ws in v.accept(ws, announce: announce, localSpeech: localSpeech) }
      }
      return passToCore(r, session: true)
    }
    let isApi = path.hasPrefix("/api/")
    if isApi && !policy.hasValidSession(r) { return .response(BridgePolicy.json(401, ["error": "not signed in"])) }
    if isApi && !policy.notCrossSite(r) { return .response(BridgePolicy.json(403, ["error": "forbidden"])) }
    if isApi && r.method == "POST" && !policy.sameOrigin(r) { return .response(BridgePolicy.json(403, ["error": "forbidden"])) }
    if isApi {
      if let reply = await api(r) { return reply }
      return passToCore(r, session: true)
    }
    return staticFile(r)
  }

  func api(_ r: BridgeRequest) async -> BridgeReply? {
    switch "\(r.method) \(r.path)" {
    case "GET /api/config":
      let defaults = EngineConfig.defaults.mapValues(\.any)
      return .response(BridgePolicy.json(200, [
        "version": version,
        "hasKey": !xaiKey.get().isEmpty,
        "keyStorage": xaiKey.kind,
        "settings": config.publicSettings().mapValues(\.any),
        "limits": ["minSpeed": EngineConfig.limits.minSpeed, "maxSpeed": EngineConfig.limits.maxSpeed],
        "defaults": defaults,
      ]))
    case "POST /api/key":
      let key = (BridgePolicy.readJSON(r.body)["key"]).map(Self.jsString)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard EngineConfig.matches(key, #"^[A-Za-z0-9_.-]{20,200}$"#) else { return .response(BridgePolicy.json(400, ["error": "That does not look like an xAI API key."])) }
      do { try xaiKey.set(key) } catch { return .response(BridgePolicy.json(500, ["error": "Orbit could not save the key."])) }
      voicesCache.set(nil) // (the voices are the account's)
      onKeyChanged?()
      voice?.keyChanged()
      return .response(BridgePolicy.json(200, ["hasKey": true]))
    case "POST /api/settings":
      var patch = JSONValue(any: BridgePolicy.readJSON(r.body)).objectValue ?? [:]
      // The hotkey and the orb's place belong to the desktop shell, which validates them itself.
      for k in ["wakeHotkey", "orbPosition", "orbStickAnchor"] { patch.removeValue(forKey: k) }
      config.update(patch)
      prewarm()
      return .response(BridgePolicy.json(200, config.publicSettings().mapValues(\.any)))
    case "POST /api/brain/key":
      // The optional Anthropic API key. An empty key removes it.
      let key = (BridgePolicy.readJSON(r.body)["key"]).map(Self.jsString)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if !key.isEmpty && !EngineConfig.matches(key, #"^sk-ant-[A-Za-z0-9_-]{20,200}$"#) {
        return .response(BridgePolicy.json(400, ["error": "That does not look like an Anthropic API key (they start with sk-ant-)."]))
      }
      do { try brainKey.set(key) } catch { return .response(BridgePolicy.json(500, ["error": "Orbit could not save the key."])) }
      return .response(BridgePolicy.json(200, ["hasKey": !key.isEmpty]))
    case "GET /api/claude-voice", "POST /api/claude-voice/stt-download", "POST /api/claude-voice/download", "GET /api/voice",
         "POST /api/claude-voice/preview", "POST /api/voice/preview":
      return await voiceRoute(r)
    case "GET /api/brain", "POST /api/brain/login", "POST /api/brain/test":
      return await brainRoute(r)
    case "GET /api/sessions":
      guard let v = voice else { return nil }
      return .response(await v.sessionsRoute())
    case "POST /api/switch":
      guard let v = voice else { return nil }
      return .response(await v.switchRoute(r))
    case "GET /api/logs":
      return .response(BridgePolicy.json(200, ["dir": log.dir?.path ?? NSNull(), "entries": log.recent(limit: 50, minLevel: .info).map(\.any)]))
    case "GET /api/usage":
      return .response(BridgePolicy.json(200, usage.summary(costPerMinute: config.number("costPerMinute")).any))
    case "GET /api/events":
      let head = BridgeResponse(status: 200, fields: [("content-type", "text/event-stream"), ("cache-control", "no-store")])
      return .stream(head: head) { [events] s in events.add(s) }
    default:
      return nil
    }
  }

  /** String(x) for what a JSON body held (Node: String(body.key || '')). */
  static func jsString(_ v: Any) -> String {
    switch v {
    case let s as String: return s
    case let n as NSNumber:
      if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "" }
      return n.doubleValue == 0 ? "" : JSNumber.string(n.doubleValue)
    case is NSNull: return ""
    case let a as [Any]: return a.map { jsString($0) }.joined(separator: ",")
    default: return "[object Object]"
    }
  }

  // MARK: static files

  func staticFile(_ r: BridgeRequest) -> BridgeReply {
    guard r.method == "GET" || r.method == "HEAD" else { return .response(BridgeResponse(status: 405)) }
    let pathname = Self.urlPathname(r.path)
    // The offline wake-word model (public data, not secret). Exact file names only.
    if pathname.hasPrefix("/models/") {
      let name = String(pathname.dropFirst("/models/".count))
      if EngineConfig.matches(name, #"^[a-z0-9._-]+\.tar\.gz$"#, .caseInsensitive) {
        let file = paths.models.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: file.path) else { return .response(BridgePolicy.plain(404, "model not installed")) }
        return .file(fields: [("content-type", "application/gzip"), ("cache-control", "max-age=31536000, immutable")] + BridgePolicy.securityHeaders, url: file)
      }
    }
    let rel: String
    if pathname == "/" {
      rel = "index.html"
    } else {
      guard let decoded = Self.decodeURIComponent(String(pathname.dropFirst())) else { return .response(BridgePolicy.plain(400, "bad request")) }
      rel = decoded
    }
    let root = paths.publicDir.standardizedFileURL
    let file = root.appendingPathComponent(rel).standardizedFileURL
    var isDir: ObjCBool = false
    guard file.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue else {
      return .response(BridgePolicy.plain(404, "not found"))
    }
    var fields: [(String, String)] = [("content-type", BridgePolicy.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"), ("cache-control", "no-store")]
    if rel == "wake.html" {
      // The hidden wake-word page: it can only be framed by Orbit's own window.
      fields += BridgePolicy.securityHeaders.filter { $0.0 != "x-frame-options" }
      fields += [("x-frame-options", "SAMEORIGIN"), ("content-security-policy", BridgePolicy.wakeCSP)]
    } else {
      fields += BridgePolicy.securityHeaders
      if file.pathExtension == "html" { fields.append(("content-security-policy", policy.contentSecurityPolicy)) }
    }
    return .file(fields: fields, url: file)
  }

  /**
   * The path as `new URL(...).pathname` has it (WHATWG, an http URL): backslashes are slashes, and
   * dot segments ("." and "..", also written %2e) are resolved. Percent escapes stay as they are.
   */
  static func urlPathname(_ raw: String) -> String {
    let p = raw.replacingOccurrences(of: "\\", with: "/")
    var out: [Substring] = []
    let segs = p.split(separator: "/", omittingEmptySubsequences: false).dropFirst() // (it starts with "/")
    for (i, s) in segs.enumerated() {
      let low = s.lowercased()
      let last = i == segs.count - 1
      if low == "." || low == "%2e" {
        if last { out.append("") }
      } else if ["..", ".%2e", "%2e.", "%2e%2e"].contains(low) {
        if !out.isEmpty { out.removeLast() }
        if last { out.append("") }
      } else {
        out.append(s)
      }
    }
    return "/" + out.joined(separator: "/")
  }

  /** JS decodeURIComponent: nil where it would throw (a bad or incomplete escape, invalid UTF-8). */
  static func decodeURIComponent(_ s: String) -> String? {
    guard s.contains("%") else { return s }
    var bytes: [UInt8] = []
    var it = Array(s.utf8)[...]
    while let c = it.first {
      it = it.dropFirst()
      if c == UInt8(ascii: "%") {
        guard it.count >= 2, let v = UInt8(String(decoding: it.prefix(2), as: UTF8.self), radix: 16) else { return nil }
        bytes.append(v)
        it = it.dropFirst(2)
      } else {
        bytes.append(c)
      }
    }
    return String(bytes: bytes, encoding: .utf8)
  }

  // MARK: the core (while parts still run there)

  /**
   * Passes a request to the core as bytes, as if it came to the core's own port: Host (and Origin,
   * for one that was already checked) say the core's address, and a signed-in request carries the
   * core's own session cookie instead of the bridge's.
   */
  func passToCore(_ r: BridgeRequest, session: Bool) -> BridgeReply {
    guard let c = core.get() else { return .response(BridgePolicy.json(503, ["error": "Orbit's core is still starting."])) }
    let coreHost = "\(BridgePolicy.host):\(c.port)"
    var replace: [String: String?] = ["host": coreHost]
    if let o = r.header("origin") { replace["origin"] = policy.allowedOrigins.contains(o) ? "http://\(coreHost)" : o }
    replace["cookie"] = session && policy.hasValidSession(r) ? "\(BridgePolicy.sessionCookie)=\(c.token)" : nil
    if !r.isWebSocketUpgrade {
      replace["connection"] = "close"
      replace["transfer-encoding"] = nil
      replace["content-length"] = r.body.isEmpty && r.header("content-length") == nil && r.header("transfer-encoding") == nil ? nil : String(r.body.count)
    }
    return .passThrough(port: c.port, head: r.head(replacing: replace), body: r.body)
  }

  /** The core's events (Claude working/finished, orbit.wake...) reach this bridge's listeners too. */
  func followCoreEvents() async {
    while !Task.isCancelled {
      guard let c = core.get(), let url = URL(string: "http://\(BridgePolicy.host):\(c.port)/api/events") else { return }
      var req = URLRequest(url: url)
      req.setValue("\(BridgePolicy.sessionCookie)=\(c.token)", forHTTPHeaderField: "Cookie")
      req.timeoutInterval = 3600
      let cfg = URLSessionConfiguration.ephemeral
      cfg.httpShouldSetCookies = false
      cfg.timeoutIntervalForRequest = 3600
      let session = URLSession(configuration: cfg)
      do {
        let (bytes, resp) = try await session.bytes(for: req)
        if (resp as? HTTPURLResponse)?.statusCode == 200 {
          for try await line in bytes.lines {
            guard line.hasPrefix("data: ") else { continue }
            events.fromCore(line: String(line.dropFirst(6)))
          }
        }
      } catch {}
      session.invalidateAndCancel()
      try? await Task.sleep(nanoseconds: 1_000_000_000)
    }
  }
}

/** JSON text as JSON.stringify writes it (slashes not escaped). */
public enum JSONText {
  public static func of(_ v: JSONValue) -> String {
    String(decoding: (try? JSONSerialization.data(withJSONObject: v.any, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data("null".utf8), as: UTF8.self)
  }
}

/**
 * /api/events: server-sent events to every listener (the launcher, Settings). The engine's own
 * (settings.changed) and the core's, merged; a listener first gets Claude's working state, and a
 * comment every 25 s keeps the connection alive.
 */
public final class EventHub: @unchecked Sendable {
  private let lock = NSLock()
  private var clients: [ObjectIdentifier: BridgeStream] = [:]
  private var lastStatus = #"{"type":"claude.status","working":[]}"#
  private var pinger: DispatchSourceTimer?

  public init() {}

  public func add(_ s: BridgeStream) {
    let first = lock.withLock { () -> String in
      clients[ObjectIdentifier(s)] = s
      return lastStatus
    }
    s.write("data: \(first)\n\n")
    s.whenClosed { [weak self, weak s] in
      guard let self, let s else { return }
      _ = self.lock.withLock { self.clients.removeValue(forKey: ObjectIdentifier(s)) }
    }
  }

  /** Claude's working state and spoken-update wakes come from the core (false once the engine's own watcher has them). */
  var coreClaudeEvents: Bool {
    get { lock.withLock { _coreClaudeEvents } }
    set { lock.withLock { _coreClaudeEvents = newValue } }
  }
  private var _coreClaudeEvents = true

  public func broadcast(_ evt: JSONValue) {
    let line = JSONText.of(evt)
    if evt["type"]?.stringValue == "claude.status" { lock.withLock { lastStatus = line } }
    send(line: line)
  }

  func send(line: String) {
    let list = lock.withLock { Array(clients.values) }
    for c in list { c.write("data: \(line)\n\n") }
  }

  /** An event line from the core: kept if it's Claude's working state; settings.changed is the engine's own. */
  func fromCore(line: String) {
    guard let v = try? JSONValue.parse(line), let type = v["type"]?.stringValue else { return }
    if type == "settings.changed" { return }
    if !coreClaudeEvents && (type.hasPrefix("claude.") || type == "orbit.wake") { return }
    if type == "claude.status" { lock.withLock { lastStatus = line } }
    send(line: line)
  }

  var count: Int { lock.withLock { clients.count } }

  func startPings() {
    let t = DispatchSource.makeTimerSource(queue: .global())
    t.schedule(deadline: .now() + 25, repeating: 25)
    t.setEventHandler { [weak self] in
      guard let self else { return }
      for c in self.lock.withLock({ Array(self.clients.values) }) { c.write(": ping\n\n") }
    }
    t.resume()
    pinger = t
  }

  func closeAll() {
    pinger?.cancel()
    for c in lock.withLock({ Array(clients.values) }) { c.close() }
  }
}
