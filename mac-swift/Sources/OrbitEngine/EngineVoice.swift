// The voice session in the engine: the /voice socket (the relay of VoiceRelay.swift on real sockets:
// the page's, Grok's realtime API, or Claude voice's Claude Code), Claude's session watcher, the
// Claude window (the macOS helper's "ax" host), and the routes that go with them (GET /api/sessions,
// POST /api/switch). What the core's sidecar did for the shell around these (the avatar's commands,
// the clipboard, the prompt box's work) comes out of `toShell` in the sidecar's own message shapes,
// and what the shell told the core (the avatar on screen, the Claude window in front) goes in through
// `shellMessage`. While Orbit anywhere and the MCP connectors still run in the core, this is switched
// on only in a test build (ORBIT_SWIFT_VOICE=1).
import Foundation
import OrbitBridge
import OrbitIntent
import OrbitKit

// MARK: the sockets, as the relay sees them

/** The page's socket. Its events come on the relay's loop. */
final class PageSocket: VoicePage, @unchecked Sendable {
  let ws: BridgeWebSocket
  var onMessage: (@Sendable (String) -> Void)?
  var onClose: (@Sendable () -> Void)?

  init(_ ws: BridgeWebSocket, loop: VoiceLoop, log: EngineLog?) {
    self.ws = ws
    ws.onMessage = { [weak self] data, _ in
      guard let me = self else { return }
      let text = String(decoding: data, as: UTF8.self)
      loop.run { me.onMessage?(text) }
    }
    ws.onClose = { [weak self] _, _ in
      guard let me = self else { return }
      loop.run { me.onClose?() }
    }
    ws.onError = { m in log?.warn("voice", "Page connection error", m) }
  }

  var isOpen: Bool { ws.readyState == .open }
  func send(_ text: String) { ws.send(text) }
  func close() { ws.close() }
}

/** Grok's realtime socket (wss://api.x.ai). Its events come on the relay's loop, as the `ws` package's do. */
final class GrokSocket: VoiceUpstream, @unchecked Sendable {
  let client: WebSocketClient
  let loop: VoiceLoop
  let socket = Locked<BridgeWebSocket?>(nil)
  let ended = Locked(false)
  var onOpen: (@Sendable () -> Void)?
  var onMessage: (@Sendable (String) -> Void)?
  var onClose: (@Sendable (Int, String) -> Void)?
  var onError: (@Sendable (String) -> Void)?
  var onRefused: (@Sendable (Int, String) -> Void)?

  init(url: String, key: String, loop: VoiceLoop) {
    client = WebSocketClient(url: URL(string: url) ?? URL(string: "wss://invalid.invalid/")!, headers: [("Authorization", "Bearer \(key)")])
    self.loop = loop
  }

  var isOpen: Bool { socket.get()?.readyState == .open }

  func start() {
    let loop = self.loop
    client.onOpen = { [weak self] ws in
      guard let me = self else { return }
      me.socket.set(ws)
      ws.onMessage = { data, _ in
        let text = String(decoding: data, as: UTF8.self)
        loop.run { me.onMessage?(text) }
      }
      ws.onError = { m in loop.run { me.onError?(m) } }
      ws.onClose = { code, reason in me.closed(Int(code), reason) }
      loop.run { me.onOpen?() }
    }
    client.onRefused = { [weak self] status, body in
      guard let me = self else { return }
      loop.run { me.onRefused?(status, body) }
    }
    // (Like the `ws` package: an error connecting, then 'close' with 1006.)
    client.onError = { [weak self] m in
      guard let me = self else { return }
      loop.run { me.onError?(m) }
      me.closed(1006, "")
    }
    client.connect()
  }

  func closed(_ code: Int, _ reason: String) {
    if ended.update({ e -> Bool in defer { e = true }; return e }) { return }
    loop.run { [self] in onClose?(code, reason) }
  }

  func send(_ text: String) { socket.get()?.send(text) }

