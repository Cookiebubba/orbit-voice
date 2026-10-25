// Emote cues (src/emote-cues.js, rule for rule): the voice model may write a cue such as <happy> just
// before the words it belongs to; it is never spoken, shown or kept. This finds and strips cues, in
// whole text or in a stream of deltas (a cue can arrive split across them), and says where each was
// in the clean text (in UTF-16 units, as the JS counts), so the emote can fire when those words play.
import Foundation

public enum EmoteCues {
  public static let cues = ["happy", "excited", "curious", "surprised", "proud", "sad", "embarrassed", "nod", "shake", "wonder", "hop"]
  static let aliases = ["celebrate": "excited", "think": "wonder", "thinking": "wonder", "laugh": "happy", "smile": "happy", "yes": "nod", "no": "shake", "wow": "surprised"]
  static let maxHold = 22 // "<" + a 20-letter word + ">"
  static let quotes: Set<UInt16> = [34, 0x201C, 0x201D] // " “ ”

  /** cueName(): the cue a word names, or nil. */
  public static func name(_ word: String) -> String? {
    let w = JS.lower(word)
    return cues.contains(w) ? w : aliases[w]
  }

  public struct Cue: Equatable, Sendable {
    public var cue: String
    /** Offset in all the clean text so far (UTF-16 units): the first character of the words after it. */
    public var at: Int
  }

  public struct Piece: Equatable, Sendable {
    public var text: String
    public var cues: [Cue]
    public init(text: String, cues: [Cue]) {
      self.text = text
      self.cues = cues
    }
  }

  static func isLetter(_ u: UInt16) -> Bool { (65...90).contains(u) || (97...122).contains(u) }
  static func isCueWord(_ w: [UInt16]) -> Bool {
    guard let f = w.first, isLetter(f), w.count <= 20 else { return false }
    return w.dropFirst().allSatisfy { isLetter($0) || $0 == 45 }
  }

  /** createCueStream(): push(delta) -> { text, cues }; end() flushes the rest. */
  public final class Stream: @unchecked Sendable {
    private var held: [UInt16] = []
    private var out = 0
    private var inCode = false
    private var inQuote = false
    private var eatSpace = false
    private var lastOut: UInt16? = nil

    public init() {}

    /** Clean characters so far (UTF-16 units). */
    public var length: Int { out }

    func run(_ src: [UInt16], final: Bool) -> (text: [UInt16], cues: [Cue], held: [UInt16]) {
      var text: [UInt16] = []
      var cues: [Cue] = []
      func emit(_ c: UInt16) {
        if eatSpace && (c == 32 || c == 9) {
          eatSpace = false
          return
        }
        eatSpace = false
        text.append(c)
        lastOut = c
        out += 1
      }
      var i = 0
      while i < src.count {
        let c = src[i]
        if c == 96 { // `
          inCode.toggle()
          emit(c)
          i += 1
          continue
        }
        if c == 10 { inQuote = false }
        if !inCode && quotes.contains(c) { inQuote.toggle() }
        if c != 60 || inCode { // "<"
          emit(c)
          i += 1
          continue
        }
        guard let close = src[(i + 1)...].firstIndex(of: 62) else { // ">"
          let rest = Array(src[i...])
          // Could still become a cue: hold it for the next delta (or drop it at the end).
          if rest.count <= maxHold && rest.dropFirst().allSatisfy({ isLetter($0) || $0 == 45 }) {
            if !final { return (text, cues, rest) }
            if rest.count > 1 {
              i = src.count // an unfinished cue at the very end: never spoken
              continue
            }
          }
          emit(c)
          i += 1
          continue
        }
        let word = Array(src[(i + 1)..<close])
        if !isCueWord(word) {
          emit(c)
          i += 1
          continue
        }
        // A cue: gone from the text; reported unless quoted or unknown.
        if let n = name(String(utf16CodeUnits: word, count: word.count)), !inQuote { cues.append(Cue(cue: n, at: out)) }
        // (After a space, an opening quote or bracket, or at the start: the space after it goes too.)
        if let l = lastOut {
          if JSWhitespace.contains(l) || l == 40 || l == 91 || l == 123 || (quotes.contains(l) && inQuote) { eatSpace = true }
        } else {
          eatSpace = true
        }
        i = close + 1
      }
      return (text, cues, [])
    }

    public func push(_ delta: String) -> Piece {
      let r = run(held + Array(delta.utf16), final: false)
      held = r.held
      return Piece(text: String(utf16CodeUnits: r.text, count: r.text.count), cues: r.cues)
    }

    public func end() -> Piece {
      let r = run(held, final: true)
      held = []
      return Piece(text: String(utf16CodeUnits: r.text, count: r.text.count), cues: r.cues)
    }
  }

  static let trailingSpace = JSRegExp(#"[ \t]+$"#)

  /** stripCues(): every cue out of whole text. */
  public static func strip(_ text: String) -> Piece {
    let s = Stream()
    let a = s.push(text)
    let b = s.end()
    return Piece(text: trailingSpace.replace(a.text + b.text, ""), cues: a.cues + b.cues)
  }

  /** withoutCues(): just the clean text. */
  public static func without(_ text: String) -> String { strip(text).text }

  static let knownCue = JSRegExp(#"([ \t]*)<([A-Za-z][A-Za-z-]{0,19})>([ \t]*)"#, "g")

  /** withoutKnownCues(): known cues only, out of text that isn't speech (a draft for Claude's box). */
  public static func withoutKnown(_ text: String) -> String {
    let all = Array(text.utf16)
    return knownCue.replace(text) { m in
      guard name(m[2] ?? "") != nil else { return m.text }
      let lineStart = m.index == 0 || all[m.index - 1] == 10
      let lineEnd = m.index + m.length == all.count || all[m.index + m.length] == 10
      return lineStart || lineEnd ? "" : (!(m[1] ?? "").isEmpty || !(m[3] ?? "").isEmpty) ? " " : ""
    }
  }
}

/** JavaScript's \s for one UTF-16 unit. */
enum JSWhitespace {
  static func contains(_ u: UInt16) -> Bool {
    switch u {
    case 9, 10, 11, 12, 13, 32, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    case 0x2000...0x200A: return true
    default: return false
    }
  }
}
