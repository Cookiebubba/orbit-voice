// The engine's routes for Claude voice's models and the voices (with their previews), and for the
// second brain's status, sign-in and connection test: server.js's, answer for answer.
import Foundation
import OrbitBridge
import OrbitIntent
import OrbitKit

extension Engine {
  // MARK: voices and Claude voice's models

  static let fallbackVoices: [JSONValue] = [
    ["id": "eve", "name": "Eve", "gender": "female"],
    ["id": "ara", "name": "Ara", "gender": "female"],
    ["id": "rex", "name": "Rex", "gender": "male"],
    ["id": "sal", "name": "Sal", "gender": "male"],
    ["id": "leo", "name": "Leo", "gender": "male"],
  ]
  /** Claude voice's voices: Kitten's eight, told apart by ear (with the preview). */
  static let claudeVoices: [JSONValue] = (0..<8).map { ["id": .string(String($0)), "name": .string("Voice \($0 + 1)"), "gender": "other"] }

  static let speedFloor = EngineConfig.limits.minSpeed
  static let speedCeiling = EngineConfig.limits.maxSpeed

  /** Math.min(max, Math.max(min, Number(v) || setting)). */
  func speed(_ v: JSONValue?) -> Double {
    let n = JSTruthy.number(v)
    let s = n != 0 && !n.isNaN ? n : config.number("speed")
    return min(Self.speedCeiling, max(Self.speedFloor, s))
  }

