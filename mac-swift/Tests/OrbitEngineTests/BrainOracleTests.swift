// The second brain, web search, finding Claude Code and the speech models against src/brain.js,
// src/platform/system.js and src/voice-models.js (parity/oracle/brain.mjs): the same inputs, the
// same stand-in Claude Code process and stand-in downloads, the same answers.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitIntent
@testable import OrbitKit

final class BrainOracleTests: XCTestCase {
  /** A stand-in Claude Code: answers with the fixture's output; records how it was started. */
  final class FakeChild: RunningChild, @unchecked Sendable {
    let result: ChildResult
    init(_ r: ChildResult) { result = r }
    func finished() async -> ChildResult { result }
    func killTree(sync: Bool) {}
  }

  struct Call { var exe: String; var args: [String]; var cwd: String; var env: [String: String]; var stdin: Data? }

  static func reply(_ v: JSONValue?) -> ChildResult {
    let code = v?["code"]?.doubleValue.map { Int32($0) } ?? 0
    return ChildResult(code: code, stdout: Data((v?["stdout"]?.stringValue ?? "").utf8), stderr: Data((v?["stderr"]?.stringValue ?? "").utf8))
  }

  func testTheSameTextAnswersAsTheCore() throws {
    let f = try Oracle.fixture("brain")
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-brain-home-\(UUID().uuidString)").path
    let empty = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-brain-empty-\(UUID().uuidString)").path
    defer {
      try? FileManager.default.removeItem(atPath: home)
      try? FileManager.default.removeItem(atPath: empty)
    }
    try FileManager.default.createDirectory(atPath: empty, withIntermediateDirectories: true)
    for rel in f["homeFiles"]?.arrayValue?.compactMap(\.stringValue) ?? [] {
      let file = (home as NSString).appendingPathComponent(rel)
      try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: file, contents: Data())
    }
    var wrong = 0
    var byFn: [String: Int] = [:]
    for c in f["cases"]?.arrayValue ?? [] {
      let fn = c["fn"]?.stringValue ?? ""
      let input = c["input"] ?? .null
      let got: JSONValue
      switch fn {
      case "brainArgs":
        do { got = .array(try Brain.args(model: input["model"]?.stringValue ?? "", explore: input["explore"]?.boolValue ?? false).map { .string($0) }) } catch { got = ["throws": .string("\(error)")] }
      case "searchArgs": got = .array(Brain.searchArgs().map { .string($0) })
      case "speakable": got = .string(Brain.speakable(input))
      case "readStructured": got = Brain.readStructured(input) ?? .null
      case "readSearch": got = Brain.readSearch(input) ?? .null
      case "readBrainResult":
        let r = Brain.readResult(input)
        got = ["answer": .string(r.answer), "structured": r.structured ?? .null]
      case "isSignInProblem": got = .bool(Brain.isSignInProblem(input))
      case "isClaudeFile": got = .bool(Brain.isClaudeFile(input.stringValue ?? ""))
      case "isLocalAbsolute": got = .bool(Brain.isLocalAbsolute(input.stringValue ?? ""))
      case "shellQuote": got = .string(Brain.shellQuote(input.stringValue ?? ""))
      case "signInScript": got = .string(Brain.signInScript(file: input["file"]?.stringValue ?? "", claudePath: input["claudePath"]?.stringValue ?? ""))
      case "brainPrompt": got = .string(Brain.prompt(question: input["question"], context: input["context"], session: input["session"]))
      case "loginShellCommand":
        let cmd = MacSystem.loginShellCommand(env: input.stringValue.map { ["SHELL": $0] } ?? [:])
        got = ["file": .string(cmd.file), "args": .array(cmd.args.map { .string($0) })]
      case "parseShellPath": got = .array(MacSystem.parseShellPath(input.stringValue).map { .string($0) })
      case "compareVersions":
        let d = MacSystem.compareVersions(input[0]?.stringValue ?? "", input[1]?.stringValue ?? "")
        got = .number(d == 0 ? 0 : d < 0 ? -1 : 1)
      case "wellKnownBinDirs": got = .array(MacSystem.wellKnownBinDirs(home: input.stringValue ?? "").map { .string($0) })
      case "searchDirs":
        got = .array(MacSystem.searchDirs(env: ["PATH": input["PATH"]?.stringValue ?? ""], home: "/Users/me", shellPath: input["shellPath"]?.arrayValue?.compactMap(\.stringValue) ?? []).map { .string($0) })
      case "findClaude":
        let h = input["home"]?.stringValue == "empty" ? empty : home
        let listed = Set(input["exists"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        let extra = Set((input["homeExists"]?.arrayValue?.compactMap(\.stringValue) ?? []).map { "\(h)/\($0)" })
        let env = (input["env"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
        let found = Brain.findClaude(input["configured"]?.stringValue ?? "", env: env, home: h, shellPath: input["shellPath"]?.arrayValue?.compactMap(\.stringValue) ?? []) { p in
          p.hasPrefix("\(h)/") ? extra.contains(p) || FileManager.default.fileExists(atPath: p) : listed.contains(p)
        }
        got = found.map { ["path": .string($0.path.hasPrefix("\(h)/") ? "~/" + $0.path.dropFirst(h.count + 1) : $0.path), "source": .string($0.source)] } ?? .null
      default:
        XCTFail("unknown case \(fn)")
        continue
      }
      if got != c["output"] {
        wrong += 1
        byFn[fn, default: 0] += 1
        if wrong <= 12 { XCTFail("\(fn) \(input.text.prefix(200)):\n  Swift \(got.text.prefix(500))\n  JS    \((c["output"] ?? .null).text.prefix(500))") }
      }
    }
    XCTAssertEqual(wrong, 0, "cases that differ: \(byFn)")
  }

  func testTheSameRunsAsTheCore() async throws {
    let f = try Oracle.fixture("brain")
    let project = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-brain-project-\(UUID().uuidString)").path
    try FileManager.default.createDirectory(atPath: project, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: project) }
    let tmp = "/private/tmp/orbit-brain-tmp"
    var wrong = 0
    for run in f["runs"]?.arrayValue ?? [] {
      let input = run["input"] ?? .null
      let calls = Locked<[Call]>([])
      let reply = Self.reply(input["reply"] ?? ["stdout": input["stdout"] ?? ""])
      let runner = BrainRunner(spawner: { exe, args, cwd, env, stdin in
        calls.update { $0.append(Call(exe: exe, args: args, cwd: cwd, env: env, stdin: stdin)) }
        return FakeChild(reply)
      }, baseEnv: ["PATH": "/usr/bin:/bin", "ANTHROPIC_API_KEY": "sk-ant-from-the-environment"], home: "/Users/me", tmp: tmp, shellPath: { [] })
      var got: JSONValue
      switch run["kind"]?.stringValue {
      case "ask":
        let o = input["opts"] ?? .null
        let cwd = o["cwd"]?.stringValue == "PROJECT" ? project : o["cwd"]?.stringValue
        got = await runner.ask(question: o["question"], model: o["model"]?.stringValue ?? "sonnet", explore: o["explore"]?.boolValue ?? false, cwd: cwd,
                               context: o["context"], session: o["session"], claudePath: "/fake/bin/claude", apiKey: o["apiKey"]?.stringValue ?? "")
      case "search":
        got = await runner.search(query: input["query"], claudePath: "/fake/bin/claude", apiKey: "")
      default:
        got = await runner.authStatus(claudePath: input["claudePath"]?.stringValue ?? "/fake/bin/claude")
      }
      // (The oracle writes every ask and search result with seconds: null, as they vary.)
      if case .object(var o) = got, run["kind"]?.stringValue != "auth" {
        o["seconds"] = .null
        got = .object(o)
      }
      let call: JSONValue = calls.get().first.map { c in
        var stdin = String(decoding: c.stdin ?? Data(), as: UTF8.self)
        stdin = JSRegExp(#"Today is \d{4}-\d{2}-\d{2}\."#).replace(stdin, "Today is DATE.")
        return [
          "exe": .string(c.exe), "args": .array(c.args.map { .string($0) }),
          "cwd": .string(c.cwd == project ? "PROJECT" : c.cwd == tmp ? "TMP" : c.cwd),
          "apiKey": c.env["ANTHROPIC_API_KEY"].map { .string($0) } ?? .null, "stdin": .string(stdin),
        ]
      } ?? .null
      if got != run["output"] || call != run["call"] {
        wrong += 1
        if wrong <= 8 {
          XCTFail("\(run["kind"]?.stringValue ?? "") \(input.text.prefix(200)):\n  Swift \(got.text.prefix(400))\n  JS    \((run["output"] ?? .null).text.prefix(400))\n  call Swift \(call.text.prefix(600))\n  call JS    \((run["call"] ?? .null).text.prefix(600))")
        }
      }
    }
    XCTAssertEqual(wrong, 0, "runs that differ")
  }

  func testTheSameSpeechModelsAsTheCore() async throws {
    let f = try Oracle.fixture("brain")
    let m = f["models"] ?? .null
    XCTAssertEqual(m["mb"], .number(Double(VoiceModels.mb)))
    let voice: JSONValue = .array(VoiceModels.voice.map { v in
      var o: [String: JSONValue] = ["id": .string(v.id), "file": .string(v.file), "url": .string(v.url), "sha256": .string(v.sha256), "size": .number(Double(v.size))]
      if let d = v.dir { o["dir"] = .string(d) }
      return .object(o)
    })
    XCTAssertEqual(voice, m["voice"])
    var stt: [String: JSONValue] = [:]
    for c in VoiceModels.stt {
      if let d = c.download {
        stt[c.id] = ["label": .string(c.label), "file": .string(d.file), "dir": .string(d.dir ?? ""), "url": .string(d.url), "sha256": .string(d.sha256),
                     "size": .number(Double(d.size)), "files": .array(c.files.map { .string($0) }), "maxSeconds": .number(Double(c.maxSeconds))]
      } else {
        stt[c.id] = ["label": .string(c.label), "bundled": .bool(c.bundled), "maxSeconds": .number(Double(c.maxSeconds)), "mb": 0]
      }
    }
    XCTAssertEqual(.object(stt), m["stt"])
    XCTAssertEqual(.array(VoiceModels.sttIds.map { .string($0) }), m["sttIds"])
    for c in m["sttOk"]?.arrayValue ?? [] { XCTAssertEqual(.bool(VoiceModels.sttOk(c["id"])), c["ok"], "sttOk \(c["id"] ?? .null)") }
    for c in m["sttConfig"]?.arrayValue ?? [] { XCTAssertEqual(VoiceModels.sttConfig(root: "/R", id: c["id"]?.stringValue), c["config"], "sttConfig \(c["id"] ?? .null)") }
    XCTAssertEqual(VoiceModels.paths(root: "/R"), m["paths"])

    // Ready or not, and the downloads that fail, step by step.
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-models-\(UUID().uuidString)").path
    defer { try? FileManager.default.removeItem(atPath: root) }
    let spec = Locked<(status: Int, bytes: Int, fetched: Int)>((200, 0, 0))
    let models = VoiceModels(root: root, fetch: { _ in
      let s = spec.update { s -> (Int, Int) in
        s.fetched += 1
        return (s.status, s.bytes)
      }
      guard (200..<300).contains(s.0) else { return (s.0, nil) }
      return (s.0, AsyncThrowingStream { c in
        var left = s.1
        while left > 0 {
          let n = min(left, 65536)
          left -= n
          c.yield(Data(count: n))
        }
        c.finish()
      })
    })
    let steps = f["modelSteps"]?["steps"]?.arrayValue ?? []
    let results = f["modelSteps"]?["results"]?.arrayValue ?? []
    for (k, st) in steps.enumerated() {
      let got: JSONValue
      switch st["op"]?.stringValue {
      case "status":
        got = ["ready": .bool(models.ready), "download": models.status(), "stt": models.sttStatus(),
               "sttReady": .object(Dictionary(uniqueKeysWithValues: VoiceModels.sttIds.map { ($0, JSONValue.bool(models.sttReady($0))) }))]
      case "download", "stt-download":
        spec.set((st["fetch"]?["status"]?.intValue ?? 0, st["fetch"]?["bytes"]?.intValue ?? 0, 0))
        do {
          if st["op"]?.stringValue == "download" { try await models.download() } else { try await models.downloadStt(st["id"]?.stringValue ?? "") }
          got = ["ok": true, "fetched": .number(Double(spec.get().fetched))]
        } catch {
          got = ["ok": false, "error": .string(VoiceModels.message(error)), "fetched": .number(Double(spec.get().fetched))]
        }
      case "write":
        for rel in st["files"]?.arrayValue?.compactMap(\.stringValue) ?? [] {
          let file = (root as NSString).appendingPathComponent(rel)
          try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
          FileManager.default.createFile(atPath: file, contents: Data((rel == "verified.json" ? "{}" : "x").utf8))
        }
        got = .null
      case "marker":
        let dir = (root as NSString).appendingPathComponent(st["dir"]?.stringValue ?? "")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try Data(#"{"at":"then","sha256":"\#(st["sha256"]?.stringValue ?? "")"}"#.utf8).write(to: URL(fileURLWithPath: (dir as NSString).appendingPathComponent("verified.json")))
        got = .null
      default:
        try? FileManager.default.removeItem(atPath: (root as NSString).appendingPathComponent(st["file"]?.stringValue ?? ""))
        got = .null
      }
      XCTAssertEqual(got, results[k], "step \(k) \(st.text)")
    }
  }
}
