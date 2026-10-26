// AudioIO on the real output device: what is scheduled is really heard (it leaves the voice's mixer).
// Plays a quiet tone for about a second; skipped on a Mac with no output.
import AVFoundation
@testable import OrbitKit
@testable import OrbitVoice
import XCTest

@MainActor
final class AudioIOTests: XCTestCase {
  /** Half a second of a quiet tone, in 100 ms chunks from `at`. */
  private func tone(_ io: AudioIO, from at: Double) {
    let n = Int(VoiceAudio.rate / 10)
    for k in 0..<5 {
      let s = (0..<n).map { i in Float(0.03 * sin(Double(i) * 2 * .pi * 440 / VoiceAudio.rate)) }
      io.schedule(PlaybackChunk(id: k + 1, samples: s, at: at + Double(k) * 0.1, isTail: false))
    }
  }

  private func heard(_ io: AudioIO) async throws -> Double {
    try await Task.sleep(for: .milliseconds(900))
    return io.meter.summary.audible
  }

  func testTheVoiceIsHeardAfterTheEngineRestartsAsTheMicOpens() async throws {
    let io = AudioIO(config: AudioIO.Config(voiceProcessing: false))
    io.prepareOutput()
    guard io.stateName == "running" else { throw XCTSkip("no audio output on this Mac") }
    io.logOutput()
    // A call starts the output, then the mic opening stops and starts the engine again. The voice
    // player used to come back saying it was playing, while nothing it was given ever sounded.
    io.restartEngine()
    io.meter.reset()
    tone(io, from: io.clock.audioTime + 0.03)
    let s = try await heard(io)
    XCTAssertGreaterThan(s, 0.3, "the voice was scheduled but never left the mixer")
    io.stopPlayback()
    io.callEnded()
  }
}
