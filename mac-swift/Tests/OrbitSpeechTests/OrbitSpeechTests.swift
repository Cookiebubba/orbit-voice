// Phase 2, step 1 checks: Orbit's speech in Swift hears and speaks exactly as the Node core does,
// with the same models (the parity clips' transcripts match word for word; Kitten's speech has the
// same length, loudness and words).
import Foundation
import XCTest
@testable import OrbitSpeech
@testable import OrbitKit

let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let modelsRoot = URL(fileURLWithPath: ProcessInfo.processInfo.environment["ORBIT_VOICE_MODELS"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("orbit-swift-dev/voice-models").path)
let clipsDir = repoRoot.appendingPathComponent("parity/out/audio")

func readWav24k(_ url: URL) throws -> [Float] {
  let d = try Data(contentsOf: url)
  return stride(from: 44, to: d.count - 1, by: 2).map { i in Float(Int16(littleEndian: d.subdata(in: i..<(i + 2)).withUnsafeBytes { $0.load(as: Int16.self) })) / 32768 }
}

func nodePath() -> String? {
  let p = ProcessInfo.processInfo.environment["ORBIT_NODE"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node/v24.18.1/bin/node").path
  return FileManager.default.isExecutableFile(atPath: p) ? p : nil
}

final class SttChunksTests: XCTestCase {
  func testShortAudioIsOnePiece() {
    XCTAssertEqual(SttChunks.split([Float](repeating: 0.1, count: 16000), maxSeconds: 8).count, 1)
    XCTAssertEqual(SttChunks.split([Float](repeating: 0.1, count: 800), maxSeconds: 8).count, 0, "under 0.1 s is dropped")
  }

  func testLongAudioIsCutAtTheQuietestPlace() {
    // 12 s of tone with silence at 6.0-6.3 s: one cut, inside the silence.
    var s = (0..<(12 * 16000)).map { Float(sin(Double($0) * 0.05)) * 0.5 }
    for i in (6 * 16000)..<(Int(6.3 * 16000)) { s[i] = 0 }
    let p = SttChunks.split(s, maxSeconds: 8)
    XCTAssertEqual(p.count, 2)
    let cut = p[0].count
    XCTAssertGreaterThanOrEqual(cut, 6 * 16000)
    XCTAssertLessThanOrEqual(cut, Int(6.3 * 16000))
    XCTAssertEqual(p[0].count + p[1].count, s.count)
  }

  func testJoinTidiesSpacing() {
    XCTAssertEqual(SttChunks.join([" hello ", "", "  world\n"]), "hello world")
  }
}

final class OrbitSpeechTests: XCTestCase {
  nonisolated(unsafe) static var speech: OrbitSpeech?
  func engine() throws -> OrbitSpeech {
    guard SpeechModelPaths(root: modelsRoot).ready(root: modelsRoot) else { throw XCTSkip("speech models not at \(modelsRoot.path)") }
    if let s = Self.speech { return s }
    let s = try OrbitSpeech(root: modelsRoot)
    Self.speech = s
    return s
  }

  func testLibraryIsTheCoresVersion() {
    XCTAssertEqual(OrbitSpeech.libraryVersion, "1.13.8")
  }

  func testMissingModelsAreReported() {
    XCTAssertThrowsError(try OrbitSpeech(root: URL(fileURLWithPath: "/nonexistent")))
  }

  /** The same clips, the same words as the Node core (and Kitten's samples equal). */
  func testMatchesTheNodeCore() throws {
    let s = try engine()
    let clips = (try? FileManager.default.contentsOfDirectory(atPath: clipsDir.path).filter { $0.hasSuffix(".wav") }.sorted()) ?? []
    guard !clips.isEmpty else { throw XCTSkip("no parity clips (npm run parity:audio)") }
    guard let node = nodePath() else { throw XCTSkip("no node") }
    let out = FileManager.default.temporaryDirectory.appendingPathComponent("speech-ref-\(UUID().uuidString).json")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [repoRoot.appendingPathComponent("mac-swift/Tests/OrbitSpeechTests/reference.mjs").path, modelsRoot.path, clipsDir.path, out.path]
    try p.run()
    p.waitUntilExit()
    XCTAssertEqual(p.terminationStatus, 0)
    let ref = try JSONValue.parse(Data(contentsOf: out))
    var same = 0
    for f in clips {
      let s24 = try readWav24k(clipsDir.appendingPathComponent(f))
      let s16 = LinearResampler(from: 24000, to: 16000).resample(s24, flush: true)
      let mine = s.transcribe(s16)
      XCTAssertEqual(mine, ref["transcripts"]?[f]?.stringValue, f)
      if mine == ref["transcripts"]?[f]?.stringValue { same += 1 }
    }
    print("transcripts identical to the Node core: \(same)/\(clips.count)")
    let phrase = ref["phrase"]?.stringValue ?? ""
    let mine = s.speak(phrase, sid: 0, speed: 1)
    let theirsData = Data(base64Encoded: ref["tts"]?.stringValue ?? "") ?? Data()
    let theirs = theirsData.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    // Kitten isn't sample-for-sample repeatable (two runs in the Node core differ too), so compare
    // what matters: the length, the loudness, and that it says the same words.
    let rms = { (x: [Float]) -> Float in sqrt(x.reduce(0) { $0 + $1 * $1 } / Float(max(1, x.count))) }
    let lenRatio = Double(mine.count) / Double(max(1, theirs.count))
    print("Kitten: \(mine.count) vs \(theirs.count) samples (x\(String(format: "%.3f", lenRatio))), rms \(rms(mine)) vs \(rms(theirs))")
    XCTAssertEqual(lenRatio, 1, accuracy: 0.06, "Kitten's length")
    XCTAssertEqual(Double(rms(mine)), Double(rms(theirs)), accuracy: Double(rms(theirs)) * 0.25, "Kitten's loudness")
    let back16 = { (x: [Float]) in LinearResampler(from: 24000, to: 16000).resample(x, flush: true) }
    let norm = { (t: String) in t.lowercased().filter { $0.isLetter || $0 == " " }.split(separator: " ").joined(separator: " ") }
    XCTAssertEqual(norm(s.transcribe(back16(mine))), norm(s.transcribe(back16(theirs))), "both say the same words")
  }

  /** The VAD finds one turn in a clip with the engine's settings (speech, then 0.45 s of quiet). */
  func testVadFindsTheTurn() throws {
    let s = try engine()
    let url = clipsDir.appendingPathComponent("draft.wav")
    guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("no parity clips") }
    let s16 = LinearResampler(from: 24000, to: 16000).resample(try readWav24k(url), flush: true)
    let vad = s.newVad()
    var segments: [[Float]] = []
    var i = 0
    while i + SpeechConfig.window <= s16.count {
      vad.accept(Array(s16[i..<(i + SpeechConfig.window)]))
      while let seg = vad.popSegment() { segments.append(seg.samples) }
      i += SpeechConfig.window
    }
    XCTAssertEqual(segments.count, 1)
    let words = s.transcribe(segments.first ?? [])
    XCTAssertTrue(words.lowercased().contains("dark mode"), words)
  }
}
