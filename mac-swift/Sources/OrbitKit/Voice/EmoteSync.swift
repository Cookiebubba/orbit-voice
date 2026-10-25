// Emotes on time (ui/src/emote-sync.js, ported line for line): each cue the voice writes (<happy>
// before "Done!") fires when the audio of the words after it starts playing, not when the text arrives.
//
// Two ways a cue comes in:
//   - On an audio chunk (Claude voice): the cue fires exactly when that chunk starts playing
//     (offset "end" = when it ends, for a cue with no words after it).
//   - As a position in the reply's transcript (Grok): the bridge strips the cue and says where it was
//     (a UTF-16 offset in the clean text). The position is mapped onto the reply's audio
//     proportionally over its speech (letters and spaces one unit, punctuation a pause's worth), then
//     snapped to the nearest start of speech after a pause.
// A cue waits until there's enough to place it; barge-in or a cancel clears everything pending.
import Foundation

public final class EmoteSync {
  static let frameS = 0.01 // the loudness envelope's step
  static let pauseS = 0.08 // this much quiet before a sound makes it a start of speech
  static let snapS = 0.7 // a cue after a full stop snaps to a start of speech within this (a comma: 3/4 of it)
  static let snapNearS = 0.2 // ...mid-phrase, only forward to one this close (after a clear pause: 1.5x)
  static let defaultRate = 0.058 // seconds per weighted character, until a reply has been measured
  static let commitS = 0.3 // an estimate from the rate alone is used only this close to when it plays

  public enum Pos: Equatable, Sendable { case at(Int), end }
  public struct ChunkCue: Equatable, Sendable {
    public var name: String
    /** Seconds after the chunk starts, or nil for "end" (when the chunk ends). */
    public var offset: Double?
    public init(name: String, offset: Double? = 0) { self.name = name; self.offset = offset }
  }

  private final class Item {
    var chunks: [(at: Double, dur: Double)] = []
    var env: [Double] = []
    var envAt: Double?
    var end: Double?
    var text: [UInt16] = []
    var textDone = false
    var audioDone = false
    var cues: [(cue: String, pos: Pos)] = []
    var peak = 0.0
    var recheck: Double?
    var recheckTimer: Int?
  }

  private let now: () -> Double
  private let fire: (String) -> Void
  private let setTimer: (Double, @escaping () -> Void) -> Int
  private let clearTimer: (Int) -> Void
  private var items: [String: Item] = [:]
  private var order: [String] = []
  private var timers = Set<Int>()
  public private(set) var rate = EmoteSync.defaultRate

  /**
   * now(): the audio clock in seconds (output latency included); fire(cue): the emote, now;
   * setTimer(ms, fn) / clearTimer(id).
   */
  public init(now: @escaping () -> Double, fire: @escaping (String) -> Void, setTimer: @escaping (Double, @escaping () -> Void) -> Int, clearTimer: @escaping (Int) -> Void) {
    self.now = now
    self.fire = fire
    self.setTimer = setTimer
    self.clearTimer = clearTimer
  }

  private func item(_ id: String) -> Item {
    if let it = items[id] { return it }
    let it = Item()
    items[id] = it
    order.append(id)
    if items.count > 12 { items[order.removeFirst()] = nil }
    return it
  }

  private func schedule(_ cue: String, at: Double) {
    let ms = max(0, (at - now()) * 1000)
    var id = 0
    id = setTimer(ms) { [weak self] in
      self?.timers.remove(id)
      self?.fire(cue)
    }
    timers.insert(id)
  }

  /** Weighted length of `text` up to `n` UTF-16 units (punctuation stands for the pause it brings). */
  public static func weight(_ text: [UInt16], _ n: Int? = nil) -> Double {
    var w = 0.0
    for c in text.prefix(min(n ?? text.count, text.count)) {
      switch c {
      case 0x2E, 0x21, 0x3F: w += 3 // . ! ?
      case 0x2C, 0x3B, 0x3A, 0x2014, 0x2D: w += 4 // , ; : — -
      default: w += 1 // a letter or a space alike
      }
    }
    return w
  }

