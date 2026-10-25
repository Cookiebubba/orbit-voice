// Emotes on time: test/emote.test.js's ui/src/emote-sync.js cases, ported, on a fake audio clock.
import XCTest
@testable import OrbitKit

final class EmoteSyncTests: XCTestCase {
  final class Rig {
    let c = ManualClock(startMs: 0)
    var fired: [(cue: String, t: Double)] = []
    lazy var sync = EmoteSync(now: { [c] in c.audioTime }, fire: { [unowned self] cue in self.fired.append((cue, self.c.audioTime)) },
                              setTimer: { [c] ms, fn in c.after(ms, fn) }, clearTimer: { [c] id in c.cancel(id) })
    func run(_ s: Double) { c.advance(to: s * 1000) }
  }

  func ms(_ s: Double) -> Int { Int((s * 1000).rounded()) }

  func testClaudeVoiceEachEmoteFiresAsItsChunkStartsPlaying() {
    let r = Rig()
    r.run(0.2)
    r.sync.audio("r1", at: 0.23, dur: 1.4, samples: nil, cue: nil)
    r.sync.audio("r1", at: 1.63, dur: 0.9, samples: nil, cue: .init(name: "happy"))
    r.sync.audio("r1", at: 2.53, dur: 1.1, samples: nil, cue: .init(name: "curious"))
    r.run(1.5)
    XCTAssertEqual(r.fired.count, 0, "nothing yet: the words are still queued behind the first chunk")
    r.run(5)
    XCTAssertEqual(r.fired.map { "\($0.cue)@\(ms($0.t))" }, ["happy@1630", "curious@2530"])
    // A feeling after the last words: when they end.
    r.sync.audio("r2", at: 6, dur: 1, samples: nil, cue: nil)
    r.sync.audio("r2", at: 7, dur: 0, samples: nil, cue: .init(name: "nod"))
    r.run(9)
    XCTAssertEqual(r.fired.last?.cue, "nod")
    XCTAssertEqual(r.fired.last!.t, 7, accuracy: 1e-9)
    // offset nil = "end" of its chunk.
    r.sync.audio("r3", at: 10, dur: 0.5, samples: nil, cue: .init(name: "wave", offset: nil))
    r.run(11)
    XCTAssertEqual(r.fired.last!.t, 10.5, accuracy: 1e-9)
  }

  func testBargeInOrACancelClearsEveryPendingEmote() {
    let r = Rig()
    r.sync.audio("r1", at: 0.1, dur: 2, samples: nil, cue: nil)
    r.sync.audio("r1", at: 2.1, dur: 1, samples: nil, cue: .init(name: "happy"))
    r.sync.text("r2", "Hello there. How are you?")
    r.sync.cue("r2", "sad", .at(13))
    XCTAssertGreaterThanOrEqual(r.sync.pending, 2)
    r.run(1)
    r.sync.clear()
    r.run(10)
    XCTAssertTrue(r.fired.isEmpty)
    XCTAssertEqual(r.sync.pending, 0)
  }

  /** Synthetic speech paced like Grok's: a letter 55 ms of sound, a space 40 ms, a comma 180 ms of quiet, a stop 380 ms. */
  func speak(_ text: String) -> (samples: [Float], starts: [Double], dur: Double) {
    let R = 24000.0
    var out: [Float] = []
    var starts: [Double] = []
    var t = 0.0
    var inWord = false
    func sound(_ s: Double, _ loud: Bool) {
      for _ in 0..<Int((s * R).rounded()) { out.append(loud ? Float(sin(Double(out.count) * 2 * Double.pi * 180 / R) * 0.5) : 0) }
      t += s
    }
    for ch in text {
      if ch.isLetter || ch.isNumber || ch == "'" {
        if !inWord { starts.append(t) }
        inWord = true
        sound(0.055, true)
      } else {
        inWord = false
        if ch == " " { sound(0.04, true) } else if ",;:".contains(ch) { sound(0.18, false) } else if ".!?".contains(ch) { sound(0.38, false) }
      }
    }
    return (out, starts, t)
  }

  func wordIndexAt(_ text: String, _ pos: Int) -> Int {
    let prefix = String(decoding: Array(text.utf16.prefix(pos)), as: UTF16.self)
    return prefix.split(whereSeparator: { !($0.isLetter || $0.isNumber || $0 == "'") }).count
  }

