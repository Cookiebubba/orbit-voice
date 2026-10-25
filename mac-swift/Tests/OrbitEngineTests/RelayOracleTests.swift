// The voice relay against src/server.js's (parity/oracle/relay.mjs): the same scripts of the page,
// Grok (or Claude voice's stand-in), Claude finishing or waiting, settings and time, with the
// stand-ins' recorded answers given back. What goes to the page, to the voice, to the event stream,
// to Claude's window and what is closed must match step by step.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitIntent
@testable import OrbitKit

final class RelayOracleTests: XCTestCase {
  /** Records everything, by kind (each kind keeps its order). */
  final class Recorder: @unchecked Sendable {
    let entries = Locked<[JSONValue]>([])
    func add(_ e: JSONValue) { entries.update { $0.append(e) } }
  }

  final class FakePage: VoicePage, @unchecked Sendable {
    let rec: Recorder
    let loop: VirtualLoop
    var state = 1
    var onMessage: (@Sendable (String) -> Void)?
    var onClose: (@Sendable () -> Void)?
    init(rec: Recorder, loop: VirtualLoop) {
      self.rec = rec
      self.loop = loop
    }
    var isOpen: Bool { state == 1 }
    func send(_ text: String) { rec.add(["kind": "page", "msg": (try? JSONValue.parse(text)) ?? .string(text)]) }
    func close() {
      if state >= 2 { return }
      state = 2
      rec.add(["kind": "pageClosing"])
      loop.run { [self] in
        state = 3
        onClose?()
      }
    }
    func gone() {
      if state < 3 {
        state = 3
        onClose?()
      }
    }
  }

  final class FakeUp: VoiceUpstream, @unchecked Sendable {
    let rec: Recorder
    let index: Int
    var state = 0
    var onOpen: (@Sendable () -> Void)?
    var onMessage: (@Sendable (String) -> Void)?
    var onClose: (@Sendable (Int, String) -> Void)?
    var onError: (@Sendable (String) -> Void)?
    var onRefused: (@Sendable (Int, String) -> Void)?
    var localTurn: (@Sendable (String, String) -> String?)?
    init(rec: Recorder, index: Int) {
      self.rec = rec
      self.index = index
    }
    var isOpen: Bool { state == 1 }
    func send(_ text: String) { rec.add(["kind": "up", "i": .number(Double(index)), "msg": (try? JSONValue.parse(text)) ?? .string(text)]) }
    func close() {
      if state < 2 { state = 2 }
      rec.add(["kind": "upClose", "i": .number(Double(index)), "code": .null, "reason": .null])
    }
    func start() {}
  }

  final class FakeWatcher: VoiceWatcher, @unchecked Sendable {
    var fns: [@Sendable (JSONValue) -> Void] = []
    var list: [JSONValue] = []
    func listen(_ fn: @escaping @Sendable (JSONValue) -> Void) { fns.append(fn) }
    func working() -> [JSONValue] { list }
  }

  /** The recorded answers of Claude's window and Claude Code, handed out in order. */
  final class Replay: ToolDesktop, @unchecked Sendable {
    let rec: Recorder
    let expected = Locked<[JSONValue]>([])
    init(rec: Recorder) { self.rec = rec }
    func call(_ name: String, _ args: JSONValue) -> JSONValue {
      let want: JSONValue? = expected.update { e -> JSONValue? in
        guard let i = e.firstIndex(where: { $0["name"]?.stringValue == name }) else { return nil }
        return e.remove(at: i)
      }
      rec.add(["kind": "desktop", "name": .string(name), "args": args, "answer": want?["answer"] ?? .null])
      return want?["answer"] ?? ["ok": false, "error": "no recorded answer"]
    }
    static func opt(_ s: String?) -> JSONValue { s.map { .string($0) } ?? .null }
    func info() async -> JSONValue { call("info", [:]) }
    func switchSession(_ title: String) async -> JSONValue { call("switch", ["title": .string(title)]) }
    func newSession(project: String) async -> JSONValue { call("new", ["project": .string(project)]) }
    func send(_ text: String, expectTitle: String?, expectNew: Bool, expectFolder: String?, filled: Bool) async -> JSONValue {
      call("send", ["text": .string(text), "expectTitle": Replay.opt(expectTitle), "expectNew": .bool(expectNew), "expectFolder": Replay.opt(expectFolder), "filled": .bool(filled)])
    }
    func fill(_ text: String, expectTitle: String?, expectNew: Bool, expectFolder: String?, replace: String?) async -> JSONValue {
      call("fill", ["text": .string(text), "expectTitle": Replay.opt(expectTitle), "expectNew": .bool(expectNew), "expectFolder": Replay.opt(expectFolder), "replace": Replay.opt(replace)])
    }
    func clear(_ text: String, expectTitle: String?, expectNew: Bool, expectFolder: String?) async -> JSONValue {
      call("clear", ["text": .string(text), "expectTitle": Replay.opt(expectTitle), "expectNew": .bool(expectNew), "expectFolder": Replay.opt(expectFolder)])
    }
    func stop() async -> JSONValue { call("stop", ["expectTitle": .null]) }
    func pending(expectTitle: String?) async -> JSONValue { call("pending", ["expectTitle": Replay.opt(expectTitle)]) }
    func answer(key: String, choice: String, option: Int, expectTitle: String?) async -> JSONValue {
      call("answer", ["key": .string(key), "choice": .string(choice), "option": .number(Double(option)), "expectTitle": Replay.opt(expectTitle)])
    }
    func app(_ action: String, value: String, title: String) async -> JSONValue { call("app", ["action": .string(action), "value": .string(value), "title": .string(title)]) }
  }