  public static func weight(_ text: String, _ n: Int? = nil) -> Double { weight(Array(text.utf16), n) }

  private func speech(_ it: Item) -> (onsets: [(t: Double, pause: Double)], first: Double?, last: Double?) {
    let th = it.peak * 0.06
    var onsets: [(t: Double, pause: Double)] = []
    var first: Double?
    var last: Double?
    var quiet = Double.infinity
    let fs = EmoteSync.frameS
    for i in 0..<it.env.count {
      let t = (it.envAt ?? 0) + Double(i) * fs
      if it.env[i] > th {
        if quiet * fs >= EmoteSync.pauseS && first != nil { onsets.append((t, min(quiet * fs, 2))) }
        if first == nil { first = t }
        last = t + fs
        quiet = 0
      } else { quiet += 1 }
    }
    return (onsets, first, last)
  }

  private enum Kind { case stop, comma, mid }

  private func snap(_ sp: (onsets: [(t: Double, pause: Double)], first: Double?, last: Double?), _ t: Double, _ kind: Kind) -> Double? {
    var best: Double?
    var bestScore = Double.infinity
    for o in sp.onsets {
      // (Mid-phrase, never back to where the phrase began: only to a pause the words come after.)
      if kind == .mid && o.t < t - 0.06 { continue }
      let reach = kind == .stop ? EmoteSync.snapS : kind == .comma ? EmoteSync.snapS * 0.75 : o.pause >= 0.15 ? EmoteSync.snapNearS * 1.5 : EmoteSync.snapNearS * 0.6
      let d = abs(o.t - t)
      if d > reach { continue }
      let score = d - (kind == .stop ? 0.8 : 0.4) * min(o.pause, 0.6)
      if score < bestScore { best = o.t; bestScore = score }
    }
    return best
  }

  private func place(_ it: Item, _ pos: Pos) -> Double? {
    guard let firstChunk = it.chunks.first else { return nil }
    let sp = speech(it)
    let start = sp.first ?? firstChunk.at
    let text = it.text
    let p: Int
    switch pos {
    case .end: p = -1
    case .at(let x): p = x
    }
    if p < 0 || (it.textDone && !hasLetterOrNumber(text.dropFirst(min(p, text.count)))) {
      // Nothing after it: when the speech ends.
      return it.audioDone ? (sp.last ?? it.end) : nil
    }
    if !hasLetterOrNumber(text.prefix(p)) { return start } // before the first word
    let kindAt = { (i: Int) -> Kind in
      var b = Array(text.prefix(i))
      while let l = b.last, isJSSpace(l) { b.removeLast() }
      guard let l = b.last else { return .mid }
      if l == 0x2E || l == 0x21 || l == 0x3F { return .stop }
      if l == 0x2C || l == 0x3B || l == 0x3A || l == 0x2014 { return .comma }
      return .mid
    }
    if !(it.textDone && it.audioDone && sp.last != nil) {
      // Not all here yet: an estimate from the speaking rate, used only when those words are about
      // to play (otherwise it waits for the rest, which nearly always comes long before).
      let t = start + EmoteSync.weight(text, p) * rate
      if t - now() > EmoteSync.commitS || (t > (it.end ?? 0) - 0.05 && !it.audioDone) {
        it.recheck = min(it.recheck ?? .infinity, t - EmoteSync.commitS)
        return nil
      }
      return snap(sp, t, kindAt(p)) ?? t
    }
    // The words' share of the reply, over its speech, snapped to where speech starts again.
    let t = start + (EmoteSync.weight(text, p) / max(1, EmoteSync.weight(text))) * (sp.last! - start)
    return snap(sp, t, kindAt(p)) ?? t
  }

