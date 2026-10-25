// The parity suite's runner in Swift: the same case files (parity/cases/*.json), the same driver
// protocol and the same test doubles as parity/run.mjs, so the suite doesn't depend on either
// language. Used by the OrbitParityTests XCTest target against the Swift build (and it can drive the
// Electron build too). See parity/PROTOCOL.md.
import Foundation
import Network

public struct ParityCase: Sendable {
  public var id: String
  public var area: String
  public var title: String
  public var raw: JSONValue
  public var needs: [String] { raw["needs"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
}

public struct ParityResult: Sendable {
  public var status: String // pass | fail | error | unsupported
  public var ms: Int
  public var error: String?
  public var dir: String?
}

public final class ParityRunner: @unchecked Sendable {
  public struct Paths: Sendable {
    public var repo: URL
    public var swiftApp: URL
    public var electronRoot: URL
    public var voiceModels: URL
    public var audio: URL
    public var node: URL
    public init(repo: URL, swiftApp: URL? = nil, electronRoot: URL? = nil, voiceModels: URL? = nil, audio: URL? = nil, node: URL) {
      self.repo = repo
      self.swiftApp = swiftApp ?? repo.appendingPathComponent("mac-swift/dist/Orbit Native.app")
      self.electronRoot = electronRoot ?? repo
      let home = FileManager.default.homeDirectoryForCurrentUser
      self.voiceModels = voiceModels ?? home.appendingPathComponent("orbit-swift-dev/voice-models")
      self.audio = audio ?? repo.appendingPathComponent("parity/out/audio")
      self.node = node
    }
  }

  public static let ports: [String: (bridge: Int, driver: Int)] = ["swift": (4521, 4522), "electron": (4541, 4542)]
  static let standinPort = 4525
  static let grokPort = 4526
  static let fakeKey = "xai-parityfakekey0000000000000000000000"

  public let paths: Paths
  public var keep = false
  public var log: (String) -> Void = { _ in }

  public init(paths: Paths) { self.paths = paths }

  // MARK: cases

  public func loadCases() throws -> [ParityCase] {
    let dir = paths.repo.appendingPathComponent("parity/cases")
    var out: [ParityCase] = []
    var ids = Set<String>()
    for f in try FileManager.default.contentsOfDirectory(atPath: dir.path).filter({ $0.hasSuffix(".json") }).sorted() {
      let doc = try JSONValue.parse(Data(contentsOf: dir.appendingPathComponent(f)))
      let area = doc["area"]?.stringValue ?? f
      for c in doc["cases"]?.arrayValue ?? [] {
        guard let id = c["id"]?.stringValue, !ids.contains(id) else { throw RunnerError("\(f): missing or duplicate case id") }
        ids.insert(id)
        out.append(ParityCase(id: id, area: area, title: c["title"]?.stringValue ?? "", raw: c))
      }
    }
    return out
  }

  // MARK: running

  struct Ctx {
    var app: AppHandle
    var bridge: BridgeHTTP
    var records: URL
    var standin: StandIn?
    var vars: [String: JSONValue]
    var last: JSONValue = .null
    var varsJSON: JSONValue { .object(vars) }
  }

  public func run(_ c: ParityCase, app which: String, features: [String]? = nil) async -> ParityResult {
    let t0 = Date()
    if let f = features, let missing = c.needs.first(where: { !f.contains($0) }) { return ParityResult(status: "unsupported", ms: 0, error: "needs \(missing)") }
    var prep: Prepared?
    var app: AppHandle?
    let result = await attempt(c, which, t0: t0, prep: &prep, app: &app)
    if let app { await app.stop() }
    await prep?.teardown()
    if let p = prep, result.status == "pass" || result.status == "unsupported", !keep { try? FileManager.default.removeItem(at: p.run) }
    return result
  }

  private func attempt(_ c: ParityCase, _ which: String, t0: Date, prep: inout Prepared?, app: inout AppHandle?) async -> ParityResult {
    let ms = { Int(Date().timeIntervalSince(t0) * 1000) }
    do {
      prep = try await prepare(c, which)
      let ports = Self.ports[which]!
      app = try await AppHandle.start(which, paths: paths, profile: prep!.profile, logs: prep!.logs, bridgePort: ports.bridge, driverPort: ports.driver, env: prep!.env)
      let hello = app!.hello
      let feats = hello["features"]?.arrayValue?.compactMap(\.stringValue) ?? []
      if let missing = c.needs.first(where: { !feats.contains($0) }) { return ParityResult(status: "unsupported", ms: ms(), error: "needs \(missing)") }
      guard let base = hello.at(path: "bridge.base")?.stringValue, let auth = hello.at(path: "bridge.authUrl")?.stringValue, let authURL = URL(string: auth) else { throw RunnerError("no bridge in hello") }
      let bridge = try await BridgeHTTP.signIn(base: base, authURL: authURL)
      var vars = prep!.vars
      vars["hello"] = hello
      vars["base"] = .string(base)
      vars["port"] = .string(String(URL(string: base)?.port ?? 0))
      vars["authPath"] = .string(authURL.path + "?" + (authURL.query ?? ""))
      var ctx = Ctx(app: app!, bridge: bridge, records: prep!.records, standin: prep!.standin, vars: vars)
      if c.raw.at(path: "fixtures.grok") != nil || c.raw.at(path: "fixtures.key") != nil {
        let r = try await bridge.request(method: "POST", path: "/api/key", body: ["key": c.raw.at(path: "fixtures.key") ?? .string(Self.fakeKey)])
        guard r["status"]?.intValue == 200 else { throw RunnerError("could not set the test key") }
      }
      let steps = c.raw["steps"]?.arrayValue ?? []
      for (i, s) in steps.enumerated() {
        do { ctx.last = try await step(s, &ctx) } catch {
          throw RunnerError("step \(i + 1) (\(s["do"]?.stringValue ?? "?")\(s["action"]?.stringValue.map { " \($0)" } ?? "")): \(error)")
        }
      }
      return ParityResult(status: "pass", ms: ms())
    } catch {
      let msg = "\(error)"
      let isError = msg.contains("did not come up") || msg.contains("no Swift build") || msg.contains("no Electron") || msg.contains("speech models")
      return ParityResult(status: isError ? "error" : "fail", ms: ms(), error: String(msg.prefix(500)), dir: prep?.run.path)
    }
  }

  // MARK: steps

  func step(_ raw: JSONValue, _ ctx: inout Ctx) async throws -> JSONValue {
    let x = ParityMatch.interpolate(raw, ctx.varsJSON)
    let timeout = x["timeoutMs"]?.doubleValue ?? 8000
    let vars = ctx.varsJSON
    func check(_ v: JSONValue, _ what: String) throws -> JSONValue {
      guard let e = x["expect"] else { return v }
      if let r = ParityMatch.match(v, e, vars: vars) { throw RunnerError("\(what): \(r)") }
      return v
    }
    let c = ctx
    func probe(_ p: JSONValue) async throws -> JSONValue {
      switch p["probe"]?.stringValue ?? p["do"]?.stringValue {
      case "state": return try await c.app.driver("GET", "/parity/state")["body"] ?? .null
      case "http": return try await c.bridge.request(method: p["method"]?.stringValue ?? "GET", path: p["path"]?.stringValue ?? "/", body: p["body"])
      case "fake": return Self.readRecord(c.records, p["name"]?.stringValue ?? "")
      case "standin":
        guard let s = c.standin else { throw RunnerError("no stand-in Claude window in this case (fixtures.standin)") }
        return try await s.call("GET", "/state")
      case "act": return try await c.app.driver("POST", "/parity/act", ["action": p["action"] ?? "", "args": p["args"] ?? .object([:])])["body"] ?? .null
      case let other: throw RunnerError("unknown probe \(other ?? "nil")")
      }
    }
    switch x["do"]?.stringValue {
    case "http":
      let r = try await ctx.bridge.request(method: x["method"]?.stringValue ?? "GET", path: x["path"]?.stringValue ?? "/", body: x["body"], auth: x["auth"] != .bool(false), origin: x["origin"]?.stringValue, host: x["host"]?.stringValue, headers: x["headers"]?.objectValue?.compactMapValues(\.stringValue) ?? [:], timeout: timeout)
      return try check(r, "\(x["method"]?.stringValue ?? "GET") \(x["path"]?.stringValue ?? "")")
    case "ws":
      let expect = x["expect"]
      let r = await ctx.bridge.websocket(query: x["query"]?.stringValue ?? "", send: x["send"]?.arrayValue ?? [], timeout: timeout, origin: x["origin"]?.stringValue, auth: x["auth"] != .bool(false)) { msgs in
        guard let e = expect else { return false }
        return ParityMatch.match(["opened": true, "messages": .array(msgs)], e, vars: vars) == nil
      }
      return try check(r, "ws /voice")
    case "act":
      let r = try await ctx.app.driver("POST", "/parity/act", ["action": x["action"] ?? "", "args": x["args"] ?? .object([:])], timeout: timeout)["body"] ?? .null
      if x["expect"] == nil, r["ok"] == .bool(false) { throw RunnerError("act \(x["action"]?.stringValue ?? ""): \(r["error"]?.stringValue ?? "")") }
      return try check(r, "act \(x["action"]?.stringValue ?? "")\(r["error"]?.stringValue.map { " (\($0.prefix(160)))" } ?? "")")
    case "state":
      return try check(try await ctx.app.driver("GET", "/parity/state")["body"] ?? .null, "state")
    case "fake":
      return try check(Self.readRecord(ctx.records, x["name"]?.stringValue ?? ""), "fake \(x["name"]?.stringValue ?? "")")
    case "standin":
      guard let s = ctx.standin else { throw RunnerError("no stand-in Claude window in this case (fixtures.standin)") }
      switch x["op"]?.stringValue {
      case "set": return try await s.call("POST", "/set", ["patch": x["patch"] ?? .object([:])])
      case "type": return try await s.call("POST", "/type", ["text": x["text"] ?? ""])
      case "move": return try await s.call("POST", "/move", x["frame"] ?? .object([:]))
      default: return try check(try await s.call("GET", "/state"), "stand-in")
      }
    case "until":
      let end = Date().addingTimeInterval(timeout / 1000)
      var why = "never matched"
      var last: JSONValue = .null
      repeat {
        if let v = try? await probe(x) {
          last = v
          if let e = x["expect"] { if let r = ParityMatch.match(v, e, vars: vars) { why = r } else { return v } } else { return v }
        }
        try await Task.sleep(nanoseconds: UInt64((x["everyMs"]?.doubleValue ?? 150) * 1e6))
      } while Date() < end
      _ = last
      throw RunnerError("until \(x["probe"]?.stringValue ?? "") (\(Int(timeout)) ms): \(why)")
    case "save":
      let from: JSONValue = x["from"]?.stringValue == "last" ? ctx.last : try await probe(["probe": x["from"] ?? "", "name": x["name"] ?? .null])
      let v = from.at(path: x["path"]?.stringValue ?? "")
      if v == nil && x["optional"] != .bool(true) { throw RunnerError("save \(x["as"]?.stringValue ?? ""): nothing at \(x["path"]?.stringValue ?? "")") }
      ctx.vars[x["as"]?.stringValue ?? "_"] = v ?? .null
      return v ?? .null
    case "check":
      return try check(x["value"] ?? .null, "check")
    case "calc":
      let expr = x["expr"]?.stringValue ?? ""
      guard let v = Self.arithmetic(expr) else { throw RunnerError("calc \(x["as"]?.stringValue ?? ""): not plain arithmetic: \(expr)") }
      ctx.vars[x["as"]?.stringValue ?? "_"] = .number(v)
      return .number(v)
    case "sleep":
      try await Task.sleep(nanoseconds: UInt64((x["ms"]?.doubleValue ?? 0) * 1e6))
      return ctx.last
    case let other:
      throw RunnerError("unknown step \(other ?? "nil")")
    }
  }

  /** Numbers and + - * / ( ) only, evaluated with the usual precedence. */
  public static func arithmetic(_ s: String) -> Double? {
    guard s.range(of: "^[-+*/(). 0-9eE]+$", options: .regularExpression) != nil else { return nil }
    var p = ArithParser(Array(s.filter { !$0.isWhitespace }))
    guard let v = p.expr(), p.i == p.c.count, v.isFinite else { return nil }
    return v
  }

  static func readRecord(_ records: URL, _ name: String) -> JSONValue {
    let file = ["fake-desktop": "fake-desktop.json", "fake-grok": "fake-grok.json", "fake-claude": "fake-claude.jsonl"][name] ?? name
    let url = records.appendingPathComponent(file)
    guard let data = try? Data(contentsOf: url) else { return name == "fake-claude" ? ["turns": [], "starts": [], "toolCalls": [], "toolResults": [], "interrupts": 0] : .null }
    guard name == "fake-claude" else { return (try? JSONValue.parse(data)) ?? .null }
    let lines = String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { try? JSONValue.parse(String($0)) }
    let turns = lines.filter { $0["kind"] == "turn" && $0["reply"] != "OK" }
    func all(_ pattern: String, in s: String) -> [String] {
      guard let re = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return [] }
      return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { Range($0.range(at: 1), in: s).map { String(s[$0]) } }
    }
    let results = turns.flatMap { all("\\[Tool result: ([a-z_]+)\\]", in: $0["text"]?.stringValue ?? "") }
    let calls = turns.flatMap { all("<tool>(\\{.*?\\})</tool>", in: $0["reply"]?.stringValue ?? "") }.compactMap { (try? JSONValue.parse($0))?["name"] }
    return ["turns": .array(turns), "toolCalls": .array(calls), "toolResults": .array(results.map { .string($0) }), "starts": .array(lines.filter { $0["kind"] == "start" }), "interrupts": .number(Double(lines.filter { $0["kind"] == "interrupt" }.count))]
  }

  // MARK: fixtures

  struct Prepared {
    var run: URL, profile: URL, records: URL, logs: URL
    var env: [String: String]
    var vars: [String: JSONValue]
    var standin: StandIn?
    var stops: [@Sendable () async -> Void]
    func teardown() async { for s in stops.reversed() { await s() } }
  }

  func prepare(_ c: ParityCase, _ which: String) async throws -> Prepared {
    let fm = FileManager.default
    let run = fm.temporaryDirectory.appendingPathComponent("orbit-parity-\(which)-\(UUID().uuidString.prefix(8))")
    let profile = run.appendingPathComponent("profile"), records = run.appendingPathComponent("records"), logs = run.appendingPathComponent("logs"), bin = run.appendingPathComponent("bin")
    for d in [profile, records, logs, bin] { try fm.createDirectory(at: d, withIntermediateDirectories: true) }
    var vars: [String: JSONValue] = ["repo": .string(paths.repo.path), "records": .string(records.path), "profile": .string(profile.path), "run": .string(run.path), "app": .string(which), "audio": .string(paths.audio.path)]
    var env: [String: String] = ["PARITY_RECORD_DIR": records.path]
    for (k, v) in ParityMatch.interpolate(c.raw["env"] ?? .object([:]), .object(vars)).objectValue ?? [:] { env[k] = v.stringValue ?? v.text }
    var settings = c.raw.at(path: "profile.settings")?.objectValue ?? [:]
    let fx = c.raw["fixtures"] ?? .object([:])
    var stops: [@Sendable () async -> Void] = []
    var standin: StandIn?
    if let fd = fx["fakeDesktop"], fd != .bool(false), !fd.isNull {
      env["ORBIT_FAKE_DESKTOP"] = paths.repo.appendingPathComponent("parity/fixtures/fake-desktop.mjs").path
      if fd != .bool(true) { env["PARITY_FAKE_DESKTOP_STATE"] = fd.text }
    }
    if let cv = fx["claudeVoice"] {
      let rules = run.appendingPathComponent("claude-rules.json")
      try (cv["rules"] ?? ["rules": []]).data().write(to: rules)
      let wrapper = bin.appendingPathComponent("claude")
      let script = "#!/bin/sh\nexport PARITY_RECORD_DIR='\(records.path)'\nexport PARITY_FAKE_CLAUDE_RULES='\(rules.path)'\nexec '\(paths.node.path)' '\(paths.repo.appendingPathComponent("parity/fixtures/fake-claude.mjs").path)' \"$@\"\n"
      try script.write(to: wrapper, atomically: true, encoding: .utf8)
      try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)
      settings["voiceEngine"] = "claude"
      settings["brainClaudePath"] = .string(wrapper.path)
      settings["claudeVoiceStt"] = "moonshine"
      settings["claudeVoiceModel"] = cv["model"] ?? "haiku"
      for (k, v) in cv["settings"]?.objectValue ?? [:] { settings[k] = v }
      guard fm.fileExists(atPath: paths.voiceModels.path) else { throw RunnerError("no speech models at \(paths.voiceModels.path)") }
      let models = profile.appendingPathComponent("claude-voice-models")
      try fm.createDirectory(at: models, withIntermediateDirectories: true)
      for f in try fm.contentsOfDirectory(atPath: paths.voiceModels.path) {
        try fm.createSymbolicLink(at: models.appendingPathComponent(f), withDestinationURL: paths.voiceModels.appendingPathComponent(f))
      }
    }
    if fx["grok"] != nil {
      let p = try ChildProcess.start(paths.node, [paths.repo.appendingPathComponent("parity/fixtures/fake-grok-server.mjs").path, String(Self.grokPort), String(fx.at(path: "grok.seed")?.intValue ?? 1), records.path])
      stops.append { p.stop() }
      guard await p.waitForOutput("ready", timeout: 10) else { throw RunnerError("fake Grok did not start") }
      env["XAI_REALTIME_URL"] = "ws://127.0.0.1:\(Self.grokPort)"
    }
    if let si = fx["standin"] {
      let s = try await StandIn.start(paths: paths, port: Self.standinPort, logs: logs, frame: si["frame"])
      standin = s
      stops.append { await s.stop() }
      env["ORBIT_TEST_CLAUDE_PID"] = String(s.pid)
      vars["standinPid"] = .number(Double(s.pid))
    }
    if !settings.isEmpty { try JSONValue.object(settings).data(pretty: true).write(to: profile.appendingPathComponent("settings.json")) }
    return Prepared(run: run, profile: profile, records: records, logs: logs, env: env, vars: vars, standin: standin, stops: stops)
  }
}

