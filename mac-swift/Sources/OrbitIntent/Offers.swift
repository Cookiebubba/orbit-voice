// Orbit's own idea, drafted on the user's yes (src/offers.js, rule for rule). A draft must be the
// user's own words; the one other source accepted is a prompt Orbit itself proposed OUT LOUD and the
// user accepted, in one of their next two replies within three minutes, with a clear yes or a request
// to pass it on. Only words from that spoken reply (and the user's own) may be in the draft.
import Foundation

public enum Offers {
  public static let windowMs: Double = 3 * 60_000
  public static let maxReplies = 2
  public static let keep = 8
  public static let maxChars = 2000

  static let offers = JSRegExp(#"\b(want me to|do you want me to|would you like me to|shall i|should i|i could|i can|i'll|let me|how about i|i'd suggest|i suggest)\b"#, "i")
  static let aboutClaude = JSRegExp(#"\b(claude|prompt|send|ask|tell|have it|get it|draft)\b"#, "i")
  static let refer = JSRegExp(#"\b(send|tell|ask|give|pass|prompt|put|draft|write)\b[^.?!]*\b(that|this|it|your idea|the idea|what you (said|suggested))\b|\b(do|try) (that|this|it)\b|\b(good|great|nice) (idea|call|thought)\b"#, "i")
  static let noNeed = JSRegExp(#"^\s*(no|nah|nope)[\s,.!]+(that'?s|it'?s|that is|it is)\s+(okay|ok|fine|alright|all right|good)[\s,.!]+|^\s*no (worries|need)[\s,.!]+"#, "i")
  static let hasWord = JSRegExp(#"[\p{L}\p{N}]"#, "u")
  static let changeWords = JSRegExp(#"\b(instead|change|but|except|don'?t|not)\b"#, "i")
  static let sendWord = JSRegExp(#"\b(send|submit)\b"#, "i")

  public struct Acceptance: Equatable, Sendable {
    public var accepts: Bool
    /** It also said to send it now. */
    public var send: Bool
  }

  /** acceptsOffer(): does this reply accept an offer? */
  public static func accepts(_ words: String) -> Acceptance {
    let stripped = noNeed.test(words) ? noNeed.replace(words, "") : words
    if !hasWord.test(stripped) { return Acceptance(accepts: false, send: false) }
    let c = Consent.of(stripped)
    if c.yes { return Acceptance(accepts: true, send: c.why == "send") }
    if ["negation", "question", "empty"].contains(c.why) { return Acceptance(accepts: false, send: false) }
    // A change ("tell Claude that") that only points back at the offer is still accepting it.
    if refer.test(stripped) && !changeWords.test(stripped) { return Acceptance(accepts: true, send: sendWord.test(stripped)) }
    return Acceptance(accepts: false, send: false)
  }

  public static func isOffer(_ text: String) -> Bool { offers.test(text) && aboutClaude.test(text) }

  /** What Orbit said aloud in this call, for offers (createOfferBook). */
  public final class Book: @unchecked Sendable {
    public struct Spoken: Equatable, Sendable {
      public var text: String
      public var at: Double
    }
    public struct Accepted: Equatable, Sendable {
      public var text: String
      public var at: Double
      public var send: Bool
    }
    private let lock = NSLock()
    private var spoken: [Spoken] = []
    private let now: () -> Double

    public init(now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) { self.now = now }

    /** Orbit finished saying this (its own audio transcript). */
    public func noteSpoken(_ text: String, at: Double? = nil) {
      let t = JS.trim(text)
      guard hasWord.test(t) else { return }
      let at = at ?? now()
      lock.withLock {
        spoken.append(Spoken(text: JS.slice(t, 0, maxChars), at: at))
        while spoken.count > keep { spoken.removeFirst() }
      }
    }

    /**
     * The spoken proposal the user's words accept: { text, at, send } or nil. `repliesSince(at)`:
     * how many times the user spoke after `at`.
     */
    public func accepted(answer: String, at answerAt: Double, repliesSince: (Double) -> Int = { _ in 0 }) -> Accepted? {
      guard !answer.isEmpty, answerAt.isFinite else { return nil }
      let acc = Offers.accepts(answer)
      guard acc.accepts else { return nil }
      let recent = lock.withLock { spoken }.filter { $0.at < answerAt && answerAt - $0.at <= windowMs && repliesSince($0.at) <= maxReplies }
      guard !recent.isEmpty else { return nil }
      if !recent.contains(where: { isOffer($0.text) }) && !refer.test(answer) { return nil }
      return Accepted(text: recent.map(\.text).joined(separator: " "), at: recent[0].at, send: acc.send)
    }

    public var size: Int { lock.withLock { spoken.count } }
  }
}
