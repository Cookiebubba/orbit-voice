// Is the user's reply a yes? (src/consent.js, rule for rule: its patterns are copied as they are and
// run with JavaScript's meaning by JSRegExp; the oracle fixtures hold the two to the same answers.)
//
// Consent = the user's latest reply, said right after Orbit asked (the callers check the timing), is
// affirmative and doesn't negate, hesitate, ask something or change the request. A send instruction
// ("send it", "press send") is enough on its own; an affirmation ("yeah", "looks good") is enough
// when the rest is only a few words. See consent.js for the full design notes.
import Foundation

public enum Consent {
  public struct Verdict: Equatable, Sendable {
    public var yes: Bool
    /** What decided it: send, affirm, or the veto: negation, change, question, empty, unclear, long. */
    public var why: String
  }

  static let mhm = JSRegExp(#"\b(mm+[- ]?h+m+|m+h+m+|uh[- ]?huh|mm[- ]?kay)\b"#, "g")
  static let nonWord = JSRegExp(#"[^a-z0-9' ]+"#, "g")
  static let strayQuote = JSRegExp(#"'(?!(s|t|re|ll|ve|d|m)\b)"#, "g")
  static let spaces = JSRegExp(#"\s+"#, "g")
  static let sent = JSRegExp(#"\b(sent|sendit|sendt|sen)\b(?= |$)"#, "g")
  static let sendIts = JSRegExp(#"\bsend (its|in it|ed)\b"#, "g")
  static let yeahs = JSRegExp(#"\b(yea|yah|yeh|ya|ye|yess+|yas|yeap|yap)\b"#, "g")
  static let okeys = JSRegExp(#"\b(okey|okie|okey dokey|okie dokie|o k|k)\b"#, "g")
  static let ok = JSRegExp(#"\bok\b"#, "g")
  static let alright = JSRegExp(#"\b(alright|all right|aight)\b"#, "g")
  static let lgtm = JSRegExp(#"\b(lgtm)\b"#, "g")
  static let mishearing = JSRegExp(#"^(cindy|sindy|sendy|send a|sending|send at|sinned it|cinda)$"#)
  static let asked = JSRegExp(#"\?\s*$"#)
  static let filler = JSRegExp(#"^(u+h*m+|u+h+|e+r+m*|a+h+|h+m+|oh|well|so|like|just|now|then|um|uh)$"#)

  /** Words of the reply, normalized; and whether it ended in a question mark. */
  static func prepare(_ text: String) -> (words: [String], line: String, asked: Bool) {
    var t = JS.trim(JS.lower(JS.nfkc(text)).replacingOccurrences(of: "\u{2018}", with: "'").replacingOccurrences(of: "\u{2019}", with: "'").replacingOccurrences(of: "`", with: "'").replacingOccurrences(of: "\u{B4}", with: "'"))
    let wasAsked = asked.test(t)
    t = mhm.replace(t, " mhm ")
    t = nonWord.replace(t, " ")
    t = strayQuote.replace(t, " ")
    t = JS.trim(spaces.replace(t, " "))
    t = sent.replace(t) { m in m.text == "sendit" ? "send it" : "send" }
    t = sendIts.replace(t, "send it")
    t = yeahs.replace(t, "yeah")
    t = okeys.replace(t, "okay")
    t = ok.replace(t, "okay")
    t = alright.replace(t, "alright")
    t = lgtm.replace(t, "looks good")
    if mishearing.test(t) { t = "send it" }
    let words = t.split(separator: " ", omittingEmptySubsequences: false).map(String.init).filter { !$0.isEmpty && !filler.test($0) }
    return (words, " \(words.joined(separator: " ")) ", wasAsked)
  }

  static let negate = JSRegExp(#" (no|nope|nah|naw|don't|dont|do not|doesn't|didn't|not|never|wait|stop|cancel|scrap|abort|hold on|hang on|hold off|hold up|one sec|one second|a sec|a second|later|maybe|perhaps|probably not|not sure|unsure|i don't know|dunno|never mind|nevermind|forget it|actually|but|although|though|except|rather|hmm|let me think|let me see|i guess|wrong|undo|throw it away|redo) "#)
  static let change = JSRegExp(#" (change|changed|instead|edit|fix|add|also|(?:delete|remove|discard)(?! (?:it|that|this|them) )|plus|another|more|less|make it|make that|shorter|longer|rewrite|reword|rephrase|replace|swap|tweak|update|correct it|first|before|after that|and then|tell it|tell claude|ask it|ask claude|include|mention|say that|type|sleep|goodnight|good night|bye|stop listening|send (?:it|that|this) to (?!claude |him )[a-z]+) "#)
  static let question = JSRegExp(#" (what|what's|whats|how|where|who|which|when|why|is it|is that|does it|did it|did you|are you|have you|should i|shall i|should we|do i|do you think|isn't|is this) "#)
  static let polite = JSRegExp(#"^(?:yeah |okay |alright |sure |so |please )*(?:can|could|would|will|wanna|want to) you (?:please |just |go ahead and |maybe )?(?:try to )?(?:send|submit|press|hit|click|push|ship|fire|go|do it)\b"#)
  static let send = JSRegExp(#" (send(?: it| that| this| that one| the prompt| the draft| the message)?(?: over| off| through| away| along| now| to claude)*|submit(?: it| that)?|ship it|fire (?:it |that )?(?:off|away)|fire away|hit send|(?:press|hit|click|push|tap)(?: on)? (?:the )?send(?: button)?|press it|hit it|push it|send button(?: and)? press(?:ed)? it|go ahead and send|you can send(?: it)?|post it) "#)
  static let affirm = JSRegExp(#" (yeah|yes|yep|yup|sure|okay|alright|cool|great|perfect|fine|good|nice|awesome|excellent|lovely|brilliant|sweet|absolutely|definitely|certainly|of course|correct|right|exactly|affirmative|indeed|mhm|please|please do|do it|do that|let's do it|let's go|go|go ahead|go for it|go on|proceed|confirm|confirmed|approved|approve|why not|sounds good|sounds great|sounds right|looks good|looks great|looks right|looks fine|that's good|that's great|that's fine|that's it|that's right|that's perfect|that works|works for me|good to go|ready|love it|nailed it|good idea|great idea|yes please|thanks|thank you|make it so|that one) "#)
  static let easy: Set<String> = Set("a an the it that this one is it's its i i'm you your we me my to for of on in and yes yeah okay please thanks thank very really totally pretty much good great looks look sounds sound go ahead now right away buddy orbit qubit claude man dude mate sir yep sure all set do did done let's lets try again button press hit click there's theres there send over off".split(separator: " ").map(String.init))
  static let whyNot = JSRegExp(" why not ", "g")

  /** consentOf(): is this reply a clear yes? */
  public static func of(_ utterance: String) -> Verdict {
    let p = prepare(utterance)
    if p.words.isEmpty { return Verdict(yes: false, why: "empty") }
    let l = whyNot.replace(p.line, " okay ")
    if negate.test(l) { return Verdict(yes: false, why: "negation") }
    let isPolite = polite.test(JS.trim(l))
    if !isPolite && (question.test(l) || (p.asked && !send.test(l))) { return Verdict(yes: false, why: "question") }
    if change.test(l) { return Verdict(yes: false, why: "change") }
    if send.test(l) || isPolite { return Verdict(yes: true, why: "send") }
    if !affirm.test(l) { return Verdict(yes: false, why: "unclear") }
    // An affirmation with a few other words ("yeah that's perfect buddy"), not a new long thought.
    let other = p.words.filter { !easy.contains($0) && !affirm.test(" \($0) ") }
    return other.count <= 3 && p.words.count <= 14 ? Verdict(yes: true, why: "affirm") : Verdict(yes: false, why: "long")
  }

  /** A spoken or typed answer that counts as consent. */
  public static func isClearYes(_ utterance: String) -> Bool { of(utterance).yes }
}
