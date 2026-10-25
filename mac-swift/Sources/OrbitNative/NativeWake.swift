// "Hey Orbit" in the app (phase 2, step 2): OrbitWake's recognizer on the app's own microphone stream
// (AudioIO's wake listener: the real mic, or the fake one in tests), in place of the web wake page.
// The model is the one the core ships (resources/models), unpacked once into the profile's cache.
import Foundation
import OrbitKit
import OrbitVoice
import OrbitWake

@MainActor
final class NativeWake: WakeListening {
  var onWake: () -> Void = {}
  private let audio: AudioIO
  private let archive: URL
  private let cache: URL
  private let log: (String) -> Void
  private var recognizer: NativeWakeRecognizer?
  private var active = false
  private var loading = false
  private let queue = DispatchQueue(label: "orbit.wake")

  init(audio: AudioIO, archive: URL, cache: URL, log: @escaping (String) -> Void) {
    self.audio = audio
    self.archive = archive
    self.cache = cache
    self.log = log
  }

  var listening: Bool { active && recognizer != nil }

  func setActive(_ on: Bool) {
    guard on != active else { return }
    active = on
    if on { start() } else { stop() }
  }

  private func start() {
    if let r = recognizer { return listen(r) }
    guard !loading else { return }
    loading = true
    let (archive, cache) = (self.archive, self.cache)
    queue.async { [weak self] in
      let r: NativeWakeRecognizer? = {
        do { return try NativeWakeRecognizer(modelDir: try WakeModel.unpacked(archive: archive, cache: cache)) } catch { return nil }
      }()
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self else { return }
          self.loading = false
          guard let r else { return self.log("Hey Orbit: the wake-word model could not be loaded") }
          self.recognizer = r
          self.log("Hey Orbit: listening on this Mac (Vosk, native)")
          if self.active { self.listen(r) }
        }
      }
    }
  }

  private func listen(_ r: NativeWakeRecognizer) {
    r.reset()
    let ok = audio.startWakeListening { [weak self] pcm in
      self?.queue.async {
        guard r.accept(pcm) else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { if self?.active == true { self?.onWake() } } }
      }
    }
    if !ok { log("Hey Orbit: the microphone isn't available (not allowed yet?)") }
  }

  private func stop() { audio.stopWakeListening() }
}
