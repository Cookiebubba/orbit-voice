// Talking to the avatar (src/avatar-commands.js, rule for rule): the catalogue of what the pixel
// buddy and Qubit can be asked to do, the `avatar` tool's definition, and the fast path that does it
// without the model when the WHOLE utterance is just an avatar command ("um, Qubit, roll left
// please"). Deliberately conservative: anything it isn't sure of goes to the model as usual.
import Foundation

public enum AvatarCommands {
  public static let minConfidence = 0.85
  public static let minWordScore = 0.8
  public static let maxWords = 10

  public struct Action: Sendable {
    public var avatars: [String]
    public var label: String
    public var dir: Bool
  }

  /** AVATAR_ACTIONS, in the JS's order. */
  public static let order = ["backflip", "frontflip", "roll", "jump", "hop", "grow", "shrink", "celebrate", "dance", "nod", "shake", "look_around", "stretch", "blink", "happy", "sad", "surprised", "curious", "wave", "trip", "kick_ball", "sit", "climb", "move", "go_home", "nap", "wake"]
  public static let actions: [String: Action] = [
    "backflip": Action(avatars: ["qubit"], label: "a backflip", dir: false),
    "frontflip": Action(avatars: ["qubit"], label: "a front flip", dir: false),
    "roll": Action(avatars: ["qubit"], label: "a roll", dir: true),
    "jump": Action(avatars: ["qubit", "buddy"], label: "a big jump", dir: false),
    "hop": Action(avatars: ["qubit", "buddy"], label: "a little hop", dir: false),
    "grow": Action(avatars: ["qubit"], label: "growing bigger for a while", dir: false),
    "shrink": Action(avatars: ["qubit"], label: "back to normal size", dir: false),
    "celebrate": Action(avatars: ["qubit", "buddy"], label: "a celebration", dir: false),
    "dance": Action(avatars: ["qubit", "buddy"], label: "a dance", dir: false),
    "nod": Action(avatars: ["qubit"], label: "a nod (yes)", dir: false),
    "shake": Action(avatars: ["qubit"], label: "a head shake (no)", dir: false),
    "look_around": Action(avatars: ["qubit", "buddy"], label: "a look around", dir: false),
    "stretch": Action(avatars: ["qubit", "buddy"], label: "a stretch", dir: false),
    "blink": Action(avatars: ["qubit"], label: "a blink", dir: false),
    "happy": Action(avatars: ["qubit"], label: "looking happy", dir: false),
    "sad": Action(avatars: ["qubit"], label: "looking sad", dir: false),
    "surprised": Action(avatars: ["qubit"], label: "looking surprised", dir: false),
    "curious": Action(avatars: ["qubit"], label: "looking curious", dir: false),
    "wave": Action(avatars: ["buddy"], label: "a wave", dir: false),
    "trip": Action(avatars: ["buddy"], label: "tripping over (on purpose)", dir: false),
    "kick_ball": Action(avatars: ["buddy"], label: "kicking a ball", dir: false),
    "sit": Action(avatars: ["buddy"], label: "sitting down for a bit", dir: false),
    "climb": Action(avatars: ["buddy"], label: "climbing onto the prompt box", dir: false),
    "move": Action(avatars: ["qubit", "buddy"], label: "moving over", dir: true),
    "go_home": Action(avatars: ["qubit", "buddy"], label: "going back to his spot", dir: false),
    "nap": Action(avatars: ["qubit", "buddy"], label: "a short nap (the call stays on)", dir: false),
    "wake": Action(avatars: ["qubit", "buddy"], label: "waking up from a nap", dir: false),
  ]
  public static let names = ["qubit": "Qubit", "buddy": "Buddy"]

  public static func actionsFor(_ kind: String) -> [String] { order.filter { actions[$0]!.avatars.contains(kind) } }
  public static func isAction(_ kind: String, _ action: String) -> Bool { actions[action]?.avatars.contains(kind) ?? false }