public struct RunnerError: Error, CustomStringConvertible {
  public let description: String
  public init(_ d: String) { description = d }
}

struct ArithParser {
  let c: [Character]
  var i = 0
  init(_ c: [Character]) { self.c = c }
  mutating func expr() -> Double? {
    guard var v = term() else { return nil }
    while i < c.count, c[i] == "+" || c[i] == "-" {
      let op = c[i]; i += 1
      guard let r = term() else { return nil }
      v = op == "+" ? v + r : v - r
    }
    return v
  }
  mutating func term() -> Double? {
    guard var v = factor() else { return nil }
    while i < c.count, c[i] == "*" || c[i] == "/" {
      let op = c[i]; i += 1
      guard let r = factor() else { return nil }
      v = op == "*" ? v * r : v / r
    }
    return v
  }
  mutating func factor() -> Double? {
    guard i < c.count else { return nil }
    if c[i] == "-" { i += 1; return factor().map { -$0 } }
    if c[i] == "+" { i += 1; return factor() }
    if c[i] == "(" {
      i += 1
      let v = expr()
      guard i < c.count, c[i] == ")" else { return nil }
      i += 1
      return v
    }
    let start = i
    while i < c.count, c[i].isNumber || c[i] == "." || c[i] == "e" || c[i] == "E" || ((c[i] == "-" || c[i] == "+") && i > start && (c[i - 1] == "e" || c[i - 1] == "E")) { i += 1 }
    return Double(String(c[start..<i]))
  }
}
