// Local speech (phase 2): the bridge's events on their way to VoiceSession when the app speaks the
// words itself (`/voice?speech=local`). The core sends each piece to say as an empty audio delta with
// `text`; this relay has it spoken (the app's Kitten) and hands the session the same delta with the
// audio filled in, so VoiceSession works exactly as with audio from the core.
//
// Order: in the core's own engine a reply's audio delta comes once its speech is made, and the reply's
// end (response.done etc.) only after all of it (src/claude-voice.js finishTurn awaits the speech).
// So here a reply's later events wait behind speech still being made, while everything about the
// user's side (speech started, transcripts) and the bridge's own events go straight through, as they
// do in the core. A cancel (talked over, hung up) drops the speech still being made and lets what
// was waiting through at once.
import Foundation

public final class LocalSpeechRelay {
  /** Make 24 kHz speech for `text`; call back (on any thread) with the samples. */
  public typealias Speak = (_ text: String, _ sid: Int, _ speed: Double, _ done: @escaping ([Float]) -> Void) -> Void

  private struct Item { var text: String?; let waitsForSpeech: Bool }
  private var queue: [Item] = []
  private var generation = 0
  private let speak: Speak
  private let deliver: (String) -> Void
  private let lock = NSLock()
  /** Pieces spoken here, and their total audio (for logs and tests). */
  public private(set) var spoken = 0
  public private(set) var spokenSamples = 0

  public init(speak: @escaping Speak, deliver: @escaping (String) -> Void) {
    self.speak = speak
    self.deliver = deliver
  }

  /** One message from the socket. */
  public func receive(_ text: String) {
    guard let v = try? JSONValue.parse(text), let type = v["type"]?.stringValue else { return pass(text) }
    if (type == "response.output_audio.delta" || type == "response.audio.delta"), v["delta"]?.stringValue == "", let say = v["text"]?.stringValue, !say.isEmpty {
      let sid = v.at(path: "voice.sid")?.intValue ?? 0
      let speed = v.at(path: "voice.speed")?.doubleValue ?? 1
      let (index, gen) = lock.withLock { () -> (Int, Int) in
        queue.append(Item(text: nil, waitsForSpeech: true))
        return (queue.count - 1, generation)
      }
      _ = index
      speak(say, sid, speed) { [weak self] samples in self?.spokenDone(v, samples, gen) }
      return
    }
    if type.hasPrefix("response.") {
      let waiting = lock.withLock { () -> Bool in
        if queue.isEmpty { return false }
        queue.append(Item(text: text, waitsForSpeech: false))
        return true
      }
      if !waiting { deliver(text) }
      return
    }
    pass(text)
  }

  private func pass(_ text: String) { deliver(text) }

  private func spokenDone(_ v: JSONValue, _ samples: [Float], _ gen: Int) {
    var obj = v.objectValue ?? [:]
    obj["delta"] = .string(VoiceAudio.base64(VoiceAudio.pcm16(float: samples)))
    obj["text"] = nil
    obj["voice"] = nil
    let filled = JSONValue.object(obj).text
    let ready: [String] = lock.withLock {
      guard gen == generation, let i = queue.firstIndex(where: { $0.waitsForSpeech && $0.text == nil }) else { return [] }
      queue[i].text = filled
      spoken += 1
      spokenSamples += samples.count
      return drainLocked()
    }
    ready.forEach(deliver)
  }

  /** Delivers from the head while ready (under the lock); returns what to deliver. */
  private func drainLocked() -> [String] {
    var out: [String] = []
    while let first = queue.first, let t = first.text {
      out.append(t)
      queue.removeFirst()
    }
    return out
  }

  /** Talked over or hung up: speech still being made is dropped; what waited behind it goes now. */
  public func cancel() {
    let ready: [String] = lock.withLock {
      generation += 1
      queue.removeAll { $0.waitsForSpeech && $0.text == nil }
      return drainLocked()
    }
    ready.forEach(deliver)
  }

  /** Is anything still being spoken or waiting? */
  public var busy: Bool { lock.withLock { !queue.isEmpty } }
}

/**
 * What the voice controller needs from on-device speech (OrbitSpeech's LocalSpeechListener and
 * LocalSpeaker in the app): hear turns in the mic audio it would otherwise send, and say words.
 */
public protocol LocalSpeechEngine: AnyObject {
  /** The user started talking. */
  var onStarted: (@Sendable () -> Void)? { get set }
  /** A turn's words, how long ago the speech ended (ms), and the speech to text used. */
  var onHeard: (@Sendable (String, Int, String) -> Void)? { get set }
  /** Mic audio as the session would send it (24 kHz mono). */
  func feed(_ samples24k: [Float])
  /** Drop what's buffered (input_audio_buffer.clear). */
  func reset()
  /** Say `text` (24 kHz out), in order. */
  func say(_ text: String, sid: Int, speed: Double, done: @escaping ([Float]) -> Void)
  /** Talked over: drop what's still to be said. */
  func cancelSpeaking()
}
