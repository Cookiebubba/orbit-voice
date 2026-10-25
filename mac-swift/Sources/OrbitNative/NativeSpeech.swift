// Phase 2, step 1 in the app: Claude voice's listening and speaking on this Mac in Swift
// (OrbitSpeech: the same models in the profile's claude-voice-models, the same settings as the core).
// Used when the call is Claude voice and the models are there; otherwise the core does it as before.
// A test build can pick with ORBIT_SPEECH=core|local (default local).
import Foundation
import OrbitKit
import OrbitSpeech

final class NativeLocalSpeech: LocalSpeechEngine, @unchecked Sendable {
  var onStarted: (@Sendable () -> Void)? {
    get { listener.onStarted }
    set { listener.onStarted = newValue }
  }
  var onHeard: (@Sendable (String, Int, String) -> Void)? {
    get { listener.onHeard }
    set { listener.onHeard = newValue }
  }
  private let speech: OrbitSpeech
  private var listener: LocalSpeechListener
  private let speaker: LocalSpeaker

  init(speech: OrbitSpeech) {
    self.speech = speech
    listener = LocalSpeechListener(speech: speech)
    speaker = LocalSpeaker(speech: speech)
  }

  /** The profile's speech models, if they're downloaded and verified. */
  static func load(profile: URL, log: (String) -> Void) -> NativeLocalSpeech? {
    let root = profile.appendingPathComponent("claude-voice-models")
    guard SpeechModelPaths(root: root).ready(root: root) else { return nil }
    do {
      let s = NativeLocalSpeech(speech: try OrbitSpeech(root: root))
      log("on-device speech in Swift ready (sherpa-onnx \(OrbitSpeech.libraryVersion))")
      return s
    } catch {
      log("on-device speech in Swift unavailable: \(error)")
      return nil
    }
  }

  func feed(_ samples24k: [Float]) { listener.feed(samples24k) }

  func reset() {
    // A fresh listener (and VAD) per call, like the core's per-connection engine.
    let started = listener.onStarted, heard = listener.onHeard
    listener = LocalSpeechListener(speech: speech)
    listener.onStarted = started
    listener.onHeard = heard
  }

  func say(_ text: String, sid: Int, speed: Double, done: @escaping ([Float]) -> Void) {
    nonisolated(unsafe) let handOver = done // (called once, from the speaker's own queue)
    speaker.say(text, sid: sid, speed: Float(speed)) { samples in handOver(samples) }
  }

  func cancelSpeaking() { speaker.cancel() }
}
