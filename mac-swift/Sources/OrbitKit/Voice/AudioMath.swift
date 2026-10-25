// Audio math with no audio device: PCM16 <-> base64, levels, and how Orbit's voice comes out of the
// speakers (ui/src/playback.js: its volume, the release at the end of a reply, and when talking over
// the very end of a reply lets it finish). The audio engine (OrbitNative/AudioIO) only moves samples.
import Foundation

public enum VoiceAudio {
  /** The realtime API's rate: mono PCM16 at 24 kHz, both ways. */
  public static let rate = 24000.0
  /** Mic audio goes out in ~100 ms chunks (ui/public/pcm-worklet.js). */
  public static let chunkSamples = 2400

  // MARK: PCM16 <-> base64 (little-endian, as Int16Array over the bytes in the page)

  public static func base64(_ pcm: [Int16]) -> String {
    pcm.withUnsafeBufferPointer { p in
      var d = Data(capacity: p.count * 2)
      for s in p { let u = UInt16(bitPattern: s.littleEndian); d.append(UInt8(u & 0xff)); d.append(UInt8(u >> 8)) }
      return d.base64EncodedString()
    }
  }

  /** Base64 PCM16 to samples. An odd last byte is dropped (bytes.length >> 1); bad base64 is no audio. */
  public static func pcm16(base64 b64: String) -> [Int16] {
    guard let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { return [] }
    let n = d.count >> 1
    var out = [Int16](repeating: 0, count: n)
    d.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let b = raw.bindMemory(to: UInt8.self)
      for i in 0..<n { out[i] = Int16(bitPattern: UInt16(b[2 * i]) | (UInt16(b[2 * i + 1]) << 8)) }
    }
    return out
  }

  /** Float (-1..1) to PCM16 exactly as the capture worklet does: clamped, s * 0x8000 below zero, s * 0x7fff above. */
  public static func pcm16(float samples: [Float]) -> [Int16] {
    samples.map { x in
      let s = max(-1, min(1, x.isNaN ? 0 : x))
      return Int16(s < 0 ? s * 0x8000 : s * 0x7fff)
    }
  }

  /** PCM16 to Float as playback does: s / 0x8000. */
  public static func float(pcm16 pcm: [Int16]) -> [Float] { pcm.map { Float($0) / 0x8000 } }

  /** Several channels to one: their average. */
  public static func downmix(_ channels: [[Float]]) -> [Float] {
    guard let first = channels.first else { return [] }
    if channels.count == 1 { return first }
    let n = channels.map(\.count).min() ?? 0
    var out = [Float](repeating: 0, count: n)
    let k = 1 / Float(channels.count)
    for ch in channels { for i in 0..<n { out[i] += ch[i] * k } }
    return out
  }

  // MARK: levels

  /** RMS of a mic chunk as the page computes it: sqrt(mean((s / 0x8000)^2)). */
  public static func rms(_ pcm: [Int16]) -> Double {
    guard !pcm.isEmpty else { return 0 }
    var sum = 0.0
    for s in pcm { let v = Double(s) / 0x8000; sum += v * v }
    return (sum / Double(pcm.count)).squareRoot()
  }

  public static func rms(_ x: [Float]) -> Double {
    guard !x.isEmpty else { return 0 }
    var sum = 0.0
    for s in x { sum += Double(s) * Double(s) }
    return (sum / Double(x.count)).squareRoot()
  }

  /** Peak absolute sample (the bridge logs the loudest mic sample this way). */
  public static func peak(_ pcm: [Int16]) -> Int { pcm.reduce(0) { max($0, abs(Int($1))) } }

  // MARK: playback.js

  /** Settings → Voice → Volume (0–1) when nothing is saved: a little under full scale, which is loud in earbuds. */
  public static let defaultVolume = 0.75

  /** The gain for a volume setting: squared, so the slider feels even (half way is about -12 dB). */
  public static func volumeGain(_ v: Double?) -> Double {
    let x = (v.map { $0.isFinite } ?? false) ? min(1, max(0, v!)) : defaultVolume
    return x * x
  }

  /** The chimes keep their level relative to the voice: as before at the default volume. */
  public static func chimeLevel(_ v: Double?, base: Double = 0.12) -> Double {
    min(0.2, base * (volumeGain(v) / volumeGain(defaultVolume)))
  }

  public static let releaseMs = 120.0
  static let quiet = 0.01 // about -40 dBFS: below this the audio has already ended by itself

  /**
   * A natural release for audio that ends abruptly (the last 10 ms still sounding): the waveform
   * mirrored at its end (so it carries on from the very last sample, no jump) under a falling
   * exponential, -48 dB after `ms`. Played right after the audio, so it only ever adds to the end.
   * nil when the audio already ends in quiet.
   */
  public static func releaseTail(_ pcm: [Int16], rate: Double = rate, ms: Double = releaseMs) -> [Float]? {
    releaseTail(pcm.map { Float($0) / 0x8000 }, rate: rate, ms: ms)
  }

  public static func releaseTail(_ x: [Float], rate: Double = rate, ms: Double = releaseMs) -> [Float]? {
    guard !x.isEmpty else { return nil }
    let w = min(x.count, Int((rate / 100).rounded()))
    var sum = 0.0
    for i in (x.count - w)..<x.count { sum += Double(x[i]) * Double(x[i]) }
    if (sum / Double(w)).squareRoot() < quiet { return nil }
    let n = Int((rate * ms / 1000).rounded())
    let k = log(250.0) / Double(n)
    let len = x.count
    var out = [Float](repeating: 0, count: n)
    for t in 0..<n {
      // Mirror back and forth across what there is (a short chunk is mirrored again at its start).
      let p = t % (2 * len)
      let i = p < len ? len - 1 - p : p - len
      out[t] = Float(Double(x[i]) * exp(-k * Double(t)))
    }
    return out
  }

  /** Talking over a reply's last moments is the user answering it, not stopping it. */
  public static let finishWithinS = 0.8

  /**
   * The user started talking while Orbit's voice plays: let what's left play out instead of cutting
   * it? Only once the whole reply has arrived and just its end is left to hear (output latency included).
   */
  public static func letItFinish(remainingS: Double, replyDone: Bool, within: Double = finishWithinS) -> Bool {
    replyDone && remainingS > 0 && remainingS <= within
  }
}

/** Collects PCM16 into fixed-size chunks (the capture worklet's 2400-sample, ~100 ms frames). */
public struct PCMChunker: Sendable {
  public let size: Int
  private var buf: [Int16] = []
  public init(size: Int = VoiceAudio.chunkSamples) { self.size = size; buf.reserveCapacity(size) }
  /** Adds samples; returns every full chunk now ready. */
  public mutating func push(_ s: [Int16]) -> [[Int16]] {
    buf.append(contentsOf: s)
    var out: [[Int16]] = []
    while buf.count >= size {
      out.append(Array(buf[0..<size]))
      buf.removeFirst(size)
    }
    return out
  }
  public mutating func reset() { buf.removeAll(keepingCapacity: true) }
}

/**
 * The orb's levels at ~20 fps (useVoice's level loop): each falls away by 0.8 per tick unless the new
 * reading is louder; shown as input x6 and output x5, capped at 1.
 */
public struct LevelMeter: Equatable, Sendable {
  public private(set) var input = 0.0
  public private(set) var output = 0.0
  public init() {}
  public mutating func tick(input i: Double, output o: Double) -> (input: Double, output: Double) {
    output = max(o, output * 0.8)
    input = max(i, input * 0.8)
    return (min(1, input * 6), min(1, output * 5))
  }
  public mutating func reset() { input = 0; output = 0 }
}