  func close() {
    if let ws = socket.get() { return ws.close() }
    // Still connecting: give up on it (it ends as a socket that never opened does).
    client.cancel()
    closed(1006, "")
  }
}

/** Claude voice for one call (ClaudeRealtime, on the relay's own loop). */
final class ClaudeSocket: VoiceUpstream, @unchecked Sendable {
  let rt: ClaudeRealtime
  var onOpen: (@Sendable () -> Void)?
  var onMessage: (@Sendable (String) -> Void)?
  var onClose: (@Sendable (Int, String) -> Void)?
  var onError: (@Sendable (String) -> Void)?
  var onRefused: (@Sendable (Int, String) -> Void)?

  init(_ rt: ClaudeRealtime) { self.rt = rt }

  var isOpen: Bool { rt.readyState == .open }

  func start() {
    rt.onOpen = { [weak self] in self?.onOpen?() }
    rt.onMessage = { [weak self] m in self?.onMessage?(JSONText.of(m)) }
    rt.onClose = { [weak self] code, reason in self?.onClose?(code, reason) }
    rt.start()
  }

  func send(_ text: String) { rt.send(text) }
  func close() { rt.close() }
}

// MARK: the voice in the engine

public final class EngineVoice: @unchecked Sendable {
  /** Every call, the warm spare and Claude voice run on this one loop. */
  public let loop = QueueLoop(label: "orbit.voice")
  public let sessions: Sessions
  public let watcher: SessionWatcher
  public let desktop: Desktop
  public let avatar = AvatarRunner()
  let spares: ClaudeVoiceSpare
  let config: EngineConfig
  let log: EngineLog
  let events: EventHub
  let voiceModels: VoiceModels
  let brain: BrainRunner
  public private(set) var hub: VoiceHub!

  /** For the shell, in the sidecar's shapes: {t: "avatar.cmd", cmd}, {t: "clipboard", text}, {t: "promptBoxWork"}. */
  public var toShell: (@Sendable (JSONValue) -> Void)?
  let avatarOnScreen = Locked<(kind: String?, onScreen: Bool)>((nil, false))
  let frontHint = Locked(0)

