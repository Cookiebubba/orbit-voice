// The voice's tool runner against src/tools.js (parity/oracle/tools.mjs): the same scripted calls on
// a virtual clock, the stand-ins' recorded answers given back, and every call to Claude's window and
// Claude Code, every notice to the page, every result and the clock checked step by step.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitIntent
@testable import OrbitKit

final class ToolsOracleTests: XCTestCase {
  /** Hands out the recorded answers in order, and keeps what Swift asked. */
  final class Replay: ToolDesktop, @unchecked Sendable {
    let lock = NSLock()
    var expected: [JSONValue] = []
    var asked: [JSONValue] = []

    func call(_ name: String, _ args: JSONValue) -> JSONValue {
      lock.withLock {
        let want: JSONValue? = expected.isEmpty ? Optional.none : expected.removeFirst()
        asked.append(["name": .string(name), "args": args, "answer": want?["answer"] ?? .null])
        return want?["answer"] ?? ["ok": false, "error": "no recorded answer"]
      }
    }

    func info() async -> JSONValue { call("info", [:]) }
    func switchSession(_ title: String) async -> JSONValue { call("switch", ["title": .string(title)]) }
    func newSession(project: String) async -> JSONValue { call("new", ["project": .string(project)]) }
    static func opt(_ s: String?) -> JSONValue { s.map { .string($0) } ?? .null }
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

  func testTheSameToolRunsAsTheCore() async throws {
    let f = try Oracle.fixture("tools")
    let t0 = f["t0"]?.doubleValue ?? 0
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-tools-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    for (rel, content) in f["files"]?.objectValue ?? [:] {
      let file = root.appendingPathComponent(rel)
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data((content.stringValue ?? "").utf8).write(to: file)
    }
    let clock = Locked(t0 + 60_000)
    let sessions = Sessions(home: root, now: { clock.get() })
    let config = EngineConfig(dir: root.appendingPathComponent("orbit-config"))
    _ = config.load(env: [:])
    config.update(["brainEnabled": true, "brainModel": "auto", "brainExplore": true, "brainConnection": "claude-code", "webSearch": true, "avatar": "qubit", "voiceEngine": "grok"])
    let replay = Replay()
    let avatar = AvatarRunner()
    avatar.chosen = { config.string("avatar") }
    avatar.sink = { cmd in replay.call("avatar", .object(cmd)) }
    let services = ToolServices(
      desktop: replay, sessions: sessions, config: config, brainKey: { "" },
      findClaude: { _ in ("/fake/bin/claude", "path") },
      brain: { q, m, explore, cwd, session, path, key in
        replay.call("brain", ["question": .string(q), "model": .string(m), "explore": .bool(explore), "cwd": Replay.opt(cwd), "session": session ?? .null, "claudePath": .string(path), "apiKey": .string(key.isEmpty ? "" : "set")])
      },
      search: { q, path, key in replay.call("search", ["query": .string(q), "claudePath": .string(path), "apiKey": .string(key.isEmpty ? "" : "set")]) },
      signIn: { path in replay.call("sign-in", ["claudePath": .string(path)]) },
      clipboard: { text in _ = replay.call("clipboard", ["text": .string(text)]); return true },
      avatar: avatar, log: nil,
      now: { clock.get() },
      sleep: { ms in clock.update { $0 += ms } },
      home: root.path
    )

    let rounds = f["rounds"]?.arrayValue ?? []
    let results = f["results"]?.arrayValue ?? []
    XCTAssertEqual(rounds.count, results.count)
    var wrong = 0
    var steps = 0
    for (k, round) in rounds.enumerated() {
      // The call's own memory of the user's words (src/server.js).
      let utterance = Locked(Utterance(text: "", at: 0))
      let speechStartedAt = Locked(0.0)
      let exchanges = Locked<[Utterance]>([])
      let notes = Locked<[JSONValue]>([])
      let hooks = CallHooks(
        notify: { e in notes.update { $0.append(e) } },
        utteranceSince: { since in
          let check = { () -> Utterance? in
            let u = utterance.get()
            return u.at > since && !JS.trim(u.text).isEmpty ? u : nil
          }
          if check() != nil || speechStartedAt.get() <= since { return check() }
          clock.update { $0 += 4000 } // (nothing arrives during a run here: the wait runs out)
          return check()
        },
        recentUtterance: { utterance.get().text.isEmpty ? nil : utterance.get() },
        userWords: {
          let now = clock.get()
          return (exchanges.get().filter { now - $0.at < 10 * 60_000 }.map(\.text) + [utterance.get().text]).filter { !$0.isEmpty }.joined(separator: " ")
        },
        heardSince: { ts in speechStartedAt.get() > ts || utterance.get().at > ts },
        repliesSince: { ts in exchanges.get().filter { $0.at > ts }.count }
      )
      let runner = ToolRunner(services: services, hooks: hooks)
      let want = results[k].arrayValue ?? []
      for (j, st) in (round["steps"]?.arrayValue ?? []).enumerated() {
        steps += 1
        let expected = want[j]
        replay.lock.withLock {
          replay.expected = expected["calls"]?.arrayValue ?? []
          replay.asked = []
        }
        notes.set([])
        var result: JSONValue = .null
        let now = clock.get()
        switch st["op"]?.stringValue {
        case "say":
          speechStartedAt.set(now)
          utterance.set(Utterance(text: st["text"]?.stringValue ?? "", at: now))
          exchanges.update { $0.append(Utterance(text: st["text"]?.stringValue ?? "", at: now)) }
        case "speech": speechStartedAt.set(now)
        case "tick": clock.update { $0 += st["ms"]?.doubleValue ?? 0 }
        case "notify": await runner.noteNotification(data: st["data"]?.boolValue ?? false)
        case "spoken": await runner.noteSpoken(st["text"]?.stringValue ?? "")
        case "allow": await runner.allowDraft(st["text"]?.stringValue ?? "")
        case "outside": await runner.noteOutsideData()
        case "setting": config.update(st["patch"]?.objectValue ?? [:])
        case "title": break // (the stand-in's window title: its answers carry it)
        case "run": result = await runner.run(st["name"]?.stringValue ?? "", st["args"]?.stringValue)
        default: break
        }
        let got: JSONValue = [
          "result": result, "notes": .array(notes.get()), "calls": .array(replay.lock.withLock { replay.asked }),
          "now": .number(clock.get() - t0), "draft": await runner.getDraft(),
        ]
        if got != expected {
          wrong += 1
          if wrong <= 10 {
            var diff: [String] = []
            for key in ["result", "notes", "calls", "now", "draft"] where got[key] != expected[key] {
              diff.append("\(key):\n    Swift \((got[key] ?? .null).text.prefix(700))\n    JS    \((expected[key] ?? .null).text.prefix(700))")
            }
            XCTFail("round \(k) step \(j) \(st.text.prefix(160)):\n  " + diff.joined(separator: "\n  "))
          }
          // Keep going from the JS's state: the clock where the JS had it.
          clock.set(t0 + (expected["now"]?.doubleValue ?? 0))
        }
      }
      await runner.dispose()
      avatar.reset()
    }
    XCTAssertGreaterThan(steps, 1000)
    XCTAssertEqual(wrong, 0, "steps that differ (of \(steps))")
  }
}