  func testGrokACueInTheTranscriptFiresWhenItsWordsPlay() {
    // src/emote-cues.js's stripCues / createCueStream output for the test's reply (see the JS test).
    let text = "All the tests passed. There is one lint warning left, in the parser. That was quick work, so we can ship."
    let cues: [(String, Int)] = [("happy", 0), ("surprised", 22), ("curious", 54), ("proud", 69), ("nod", 90)]
    let deltas: [(String, [(String, Int)])] = [
      ("All the tests passed. ", [("happy", 0)]),
      ("There is one lint warning left, in the", [("surprised", 22), ("curious", 54)]),
      (" parser. That was quick work, so we can ship.", [("proud", 69), ("nod", 90)]),
    ]
    let sp = speak(text)
    let r = Rig()
    r.run(0.6)
    for (t, cs) in deltas {
      r.sync.text("g1", t)
      for (c, at) in cs { r.sync.cue("g1", c, .at(at)) }
    }
    r.sync.textDone("g1", text)
    let startAt = 0.65
    let step = 12000
    var i = 0, k = 0
    while i < sp.samples.count {
      r.run(0.6 + Double(k) * 0.1)
      let chunk = Array(sp.samples[i..<min(sp.samples.count, i + step)])
      r.sync.audio("g1", at: startAt + Double(i) / 24000, dur: Double(chunk.count) / 24000, samples: chunk, cue: nil)
      i += step
      k += 1
    }
    r.sync.audioDone("g1")
    r.run(startAt + sp.dur + 1)
    XCTAssertEqual(r.fired.count, cues.count)
    let units = Array(text.utf16)
    for (n, (name, at)) in cues.enumerated() {
      let want = startAt + sp.starts[wordIndexAt(text, at)]
      let err = r.fired[n].t - want
      let before = String(decoding: Array(units.prefix(at)), as: UTF16.self)
      let mid = at > 0 && before.range(of: #"[.!?,;:]\s*$"#, options: .regularExpression) == nil
      XCTAssertEqual(r.fired[n].cue, name)
      XCTAssertLessThanOrEqual(abs(err), mid ? 0.17 : 0.08, "\(name)\(mid ? " (mid-phrase)" : ""): \(ms(err)) ms from its words")
    }
  }

  func testGrokRealRepliesReplayedEachEmoteWithin80msAtPhraseStarts() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/grok-emote-replies-clean.json")
    let fx = try JSONValue.parse(Data(contentsOf: url))
    var errs: [Double] = []
    for reply in fx["replies"]!.arrayValue! {
      let name = reply["name"]!.stringValue!
      let r = Rig()
      var head = 0.0
      var frame = 0
      var start: Double?
      let env = reply["envelope"]!.arrayValue!.map { $0.doubleValue ?? 0 }
      for e in reply["events"]!.arrayValue! {
        let t = e[0]!.doubleValue!, type = e[1]!.stringValue!
        r.run(t / 1000)
        switch type {
        case "text":
          r.sync.text("g", e[2]!.stringValue!)
          for q in e[3]!.arrayValue! { r.sync.cue("g", q[0]!.stringValue!, .at(q[1]!.intValue!)) }
        case "text.done":
          r.sync.textDone("g")
        case "audio":
          // The page schedules each chunk right after the last (or now, if it ran dry).
          let x = e[2]!.doubleValue!
          let at = max(head, r.c.audioTime + 0.03)
          if start == nil { start = at }
          let frames = Int(jsRound(x / 240))
          var samples = [Float](repeating: 0, count: frames * 240)
          for f in 0..<frames {
            let v = Float((frame + f < env.count ? env[frame + f] : 0) / 10000)
            for s in (f * 240)..<((f + 1) * 240) { samples[s] = v }
          }
          frame += frames
          r.sync.audio("g", at: at, dur: x / 24000, samples: samples, cue: nil)
          head = at + x / 24000
        case "done":
          r.sync.audioDone("g")
        default: break
        }
      }
      r.run(r.c.audioTime + 30)
      let words = reply["words"]!.arrayValue!.map { $0.doubleValue! }
      let midPhrase = Set(reply["midPhrase"]!.arrayValue!.map { $0.intValue! })
      XCTAssertEqual(r.fired.count, words.count, name)
      guard r.fired.count == words.count else { continue }
      for (k, w) in words.enumerated() {
        let err = r.fired[k].t - start! - w
        let mid = midPhrase.contains(k)
        errs.append(abs(err))
        XCTAssertLessThanOrEqual(abs(err), mid ? 0.17 : 0.08, "\(name) cue \(k) (\(r.fired[k].cue)\(mid ? ", mid-phrase" : "")): \(ms(err)) ms")
      }
    }
    let mean = errs.reduce(0, +) / Double(max(1, errs.count))
    XCTAssertLessThan(mean, 0.04, "mean error \(ms(mean)) ms over \(errs.count) cues")
  }

  func testTheWeightsTheTimingUses() {
    XCTAssertEqual(EmoteSync.weight("ab c"), 4)
    XCTAssertGreaterThan(EmoteSync.weight("Hi, there."), EmoteSync.weight("Hi  there "))
    XCTAssertEqual(EmoteSync.weight("a—b-c"), 11)
  }

  func testGrokWithoutTheEndOfItsAudioACueStillFiresFromTheSpeakingRate() {
    let r = Rig()
    let text = "One two three four five six seven eight nine ten eleven twelve."
    r.run(0.1)
    r.sync.text("g", text)
    r.sync.textDone("g")
    let pos = Array(text.utf16).count - Array(text[text.range(of: "seven")!.lowerBound...].utf16).count
    r.sync.cue("g", "nod", .at(pos))
    // 3 s of steady sound arrives (no audio.done, ever).
    r.sync.audio("g", at: 0.2, dur: 3, samples: [Float](repeating: 0.3, count: 72000), cue: nil)
    r.run(10)
    XCTAssertEqual(r.fired.count, 1)
    let want = 0.2 + EmoteSync.weight(text, pos) * r.sync.rate
    XCTAssertLessThan(abs(r.fired[0].t - want), 0.02, "at its estimate (\(ms(r.fired[0].t)) ms, want \(ms(want)) ms)")
  }
}