  /** avatarToolDef(): the `avatar` tool for this avatar (only offered while one is on). */
  public static func toolDef(_ kind: String) -> [String: Any] {
    let name = names[kind] ?? kind
    let acts = actionsFor(kind)
    return [
      "type": "function",
      "name": "avatar",
      "description": "Make \(name) (you, on the Claude window) do something when the user asks: \(acts.map { "\($0) = \(actions[$0]!.label)" }.joined(separator: "; ")). Only for requests to \(name) himself; work in the user's code always goes to Claude as a prompt.",
      "parameters": [
        "type": "object",
        "properties": [
          "action": ["type": "string", "enum": acts],
          "direction": ["type": "string", "enum": ["left", "right"], "description": "For roll and move: which way. Leave out to let him pick."],
        ],
        "required": ["action"],
      ] as [String: Any],
    ]
  }

  // MARK: the fast path

  static let negative: Set<String> = Set(("claude clawed cloud prompt prompts draft drafts send sent sending session sessions code coding file files commit commits test tests " +
    "bug bugs fix add added animation animations implement feature function tell ask type typed copy paste clipboard git github repo " +
    "project build error errors app settings button cancel yes no not dont never stop why how what when where which who whose does did " +
    "is are was were should sleep asleep sleeping goodnight night nap napping wake awake listen listening hang bye goodbye quit mute unmute").split(separator: " ").map(String.init))
  /** NEGATIVE in the JS Set's order (the fuzzy veto walks it in order; any() makes order moot). */
  static let negativeLong: [String] = negative.filter { $0.utf16.count >= 5 }
  static let fillers: Set<String> = Set("um umm uh uhh er erm ah ahh hmm hm mm oh okay ok hey yo so alright well now please pls just again".split(separator: " ").map(String.init))
  static let qubitNames: Set<String> = ["qubit", "qubits", "cubit", "kubit", "qbit", "cubic", "cubits"]
  static let anyNames: Set<String> = ["buddy", "bud", "orbit", "pal", "dude"]
  static let leads = ["can you", "could you", "would you", "will you", "can u", "go ahead and", "i want you to", "i want to see you", "i want to see", "let me see you", "lets see you", "let me see", "lets see", "show me", "show us", "try to", "time to", "you can", "little guy", "little buddy", "pixel buddy"]
  static let tails = ["for me", "for us", "real quick", "right now", "little guy", "little buddy", "pixel buddy", "thanks", "thank you"]
  static let merge: [String: String] = [
    "back flip": "backflip", "back flips": "backflip", "black flip": "backflip", "front flip": "frontflip", "front flips": "frontflip",
    "q bit": "qubit", "cue bit": "qubit", "queue bit": "qubit", "cute bit": "qubit", "barrel roll": "barrelroll",
  ]
  static let alias: [String: String] = [
    "backflips": "backflip", "frontflips": "frontflip", "flips": "flip", "rolls": "roll", "role": "roll", "roles": "roll",
    "jumps": "jump", "hops": "hop", "dances": "dance", "nods": "nod", "write": "right", "rite": "right", "celebrates": "celebrate",
    "stretches": "stretch", "blinks": "blink", "waves": "wave", "bigger": "bigger",
  ]

  static let art = "(a|an|the|another|one|some)?"
  static let doVerb = "(do|try|pull|throw|give|make)?"
  static let templateSources: [(String, [String])] = [
    ("backflip", ["\(doVerb) \(art) backflip", "(do)? flip (backwards|backward|back)", "\(doVerb) \(art) (backwards|backward) flip"]),
    ("frontflip", ["\(doVerb) \(art) (frontflip|flip)", "(do)? flip (forward|forwards)", "\(doVerb) \(art) (forward|forwards) flip"]),
    ("roll", ["\(doVerb) \(art) (roll|barrelroll) (over|around)? (to)? (the)? <dir>?", "roll (over|around)? (to)? (the)? <dir>?"]),
    ("jump", ["jump (up)? (high)?", "\(doVerb) \(art) (big)? jump"]),
    ("hop", ["(hop|bounce) (up)?", "\(doVerb) \(art) (little)? (hop|bounce)"]),
    ("grow", ["(get|go|grow|become) (bigger|big|huge|giant|larger|large|tall|taller)", "grow (up|big|bigger)?", "power up", "supersize", "super size"]),
    ("shrink", ["(get|go|become) (smaller|small|tiny|little)", "shrink (down|back)?", "power down", "(go)? back to (your)? normal (size)?"]),
    ("celebrate", ["celebrate", "\(doVerb) \(art) celebration", "\(doVerb) \(art) victory dance", "party", "party time"]),
    ("dance", ["dance", "\(doVerb) \(art) (little|happy)? dance", "boogie", "bust a move", "(play)? (some)? music"]),
    ("nod", ["nod", "nod your head"]),
    ("shake", ["shake (your)? head"]),
    ("look_around", ["look around", "have a look around"]),
    ("stretch", ["stretch", "\(doVerb) \(art) stretch", "yawn"]),
    ("blink", ["blink", "wink", "\(doVerb) \(art) (blink|wink)"]),
    ("happy", ["(look|be|get) happy", "smile"]),
    ("sad", ["(look|be|get) sad"]),
    ("surprised", ["(look|be|act) surprised"]),
    ("curious", ["(look|be|act) curious"]),
    ("wave", ["wave", "wave (hi|hello)", "wave at me", "\(doVerb) \(art) wave"]),
    ("trip", ["trip", "trip over", "fall (over|down)"]),
    ("kick_ball", ["kick (a|the)? ball", "play (with)? (a|the|your)? ball", "play ball"]),
    ("sit", ["sit (down)?", "take a seat", "have a seat"]),
    ("climb", ["climb (up)?", "climb (on|onto) (the)? box", "get on the box"]),
    ("move", ["(go|move|walk|hop|run|scoot) (over)? (to)? (the)? <dir>"]),
    ("go_home", ["go home", "go to your spot", "back to your spot"]),
  ]

