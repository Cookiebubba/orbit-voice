// Local speech (phase 2, step 1): the app's listener hears exactly what the core's own audio path
// hears, on the same clips fed the same way (100 ms chunks): the same turns, the same words, and the
// same "stopped talking this long ago".
import Foundation
import XCTest
@testable import OrbitSpeech
@testable import OrbitKit

final class LocalSpeechTests: XCTestCase {
  func testListenerMatchesTheCoresAudioPath() throws {
    guard SpeechModelPaths(root: modelsRoot).ready(root: modelsRoot) else { throw XCTSkip("no speech models") }
    let clips = (try? FileManager.default.contentsOfDirectory(atPath: clipsDir.path).filter { $0.hasSuffix(".wav") }.sorted()) ?? []
    guard !clips.isEmpty, let node = nodePath() else { throw XCTSkip("no clips or node") }
    let out = FileManager.default.temporaryDirectory.appendingPathComponent("engine-ref-\(UUID().uuidString).json")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [repoRoot.appendingPathComponent("mac-swift/Tests/OrbitSpeechTests/engine-reference.mjs").path, modelsRoot.path, clipsDir.path, out.path]
    try p.run()
    p.waitUntilExit()
    XCTAssertEqual(p.terminationStatus, 0)
    let ref = try JSONValue.parse(Data(contentsOf: out))
    let speech = try OrbitSpeech(root: modelsRoot)
    var same = 0
    for f in clips {
      let samples = try readWav24k(clipsDir.appendingPathComponent(f))
      let listener = LocalSpeechListener(speech: speech)
      let started = Locked(0)
      let heard = Locked<[(String, Int)]>([])
      listener.onStarted = { started.update { $0 += 1 } }
      listener.onHeard = { text, ms, _ in heard.update { $0.append((text, ms)) } }
      var i = 0
      while i < samples.count {
        listener.feed(Array(samples[i..<min(samples.count, i + 2400)]))
        i += 2400
      }
      listener.drain()
      let r = ref[f]
      XCTAssertEqual(started.get(), r?["started"]?.intValue, "\(f): turns started")
      let mine = heard.get().map(\.0)
      let theirs = r?["transcripts"]?.arrayValue?.compactMap(\.stringValue) ?? []
      XCTAssertEqual(mine, theirs, "\(f): words")
      let theirMs = r?["endedMsAgo"]?.arrayValue?.compactMap(\.intValue) ?? []
      for (a, b) in zip(heard.get().map(\.1), theirMs) { XCTAssertEqual(Double(a), Double(b), accuracy: 40, "\(f): ended ms ago") }
      if mine == theirs { same += 1 }
    }
    print("local listener vs the core's audio path: \(same)/\(clips.count) clips heard identically")
  }

  func testSpeakerSaysInOrderAndCancelDropsTheRest() throws {
    guard SpeechModelPaths(root: modelsRoot).ready(root: modelsRoot) else { throw XCTSkip("no speech models") }
    let speaker = LocalSpeaker(speech: try OrbitSpeech(root: modelsRoot))
    let got = Locked<[Int]>([])
    let done = expectation(description: "two said")
    done.expectedFulfillmentCount = 2
    speaker.say("One.", sid: 0, speed: 1) { s in got.update { $0.append(s.count > 0 ? 1 : -1) }; done.fulfill() }
    speaker.say("Two.", sid: 0, speed: 1) { s in got.update { $0.append(s.count > 0 ? 2 : -2) }; done.fulfill() }
    wait(for: [done], timeout: 20)
    XCTAssertEqual(got.get(), [1, 2])
    // Cancelled before it's made: never handed over.
    let never = expectation(description: "cancelled")
    never.isInverted = true
    speaker.say("A long sentence that should never be heard because it was talked over.", sid: 0, speed: 1) { _ in never.fulfill() }
    speaker.cancel()
    wait(for: [never], timeout: 3)
  }
}
