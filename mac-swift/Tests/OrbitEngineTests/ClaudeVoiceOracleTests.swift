// Claude voice's realtime stand-in against src/claude-voice.js (parity/oracle/claudevoice.mjs): the
// same scripts of what the bridge sends and what Claude Code writes, on a virtual loop with the JS's
// macrotask and microtask order, and a stand-in Claude Code that records how it was started, every
// line it was sent and when it was ended. Every message out, process and line must match.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitIntent
@testable import OrbitKit

/** A loop for tests: a virtual clock, macrotasks run when pumped, timers fired by tick. */
final class VirtualLoop: VoiceLoop, @unchecked Sendable {
  var now: Double
  private var tasks: [@Sendable () -> Void] = []
  private var microtasks: [@Sendable () -> Void] = []
  private var timers: [(token: Int, at: Double, seq: Int, f: @Sendable () -> Void)] = []
  private var nextToken = 1
  private var seq = 0

  init(now: Double) { self.now = now }

  func run(_ f: @escaping @Sendable () -> Void) { tasks.append(f) }
  func micro(_ f: @escaping @Sendable () -> Void) { microtasks.append(f) }
  func after(_ ms: Double, _ f: @escaping @Sendable () -> Void) -> Int {
    let t = nextToken
    nextToken += 1
    seq += 1
    timers.append((t, now + max(1, ms), seq, f))
    return t
  }
  func cancel(_ token: Int) { timers.removeAll { $0.token == token } }

  private func drain() { while !microtasks.isEmpty { microtasks.removeFirst()() } }

  /** Runs every queued macrotask (and what they queue), each followed by its microtasks. */
  func pump() {
    drain()
    while !tasks.isEmpty {
      tasks.removeFirst()()
      drain()
    }
  }

  /** Moves the clock on, firing due timers in order (as node's mock timers tick does). */
  func tick(_ ms: Double) {
    // (node's mock timers: the clock goes to the end first, then the due timers fire in order)
    now += ms
    while let next = timers.filter({ $0.at <= now }).min(by: { ($0.at, $0.seq) < ($1.at, $1.seq) }) {
      timers.removeAll { $0.token == next.token }
      next.f()
      drain()
      pump()
    }
    pump()
  }
}

final class ClaudeVoiceOracleTests: XCTestCase {
  final class FakeChild: StreamChild, @unchecked Sendable {
    var onStdout: (@Sendable (Data) -> Void)?
    var onStderr: (@Sendable (Data) -> Void)?
    var onClose: (@Sendable () -> Void)?
    let pid: Int32 = 0
    let index: Int
    let log: Locked<[JSONValue]>
    var buf = ""
    init(index: Int, log: Locked<[JSONValue]>) {
      self.index = index
      self.log = log
    }
    func start() {}
    func write(_ data: Data) {
      buf += String(decoding: data, as: UTF8.self)
      while let r = buf.range(of: "\n") {
        var line = String(buf[..<r.lowerBound])
        buf = String(buf[r.upperBound...])
        line = JSRegExp(#""request_id":"int_[0-9a-f]{8}""#).replace(line, #""request_id":"int_ID""#)
        log.update { $0.append(["kind": "stdin", "proc": .number(Double(index)), "line": .string(line)]) }
      }
    }
    func closeStdin() {}
    func killTree(sync: Bool) { log.update { $0.append(["kind": "kill", "proc": .number(Double(index))]) } }
  }

