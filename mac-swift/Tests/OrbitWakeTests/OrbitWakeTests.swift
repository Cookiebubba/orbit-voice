// "Hey Orbit" natively: the same model and grammar as the web wake page wake on the wake words and
// stay quiet on the decoys and on other speech (the parity clips, synthesised with Kitten).
import Foundation
import XCTest
@testable import OrbitWake

let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let clips = repoRoot.appendingPathComponent("parity/out/audio")

func pcm16(_ url: URL) throws -> [Int16] {
  let d = try Data(contentsOf: url)
  return stride(from: 44, to: d.count - 1, by: 2).map { i in Int16(littleEndian: d.subdata(in: i..<(i + 2)).withUnsafeBytes { $0.load(as: Int16.self) }) }
}

final class WakeGrammarTests: XCTestCase {
  func testThePatternIsTheWakePagesOne() {
    for t in ["hey orbit", "okay orbit", "hey rock", "okay brock", "uh hey orbit there"] { XCTAssertTrue(WakeGrammar.isWake(t), t) }
    for t in ["hey rabbit", "in orbit", "the orbit", "hey rocky", "orbit", "hey", ""] { XCTAssertFalse(WakeGrammar.isWake(t), t) }
  }

  func testTheGrammarIsWordForWordTheWakePagesOne() throws {
    let src = try String(contentsOf: repoRoot.appendingPathComponent("ui/src/wake.ts"), encoding: .utf8)
    let block = src.components(separatedBy: "const GRAMMAR = [")[1].components(separatedBy: "];")[0]
    let theirs = block.split(separator: "\n").flatMap { line -> [String] in
      let l = line.split(separator: "//")[0]
      return l.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }.filter { !$0.isEmpty }
    }
    XCTAssertEqual(WakeGrammar.phrases, theirs)
  }
}

final class NativeWakeTests: XCTestCase {
  func recognizer() throws -> NativeWakeRecognizer {
    let archive = repoRoot.appendingPathComponent("resources/models/\(WakeModel.file)")
    guard FileManager.default.fileExists(atPath: archive.path) else { throw XCTSkip("no wake model (node scripts/fetch-model.mjs)") }
    let cache = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-wake-test")
    return try NativeWakeRecognizer(modelDir: try WakeModel.unpacked(archive: archive, cache: cache))
  }

  /** Feeds a clip in 100 ms chunks (as the mic does), then a second of silence; did it wake? */
  func wakes(_ r: NativeWakeRecognizer, _ clip: String) throws -> Bool {
    let url = clips.appendingPathComponent(clip)
    guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("no clip \(clip) (npm run parity:audio)") }
    var s = try pcm16(url) + [Int16](repeating: 0, count: 24_000)
    var woke = false
    while !s.isEmpty {
      let n = min(2400, s.count)
      if r.accept(Array(s.prefix(n))) { woke = true }
      s.removeFirst(n)
    }
    return woke
  }

  func testWakesOnHeyOrbitAndNotOnDecoysOrOtherSpeech() throws {
    let r = try recognizer()
    XCTAssertTrue(try wakes(r, "wake.wav"), "Hey Orbit (heard: \(r.lastText))")
    r.now = { Date().timeIntervalSince1970 * 1000 + 10_000 } // past the debounce
    XCTAssertFalse(try wakes(r, "decoy.wav"), "Hey rabbit (heard: \(r.lastText))")
    for c in ["draft.wav", "yes.wav", "sleep.wav", "asking.wav"] { XCTAssertFalse(try wakes(r, c), "\(c) (heard: \(r.lastText))") }
  }

  func testDebounce() throws {
    let r = try recognizer()
    var t = 1_000_000.0
    r.now = { t }
    XCTAssertTrue(try wakes(r, "wake.wav"))
    t += 500
    XCTAssertFalse(try wakes(r, "wake.wav"), "within 2 s: once")
    t += 3000
    XCTAssertTrue(try wakes(r, "wake.wav"))
  }
}
