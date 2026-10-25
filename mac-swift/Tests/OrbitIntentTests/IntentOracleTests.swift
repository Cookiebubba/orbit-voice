// The core's pure text modules against their Swift ports, on the oracle's corpus
// (parity/oracle/fixtures/intent.json: the JS's own answers): the same, case for case.
import Foundation
import XCTest
@testable import OrbitIntent
import OrbitKit

final class IntentOracleTests: XCTestCase {
  static let fixture: JSONValue? = {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../parity/oracle/fixtures/intent.json").standardizedFileURL
    return (try? Data(contentsOf: url)).flatMap { try? JSONValue.parse($0) }
  }()

  func fixture() throws -> JSONValue {
    guard let f = Self.fixture else { throw XCTSkip("no intent oracle fixture (node parity/oracle/gen.mjs)") }
    return f
  }

  /** Runs `check` on every case, failing with the first few that differ and the count. */
  func each(_ list: [JSONValue], _ name: String, _ check: (JSONValue) -> (got: JSONValue, want: JSONValue)) {
    var wrong = 0
    for c in list {
      let (got, want) = check(c)
      if got != want {
        wrong += 1
        if wrong <= 8 { XCTFail("\(name)(\(c["input"]?.text ?? c.text.prefix(120).description)): Swift \(got.text), JS \(want.text)") }
      }
    }
    XCTAssertEqual(wrong, 0, "\(name): cases that differ")
  }

  var cases: [JSONValue] { (try? fixture()["cases"]?.arrayValue) ?? [] }

  func testTheCorpusIsThere() throws {
    XCTAssertGreaterThan(try fixture()["cases"]?.arrayValue?.count ?? 0, 2000)
  }

  func testConsent() {
    each(cases, "consentOf") { c in
      let v = Consent.of(c["input"]?.stringValue ?? "")
      return (["yes": .bool(v.yes), "why": .string(v.why)], c["consent"] ?? .null)
    }
  }

  func testSendIntent() {
    each(cases, "sendInstruction") { c in
      let v = SendIntent.instruction(c["input"]?.stringValue ?? "")
      return (["send": .bool(v.send), "rest": .string(v.rest)], c["send"] ?? .null)
    }
    each(cases, "withoutSendTail") { c in (.string(SendIntent.withoutSendTail(c["input"]?.stringValue ?? "")), c["sendTail"] ?? .null) }
  }

  func testOffers() {
    each(cases, "acceptsOffer") { c in
      let v = Offers.accepts(c["input"]?.stringValue ?? "")
      return (["accepts": .bool(v.accepts), "send": .bool(v.send)], c["accepts"] ?? .null)
    }
    each(cases, "isOffer") { c in (.bool(Offers.isOffer(c["input"]?.stringValue ?? "")), c["isOffer"] ?? .null) }
  }

  func testWholeUtteranceCommands() {
    each(cases, "isSleepCommand") { c in (.bool(SleepCommand.matches(c["input"]?.stringValue ?? "")), c["sleep"] ?? .null) }
    each(cases, "isStopCommand") { c in (.bool(StopCommand.isCommand(c["input"]?.stringValue ?? "")), c["stop"] ?? .null) }
    each(cases, "asksToStop") { c in (.bool(StopCommand.asksToStop(c["input"]?.stringValue ?? "")), c["asksToStop"] ?? .null) }
    each(cases, "asksToStop(hasDraft)") { c in (.bool(StopCommand.asksToStop(c["input"]?.stringValue ?? "", hasDraft: true)), c["asksToStopDraft"] ?? .null) }
    each(cases, "matchPresenceCommand") { c in (Presence.match(c["input"]?.stringValue ?? "").map { .string($0) } ?? .null, c["presence"] ?? .null) }
    each(cases, "matchPresenceCommand(away)") { c in (Presence.match(c["input"]?.stringValue ?? "", away: true).map { .string($0) } ?? .null, c["presenceAway"] ?? .null) }
    each(cases, "isStopEverything") { c in (.bool(Presence.isStopEverything(c["input"]?.stringValue ?? "")), c["stopEverything"] ?? .null) }
    each(cases, "presence normalize") { c in (.string(Presence.normalize(c["input"]?.stringValue ?? "")), c["normalize"] ?? .null) }
    each(cases, "asksToSwitch") { c in (.bool(Switching.asks(c["input"]?.stringValue ?? "")), c["asksToSwitch"] ?? .null) }
  }

