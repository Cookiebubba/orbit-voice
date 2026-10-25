// "Hey Orbit" in Swift (phase 2, step 2): the same offline recognizer as the Electron build's wake
// page (ui/src/wake.ts: Vosk, the small en-us 0.15 model Orbit ships, the same grammar of wake words
// and decoys, the same wake pattern and 2 s debounce), run natively with Vosk's C library instead of
// its WebAssembly build. Audio is the app's own microphone stream (or the fake one in tests).
import Foundation
import VoskC

public enum WakeGrammar {
  /** ui/src/wake.ts GRAMMAR, word for word: the wake words, stand-ins for "Grok", decoys, [unk]. */
  public static let phrases = [
    "hey orbit", "okay orbit",
    "hey rock", "hey brock", "okay rock", "okay brock",
    // decoys
    "hey brooke", "hey brook", "hey rob", "hey bob", "hey rocky", "hey robert",
    "hey rabbit", "hey hobbit", "in orbit", "the orbit", "an orbit", "hey order", "hey abbott",
    "hey army", "hey robbie", "hey ruby", "hey arbor", "hey harbor", "hey barbie",
    "[unk]",
  ]
  public static let debounceMs = 2000.0

  /** ui/src/wake.ts WAKE: /\b(hey|okay) (orbit|rock|brock)\b/ */
  public static func isWake(_ text: String) -> Bool {
    text.range(of: #"\b(hey|okay) (orbit|rock|brock)\b"#, options: .regularExpression) != nil
  }

  public static var json: String {
    String(decoding: (try? JSONSerialization.data(withJSONObject: phrases)) ?? Data("[]".utf8), as: UTF8.self)
  }
}

/** The Vosk model Orbit ships (the tar.gz in resources/models), unpacked once into a cache folder. */
public enum WakeModel {
  public static let file = "vosk-model-small-en-us-0.15.tar.gz"

  /** The unpacked model's folder (the one with conf/model.conf), unpacking it first if needed. */
  public static func unpacked(archive: URL, cache: URL) throws -> URL {
    let fm = FileManager.default
    let dest = cache.appendingPathComponent("vosk-model")
    if let found = find(in: dest) { return found }
    try? fm.removeItem(at: dest)
    try fm.createDirectory(at: dest, withIntermediateDirectories: true)
    let tar = Process()
    tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
    tar.arguments = ["-xzf", archive.path, "-C", dest.path]
    try tar.run()
    tar.waitUntilExit()
    guard tar.terminationStatus == 0, let found = find(in: dest) else { throw WakeError.badModel }
    return found
  }

  static func find(in dir: URL) -> URL? {
    let fm = FileManager.default
    if fm.fileExists(atPath: dir.appendingPathComponent("conf/model.conf").path) || fm.fileExists(atPath: dir.appendingPathComponent("am/final.mdl").path) { return dir }
    for sub in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where sub.hasDirectoryPath {
      if let f = find(in: sub) { return f }
    }
    return nil
  }
}

public enum WakeError: Error { case badModel, noRecognizer }

/** One recognizer over one audio stream: feed PCM16, get told when someone says "Hey Orbit". */
public final class NativeWakeRecognizer: @unchecked Sendable {
  private let model: OpaquePointer
  private var rec: OpaquePointer?
  private let rate: Float
  private var lastWake = -Double.infinity
  private let lock = NSLock()
  public var now: () -> Double = { Date().timeIntervalSince1970 * 1000 }
  /** The words of the last final result (tests and logs only; never stored). */
  public private(set) var lastText = ""

  public init(modelDir: URL, sampleRate: Double = 24_000) throws {
    vosk_set_log_level(-1)
    guard let m = vosk_model_new(modelDir.path) else { throw WakeError.badModel }
    model = m
    rate = Float(sampleRate)
    rec = vosk_recognizer_new_grm(model, rate, WakeGrammar.json)
    guard rec != nil else { throw WakeError.noRecognizer }
  }

  deinit {
    if let rec { vosk_recognizer_free(rec) }
    vosk_model_free(model)
  }

  /** Feed audio; true when this chunk finished an utterance that was a wake word (debounced). */
  @discardableResult public func accept(_ pcm: [Int16]) -> Bool {
    lock.withLock {
      guard let rec, !pcm.isEmpty else { return false }
      let final = pcm.withUnsafeBufferPointer { vosk_recognizer_accept_waveform_s(rec, $0.baseAddress, Int32($0.count)) }
      guard final == 1, let c = vosk_recognizer_result(rec) else { return false }
      let text = (try? JSONSerialization.jsonObject(with: Data(String(cString: c).utf8)) as? [String: Any])?["text"] as? String ?? ""
      lastText = text
      guard WakeGrammar.isWake(text), now() - lastWake > WakeGrammar.debounceMs else { return false }
      lastWake = now()
      return true
    }
  }

  /** Start over (a new listening stretch). */
  public func reset() { lock.withLock { if let rec { vosk_recognizer_reset(rec) } } }
}