  struct Slot {
    var words: [String]
    var optional: Bool
    var capture: String?
  }
  struct Template {
    var action: String
    var slots: [Slot]
  }

  static func parse(_ src: String) -> [Slot] {
    JS.trim(src).split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init).filter { !$0.isEmpty }.map { part in
      let optional = part.hasSuffix("?")
      let p = optional ? String(part.dropLast()) : part
      if p == "<dir>" { return Slot(words: ["left", "right"], optional: optional, capture: "dir") }
      var inner = p
      if inner.hasPrefix("(") { inner.removeFirst() }
      if inner.hasSuffix(")") { inner.removeLast() }
      return Slot(words: inner.split(separator: "|", omittingEmptySubsequences: false).map(String.init), optional: optional, capture: nil)
    }
  }
  static let templates: [Template] = templateSources.flatMap { action, list in list.map { Template(action: action, slots: parse($0)) } }
  static let templateWords: Set<String> = Set(templates.flatMap { $0.slots.flatMap(\.words) })

  /** Edit distance with transpositions (optimal string alignment), on UTF-16 units as the JS. */
  static func editDistance(_ a: [UInt16], _ b: [UInt16]) -> Int {
    let m = a.count, n = b.count
    var d = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)
    for i in 0...m { d[i][0] = i }
    for j in 0...n { d[0][j] = j }
    if m > 0 && n > 0 {
      for i in 1...m {
        for j in 1...n {
          let c = a[i - 1] == b[j - 1] ? 0 : 1
          d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
          if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] { d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1) }
        }
      }
    }
    return d[m][n]
  }

  /** wordScore(): 1 exact (or an alias), else fuzzy for long words. */
  public static func wordScore(_ heard: String, _ word: String) -> Double {
    if heard == word || alias[heard] == word { return 1 }
    let h = Array(heard.utf16), w = Array(word.utf16)
    if w.count < 5 || h.count < 4 { return 0 }
    return max(0, 1 - Double(editDistance(h, w)) / Double(max(h.count, w.count)))
  }

  static let apostrophes = JSRegExp("[\u{2019}'`]", "g")
  static let nonWord = JSRegExp(#"[^\p{L}\p{N}]+"#, "u")

  static func tokenize(_ text: String) -> [String] {
    nonWord.split(apostrophes.replace(JS.lower(JS.nfkc(text)), "")).filter { !$0.isEmpty }
  }

  static func mergePairs(_ tokens: [String]) -> [String] {
    var out: [String] = []
    var i = 0
    while i < tokens.count {
      if i + 1 < tokens.count, let m = merge["\(tokens[i]) \(tokens[i + 1])"] {
        out.append(m)
        i += 2
      } else {
        out.append(tokens[i])
        i += 1
      }
    }
    return out
  }

  static func startsWith(_ t: [String], _ phrase: String) -> Int {
    let p = phrase.split(separator: " ").map(String.init)
    return p.count <= t.count && zip(p, t).allSatisfy { $0 == $1 } ? p.count : 0
  }
  static func endsWith(_ t: [String], _ phrase: String) -> Int {
    let p = phrase.split(separator: " ").map(String.init)
    let off = t.count - p.count
    return off >= 0 && p.enumerated().allSatisfy { t[off + $0.offset] == $0.element } ? p.count : 0
  }

  /** Take fillers, names and polite leads and tails off both ends. */
  static func strip(_ tokens: [String], _ kind: String) -> [String] {
    let isName = { (w: String) in anyNames.contains(w) || (kind == "qubit" && qubitNames.contains(w)) }
    var t = tokens
    var changed = true
    while changed && !t.isEmpty {
      changed = false
      if fillers.contains(t[0]) || isName(t[0]) {
        t.removeFirst()
        changed = true
        continue
      }
      if t.count > 1 && (fillers.contains(t.last!) || isName(t.last!)) {
        t.removeLast()
        changed = true
        continue
      }
      for lead in leads {
        let n = startsWith(t, lead)
        if n > 0 && n < t.count {
          t.removeFirst(n)
          changed = true
          break
        }
      }
      if changed { continue }
      for tail in tails {
        let n = endsWith(t, tail)
        if n > 0 && n < t.count {
          t.removeLast(n)
          changed = true
          break
        }
      }
    }
    return t
  }

  struct Fit {
    var mean: Double
    var min: Double
    var captures: [String: String]
  }

  /** The best way `tokens` fill `slots` (every token used, every required slot filled), or nil. */
  static func fit(_ tokens: [String], _ slots: [Slot]) -> Fit? {
    var best: Fit?
    func go(_ ti: Int, _ si: Int, _ scores: [Double], _ captures: [String: String]) {
      if si == slots.count {
        if ti == tokens.count && !scores.isEmpty {
          let mn = scores.min()!
          let mean = scores.reduce(0, +) / Double(scores.count)
          if best == nil || mn > best!.min || (mn == best!.min && mean > best!.mean) { best = Fit(mean: mean, min: mn, captures: captures) }
        }
        return
      }
      let s = slots[si]
      if s.optional { go(ti, si + 1, scores, captures) }
      if ti >= tokens.count { return }
      // Multi-word alternatives ("victory dance") take as many tokens as they have words.
      for w in s.words {
        let parts = w.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        if ti + parts.count > tokens.count { continue }
        let sc = parts.enumerated().map { wordScore(tokens[ti + $0.offset], $0.element) }
        if sc.contains(where: { $0 < minWordScore }) { continue }
        let word = alias[tokens[ti]] ?? tokens[ti]
        var next = captures
        if let cap = s.capture { next[cap] = s.words.contains(word) ? word : w }
        go(ti + parts.count, si + 1, scores + sc, next)
      }
    }
    go(0, 0, [], [:])
    return best
  }

  public struct Match: Equatable, Sendable {
    public var action: String
    public var dir: String?
    public var confidence: Double
    public var sure: Bool
  }

  /** matchAvatarCommand(): is this whole utterance just a command for `avatar` ('qubit' | 'buddy')? */
  public static func match(_ text: String, avatar: String) -> Match? {
    guard avatar == "qubit" || avatar == "buddy" else { return nil }
    let raw = tokenize(text)
    if raw.isEmpty || raw.count > maxWords { return nil }
    let tokens = mergePairs(raw)
    // A veto word anywhere (fuzzily: "clawed" for "claude"), unless it's one of the template words.
    for w in tokens {
      if negative.contains(w) { return nil }
      if w.utf16.count >= 5 && !templateWords.contains(w) && negativeLong.contains(where: { wordScore(w, $0) >= 0.84 }) { return nil }
    }
    let core = strip(tokens, avatar)
    if core.isEmpty { return nil }
    var best: (action: String, dir: String?, confidence: Double)?
    for t in templates {
      guard actions[t.action]!.avatars.contains(avatar), let f = fit(core, t.slots) else { continue }
      if best == nil || f.min > best!.confidence { best = (t.action, f.captures["dir"], (f.min * 1000 + 0.5).rounded(.down) / 1000) }
    }
    guard let b = best else { return nil }
    return Match(action: b.action, dir: b.dir, confidence: b.confidence, sure: b.confidence >= minConfidence)
  }
}
