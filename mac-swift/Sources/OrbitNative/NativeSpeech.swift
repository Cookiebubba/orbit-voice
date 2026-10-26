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

  /**
   * The profile's speech models, if they're downloaded and verified, warmed up: one short sentence
   * is spoken (and thrown away) first, since the voice's first sentence is much slower than the rest
   * (its runtime sets itself up then), and a call's first words shouldn't wait on that.
   */
  static func load(profile: URL, log: @escaping @Sendable (String) -> Void) -> NativeLocalSpeech? {
    let root = profile.appendingPathComponent("claude-voice-models")
    guard SpeechModelPaths(root: root).ready(root: root) else { return nil }
    do {
      let t0 = Date()
      let speech = try OrbitSpeech(root: root)
      let loaded = Date()
      _ = speech.speak("Okay.", sid: 0, speed: 1)
      let ms = { (a: Date, b: Date) in Int((b.timeIntervalSince(a) * 1000).rounded()) }
      log("on-device speech in Swift ready (sherpa-onnx \(OrbitSpeech.libraryVersion)): models loaded in \(ms(t0, loaded)) ms, voice warmed up in \(ms(loaded, Date())) ms")
      let s = NativeLocalSpeech(speech: speech)
      s.log = log
      return s
    } catch {
      log("on-device speech in Swift unavailable: \(error)")
      return nil
    }
  }

  // One call's speaking, for the log as it ends: how long each piece took to make (from asking to
  // samples, so waiting behind the one before counts too), and how many were dropped by a talk-over.
  var log: @Sendable (String) -> Void = { _ in }
  private let stats = Locked<(asked: Int, made: Int, firstMs: Int?, slowestMs: Int, totalMs: Int, dropped: Int)>((0, 0, nil, 0, 0, 0))

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
    let asked = Date()
    let stats = self.stats
    stats.update { $0.asked += 1 }
    speaker.say(text, sid: sid, speed: Float(speed)) { samples in
      let ms = Int((Date().timeIntervalSince(asked) * 1000).rounded())
      stats.update { s in
        s.made += 1
        if s.firstMs == nil { s.firstMs = ms }
        s.slowestMs = max(s.slowestMs, ms)
        s.totalMs += ms
      }
      handOver(samples)
    }
  }

  func cancelSpeaking() {
    // (What was asked for and not made yet is dropped.)
    stats.update { s in
      s.dropped += max(0, s.asked - s.made - s.dropped)
    }
    speaker.cancel()
  }

  func callEnded() {
    let s = stats.update { s -> (asked: Int, made: Int, firstMs: Int?, slowestMs: Int, totalMs: Int, dropped: Int) in
      defer { s = (0, 0, nil, 0, 0, 0) }
      return s
    }
    guard s.asked > 0 else { return }
    let avg = s.made > 0 ? s.totalMs / s.made : 0
    log("speech this call: \(s.made) of \(s.asked) piece(s) made, first in \(s.firstMs.map { "\($0) ms" } ?? "–"), \(avg) ms on average, slowest \(s.slowestMs) ms\(s.dropped > 0 ? ", \(s.dropped) dropped when talked over" : "")")
  }
}

/**
 * Claude voice's preview in Settings (the engine's POST /api/claude-voice/preview): the profile's
 * models, loaded on the first preview and let go after two quiet minutes.
 */
final class PreviewSpeech: @unchecked Sendable {
  private let root: URL
  private let lock = NSLock()
  private var speech: OrbitSpeech?
  private var generation = 0

  init(profile: URL) { root = profile.appendingPathComponent("claude-voice-models") }

  func speak(_ text: String, sid: Int, speed: Double) async throws -> [Float] {
    try await Task.detached(priority: .userInitiated) { [self] in
      let s: OrbitSpeech = try lock.withLock {
        if let speech { return speech }
        let s = try OrbitSpeech(root: root)
        speech = s
        return s
      }
      let samples = s.speak(text, sid: sid, speed: Float(speed))
      let gen = lock.withLock { generation += 1; return generation }
      DispatchQueue.global().asyncAfter(deadline: .now() + 120) { [weak self] in
        guard let self else { return }
        self.lock.withLock { if self.generation == gen { self.speech = nil } }
      }
      return samples
    }.value
  }
}

extension AppDelegate {
  func previewSpeaker(profile: URL) -> @Sendable (String, Int, Double) async throws -> [Float] {
    let p = PreviewSpeech(profile: profile)
    return { text, sid, speed in try await p.speak(text, sid: sid, speed: speed) }
  }
}
