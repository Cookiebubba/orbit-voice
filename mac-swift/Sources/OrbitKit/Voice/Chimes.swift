// Orbit's little UI chimes (ui/src/sounds.ts), made from sine notes, no audio files: rendered here
// into samples the audio engine plays. Same notes, spacing and envelope as the page's oscillators.
import Foundation

public enum Chime: String, Sendable, CaseIterable {
  case wake, sleep, done

  /** C5 → G5, G5 → C5, E5 → G5 → C6. */
  public var notes: [Double] {
    switch self {
    case .wake: return [523.25, 783.99]
    case .sleep: return [783.99, 523.25]
    case .done: return [659.25, 783.99, 1046.5]
    }
  }

  /** How long it sounds: each note starts 0.12 s after the last and stops 0.32 s after its start. */
  public var duration: Double { Double(notes.count - 1) * 0.12 + 0.32 }

  /**
   * The chime at `volume` (peak gain per note): 0 → volume in 20 ms, an exponential fall to 0.001 at
   * 280 ms, held there until the note stops at 320 ms.
   */
  public func render(volume: Double, rate: Double = 48000) -> [Float] {
    let n = Int((duration * rate).rounded(.up))
    var out = [Float](repeating: 0, count: n)
    guard volume > 0 else { return out }
    for (i, f) in notes.enumerated() {
      let start = Double(i) * 0.12
      let s0 = Int((start * rate).rounded())
      let len = Int((0.32 * rate).rounded())
      for k in 0..<len where s0 + k < n {
        let t = Double(k) / rate
        let g: Double
        if t < 0.02 { g = volume * t / 0.02 }
        else if t < 0.28 { g = volume * pow(0.001 / volume, (t - 0.02) / 0.26) }
        else { g = 0.001 }
        out[s0 + k] += Float(g * sin(2 * Double.pi * f * t))
      }
    }
    return out
  }
}