  static func cuesJSON(_ p: EmoteCues.Piece) -> JSONValue {
    ["text": .string(p.text), "cues": .array(p.cues.map { ["cue": .string($0.cue), "at": .number(Double($0.at))] })]
  }

  func testEmoteCues() throws {
    each(cases, "stripCues") { c in (Self.cuesJSON(EmoteCues.strip(c["input"]?.stringValue ?? "")), c["strip"] ?? .null) }
    each(cases, "withoutKnownCues") { c in (.string(EmoteCues.withoutKnown(c["input"]?.stringValue ?? "")), c["knownCues"] ?? .null) }
    let streams = try fixture()["streams"]?.arrayValue ?? []
    XCTAssertGreaterThan(streams.count, 50)
    each(streams, "createCueStream") { s in
      let st = EmoteCues.Stream()
      var pieces = (s["deltas"]?.arrayValue ?? []).map { Self.cuesJSON(st.push($0.stringValue ?? "")) }
      pieces.append(Self.cuesJSON(st.end()))
      return (["pieces": .array(pieces), "length": .number(Double(st.length))], ["pieces": s["pieces"] ?? .null, "length": s["length"] ?? .null])
    }
  }

  static func matchJSON(_ m: AvatarCommands.Match?) -> JSONValue {
    guard let m else { return .null }
    var o: [String: JSONValue] = ["action": .string(m.action), "confidence": .number(m.confidence), "sure": .bool(m.sure)]
    if let d = m.dir { o["dir"] = .string(d) }
    return .object(o)
  }

  func testTheAvatarsFastPath() throws {
    each(cases, "matchAvatarCommand(qubit)") { c in (Self.matchJSON(AvatarCommands.match(c["input"]?.stringValue ?? "", avatar: "qubit")), c["qubit"] ?? .null) }
    each(cases, "matchAvatarCommand(buddy)") { c in (Self.matchJSON(AvatarCommands.match(c["input"]?.stringValue ?? "", avatar: "buddy")), c["buddy"] ?? .null) }
    each(try fixture()["scores"]?.arrayValue ?? [], "wordScore") { s in (.number(AvatarCommands.wordScore(s["heard"]?.stringValue ?? "", s["word"]?.stringValue ?? "")), s["score"] ?? .null) }
    for kind in ["qubit", "buddy"] {
      let want = try fixture().at(path: "toolDefs.\(kind)")
      XCTAssertEqual(JSONValue(any: AvatarCommands.toolDef(kind)), want, kind)
    }
  }

  static func decisionJSON(_ d: ClaudePrompt.Decision?) -> JSONValue {
    guard let d else { return .null }
    var o: [String: JSONValue] = ["choice": .string(d.choice), "generic": .bool(d.generic)]
    if let n = d.option { o["option"] = .number(Double(n)) }
    return .object(o)
  }

  func testAnsweringClaudesPrompts() throws {
    each(cases, "decisionFrom(permission)") { c in (Self.decisionJSON(ClaudePrompt.decision(c["input"]?.stringValue ?? "", kind: "permission")), c["permission"] ?? .null) }
    let labels = ["Use Redis", "Postgres", "Keep it in memory for now"]
    each(cases, "decisionFrom(question)") { c in (Self.decisionJSON(ClaudePrompt.decision(c["input"]?.stringValue ?? "", kind: "question", choiceLabels: labels)), c["question"] ?? .null) }
    each(try fixture()["questions"]?.arrayValue ?? [], "decisionFrom(cards)") { q in
      (Self.decisionJSON(ClaudePrompt.decision(q["text"]?.stringValue ?? "", kind: "question", choiceLabels: (q["labels"]?.arrayValue ?? []).compactMap(\.stringValue))), q["out"] ?? .null)
    }
  }

