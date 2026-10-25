// "Send it" in the same breath (src/send-intent.js, rule for rule): did the user's own request also
// tell Orbit to send the prompt? Deterministic on purpose: the send happens only when the user's own
// words say so; anything unclear is a no (Orbit then asks).
//
//   "tell Claude to fix the tests and send it"  -> yes: draft "Fix the tests." and send it at once
//   "tell it to fix the nav, don't send it yet" -> no
//   "tell Claude to write a function that says send it" -> no: those words are the prompt's
import Foundation

public enum SendIntent {
  public struct Instruction: Equatable, Sendable {
    public var send: Bool
    /** The request without the send instruction (what the prompt is made from). */
    public var rest: String
  }

  static let curlySingle = JSRegExp("[\u{2018}\u{2019}`]", "g")
  static let curlyDouble = JSRegExp("[\u{201C}\u{201D}]", "g")
  static let spaces = JSRegExp(#"\s+"#, "g")

  /** Normalized for matching: curly quotes straight, spacing collapsed. */
  static func norm(_ s: String) -> String {
    JS.trim(spaces.replace(curlyDouble.replace(curlySingle.replace(JS.nfkc(s), "'"), "\""), " "))
  }

  static let obj = #"(?:it|that|this|that one|this one|the (?:prompt|message|draft))"#
  static let after = #"(?:\s+(?:over|off|through|along))?(?:\s+to (?:claude|him))?(?:\s+(?:now|right now|right away|straight away|immediately|asap))?(?:\s+(?:please|for me|thanks|thank you))?"#
  static let verb = #"(?:(?:send|sent|submit)(?:\s+\#(obj))?|fire\s+\#(obj)(?:\s+off)?)"#
  static let leadWord = #"(?:and|then|and then|so|just|please|go ahead and|go ahead,?|you can|feel free to|don'?t ask(?: me)?,?|no need to (?:ask|confirm),?|without asking,?)"#
  static let tail = JSRegExp(#"(^|[\s,.;:!—–-]+)((?:\#(leadWord)\s+)*\#(verb)\#(after))[\s.!]*$"#, "i")
  static let contentVerb = JSRegExp(#"\b(?:print|log|echo|say|says|said|saying|show|shows|display|output|type|write|return|returns|called|named|labell?ed|titled|reads|text|word|words|phrase|label|button)\s*["']?$"#, "i")
  static let content = JSRegExp(#"\b(?:says?|saying|said|reads?|called|named|labell?ed|titled|text|words?|phrase|button|label)\s+["']?(?:just\s+)?(?:send|sent|submit)\b"#, "i")
  static let toSomeone = JSRegExp(#"\b(?:send|sent|submit)\s+(?:it|that|this|them|the \w+)\s+(?:over\s+)?to\s+(?!claude\b|him\b)\w"#, "i")
  static let asking = JSRegExp(#"\b(?:should|shall|would|could|do|does|did|can|will) (?:i|we|you) (?:just )?(?:send|submit)\b|\b(?:want|like) me to (?:just )?(?:send|submit)\b|\b(?:send|submit)\b[^.!]*\?\s*$"#, "i")
  static let head = JSRegExp(#"^(?:(?:ok(?:ay)?|alright|so|hey orbit|orbit)[,\s]+)?(?:please\s+|just\s+|go ahead and\s+)?(?:send|submit)\s+(?:(?:to\s+)?claude|(?:this|the following|a (?:prompt|message))(?:\s+to\s+claude)?|claude (?:this|a (?:prompt|message)))\s*(?::|,|-|—|saying\b|that says\b)\s*(?=\S)"#, "i")
  static let noAsk = JSRegExp(#"(?:^|[\s,.;:—–-]+)(?:(?:don'?t|do not) (?:ask|check with) me(?: first)?|no need to (?:ask|confirm|check)|without (?:asking|confirming|checking))[\s,.;:!—–-]*$"#, "i")
  static let replyOnly = JSRegExp(#"^(?:(?:ok|okay|alright|all right|yes|yeah|yep|yup|sure|cool|great|perfect|good|fine|right|um+|uh+|so|well|now|and|then|please|go|go ahead|do it|looks good|that's good|that's fine)[\s,.!]*)*$"#, "i")
  static let hasWord = JSRegExp(#"[\p{L}\p{N}]"#, "u")
  static let itThatThis = JSRegExp(#"^(?:it|that|this)\b"#, "i")
  static let leadAtStart = JSRegExp("^\(leadWord)\\b", "i")
  static let breakChar = JSRegExp(#"[,.;:!—–-]"#)
  static let negatedBefore = JSRegExp(#"\b(?:don'?t|do not|never|not|no need to|but)\s*(?:just\s+)?$"#, "i")
  static let dontAskMe = JSRegExp(#"\b(?:don'?t ask(?: me)?)\b"#, "gi")
  static let negatedVerb = JSRegExp(#"\b(?:don'?t|do not|never)\b"#, "i")
  static let claudeSends = JSRegExp(#"\b(?:tell|ask|have|get|make|let)\s+(?:claude|it|him)(?:\s+to)?\s*$"#, "i")
  static let trailingPunct = JSRegExp(#"[\s,;:—–-]+$"#)
  static let trailingJoin = JSRegExp(#"\s+(?:and|then|and then|so|but)$"#, "i")
  static let trailingJoinNoBut = JSRegExp(#"\s+(?:and|then|and then|so)$"#, "i")
  static let endSpaceDots = JSRegExp(#"[\s.!]+$"#)
  static let endsSentence = JSRegExp(#"[.!?]$"#)

  /** sendInstruction(): do these words tell Orbit to send the prompt they ask for, now? */
  public static func instruction(_ words: String) -> Instruction {
    let original = norm(words)
    if original.isEmpty { return Instruction(send: false, rest: "") }
    let no = Instruction(send: false, rest: original)
    if let h = head.firstMatch(original) {
      let rest = JS.trim(JS.slice(original, h.length))
      return !rest.isEmpty && !itThatThis.test(rest) && !replyOnly.test(rest) ? Instruction(send: true, rest: rest) : no
    }
    let s = noAsk.replace(original, "")
    guard let m = tail.firstMatch(s) else { return no }
    let before = JS.trim(JS.slice(s, 0, m.index))
    // Nothing (or only "okay") before it: a reply about a draft already made, not a request.
    if !hasWord.test(before) || replyOnly.test(before) { return no }
    if asking.test(original) || content.test(original) || toSomeone.test(original) { return no }
    // "don't send it", "not yet, send it later": a negation right before the send words.
    if negatedBefore.test(before) || negatedVerb.test(dontAskMe.replace(m[2] ?? "", "")) { return no }
    // No break before it ("print send it"): the words of the work.
    if !breakChar.test(m[1] ?? "") && !leadAtStart.test(m[2] ?? "") && contentVerb.test(before) { return no }
    // "...tell Claude to send it": Claude is the one sending, so it's the work.
    if claudeSends.test(before) { return no }
    return Instruction(send: true, rest: JS.trim(trailingJoin.replace(trailingPunct.replace(before, ""), "")))
  }

  /** withoutSendTail(): a draft made from words with a send instruction, that instruction taken off its end. */
  public static func withoutSendTail(_ text: String) -> String {
    var t = text
    // "..., don't ask me." left at the end on its own is for Orbit too.
    let trimmedEnd = endSpaceDots.replace(t, "")
    let noAskGone = noAsk.replace(trimmedEnd, "")
    if noAskGone != trimmedEnd && hasWord.test(noAskGone) { t = endsSentence.test(noAskGone) ? noAskGone : noAskGone + "." }
    let trimmed = endSpaceDots.replace(t, "")
    let bare = noAsk.replace(trimmed, "")
    guard let m = tail.firstMatch(bare), !content.test(bare) else { return t }
    let raw = JS.slice(bare, 0, m.index)
    if !breakChar.test(m[1] ?? "") && !leadAtStart.test(m[2] ?? "") && contentVerb.test(raw) { return t }
    let before = JS.trim(trailingJoinNoBut.replace(trailingPunct.replace(raw, ""), ""))
    if !hasWord.test(before) || replyOnly.test(before) { return t }
    return endsSentence.test(before) ? before : before + "."
  }
}
