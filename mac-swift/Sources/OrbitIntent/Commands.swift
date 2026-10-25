// The whole-utterance commands, each the core's rule for rule:
//   SleepCommand  src/sleep-command.js    "go to sleep" hangs up at once, no model turn
//   StopCommand   src/stop-command.js     "stop" for Claude: the fast path, and the gate on stop_claude
//   Presence      src/anywhere/presence.js "come here", "go away", "stop everything"
//   Switching     src/anywhere/switching.js "switch to Discord" (the words; the act is the helper's)
import Foundation

/** Words for the strict command matchers: lower case, apostrophes gone, letters only, fillers out. */
enum CommandWords {
  static let apostrophes = JSRegExp("[\u{2019}']", "g")
  static let nonLetters = JSRegExp(#"[^a-z\s]"#, "g")
  static let spaces = JSRegExp(#"\s+"#)
  static let filler = JSRegExp(#"^(?:u+h*m+|u+h+|e+r+m*|a+h+|h+m+|m{2,})$"#)

  /** text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w && !FILLER.test(w)) */
  static func split(_ text: String) -> [String] {
    let t = nonLetters.replace(apostrophes.replace(JS.lower(text), ""), " ")
    return spaces.split(t).filter { !$0.isEmpty && !filler.test($0) }
  }
}

public enum SleepCommand {
  static let phrases: Set<String> = [
    "sleep", "go to sleep", "go back to sleep", "go to bed", "time to sleep", "nap", "take a nap",
    "stop listening", "hang up", "goodnight", "good night", "night", "night night",
    "bye", "goodbye", "good bye", "bye bye", "see you", "see you later",
  ]
  static let names: Set<String> = ["orbit", "grok", "qubit", "buddy"]
  static let lead = ["hey", "okay", "ok", "alright", "all right", "right", "cool", "great", "perfect", "thanks", "thank you", "so", "and", "now", "you can", "please", "just", "go ahead and"]
  static let tail = ["thanks", "thank you", "please", "now", "for now", "then", "buddy", "orbit", "grok", "qubit", "or bit", "orb it", "a bit", "for a bit", "a little bit", "for a little bit", "for a while"]

  static func strip(_ input: [String], _ list: [String], fromEnd: Bool) -> [String] {
    var words = input
    // Longest first ("for now" before "now"); a stable sort, as JavaScript's.
    let ordered = list.enumerated().sorted { a, b in
      let la = a.element.split(separator: " ").count, lb = b.element.split(separator: " ").count
      return la != lb ? la > lb : a.offset < b.offset
    }.map(\.element)
    var again = true
    while again && !words.isEmpty {
      again = false
      if names.contains(fromEnd ? words.last! : words.first!) {
        words = fromEnd ? Array(words.dropLast()) : Array(words.dropFirst())
        again = true
        continue
      }
      for p in ordered {
        let pw = p.split(separator: " ").map(String.init)
        let at = fromEnd ? Array(words.suffix(pw.count)) : Array(words.prefix(pw.count))
        if pw.count < words.count && at == pw {
          words = fromEnd ? Array(words.dropLast(pw.count)) : Array(words.dropFirst(pw.count))
          again = true
          break
        }
      }
    }
    return words
  }

  /** isSleepCommand(): is this whole utterance only "go to sleep" (or the like)? */
  public static func matches(_ text: String) -> Bool {
    var words = CommandWords.split(text)
    if words.isEmpty || words.count > 9 { return false }
    words = strip(words, lead, fromEnd: false)
    words = strip(words, tail, fromEnd: true)
    return phrases.contains(words.joined(separator: " "))
  }
}

public enum StopCommand {
  static let phrases: Set<String> = [
    "stop", "stop it", "stop that", "stop this", "stop now", "stop claude", "claude stop", "stop him", "stop the run",
    "stop the task", "stop working", "stop everything", "stop all that", "halt", "abort", "abort it", "interrupt",
    "interrupt it", "interrupt claude", "cancel the run", "cancel that run", "cancel this run", "cancel the task",
    "cancel it claude", "stop stop", "stop stop stop",
  ]
  static let lead = ["no", "nope", "wait", "whoa", "woah", "hey", "okay", "ok", "oh", "please", "hold on", "hang on", "thats wrong", "that is wrong", "wrong", "no no", "claude", "just", "quick", "quickly", "actually"]
  static let tail = ["please", "now", "right now", "immediately", "claude", "thanks", "thank you", "already", "asap"]

  static func strip(_ input: [String], _ list: [String], fromEnd: Bool) -> [String] {
    var words = input
    var again = true
    while again && words.count > 1 {
      again = false
      for p in list {
        let pw = p.split(separator: " ").map(String.init)
        let at = fromEnd ? Array(words.suffix(pw.count)) : Array(words.prefix(pw.count))
        if pw.count < words.count && at == pw {
          words = fromEnd ? Array(words.dropLast(pw.count)) : Array(words.dropFirst(pw.count))
          again = true
          break
        }
      }
    }
    return words
  }

  /** isStopCommand(): is this whole utterance only "stop Claude" (or the like)? */
  public static func isCommand(_ text: String) -> Bool {
    var words = CommandWords.split(text)
    if words.isEmpty || words.count > 8 { return false }
    words = strip(words, lead, fromEnd: false)
    words = strip(words, tail, fromEnd: true)
    return phrases.contains(words.joined(separator: " "))
  }

  static let verb = "stop|halt|abort|interrupt|kill|cancel"
  static let nounAfter = "buttons?|signs?|words?|watch(es)?|loss(es)?|lights?|commands?|hooks?|handlers?|events?|signals?|conditions?|bits?|sequences?|tokens?|codes?|features?|options?|propagation|icons?|states?|functions?|methods?|endpoints?|screens?|menus?|keys?|shortcuts?|animations?|logic|flags?|errors?"
  static let stopRE = JSRegExp(#"\b(\#(verb))\b(?!\s+(\#(nounAfter))\b)"#, "g")
  static let forOrbit = JSRegExp(#"\b(stop|quit)\s+(listening|talking|speaking|recording|the mic|the microphone)\b"#)
  static let negated = JSRegExp(#"\b(dont|do not|never|not|no need to|shouldnt|wont|didnt|doesnt|cant|without)\b(\s+\S+){0,2}?\s+(\#(verb))\b|\bkeep (going|working)\b"#)
  static let statusQuestion = JSRegExp(#"^(did|has|is|was|were|why|when|where|how|does|do)\b"#)
  static let asksClaude = JSRegExp(#"\b((tell|ask|let|have|get|make|instruct)\s+(claude|it|him)|(say|write|type|send)\s+(to\s+)?(claude|it))\b"#)
  static let runGerund: Set<String> = ["working", "doing", "going", "running", "generating", "thinking", "everything", "that", "this", "it", "now"]
  static let cancelObjects = JSRegExp(#"\b(run|task|job|claude|work|everything|what (its|it is|hes|he is|claude is) doing)\b"#)
  static let apostrophes = JSRegExp("[\u{2019}']", "g")
  static let nonLetters = JSRegExp(#"[^a-z\s]"#, "g")
  static let spaces = JSRegExp(#"\s+"#, "g")
  static let ing = JSRegExp(#"ing$"#)

  /**
   * asksToStop(): do the user's own words ask to stop Claude's run? `hasDraft`: a draft is waiting,
   * so a bare "cancel that" is about the draft, not Claude.
   */
  public static func asksToStop(_ text: String, hasDraft: Bool = false) -> Bool {
    let w = JS.trim(spaces.replace(nonLetters.replace(apostrophes.replace(JS.lower(text), ""), " "), " "))
    if w.isEmpty || forOrbit.test(w) || negated.test(w) || statusQuestion.test(w) { return false }
    let hits = stopRE.allMatches(w)
    if hits.isEmpty { return false }
    if hits.allSatisfy({ $0[1] == "cancel" }) && (hasDraft || !cancelObjects.test(w)) { return false }
    // "Tell Claude to stop using var": a habit for Claude to drop, so a prompt.
    if asksClaude.test(w) {
      let after: (JSMatch) -> String = { h in
        let rest = JS.trim(JS.slice(w, h.index + h.length))
        return rest.split(separator: " ", omittingEmptySubsequences: false).first.map(String.init) ?? ""
      }
      if hits.allSatisfy({ ing.test(after($0)) && !runGerund.contains(after($0)) }) { return false }
    }
    return true
  }
}

public enum Presence {
  static let filler = JSRegExp(#"\b(um+|uh+|er+m*|hmm+|ah+|oh|okay|ok|hey|yo|so|well|please|now|real quick|for me|buddy|pal|little guy)\b"#, "gi")
  static let names = JSRegExp(#"\b(qubit|cubit|cubic|q bit|orbit|buddy)\b"#, "gi")
  static let come = [
    JSRegExp(#"^(can you |could you |would you )?(come|hop|jump|pop|get) (over )?(here|in here|over|in)$"#),
    JSRegExp(#"^(come|hop|jump|pop) (over )?(to|into|in) (this|my) (window|app|one)$"#),
    JSRegExp(#"^(come|hop) (over )?here$"#),
    JSRegExp(#"^follow me( here)?$"#),
    JSRegExp(#"^come with me$"#),
  ]
  // (Never a bare "go" or "you can go": those may be a yes to "Send it?".)
  static let leave = [
    JSRegExp(#"^(you can )?(go away|leave)$"#),
    JSRegExp(#"^(leave|get out of) (this|my) (window|app)$"#),
    JSRegExp(#"^go (back )?home$"#),
    JSRegExp(#"^go back to claude$"#),
  ]
  static let apostrophes = JSRegExp("[\u{2019}']", "g")
  static let nonLetters = JSRegExp(#"[^a-z\s]+"#, "g")
  static let spaces = JSRegExp(#"\s+"#, "g")
  static let refusal = JSRegExp(#"\b(don'?t|do not|never|not|stop|tell (claude|it))\b"#, "i")
  static let negation = JSRegExp(#"\b(don'?t|do not|never|not)\b"#, "i")
  static let stopEverything = JSRegExp(#"^(stop|cancel|halt|kill) (everything|it all|all (of )?(the |my )?(helpers|tasks|of them|agents)|all)$"#)

  /** normalize(): the words, with fillers, names and punctuation taken out. */
  public static func normalize(_ text: String) -> String {
    var t = apostrophes.replace(JS.lower(text), "")
    t = nonLetters.replace(t, " ")
    t = names.replace(t, " ")
    t = filler.replace(t, " ")
    return JS.trim(spaces.replace(t, " "))
  }

  /** matchPresenceCommand(): 'come_here', 'leave' (only when `away`), or nil. */
  public static func match(_ text: String, away: Bool = false) -> String? {
    if JS.length(text) > 80 || refusal.test(text) { return nil }
    let t = normalize(text)
    if t.isEmpty || t.split(separator: " ", omittingEmptySubsequences: false).count > 7 { return nil }
    if come.contains(where: { $0.test(t) }) { return "come_here" }
    if away && leave.contains(where: { $0.test(t) }) { return "leave" }
    return nil
  }

  /** isStopEverything(): "Orbit, stop everything" (and only that). */
  public static func isStopEverything(_ text: String) -> Bool {
    stopEverything.test(normalize(text)) && !negation.test(text)
  }
}

public enum Switching {
  public static let askMaxAgeMs: Double = 2 * 60_000
  public static let guardGraceMs: Double = 3000
  static let switchRE = JSRegExp(#"\b(switch|swap|flip|jump|open|pull\s+(it\s+|that\s+)?up|bring\s+(it\s+|that\s+)?up|go\s+(back\s+|over\s+)?(to|into)|take\s+me|back\s+to|change\s+(over\s+)?to|move\s+(over\s+)?to)\b"#, "i")
  static let there = JSRegExp(#"\b(take me (there|to it)|show me|go there|bring (it|that) up|switch (me )?(there|to it))\b"#, "i")
  static let negated = JSRegExp(#"\b(don'?t|do\s+not|never|not|no\s+need\s+to|stop)\b(\s+\S+){0,3}?\s+(switch|swap|flip|jump|open|pull|bring|go|take|change|move|show)\b"#, "i")

  /** asksToSwitch(): do these words ask to switch windows? */
  public static func asks(_ words: String) -> Bool {
    (switchRE.test(words) || there.test(words)) && !negated.test(words)
  }

  /** What the helper's switch answer means, in words for the voice (switchOutcome). */
  public static func outcome(_ r: [String: Any]?, name: String) -> [String: Any] {
    guard let r, !JSValue.truthy(r["error"]) else {
      return ["ok": false, "error": (r?["error"] as? String) == "no_window" ? "That window has closed." : "Orbit could not switch to \(name)."]
    }
    if JSValue.truthy(r["switched"]) { return ["ok": true, "switched": true, "how": r["how"] ?? NSNull()] }
    if (r["how"] as? String) == "flash" { return ["ok": true, "switched": false, "flashing": true, "say": "Windows wouldn't let Orbit bring \(name) forward, so its taskbar button is flashing."] }
    return ["ok": false, "error": "Windows wouldn't let Orbit bring \(name) forward."]
  }
}

/** JavaScript's truthiness for values that came from JSON. */
public enum JSValue {
  public static func truthy(_ v: Any?) -> Bool {
    switch v {
    case nil, is NSNull: return false
    case let n as NSNumber:
      if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
      return n.doubleValue != 0 && !n.doubleValue.isNaN
    case let b as Bool: return b
    case let s as String: return !s.isEmpty
    case let d as Double: return d != 0 && !d.isNaN
    case let i as Int: return i != 0
    default: return true
    }
  }
}