  func testQuoteSafeWindowTextAndPolicy() throws {
    each(cases, "quoteSafe") { c in (.string(QuoteSafe.text(c["input"]?.stringValue, max: 60)), c["quoteSafe"] ?? .null) }
    let verdict = { (v: WindowPolicy.Verdict) -> JSONValue in
      var o: [String: JSONValue] = ["ok": .bool(v.ok)]
      if let r = v.reason { o["reason"] = .string(r) }
      if let s = v.say { o["say"] = .string(s) }
      return .object(o)
    }
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../parity/oracle/fixtures/policy.json").standardizedFileURL
    guard let policy = (try? Data(contentsOf: url)).flatMap({ try? JSONValue.parse($0) }) else { throw XCTSkip("no policy oracle fixture (node parity/oracle/gen.mjs on a Mac)") }
    each(policy["windowTexts"]?.arrayValue ?? [], "windowText") { c in (.string(WindowPolicy.windowText(c["input"]?.stringValue, max: 80)), c["output"] ?? .null) }
    each(policy["cases"]?.arrayValue ?? [], "readable/actable") { p in
      let w = p["win"] ?? .null
      let win = WindowPolicy.Window(hwnd: w["hwnd"]?.intValue ?? 0, kind: w["kind"]?.stringValue, exe: w["exe"]?.stringValue, title: w["title"]?.stringValue, cls: w["cls"]?.stringValue, bundle: w["bundle"]?.stringValue, elevated: w["elevated"]?.boolValue ?? false)
      return (["readable": verdict(WindowPolicy.readable(win)), "actable": verdict(WindowPolicy.actable(win))], ["readable": p["readable"] ?? .null, "actable": p["actable"] ?? .null])
    }
    each(try fixture()["joins"]?.arrayValue ?? [], "joinTranscripts") { j in (.string(Transcripts.join((j["input"]?.arrayValue ?? []).compactMap(\.stringValue))), j["output"] ?? .null) }
    each(try fixture()["switchOutcomes"]?.arrayValue ?? [], "switchOutcome") { o in
      (JSONValue(any: Switching.outcome(o["input"]?.objectValue?.mapValues(\.any), name: "Discord")), o["output"] ?? .null)
    }
  }

  func testOfferBooks() throws {
    each(try fixture()["offers"]?.arrayValue ?? [], "offer book") { script in
      let steps = script.arrayValue ?? []
      let clock = Locked(0.0)
      let book = Offers.Book(now: { clock.get() })
      var got: JSONValue = .null
      var want: JSONValue = .null
      for s in steps {
        if let line = s["spoken"]?.stringValue {
          book.noteSpoken(line, at: s["at"]?.doubleValue)
        } else if let answer = s["answer"]?.stringValue {
          let replies = s["replies"]?.intValue ?? 0
          let a = book.accepted(answer: answer, at: s["at"]?.doubleValue ?? 0) { _ in replies }
          got = a.map { ["text": .string($0.text), "at": .number($0.at), "send": .bool($0.send)] } ?? .null
          want = s["out"] ?? .null
        }
      }
      return (got, want)
    }
  }

  func testContinuityScripts() throws {
    each(try fixture()["continuity"]?.arrayValue ?? [], "continuity") { script in
      let clock = Locked(0.0)
      let c = Continuity(now: { clock.get() })
      var got: [JSONValue] = []
      var want: [JSONValue] = []
      var lastDue: [Continuity.Result] = []
      for step in script.arrayValue ?? [] {
        clock.set(step["at"]?.doubleValue ?? 0)
        let a = step["args"] ?? .null
        switch step["op"]?.stringValue {
        case "recordCall":
          let ex = (a["exchanges"]?.arrayValue ?? []).map { Continuity.Exchange(who: $0["who"]?.stringValue ?? "", text: $0["text"]?.stringValue ?? "", at: $0["at"]?.doubleValue ?? .nan) }
          c.recordCall(exchanges: ex, sessionTitle: a["sessionTitle"]?.stringValue, draftText: a["draftText"]?.stringValue, draftsMade: a["draftsMade"]?.intValue ?? 0)
        case "awaitPrompt":
          c.awaitPrompt(text: a["text"]?.stringValue, sessionTitle: a["sessionTitle"]?.stringValue, sessionId: a["sessionId"]?.stringValue)
        case "matchFinished":
          let r = c.matchFinished(id: a["id"]?.stringValue, title: a["title"]?.stringValue)
          got.append(r.map { ["text": .string($0.text ?? ""), "sessionTitle": $0.sessionTitle.map { .string($0) } ?? .null, "sessionId": $0.sessionId.map { .string($0) } ?? .null] } ?? .null)
          want.append(step["out"] ?? .null)
        case "noteText":
          got.append(.string(c.noteText()))
          want.append(step["out"] ?? .null)
        case "dueResults":
          lastDue = c.dueResults()
          got.append(.array(lastDue.map { $0.text.map { .string($0) } ?? .null }))
          want.append(step["out"] ?? .null)
        case "markSpoken":
          c.markSpoken(lastDue)
        case "unsentDraft":
          got.append(c.unsentDraft().map { .string($0) } ?? .null)
          want.append(step["out"] ?? .null)
        default: break
        }
      }
      return (.array(got), .array(want))
    }
  }
}

