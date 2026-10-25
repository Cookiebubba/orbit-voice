// Answering Claude when it's blocked on the user (src/claude-prompt.js, rule for rule): what the
// user's own words decide about a tool-permission prompt or one of Claude's multiple-choice
// questions. The gate on answer_claude_prompt: the voice may only press what the user said, and
// "always allow" (or "for this session") only when they say so in so many words.
import Foundation

public enum ClaudePrompt {
  static let apostrophes = JSRegExp("[\u{2019}']", "g")
  static let nonWord = JSRegExp(#"[^a-z0-9\s]"#, "g")
  static let spaces = JSRegExp(#"\s+"#, "g")

  static func norm(_ text: String) -> String {
    JS.trim(spaces.replace(nonWord.replace(apostrophes.replace(JS.lower(text), ""), " "), " "))
  }

  static let always = JSRegExp(#"\b(always|every time|everytime|from now on|permanently|for good|all the time|dont ask (me )?again|stop asking)\b"#)
  static let session = JSRegExp(#"\bfor (this|the) (session|chat|conversation|task)\b"#)
  static let deny = JSRegExp(#"\b(deny|denied|reject|decline|refuse|block|nope|no|nah|dont|do not|never|cancel|stop|not)\b"#)
  static let allow = JSRegExp(#"\b(allow|allowed|yes|yeah|yep|yup|approve|approved|accept|go ahead|do it|ok|okay|sure|let (it|him|claude)|run it|fine|permit|continue|proceed|grant|go for it|sounds good|absolutely|affirmative|please do)\b"#)
  static let generic = JSRegExp(#"^(yes|yeah|yep|yup|ok|okay|sure|fine|no|nope|nah|please|absolutely|affirmative|do it|go ahead|go for it|sounds good)( (please|then|thanks|thank you))?$"#)
  static let question = JSRegExp(#"^(should|shall|is|are|was|does|do (i|we)|what|whats|why|how|when|where|which|who|whos)\b"#)
  static let ordinals: [(JSRegExp, Int)] = [
    (JSRegExp(#"\b(first|1st)\b"#), 1), (JSRegExp(#"\b(second|2nd)\b"#), 2), (JSRegExp(#"\b(third|3rd)\b"#), 3),
    (JSRegExp(#"\b(fourth|4th)\b"#), 4), (JSRegExp(#"\b(fifth|5th)\b"#), 5), (JSRegExp(#"\b(sixth|6th)\b"#), 6),
  ]
  static let numbers = ["one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "a": 1, "b": 2, "c": 3, "d": 4]
  static let stop: Set<String> = Set("the a an and or to of for with it its this that one option choice number go use pick choose want lets let say answer them do is be".split(separator: " ").map(String.init))
  static let last = JSRegExp(#"\b(last|final|bottom)\b( one| option)?\b"#)
  static let named = JSRegExp(#"\b(?:option|number|choice|answer)\s+(one|two|three|four|five|six|[1-6]|[a-d])\b"#, "g")
  static let bare = JSRegExp(#"^(?:the )?(one|two|three|four|five|six|[1-6])(?: please)?$"#)
  static let skip = JSRegExp(#"\bskip\b"#)
  static let dontAskAgain = JSRegExp(#"\b(dont ask (me )?again|stop asking)\b"#, "g")
  static let negatedAllow = JSRegExp(#"\b(dont|do not|never|not)\s+(allow|approve|accept|let|run)\b"#, "g")

  /** Which option the words point at: 1-based, the last one's number, -1 for several, or nil. */
  static func optionFrom(_ w: String, _ count: Int) -> Int? {
    if last.test(w) { return count }
    // (Every word these patterns can catch is in `numbers`.)
    var hits = Set<Int>()
    for (re, n) in ordinals where re.test(w) { hits.insert(n) }
    for m in named.allMatches(w) { if let n = numbers[m[1] ?? ""] { hits.insert(n) } }
    if let b = bare.firstMatch(w), let n = numbers[b[1] ?? ""] { hits.insert(n) }
    return hits.count == 1 ? hits.first : hits.count > 1 ? -1 : nil
  }

  /** Which option's own words (its label) the user said: 1-based, -1 if more than one, or nil. */
  static func labelFrom(_ w: String, _ labels: [String]) -> Int? {
    let said = Set(w.split(separator: " ", omittingEmptySubsequences: false).map(String.init))
    let scores: [Double] = labels.map { label in
      let words = norm(label).split(separator: " ", omittingEmptySubsequences: false).map(String.init).filter { !$0.isEmpty }
      let strong = words.filter { ($0.utf16.count >= 3 || words.count == 1) && !stop.contains($0) }
      if strong.isEmpty { return 0 }
      let hit = strong.filter { said.contains($0) }.count
      // A one-word label must be said as that word; longer ones by most of their words.
      return hit > 0 && Double(hit) >= (Double(strong.count) / 2).rounded(.up) ? Double(hit) / Double(strong.count) : 0
    }
    let best = max(0, scores.max() ?? 0)
    if best == 0 { return nil }
    let at = scores.enumerated().filter { $0.element == best }.map { $0.offset + 1 }
    return at.count == 1 ? at[0] : -1
  }

  public struct Decision: Equatable, Sendable {
    /** allow_once, allow_session, allow_always, deny, option, skip */
    public var choice: String
    public var option: Int?
    /** Only a plain yes or no. */
    public var generic: Bool
  }

  /**
   * decisionFrom(): what the user's own words decide about `prompt` (kind "question" with choices'
   * labels, or a permission prompt), or nil if they don't say (or say both).
   */
  public static func decision(_ text: String, kind: String, choiceLabels: [String] = []) -> Decision? {
    let w = norm(text)
    if w.isEmpty { return nil }
    // "Should I allow it?" asks you; "can you allow it" asks you to.
    if question.test(w) { return nil }
    let isGeneric = generic.test(w)
    if kind == "question" {
      let byNumber = optionFrom(w, choiceLabels.count)
      let byLabel = labelFrom(w, choiceLabels)
      if byNumber == -1 || byLabel == -1 { return nil }
      if let a = byNumber, let b = byLabel, a != 0, b != 0, a != b { return nil }
      let n = (byNumber.flatMap { $0 == 0 ? nil : $0 }) ?? byLabel
      if let n, n >= 1, n <= choiceLabels.count { return Decision(choice: "option", option: n, generic: false) }
      if skip.test(w) { return Decision(choice: "skip", option: nil, generic: false) }
      return nil
    }
    let isAlways = always.test(w)
    // "Don't allow it" is a no: the allow word it negates goes.
    let rest = negatedAllow.replace(dontAskAgain.replace(w, " "), "deny")
    let no = deny.test(rest)
    let yes = allow.test(rest) || isAlways
    if no == yes { return nil }
    if no { return Decision(choice: "deny", option: nil, generic: isGeneric) }
    return Decision(choice: isAlways ? "allow_always" : session.test(w) ? "allow_session" : "allow_once", option: nil, generic: isGeneric)
  }

  /** The answer_claude_prompt tool's choices, as the voice names them, to the window's. */
  public static let choiceNames = ["allow": "allow_once", "allow_once": "allow_once", "allow_for_session": "allow_session", "allow_session": "allow_session", "always_allow": "allow_always", "allow_always": "allow_always", "deny": "deny", "option": "option", "skip": "skip"]
}
