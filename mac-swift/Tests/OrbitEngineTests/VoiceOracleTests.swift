// What the voice is told and given (src/agent.js), its tools' text checks (src/tools.js,
// src/app-control.js) and Claude voice's text handling (src/claude-voice.js), against the core's own
// answers (parity/oracle/voice.mjs).
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitIntent
@testable import OrbitKit

final class VoiceOracleTests: XCTestCase {
  func testTheSameTextAnswersAsTheCore() throws {
    let f = try Oracle.fixture("voice")
    var wrong = 0
    var byFn: [String: Int] = [:]
    var total: [String: Int] = [:]
    for c in f["cases"]?.arrayValue ?? [] {
      let fn = c["fn"]?.stringValue ?? ""
      let i = c["input"] ?? .null
      let s = i.stringValue ?? ""
      total[fn, default: 0] += 1
      let got: JSONValue
      switch fn {
      case "removeFillers": got = .string(VoiceText.removeFillers(s))
      case "asksVerbatim": got = .bool(VoiceText.asksVerbatim(s))
      case "asksSwitch": got = .bool(VoiceText.asksFor("switch", s))
      case "asksDraft": got = .bool(VoiceText.asksFor("draft", s))
      case "asksSetting": got = .bool(VoiceText.asksSetting(i["words"]?.stringValue ?? "", i["setting"]?.stringValue ?? "", i["value"]?.stringValue ?? ""))
      case "asksApp": got = .bool(VoiceText.asksApp(i["action"]?.stringValue ?? "", i["words"]?.stringValue ?? "", i["value"]?.stringValue ?? ""))
      case "wordsNotSaid": got = .array(VoiceText.wordsNotSaid(i["draft"]?.stringValue ?? "", i["said"]?.stringValue ?? "", direct: i["direct"]?.boolValue ?? false).map { .string($0) })
      case "isEditOf": got = .bool(VoiceText.isEditOf(i["box"]?.stringValue ?? "", i["draft"]?.stringValue ?? ""))
      case "toolErrorForLog": got = .string(VoiceText.toolErrorForLog(i))
      case "sendFailureStep": got = .string(VoiceText.sendFailureStep(i))
      case "brainToolResult":
        let o = i["opts"] ?? .null
        got = VoiceText.brainToolResult(i["result"], label: o["label"]?.stringValue ?? "Claude", readProject: o["readProject"]?.stringValue, note: o["note"]?.stringValue ?? "")
      case "soundsUnfinished": got = .bool(VoiceText.soundsUnfinished(s))
      case "speakableText": got = .string(VoiceText.speakableText(s))
      case "takeChunks":
        let r = VoiceText.takeChunks(i["buf"]?.stringValue ?? "", first: i["first"]?.boolValue ?? false, final: i["final"]?.boolValue ?? false)
        got = ["chunks": .array(r.chunks.map { .string($0) }), "rest": .string(r.rest)]
      case "isJunk": got = .bool(VoiceText.isJunk(s))
      case "parseToolCall": got = VoiceText.parseToolCall(s)?.json ?? .null
      case "parseXmlToolCall": got = VoiceText.parseXmlToolCall(s)?.json ?? .null
      case "findToolCall":
        let r = VoiceText.findToolCall(s)
        got = ["call": r.call?.json ?? .null, "at": .number(Double(r.at))]
      default:
        XCTFail("unknown case \(fn)")
        continue
      }
      if got != c["output"] {
        wrong += 1
        byFn[fn, default: 0] += 1
        if wrong <= 15 { XCTFail("\(fn) \(i.text.prefix(200)):\n  Swift \(got.text.prefix(500))\n  JS    \((c["output"] ?? .null).text.prefix(500))") }
      }
    }
    XCTAssertGreaterThan(total.values.reduce(0, +), 8000, "the whole corpus ran")
    XCTAssertEqual(wrong, 0, "cases that differ: \(byFn) of \(total)")
  }

  func testWhatTheVoiceIsToldAndGiven() throws {
    let f = try Oracle.fixture("voice")
    XCTAssertEqual(f["contextSettings"], .array(Agent.contextSettings.map { .string($0) }))
    var wrong = 0
    for (k, c) in (f["contexts"]?.arrayValue ?? []).enumerated() {
      let settings = c["settings"]?.objectValue ?? [:]
      let ctx = Agent.context(settings)
      let want = c["context"] ?? .null
      let prompt = Agent.systemPrompt(instructions: ctx.instructions, tools: ctx.tools)
      if ctx.json != want || .string(prompt) != c["prompt"] {
        wrong += 1
        if wrong <= 3 {
          let a = ctx.instructions, b = want["instructions"]?.stringValue ?? ""
          let at = Array(zip(a, b)).firstIndex { $0 != $1 } ?? min(a.count, b.count)
          XCTFail("context \(k) \(JSONValue.object(settings).text):\n  instructions same: \(a == b) (first difference at \(at): Swift …\(a.dropFirst(max(0, at - 60)).prefix(160))…\n  JS    …\(b.dropFirst(max(0, at - 60)).prefix(160))…)\n  tools same: \(ctx.json["tools"] == want["tools"]) face \(ctx.face)/\(want["face"] ?? .null)\n  prompt same: \(.string(prompt) == c["prompt"])")
        }
      }
    }
    XCTAssertGreaterThan(f["contexts"]?.arrayValue?.count ?? 0, 20)
    XCTAssertEqual(wrong, 0, "contexts that differ")
  }
}