  init(engine: Engine, desktop: Desktop, realtimeURL: String?, home: URL) {
    config = engine.config
    log = engine.log
    events = engine.events
    voiceModels = engine.voiceModels
    brain = engine.brain
    self.desktop = desktop
    sessions = Sessions(home: home)
    watcher = SessionWatcher(sessions: sessions, log: engine.log)
    let loop = self.loop
    let env = ProcessInfo.processInfo.environment
    let baseEnv: @Sendable () -> [String: String] = { MacSystem.childEnv(env, shellPath: MacSystem.cachedShellPath ?? []) }
    let spawner: StreamSpawner = { exe, args, cwd, env in StreamProcess(exe, args, cwd: cwd, env: env) }
    spares = ClaudeVoiceSpare(loop: loop, spawner: spawner, baseEnv: baseEnv)

    let config = engine.config
    let log = engine.log
    let brain = engine.brain
    let xaiKey = engine.xaiKey
    let brainKey = engine.brainKey
    let voiceModels = engine.voiceModels
    let events = engine.events
    let onScreen = avatarOnScreen
    let hint = frontHint
    let spares = self.spares

    desktop.frontHint = { hint.get() }
    _ = desktop.onPromptBoxWork { [weak self] _ in self?.toShell?(["t": "promptBoxWork"]) }
    avatar.chosen = { config.string("avatar") }
    // (The shell reports what's on screen, so the answer is at once, as the sidecar's sink.)
    avatar.sink = { [weak self] cmd in
      let s = onScreen.get()
      guard s.kind != nil, s.onScreen else { return ["ok": false, "error": "There is no avatar on screen."] }
      self?.toShell?(["t": "avatar.cmd", "cmd": .object(cmd)])
      return ["ok": true]
    }

    let tools = ToolServices(
      desktop: desktop, sessions: sessions, config: config, brainKey: { brainKey.get() },
      findClaude: { await brain.findClaude($0) },
      brain: { q, model, explore, cwd, session, path, key in
        await brain.ask(question: .string(q), model: model, explore: explore, cwd: cwd, session: session, claudePath: path, apiKey: key)
      },
      search: { q, path, key in await brain.search(query: .string(q), claudePath: path, apiKey: key) },
      signIn: { path in brain.openSignIn(claudePath: path) },
      clipboard: { [weak self] text in
        self?.toShell?(["t": "clipboard", "text": .string(text)])
        return self?.toShell != nil
      },
      avatar: avatar, log: log, home: home.path
    )
    hub = VoiceHub(.init(
      loop: loop, config: config, xaiKey: { xaiKey.get() }, brainKey: { brainKey.get() }, log: log, usage: engine.usage,
      tools: tools, sessions: sessions, desktop: desktop, watcher: watcher, anywhere: VoiceAnywhereOff(),
      broadcast: { events.broadcast($0) },
      claudeModelsReady: { voiceModels.ready },
      findClaude: { Brain.findClaude($0, env: env, home: NSHomeDirectory(), shellPath: MacSystem.cachedShellPath ?? [])?.path },
      grok: { url, key in GrokSocket(url: url, key: key, loop: loop) },
      claude: { o, localTurn in
        let rt = ClaudeRealtime(o, loop: loop, spawner: spawner, useSpare: true, spares: spares, baseEnv: baseEnv())
        rt.localTurn = localTurn
        rt.onMetrics = { m in EngineVoice.logTurn(log, m) }
        rt.onWarn = { m, d in log.warn("voice", m, d) }
        return ClaudeSocket(rt)
      },
      realtimeURL: realtimeURL,
      claudeModelsDownloading: {
        let st = voiceModels.status()
        return st["state"]?.stringValue == "downloading" ? Int(st["percent"]?.doubleValue ?? 0) : nil
      }
    ))
  }

  func start() {
    hub.start()
    watcher.start()
  }

  func stop() {
    hub.stopBackgroundWork()
    spares.stopAll()
    watcher.stop()
  }

  /** A page asked for /voice (already checked: Orbit's own signed-in window). */
  func accept(_ ws: BridgeWebSocket, announce: Bool, localSpeech: Bool) {
    hub.connect(PageSocket(ws, loop: loop, log: log), announce: announce, localSpeech: localSpeech)
  }

  /** What the shell tells the core: the avatar on screen, the Claude window in front. */
  public func shellMessage(_ m: JSONValue) {
    switch m["t"]?.stringValue {
    case "avatarState":
      let k = m["kind"]?.stringValue
      avatarOnScreen.set((k == "qubit" || k == "buddy" ? k : nil, JSTruthy.of(m["onScreen"])))
    case "frontHint":
      frontHint.set(m["id"].flatMap { $0.doubleValue }.map { Int($0) } ?? 0)
    default:
      break
    }
  }

  /** Claude voice on: a warm Claude Code for the next call (server.js prewarmClaudeVoice; the shell holds the speech models). */
  func prewarm() {
    loop.run { [self] in
      guard config.string("voiceEngine") == "claude", voiceModels.ready,
            let exe = Brain.findClaude(config.string("brainClaudePath"), env: ProcessInfo.processInfo.environment, home: NSHomeDirectory(), shellPath: MacSystem.cachedShellPath ?? [])?.path else { return }
      let ctx = hub.agentContext()
      spares.keep(exe: exe, prompt: Agent.systemPrompt(instructions: ctx.instructions, tools: ctx.tools), model: config.string("claudeVoiceModel"), effort: config.string("claudeVoiceEffort"))
    }
  }

  /** A speech-to-text model came in: a live Claude voice call switches to it now. */
  func sttReady() {
    loop.run { [self] in for c in hub.liveSessions.values { c.pushConfig() } }
  }

  /** A new xAI key: the resume note was made with the old key's account. */
  func keyChanged() {
    loop.run { [self] in hub.continuity.reset() }
  }