  func testTheSameTurnsAsTheCore() throws {
    let f = try Oracle.fixture("claudevoice")
    let t0 = f["t0"]?.doubleValue ?? 0
    let calls = f["calls"]?.arrayValue ?? []
    let results = f["results"]?.arrayValue ?? []
    XCTAssertEqual(calls.count, results.count)
    var wrong = 0
    var steps = 0
    var now = t0
    for (k, script) in calls.enumerated() {
      let want = results[k].arrayValue ?? []
      // (The JS's clock runs on from call to call.)
      let loop = VirtualLoop(now: now)
      let log = Locked<[JSONValue]>([])
      let children = Locked<[FakeChild]>([])
      let spawner: StreamSpawner = { exe, args, cwd, env in
        let i = children.get().count
        let at = args.firstIndex(of: "--system-prompt-file")
        let prompt = at.flatMap { try? String(contentsOfFile: args[$0 + 1], encoding: .utf8) }
        let shown = args.enumerated().map { $0.offset == (at ?? -9) + 1 ? "PROMPT_FILE" : $0.element }
        let voiceCwd = (BrainRunner.tmpdir as NSString).appendingPathComponent("orbit-voice-not-a-project")
        log.update { $0.append(["kind": "spawn", "proc": .number(Double(i)), "exe": .string(exe), "args": .array(shown.map { .string($0) }), "prompt": prompt.map { .string($0) } ?? .null,
                                "cwd": .string(cwd == voiceCwd ? "VOICE_CWD" : cwd), "quiet": env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"].map { .string($0) } ?? .null,
                                "apiKey": env["ANTHROPIC_API_KEY"].map { .string($0) } ?? .null]) }
        let c = FakeChild(index: i, log: log)
        children.update { $0.append(c) }
        return c
      }
      var rt: ClaudeRealtime?
      for (j, st) in script.arrayValue?.enumerated() ?? [].enumerated() {
        steps += 1
        log.set([])
        switch st["op"]?.stringValue {
        case "open":
          let o = st["opts"] ?? .null
          var opts = ClaudeRealtime.Options()
          opts.claudePath = "/fake/bin/claude"
          opts.localSpeech = true
          if let m = o["model"]?.stringValue { opts.model = m }
          if let e = o["effort"]?.stringValue { opts.effort = e }
          if let s = o["sid"]?.doubleValue { opts.sid = Int(s) }
          if let s = o["speed"]?.doubleValue { opts.speed = s }
          let r = ClaudeRealtime(opts, loop: loop, spawner: spawner, useSpare: false, spares: nil, baseEnv: ["PATH": "/usr/bin:/bin", "ANTHROPIC_API_KEY": "sk-ant-should-not-pass"])
          r.localTurn = { text, itemId in
            log.update { $0.append(["kind": "localTurn", "text": .string(text), "itemId": .string(itemId)]) }
            return JSRegExp("backflip", "i").test(text) ? "[Orbit note: Orbit did a backflip itself.]" : nil
          }
          r.onMessage = { m in log.update { $0.append(["kind": "emit", "msg": m]) } }
          r.onOpen = { log.update { $0.append(["kind": "open"]) } }
          r.onClose = { code, reason in log.update { $0.append(["kind": "close", "code": .number(Double(code)), "reason": .string(reason)]) } }
          r.onMetrics = { m in
            var x = m.objectValue ?? [:]
            for key in ["endedAt", "heardAt", "textAt", "firstTokenAt", "firstAudioAt", "fillerAt"] {
              if let v = x[key]?.doubleValue { x[key] = .number(v - t0) } else { x[key] = .null }
            }
            log.update { $0.append(["kind": "metrics", "m": .object(x)]) }
          }
          r.onWarn = { what, _ in log.update { $0.append(["kind": "warn", "what": .string(what)]) } }
          rt = r
          r.start()
        case "send": rt?.send(st["data"]?.stringValue ?? "")
        case "send-raw": rt?.send(st["data"]?.stringValue ?? "")
        case "out":
          let i = st["proc"]?.intValue ?? -1
          let kids = children.get()
          let c = i < 0 ? kids.last : (i < kids.count ? kids[i] : nil)
          let text = (st["lines"]?.arrayValue ?? []).map { JSONText.of($0) }.joined(separator: "\n") + "\n"
          c?.onStdout?(Data(text.utf8))
        case "exit":
          let i = st["proc"]?.intValue ?? -1
          let kids = children.get()
          let c = i < 0 ? kids.last : (i < kids.count ? kids[i] : nil)
          if let e = st["stderr"]?.stringValue { c?.onStderr?(Data(e.utf8)) }
          c?.onClose?()
        case "tick": loop.tick(st["ms"]?.doubleValue ?? 0)
        case "close": rt?.close()
        default: break
        }
        loop.pump()
        let expected = want[j]
        // (Messages out and the processes' own records each keep their order; the JS interleaves
        // stdin lines with the rest through stream events, so they're compared per kind.)
        let byKind = { (entries: [JSONValue]) -> [String: [JSONValue]] in Dictionary(grouping: entries) { $0["kind"]?.stringValue ?? "" } }
        let gotKinds = byKind(log.get())
        let wantKinds = byKind(expected["log"]?.arrayValue ?? [])
        let sameNow = loop.now - t0 == expected["now"]?.doubleValue
        let sameState = (rt.map { JSONValue.number(Double($0.readyState.rawValue)) } ?? .null) == expected["readyState"]
        if gotKinds != wantKinds || !sameNow || !sameState {
          wrong += 1
          if wrong <= 8 {
            var diff: [String] = []
            for key in Set(gotKinds.keys).union(wantKinds.keys).sorted() where gotKinds[key] != wantKinds[key] {
              diff.append("\(key):\n    Swift \(JSONValue.array(gotKinds[key] ?? []).text.prefix(900))\n    JS    \(JSONValue.array(wantKinds[key] ?? []).text.prefix(900))")
            }
            if !sameNow { diff.append("now: Swift \(loop.now - t0) JS \(expected["now"] ?? .null)") }
            if !sameState { diff.append("readyState: Swift \(rt?.readyState.rawValue ?? -1) JS \(expected["readyState"] ?? .null)") }
            XCTFail("call \(k) step \(j) \(st.text.prefix(140)):\n  " + diff.joined(separator: "\n  "))
          }
        }
      }
      now = loop.now
    }
    XCTAssertGreaterThan(steps, 250)
    XCTAssertEqual(wrong, 0, "steps that differ (of \(steps))")
  }
}
