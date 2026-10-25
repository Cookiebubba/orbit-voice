// A streaming sample-rate converter: the mic's rate (44.1 / 48 kHz, or a test WAV's) to the 24 kHz
// the realtime API takes. Band-limited (windowed sinc), not decimation: dropping every other sample
// folds everything above 12 kHz back into the speech band as noise the voice detection hears.
// Chunk boundaries don't matter: feeding it in any pieces gives the same samples as all at once.
import Foundation

public final class Resampler {
  public let inRate: Double
  public let outRate: Double
  /** Input samples per output sample. */
  private let step: Double
  /** The low-pass cutoff as a fraction of the input rate (just under the lower Nyquist). */
  private let cutoff: Double
  /** Kernel half-width, in input samples. */
  private let half: Int
  /** The kernel sampled at `res` points per input sample, from 0 to `half` (it's symmetric). */
  private let table: [Double]
  private let res = 512
  private var buf: [Float]
  /** Where the next output sample sits, in input samples from buf[0]. */
  private var pos: Double

  public init(from inRate: Double, to outRate: Double, zeroCrossings: Int = 16) {
    self.inRate = inRate
    self.outRate = outRate
    step = inRate / outRate
    cutoff = 0.5 * min(1, outRate / inRate) * 0.92
    half = Int((Double(zeroCrossings) / (2 * cutoff)).rounded(.up))
    var t = [Double](repeating: 0, count: half * res + 2)
    let beta = 8.6
    let i0b = Resampler.besselI0(beta)
    for k in 0..<t.count {
      let x = Double(k) / Double(res) // input samples from the centre
      let r = x / Double(half)
      let w = r >= 1 ? 0 : Resampler.besselI0(beta * (1 - r * r).squareRoot()) / i0b // Kaiser window
      let a = 2 * cutoff * x
      let sinc = a == 0 ? 1 : sin(Double.pi * a) / (Double.pi * a)
      t[k] = 2 * cutoff * sinc * w
    }
    table = t
    // Start with silence before the first sample, so output starts with the input (no ramp-in skew).
    buf = [Float](repeating: 0, count: half)
    pos = Double(half)
  }

  public var isPassthrough: Bool { inRate == outRate }

  /** Feed input; get every output sample it completes. */
  public func process(_ input: [Float]) -> [Float] {
    if isPassthrough { return input }
    buf.append(contentsOf: input)
    var out: [Float] = []
    out.reserveCapacity(Int(Double(input.count) / step) + 2)
    let n = buf.count
    buf.withUnsafeBufferPointer { b in
      table.withUnsafeBufferPointer { tab in
        while Int(pos) + half < n {
          let c = Int(pos)
          var acc = 0.0
          var k = c - half + 1
          while k <= c + half {
            let d = abs(Double(k) - pos) * Double(res)
            let j = Int(d)
            if j + 1 < tab.count {
              let f = d - Double(j)
              acc += Double(b[k]) * (tab[j] + (tab[j + 1] - tab[j]) * f)
            }
            k += 1
          }
          out.append(Float(acc))
          pos += step
        }
      }
    }
    // Keep only what the next outputs still need.
    let drop = max(0, Int(pos) - half)
    if drop > 0 {
      buf.removeFirst(drop)
      pos -= Double(drop)
    }
    return out
  }

  public func reset() {
    buf = [Float](repeating: 0, count: half)
    pos = Double(half)
  }

  /** Modified Bessel function of the first kind, order 0 (for the Kaiser window). */
  static func besselI0(_ x: Double) -> Double {
    var sum = 1.0, term = 1.0
    let q = x * x / 4
    for k in 1..<64 {
      term *= q / Double(k * k)
      sum += term
      if term < sum * 1e-12 { break }
    }
    return sum
  }
}