  /** One Claude voice turn's timing, for the log (server.js claudeVoiceMetrics). */
  static func logTurn(_ log: EngineLog, _ m: JSONValue) {
    let at = { (k: String) -> Double? in m[k]?.doubleValue.flatMap { $0 == 0 ? nil : $0 } }
    guard let ended = at("endedAt") else { return }
    let s = { (a: Double?, b: Double?) -> String in
      guard let a, let b else { return "–" }
      return String(format: "%.2fs", (a - b) / 1000)
    }
    let total = at("firstAudioAt") != nil ? s(at("firstAudioAt"), ended) : "no audio"
    let stt = m["stt"]?.stringValue ?? ""
    let filler = at("fillerAt").map { ", filler at \(s($0, ended))" } ?? ""
    let tool = JSTruthy.of(m["tool"]) ? ", tool \(JSTruthy.string(m["tool"]))" : ""
    log.info("voice", "Claude voice turn: you stopped → first audio \(total)",
             "end of turn \(s(at("heardAt"), ended)), speech to text \(s(at("textAt"), at("heardAt")))\(!stt.isEmpty && stt != "moonshine" ? " (\(stt))" : ""), Claude first word \(s(at("firstTokenAt"), at("textAt"))), first audio \(s(at("firstAudioAt"), at("firstTokenAt")))\(filler)\(tool), \(JSTruthy.string(m["status"]))")
  }

  // MARK: routes

  /** GET /api/sessions: what Claude's sidebar shows (every row can be opened), with what's known from disk. */
  func sessionsRoute() async -> BridgeResponse {
    let working = Set(watcher.working().compactMap { $0["title"]?.stringValue })
    let local = sessions.list()
    var byTitle: [String: DesktopSession] = [:]
    for s in local { byTitle[s.title] = s } // (a later one with the same title wins, as a Map does)
    let sidebar = await desktop.listSidebarSessions()
    let ok = sidebar["ok"] == .bool(true)
    var rows: [[String: Any]] = []
    if ok {
      for x in sidebar["sessions"]?.arrayValue ?? [] {
        let title = JSTruthy.string(x["title"])
        let label = JSTruthy.string(x["label"])
        var r: [String: Any] = ["title": title, "badge": label != title ? JS.trim(JS.slice(label, JS.length(title), JS.length(label))) : ""]
        if let o = x["open"] { r["open"] = o.any }
        rows.append(r)
      }
    } else {
      rows = local.prefix(15).map { ["title": $0.title, "badge": "", "open": false] }
    }
    let list = rows.prefix(60).map { r -> [String: Any] in
      var out = r
      let title = r["title"] as? String ?? ""
      let meta = byTitle[title]
      out["id"] = (meta?.id).flatMap { $0.isEmpty ? nil : $0 } ?? title
      out["project"] = (meta?.project).flatMap { $0.isEmpty ? nil : $0 } ?? (r["badge"] as? String ?? "")
      out["lastActive"] = meta.map { sessions.ago($0.lastActivityAt) } ?? ""
      out["working"] = working.contains(title)
      return out
    }
    var body: [String: Any] = ["sessions": list, "canSwitch": ok]
    if !ok { body["openInApp"] = NSNull() } else if let t = sidebar["sessionTitle"] { body["openInApp"] = t.any }
    return BridgePolicy.json(200, body)
  }

  /** POST /api/switch: opens that session in the Claude app. */
  func switchRoute(_ r: BridgeRequest) async -> BridgeResponse {
    let title = Engine.jsString(BridgePolicy.readJSON(r.body)["title"] ?? "")
    let result = await desktop.switchSession(title)
    let ok = result["ok"] == .bool(true)
    if ok {
      var evt: [String: JSONValue] = ["type": "claude.open"]
      if let t = result["sessionTitle"] { evt["title"] = t }
      events.broadcast(.object(evt))
    }
    return BridgePolicy.json(ok ? 200 : 409, result.any)
  }
}