final class JSRegExpTests: XCTestCase {
  func testJavaScriptMeanings() {
    XCTAssertTrue(JSRegExp(#"\bcaf\b"#).test("café"), "é is not a word character in JS: a boundary after f")
    XCTAssertFalse(JSRegExp(#"\bfé"#).test("café"), "nor one before f")
    XCTAssertFalse(JSRegExp(#"a$"#).test("a\n"), "$ is the end of input only")
    XCTAssertTrue(JSRegExp(#"a$"#, "m").test("a\nb"))
    XCTAssertTrue(JSRegExp(#"^.$"#).test("\u{0B}"), ". takes a vertical tab in JS")
    XCTAssertFalse(JSRegExp(#"^.$"#).test("\n"))
    XCTAssertTrue(JSRegExp(#"^\s$"#).test("\u{FEFF}"))
    XCTAssertFalse(JSRegExp(#"^\s$"#).test("\u{85}"), "NEL is not JS whitespace")
    XCTAssertTrue(JSRegExp(#"[[]"#).test("["), "a literal [ inside a class")
    XCTAssertTrue(JSRegExp(#"a{"#).test("a{"), "a literal brace")
    XCTAssertTrue(JSRegExp(#"^a{2}$"#).test("aa"))
    XCTAssertTrue(JSRegExp(#"^\u{1F600}$"#, "u").test("😀"))
    XCTAssertTrue(JSRegExp(#"^[^]$"#).test("\n"))
    XCTAssertFalse(JSRegExp(#"[]"#).test("x"))
  }

  func testReplaceTemplatesAndFunctions() {
    XCTAssertEqual(JSRegExp(#"(\w+) (\w+)"#).replace("john smith", "$2, $1 ($&) $$ $3"), "smith, john (john smith) $ $3")
    XCTAssertEqual(JSRegExp("o", "g").replace("foo boo", "0"), "f00 b00")
    XCTAssertEqual(JSRegExp("o").replace("foo", "0"), "f0o", "without g: the first only")
    XCTAssertEqual(JSRegExp("b").replace("abc", "[$`|$']"), "a[a|c]c")
    XCTAssertEqual(JSRegExp(#"(?<y>\d{4})"#).replace("in 2026!", "<$<y>>"), "in <2026>!")
    XCTAssertEqual(JSRegExp(#"\d"#, "g").replace("a1b2") { String(Int($0.text)! * 2) }, "a2b4")
  }

  func testSplitAsJavaScriptDoes() {
    XCTAssertEqual(JSRegExp(#"\s+"#).split(" a  b "), ["", "a", "b", ""])
    XCTAssertEqual(JSRegExp(#"(,)"#).split("a,b"), ["a", ",", "b"])
    XCTAssertEqual(JSRegExp("").split("abc"), ["a", "b", "c"])
    XCTAssertEqual(JSRegExp("x").split(""), [""])
    XCTAssertEqual(JSRegExp("").split(""), [])
  }

  func testStringHelpers() {
    XCTAssertEqual(JS.trim("\u{FEFF} a \u{3000}"), "a")
    XCTAssertEqual(JS.slice("abcdef", 1, -1), "bcde")
    XCTAssertEqual(JS.length("😀"), 2)
  }
}
