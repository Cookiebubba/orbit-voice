// Local speech for Orbit Native's Claude voice (phase 2, step 1): the listening and speaking the core
// does in src/claude-voice.js (onMicAudio, onSegment, queueSpeech), done in the app instead, so only
// words cross the socket (`?speech=local`; the core then sends the words to say, not their audio).
// The listener is a line-for-line port of the core's audio path: the same 24 → 16 kHz resampling,
// 512-sample VAD windows, the same 0.3 s lead-in from the last 32 s, and the same chunked Moonshine.
import Foundation

/** Hears turns in the mic stream (24 kHz floats), as the core's onMicAudio/onSegment do. */
public final class LocalSpeechListener: @unchecked Sendable {
  public typealias Started = @Sendable () -> Void
  /** (transcript, ms between the end of speech and now, the speech-to-text used) */
  public typealias Heard = @Sendable (String, Int, String) -> Void

  private let speech: OrbitSpeech
  private let vad: SpeechVad
  private let resampler = LinearResampler(from: SpeechConfig.inRate, to: SpeechConfig.vadRate)
  private let queue = DispatchQueue(label: "orbit.local-speech.listen")
  private let sttQueue = DispatchQueue(label: "orbit.local-speech.stt")
  private var pending: [Float] = []
  private var fed = 0
  private var history: [(at: Int, data: [Float])] = []
  private var speaking = false
  private let preroll = Int(0.3 * Double(SpeechConfig.vadRate))
  private let keep = 32 * SpeechConfig.vadRate
  public var onStarted: Started?
  public var onHeard: Heard?

  public init(speech: OrbitSpeech) {
    self.speech = speech
    vad = speech.newVad()
  }

  /** Mic audio, 24 kHz mono floats, any chunk size. */
  public func feed(_ samples24k: [Float]) {
    queue.async { self.process(samples24k) }
  }

  /** Drop what's buffered (the call ended or was muted), as input_audio_buffer.clear does. */
  public func reset() {
    queue.async {
      self.pending = []
      self.vad.reset()
      self.fed = 0
      self.history = []
      self.speaking = false
    }
  }

  /** Waits until everything fed so far is processed (tests). */
  public func drain() { queue.sync {}; sttQueue.sync {} }

  private func process(_ s24: [Float]) {
    let f = resampler.resample(s24, flush: false)
    let all = pending + f
    var i = 0
    while i + SpeechConfig.window <= all.count {
      let win = Array(all[i..<(i + SpeechConfig.window)])
      history.append((fed, win))
      fed += SpeechConfig.window
      while let first = history.first, first.at < fed - keep { history.removeFirst() }
      vad.accept(win)
      if vad.speaking && !speaking {
        speaking = true
        onStarted?()
      }
      while let seg = vad.popSegment() {
        let start = seg.start
        let end = start + seg.samples.count
        let withLeadIn = start >= 0 && end <= fed ? slice(max(0, start - preroll), end) : seg.samples
        let endedMsAgo = Int(Double(fed - end) / Double(SpeechConfig.vadRate) * 1000)
        speaking = false
        let sp = speech
        let heard = onHeard
        sttQueue.async {
          let text = sp.transcribe(withLeadIn)
          heard?(text, endedMsAgo, "moonshine")
        }
      }
      i += SpeechConfig.window
    }
    pending = Array(all[i...])
  }

  private func slice(_ from: Int, _ to: Int) -> [Float] {
    var out = [Float](repeating: 0, count: max(0, to - from))
    for w in history {
      let a = max(from, w.at), b = min(to, w.at + w.data.count)
      if a < b { for k in a..<b { out[k - from] = w.data[k - w.at] } }
    }
    return out
  }
}

/** Says the core's words with Kitten, in order, off the main thread. */
public final class LocalSpeaker: @unchecked Sendable {
  private let speech: OrbitSpeech
  private let queue = DispatchQueue(label: "orbit.local-speech.speak")
  private var generation = 0
  private let lock = NSLock()

  public init(speech: OrbitSpeech) { self.speech = speech }

  /** Synthesizes `text` (24 kHz) and hands it over in order; a cancel drops what's queued. */
  public func say(_ text: String, sid: Int, speed: Float, done: @escaping @Sendable ([Float]) -> Void) {
    let g = lock.withLock { generation }
    queue.async {
      guard self.lock.withLock({ self.generation }) == g else { return }
      let samples = self.speech.speak(text, sid: sid, speed: speed)
      guard self.lock.withLock({ self.generation }) == g else { return }
      done(samples)
    }
  }

  /** Talked over: nothing still queued is said. */
  public func cancel() { lock.withLock { generation += 1 } }
}