  func testTheSameVoiceSessionsAsTheCore() async throws {
    let f = try Oracle.fixture("relay")
    let t0 = f["t0"]?.doubleValue ?? 0
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-relay-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    for (rel, content) in f["files"]?.objectValue ?? [:] {
      let file = root.appendingPathComponent(rel)
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data((content.stringValue ?? "").utf8).write(to: file)
    }
    let loop = VirtualLoop(now: t0 + 60_000)
    let rec = Recorder()
    let sessions = Sessions(home: root, now: { loop.now })
    let config = EngineConfig(dir: root.appendingPathComponent("orbit-config"))
    _ = config.load(env: [:])
    _ = config.onChange { changed, _ in rec.add(["kind": "broadcast", "evt": ["type": "settings.changed", "changed": .array(changed.map { .string($0) })]]) }
    let replay = Replay(rec: rec)
    let avatar = AvatarRunner()
    avatar.chosen = { config.string("avatar") }
    avatar.sink = { cmd in
      rec.add(["kind": "avatar", "cmd": .object(cmd)])
      return ["ok": true]
    }
    let tools = ToolServices(
      desktop: replay, sessions: sessions, config: config, brainKey: { "" },
      findClaude: { _ in ("/fake/bin/claude", "path") },
      brain: { q, m, explore, cwd, session, path, key in
        replay.call("brain", ["question": .string(q), "model": .string(m), "explore": .bool(explore), "cwd": Replay.opt(cwd), "session": session ?? .null, "claudePath": .string(path), "apiKey": .string(key.isEmpty ? "" : "set")])
      },
      search: { q, path, key in replay.call("search", ["query": .string(q), "claudePath": .string(path), "apiKey": .string(key.isEmpty ? "" : "set")]) },
      signIn: { path in replay.call("sign-in", ["claudePath": .string(path)]) },
      clipboard: { text in rec.add(["kind": "clipboard", "text": .string(text)]); return true },
      avatar: avatar, log: nil, now: { loop.now },
      sleep: { _ in }, home: root.path
    )
    let watcher = FakeWatcher()
    let ups = Locked<[FakeUp]>([])
    let hub = VoiceHub(.init(
      loop: loop, config: config, xaiKey: { "xai-oracle-key-0000000000000000" }, brainKey: { "" }, log: nil, usage: nil,
      tools: tools, sessions: sessions, desktop: replay, watcher: watcher, anywhere: VoiceAnywhereOff(),
      broadcast: { evt in rec.add(["kind": "broadcast", "evt": evt]) },
      claudeModelsReady: { true }, findClaude: { _ in "/fake/bin/claude" },
      grok: { url, key in
        let u = FakeUp(rec: rec, index: ups.get().count)
        ups.update { $0.append(u) }
        rec.add(["kind": "upNew", "i": .number(Double(u.index)), "kind2": "grok", "url": .string(url), "auth": key.isEmpty ? .null : "Bearer KEY"])
        return u
      },
      claude: { o, localTurn in
        let u = FakeUp(rec: rec, index: ups.get().count)
        u.localTurn = localTurn
        ups.update { $0.append(u) }
        rec.add(["kind": "upNew", "i": .number(Double(u.index)), "kind2": "claude", "claudePath": o.claudePath.map { .string($0) } ?? .null, "speed": .number(o.speed), "sid": .number(Double(o.sid)),
                 "model": .string(o.model), "effort": .string(o.effort), "stt": .string(o.stt), "localSpeech": .bool(o.localSpeech)])
        return u
      }
    ))
    hub.start()
    config.update(["anywhere": false, "webSearch": false, "brainEnabled": true, "voiceEngine": "grok"])

    /** Run everything that's queued (tool calls come back from the runner's actor), until it's quiet. */
    func settle() async {
      var quiet = 0
      while quiet < 6 {
        loop.pump()
        try? await Task.sleep(nanoseconds: 2_000_000)
        quiet = loop.idle ? quiet + 1 : 0
      }
    }
    await settle()

    let calls = f["calls"]?.arrayValue ?? []
    let results = f["results"]?.arrayValue ?? []
    XCTAssertEqual(calls.count, results.count)
    var wrong = 0
    var steps = 0
    var page: FakePage?
    for (k, script) in calls.enumerated() {
      let want = results[k].arrayValue ?? []
      for (j, st) in (script.arrayValue ?? []).enumerated() {
        steps += 1
        rec.entries.set([])
        let expected = want[j]
        replay.expected.set((expected["log"]?.arrayValue ?? []).filter { $0["kind"]?.stringValue == "desktop" })
        switch st["op"]?.stringValue {
        case "connect":
          let p = FakePage(rec: rec, loop: loop)
          page = p
          let q = st["query"]?.stringValue ?? ""
          hub.connect(p, announce: q.contains("announce=1"), localSpeech: q.contains("speech=local"))
        case "page": page?.onMessage.map { fn in loop.run { fn(JSONText.of(st["msg"] ?? .null)) } }
        case "pageClose":
          let p = page
          loop.run { p?.gone() }
        case "upOpen":
          if let u = ups.get().last {
            u.state = 1
            loop.run { u.onOpen?() }
          }
        case "up": if let u = ups.get().last { loop.run { u.onMessage?(JSONText.of(st["evt"] ?? .null)) } }
        case "upClose":
          if let u = ups.get().last {
            u.state = 3
            loop.run { u.onClose?(st["code"]?.intValue ?? 1000, st["reason"]?.stringValue ?? "") }
          }
        case "upError": if let u = ups.get().last { loop.run { u.onError?(st["message"]?.stringValue ?? "") } }
        case "upRefused": if let u = ups.get().last { loop.run { u.onRefused?(st["status"]?.intValue ?? 0, st["body"]?.stringValue ?? "") } }
        case "watcher": for fn in watcher.fns { fn(st["evt"] ?? .null) }
        case "working": watcher.list = st["list"]?.arrayValue ?? []
        case "tick": loop.tick(st["ms"]?.doubleValue ?? 0)
        case "setting": config.update(st["patch"]?.objectValue ?? [:])
        case "localTurn":
          let r = ups.get().last?.localTurn?(st["text"]?.stringValue ?? "", st["item"]?.stringValue ?? "")
          rec.add(["kind": "localTurnResult", "result": r.map { ["note": .string($0)] } ?? .null])
        default: break
        }
        await settle()
        // (A tool's result goes to the voice as a JSON string: its keys' order isn't kept by the
        // Swift runner's objects, so the result is compared as JSON.)
        let normal = { (e: JSONValue) -> JSONValue in
          guard e["kind"]?.stringValue == "up", case .object(var o) = e, case .object(var msg)? = o["msg"], case .object(var item)? = msg["item"],
                item["type"]?.stringValue == "function_call_output", let out = item["output"]?.stringValue, let parsed = try? JSONValue.parse(out) else { return e }
          item["output"] = parsed
          msg["item"] = .object(item)
          o["msg"] = .object(msg)
          return .object(o)
        }
        let byKind = { (entries: [JSONValue]) -> [String: [JSONValue]] in Dictionary(grouping: entries.map(normal)) { $0["kind"]?.stringValue ?? "" } }
        // (The fake's own upNew uses "kind2" for the socket's kind: the JS's has it as "kind" next to the record's.)
        let gotKinds = byKind(rec.entries.get().map { e in
          guard e["kind"]?.stringValue == "upNew", case .object(var o) = e else { return e }
          o["kind"] = "upNew"
          return .object(o)
        })
        let wantKinds = byKind((expected["log"]?.arrayValue ?? []).map { e in
          guard e["kind"]?.stringValue == "grok" || e["kind"]?.stringValue == "claude", case .object(var o) = e else { return e }
          o["kind2"] = o["kind"]
          o["kind"] = "upNew"
          return .object(o)
        })
        let sameNow = loop.now - t0 == expected["now"]?.doubleValue
        if gotKinds != wantKinds || !sameNow {
          wrong += 1
          if wrong <= 10 {
            var diff: [String] = []
            for key in Set(gotKinds.keys).union(wantKinds.keys).sorted() where gotKinds[key] != wantKinds[key] {
              diff.append("\(key):\n    Swift \(JSONValue.array(gotKinds[key] ?? []).text.prefix(1200))\n    JS    \(JSONValue.array(wantKinds[key] ?? []).text.prefix(1200))")
            }
            if !sameNow { diff.append("now: Swift \(loop.now - t0) JS \(expected["now"] ?? .null)") }
            XCTFail("scene \(k) step \(j) \(st.text.prefix(140)):\n  " + diff.joined(separator: "\n  "))
          }
        }
      }
    }
    XCTAssertGreaterThan(steps, 200)
    XCTAssertEqual(wrong, 0, "steps that differ (of \(steps))")
  }
}