  private func settle(_ id: String) {
    guard let it = items[id] else { return }
    it.recheck = nil
    it.cues = it.cues.filter { c in
      guard let at = place(it, c.pos) else { return true }
      schedule(c.cue, at: at)
      return false
    }
    if !it.cues.isEmpty, let recheck = it.recheck, it.recheckTimer == nil {
      // Look again when the estimate is about to play (if nothing more has come by then).
      var tid = 0
      tid = setTimer(max(10, (recheck - now()) * 1000)) { [weak self, weak it] in
        self?.timers.remove(tid)
        it?.recheckTimer = nil
        self?.settle(id)
      }
      it.recheckTimer = tid
      timers.insert(tid)
    }
    if it.textDone && it.audioDone {
      let sp = speech(it)
      let w = EmoteSync.weight(it.text)
      if let f = sp.first, let l = sp.last, l - f > 0.6, w > 10 { rate = rate * 0.5 + ((l - f) / w) * 0.5 }
    }
  }

  /**
   * Audio for item `id` was scheduled at `at` (clock seconds) for `dur` seconds. `samples` (24 kHz,
   * -1..1) give its loudness envelope; `cue` is an emote that starts with this chunk (Claude voice).
   */
  public func audio(_ id: String, at: Double, dur: Double, samples: [Float]?, cue: ChunkCue?) {
    let it = item(id)
    it.chunks.append((at, dur))
    if let cue, !cue.name.isEmpty {
      schedule(cue.name, at: cue.offset == nil ? at + dur : at + cue.offset!)
    }
    if let samples, !samples.isEmpty {
      if it.envAt == nil { it.envAt = at }
      let per = Int(jsRound(Double(samples.count) / max(1, dur / EmoteSync.frameS)))
      // Frames line up with the clock (a gap between chunks is quiet frames).
      let first = Int(jsRound((at - it.envAt!) / EmoteSync.frameS))
      while it.env.count < first { it.env.append(0) }
      if per > 0 {
        var i = 0
        while i + per <= samples.count {
          var s = 0.0
          for k in 0..<per { let x = Double(samples[i + k]); s += x * x }
          let v = (s / Double(per)).squareRoot()
          it.env.append(v)
          if v > it.peak { it.peak = v }
          i += per
        }
      }
    }
    it.end = max(it.end ?? 0, at + dur)
    settle(id)
  }

  /** More of item `id`'s (clean) transcript. */
  public func text(_ id: String, _ delta: String) {
    item(id).text.append(contentsOf: delta.utf16)
    settle(id)
  }

  /** Item `id`'s whole transcript (clean), when it's done. */
  public func textDone(_ id: String, _ transcript: String? = nil) {
    let it = item(id)
    if let t = transcript, t.utf16.count >= it.text.count { it.text = Array(t.utf16) }
    it.textDone = true
    settle(id)
  }

  /** All of item `id`'s audio has come. */
  public func audioDone(_ id: String) {
    guard let it = items[id] else { return }
    it.audioDone = true
    settle(id)
  }

  /** A cue at UTF-16 position `pos` of item `id`'s clean transcript (Grok). */
  public func cue(_ id: String, _ name: String, _ pos: Pos) {
    let it = item(id)
    if case .at(let p) = pos { it.cues.append((name, .at(max(0, p)))) } else { it.cues.append((name, .end)) }
    settle(id)
  }

  /** Barge-in, a cancel, a hang-up: nothing pending fires. */
  public func clear() {
    for id in timers { clearTimer(id) }
    timers.removeAll()
    items.removeAll()
    order.removeAll()
  }

  public var pending: Int { timers.count + items.values.reduce(0) { $0 + $1.cues.count } }
}

/** Math.round: halves go up. */
func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

/** JS's \s for one UTF-16 unit. */
func isJSSpace(_ c: UInt16) -> Bool {
  switch c {
  case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
  default: return false
  }
}

/** /[\p{L}\p{N}]/u on UTF-16 units. */
func hasLetterOrNumber<S: Sequence>(_ units: S) -> Bool where S.Element == UInt16 {
  String(decoding: Array(units), as: UTF16.self).unicodeScalars.contains { isLetterOrNumber($0) }
}

func isLetterOrNumber(_ s: Unicode.Scalar) -> Bool {
  switch s.properties.generalCategory {
  case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
       .decimalNumber, .letterNumber, .otherNumber: return true
  default: return false
  }
}

/** /[\p{L}\p{N}]/u on a string. */
public func hasLetterOrNumber(_ s: String) -> Bool { s.unicodeScalars.contains { isLetterOrNumber($0) } }