  func voiceRoute(_ r: BridgeRequest) async -> BridgeReply? {
    switch "\(r.method) \(r.path)" {
    case "GET /api/claude-voice":
      // For Settings: the speech models' state, and whether Claude Code is here.
      let found = await brain.findClaude(config.string("brainClaudePath")) != nil
      return json(200, ["models": voiceModels.status(), "mb": .number(Double(VoiceModels.mb)), "claudeFound": .bool(found), "stt": voiceModels.sttStatus()])

    case "POST /api/claude-voice/stt-download":
      // One speech-to-text model (pinned checksum), when it's chosen; Settings polls GET for progress.
      let id = JSONValue(any: BridgePolicy.readJSON(r.body)["id"])
      guard VoiceModels.sttOk(id), let sid = id.stringValue else { return json(400, ["error": "Unknown speech-to-text model."]) }
      let task = try? voiceModels.startStt(sid)
      let label = VoiceModels.stt.first { $0.id == sid }?.label ?? sid
      Task { [weak self] in
        do {
          try await task?.value
          self?.prewarm()
          self?.onSttReady?() // a live call switches to it now
          self?.voice?.sttReady()
        } catch {
          self?.log.warn("voice", "Claude voice: \(label) download failed", JS.slice(VoiceModels.message(error), 0, 200))
        }
      }
      return json(200, ["ok": true, "stt": voiceModels.sttStatus()])

    case "POST /api/claude-voice/download":
      // Fetch the speech models (pinned checksums); Settings polls GET for progress.
      let task = voiceModels.startDownload()
      Task { [weak self] in
        do {
          try await task?.value
          self?.prewarm()
        } catch {
          self?.log.warn("voice", "Claude voice: model download failed", JS.slice(VoiceModels.message(error), 0, 200))
        }
      }
      return json(200, ["ok": true, "models": voiceModels.status()])

    case "GET /api/voice":
      // Grok's voices come from xAI; Claude voice's are Kitten's 8, on this Mac. ?engine= asks for one
      // engine's list (Settings shows both while switching between them).
      let engine = r.query("engine")
      var out: [String: JSONValue] = ["speed": config["speed"] ?? .null, "minSpeed": .number(Self.speedFloor), "maxSpeed": .number(Self.speedCeiling)]
      if engine == "claude" || (engine != "grok" && config.string("voiceEngine") == "claude") {
        out["voice"] = .string(JSTruthy.string(config["claudeVoice"]))
        out["voices"] = .array(Self.claudeVoices)
        out["engine"] = "claude"
      } else {
        out["voice"] = config["voice"] ?? .null
        out["voices"] = .array(await listVoices())
        out["engine"] = "grok"
      }
      return json(200, .object(out))

    case "POST /api/claude-voice/preview":
      // A short sample of one of Claude voice's voices, made on this Mac (no network, no cost).
      guard voiceModels.ready else { return json(409, ["error": "Download the speech models first (Voice engine, above)."]) }
      let body = JSONValue(any: BridgePolicy.readJSON(r.body))
      let n = JSTruthy.number(body["voice"])
      let sid = n.isFinite && n.rounded(.towardZero) == n && n >= 0 && n <= 7 ? Int(n) : Int(config.number("claudeVoice"))
      let speed = speed(body["speed"])
      guard let speak = claudePreview else { return json(500, ["error": "Claude voice's speech isn't available in this copy of Orbit."]) }
      do {
        let samples = try await speak("Hi, I'm Orbit. Tell me what you need, and I'll pass it on to Claude.", sid, speed)
        return .response(BridgeResponse(status: 200, fields: [("content-type", "audio/wav"), ("cache-control", "no-store")] + BridgePolicy.securityHeaders, body: Self.wavFile(samples, rate: 24000)))
      } catch {
        log.error("http", "POST /api/claude-voice/preview failed", "\(error)")
        return json(500, ["error": .string(JS.slice("\(error)", 0, 300))])
      }

    case "POST /api/voice/preview":
      // A short spoken sample of a voice at a speed, via xAI text to speech.
      let body = JSONValue(any: BridgePolicy.readJSON(r.body))
      let asked = JSTruthy.string(body["voice"])
      let id = JSRegExp("^[a-z0-9_-]{1,40}$", "i").test(asked) ? asked : config.string("voice")
      let name = JS.slice(id, 0, 1).uppercased() + JS.slice(id, 1)
      var req = URLRequest(url: xaiAPI.appendingPathComponent("tts"))
      req.httpMethod = "POST"
      req.setValue("Bearer \(xaiKey.get())", forHTTPHeaderField: "Authorization")
      req.setValue("application/json", forHTTPHeaderField: "content-type")
      req.httpBody = OJSON.obj([
        ("text", .str("Hi, I'm \(name). This is how I'll sound when we talk.")), ("voice_id", .str(id)), ("language", .str("en")), ("speed", .num(speed(body["speed"]))),
      ]).text.data(using: .utf8)
      do {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
          log.warn("xai", "Voice preview failed (HTTP \(status))")
          return json(502, ["error": .string("xAI could not make a preview (HTTP \(status)).")])
        }
        return .response(BridgeResponse(status: 200, fields: [("content-type", "audio/mpeg"), ("cache-control", "no-store")] + BridgePolicy.securityHeaders, body: data))
      } catch {
        log.error("http", "POST /api/voice/preview failed", error.localizedDescription)
        return json(500, ["error": .string(JS.slice(error.localizedDescription, 0, 300))])
      }

    default:
      return nil
    }
  }

  /** xAI's voices for this key (an hour's cache), or the five Orbit knows if they can't be had. */
  func listVoices() async -> [JSONValue] {
    if let c = voicesCache.get(), Date().timeIntervalSince(c.at) < 3600 { return c.voices }
    var req = URLRequest(url: xaiAPI.appendingPathComponent("tts/voices"))
    req.setValue("Bearer \(xaiKey.get())", forHTTPHeaderField: "Authorization")
    guard let (data, resp) = try? await URLSession.shared.data(for: req), (200..<300).contains((resp as? HTTPURLResponse)?.statusCode ?? 0),
          let list = (try? JSONValue.parse(data))?["voices"]?.arrayValue else { return Self.fallbackVoices }
    var voices: [JSONValue] = []
    for v in list {
      guard case .object(let o) = v else { return Self.fallbackVoices } // (the core's map would throw)
      guard JSRegExp("^[a-z0-9_-]{1,40}$", "i").test(JSTruthy.string(o["voice_id"])) else { continue }
      let name = JSTruthy.of(o["name"]) ? o["name"] : o["voice_id"]
      voices.append(["id": o["voice_id"] ?? .null, "name": .string(JS.slice(JSTruthy.string(name), 0, 40)), "gender": .string(JS.slice(JSTruthy.stringOrEmpty(o["gender"]), 0, 20))])
    }
    if voices.isEmpty { return Self.fallbackVoices }
    voicesCache.set((Date(), voices))
    return voices
  }

  /** Mono float samples as a 16-bit PCM WAV file. */
  static func wavFile(_ samples: [Float], rate: Int) -> Data {
    var d = Data(capacity: 44 + samples.count * 2)
    func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8))
    u32(36 + samples.count * 2)
    d.append(contentsOf: Array("WAVEfmt ".utf8))
    u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
    d.append(contentsOf: Array("data".utf8))
    u32(samples.count * 2)
    for s in samples {
      let v = Int16(max(-32768, min(32767, (Double(s) * 32767).rounded(.toNearestOrAwayFromZero))))
      withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) }
    }
    return d
  }

  // MARK: the second brain

  func brainRoute(_ r: BridgeRequest) async -> BridgeReply? {
    switch "\(r.method) \(r.path)" {
    case "GET /api/brain":
      // For Settings: is Claude Code found, and how it connects. signedIn: Claude Code's own sign-in
      // (null when not checked: an API-key connection, or not found).
      let claude = await brain.findClaude(config.string("brainClaudePath"))
      var signedIn: JSONValue = .null
      if let claude, config.string("brainConnection") != "api-key" {
        if let c = authCache.get(), Date().timeIntervalSince(c.at) <= 5, c.path == claude.path {
          signedIn = c.signedIn
        } else {
          let st = await brain.authStatus(claudePath: claude.path)
          signedIn = st["ok"] == .bool(true) ? (st["signedIn"] ?? .null) : .null
          authCache.set((Date(), claude.path, signedIn))
        }
      }
      return json(200, ["found": .bool(claude != nil), "path": claude.map { .string($0.path) } ?? .null, "source": claude.map { .string($0.source) } ?? .null,
                        "hasKey": .bool(!brainKey.get().isEmpty), "signedIn": signedIn])

    case "POST /api/brain/login":
      // Settings' "Sign in": Claude Code's own sign-in, in a Terminal window of its own.
      if config.string("brainConnection") == "api-key" { return json(400, ["ok": false, "error": "The second brain is set to use an API key."]) }
      if let at = signInOpenedAt.get(), Date().timeIntervalSince(at) < 5 { return json(200, ["ok": true, "note": "The sign-in window is already open."]) }
      guard let claude = await brain.findClaude(config.string("brainClaudePath")) else {
        return json(200, ["ok": false, "error": "Claude Code was not found. Install it, or set its path below."])
      }
      let res = brain.openSignIn(claudePath: claude.path)
      if res["ok"] == .bool(true) { signInOpenedAt.set(Date()) }
      authCache.set(nil)
      if res["ok"] == .bool(true) { log.info("brain", "Opened Claude Code sign-in (Settings)") } else { log.info("brain", "Could not open Claude Code sign-in", res["error"]?.stringValue) }
      return json(200, res)

    case "POST /api/brain/test":
      // A tiny Haiku question through the chosen connection, so Settings can say "Connected".
      guard let claude = await brain.findClaude(config.string("brainClaudePath")) else {
        return json(200, ["ok": false, "error": "Claude Code was not found. Install it, or set its path below."])
      }
      let useKey = config.string("brainConnection") == "api-key"
      if useKey && brainKey.get().isEmpty { return json(200, ["ok": false, "error": "Add your Anthropic API key first."]) }
      // One test at a time, stopped if the page goes away.
      guard brainTestRunning.update({ running -> Bool in
        if running { return false }
        running = true
        return true
      }) else { return json(200, ["ok": false, "error": "A connection test is already running."]) }
      let apiKey = useKey ? brainKey.get() : ""
      return .deferred { [self] in
        defer { brainTestRunning.set(false) }
        let res = await brain.ask(question: "Reply with exactly one word: ready", model: "haiku", claudePath: claude.path, apiKey: apiKey)
        if res["ok"] != .bool(true) {
          // Orbit's sentence, not Claude Code's output.
          log.warn("brain", "Connection test failed", JS.slice((res["error"]?.stringValue ?? "").components(separatedBy: ": ")[0], 0, 200))
        }
        if res["needsSignIn"] == .bool(true) { authCache.set(nil) }
        let body: JSONValue = res["ok"] == .bool(true)
          ? ["ok": true, "seconds": res["seconds"] ?? .null]
          : ["ok": false, "error": res["error"] ?? .null, "needsSignIn": .bool(res["needsSignIn"] == .bool(true))]
        return BridgePolicy.json(200, body.any)
      }

    default:
      return nil
    }
  }

  func json(_ status: Int, _ body: JSONValue) -> BridgeReply { .response(BridgePolicy.json(status, body.any)) }
}
