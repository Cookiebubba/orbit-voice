// Orbit's settings: keys, types, defaults and limits exactly as src/config.js DEFAULTS / LIMITS /
// sanitize(), and where each one shows in Settings (ui/src/Settings.tsx). sanitize() here gives the
// same answer as the bridge's, so the Settings screen can clamp and refuse before it posts.
import Foundation

/** The Settings screen's sections, in the page's order (ui/src/Settings.tsx). */
public enum SettingsSection: String, CaseIterable, Sendable {
  case voiceEngine = "Voice engine"
  case voice = "Voice" // "Grok's voice" or "Orbit's voice" (the engine's card)
  case listening = "Listening"
  case whenClaudeFinishes = "When Claude finishes"
  case secondBrain = "Second brain"
  case anywhere = "Orbit anywhere"
  case hotkey = "Wake hotkey"
  case app = "App"
  case avatar = "Avatar"
  case usage = "Usage"
  case updates = "Updates"
  case about = "About"
  /** Kept by the shell, never shown (the orb's position, its anchor on the Claude window...). */
  case hidden = "Hidden"
}

public enum SettingKind: Sendable, Equatable {
  case bool
  /** A real yes/no only (true/false or their strings): anything else is ignored, not read as false. */
  case strictBool
  /** Clamped to [min, max] and rounded to `places` decimals (Math.round(v * 10^places) / 10^places). */
  case number(min: Double, max: Double, places: Int)
  /** Accepted only when finite, min <= v < maxExclusive (refused, not clamped). */
  case numberRange(min: Double, maxExclusive: Double, places: Int)
  /** A whole number in [min, max] (refused otherwise). */
  case integer(min: Int, max: Int)
  case choice([String])
  /** voice, model, wakeHotkey: a short token. */
  case token(pattern: String, maxLength: Int, lowercase: Bool)
  /** brainClaudePath: "" or an absolute local path to claude. */
  case claudePath
  /** anywhereUnderOrbit: program names. */
  case appList
  /** orbPosition / orbStickAnchor: the shell's own, not sent through /api/settings. */
  case object
}

public struct SettingSpec: Sendable, Equatable {
  public var key: String
  public var kind: SettingKind
  public var defaultValue: JSONValue
  public var section: SettingsSection
  /** The page's label for it (Electron's words, on a Mac). */
  public var label: String
  /** Can POST /api/settings change it? (wakeHotkey goes through the hotkey; the orb's spots are the shell's.) */
  public var postable: Bool
  public init(_ key: String, _ kind: SettingKind, _ def: JSONValue, _ section: SettingsSection, _ label: String, postable: Bool = true) {
    self.key = key; self.kind = kind; self.defaultValue = def; self.section = section; self.label = label; self.postable = postable
  }
}

public enum SettingsSchema {
  /** src/config.js LIMITS */
  public static let minSpeed = 0.7
  public static let maxSpeed = 1.5
  /** ui/src/orbLook.ts PULSE_MIN / PULSE_MAX */
  public static let pulseMin = 0.01
  public static let pulseMax = 0.1
  public static let avatars = ["buddy", "qubit", "none"]

  /** Every key of src/config.js DEFAULTS, in its order. */
  public static let specs: [SettingSpec] = [
    SettingSpec("voice", .token(pattern: "^(?i)[a-z0-9_-]{1,40}$", maxLength: 40, lowercase: true), "eve", .voice, "Voice"),
    SettingSpec("speed", .number(min: minSpeed, max: maxSpeed, places: 2), 1, .voice, "Talking speed"),
    SettingSpec("voiceVolume", .number(min: 0, max: 1, places: 2), 0.75, .voice, "Volume"),
    SettingSpec("wakeHotkey", .token(pattern: "^[A-Za-z0-9_+.-]+$", maxLength: 59, lowercase: false), .string(HotkeyAccelerator.defaultAccelerator), .hotkey, "Wake hotkey", postable: false),
    SettingSpec("listenMode", .choice(["always", "tap"]), "always", .listening, "Listening"),
    SettingSpec("halfDuplex", .bool, false, .listening, "Don't listen while Grok is talking"),
    SettingSpec("wakeWord", .bool, false, .listening, "Wake word: say “Hey Orbit” (or “Hey Grok”)"),
    SettingSpec("announce", .choice(["speak", "chime", "off"]), "speak", .whenClaudeFinishes, "When Claude finishes"),
    SettingSpec("announceWake", .bool, false, .whenClaudeFinishes, "Wake Grok to say it"),
    SettingSpec("wakeOnResults", .bool, true, .whenClaudeFinishes, "Wake Grok when something you asked for is ready"),
    SettingSpec("costPerMinute", .numberRange(min: 0, maxExclusive: 10, places: 3), 0.08, .usage, "Price per minute (USD)"),
    SettingSpec("model", .token(pattern: "^[A-Za-z0-9_+.-]+$", maxLength: 59, lowercase: false), "grok-voice-latest", .hidden, "Model"),
    SettingSpec("orbPosition", .object, nil, .hidden, "Orb position", postable: false),
    SettingSpec("autoUpdate", .bool, true, .updates, "Update automatically"),
    SettingSpec("orbStick", .bool, false, .app, "Stick to Claude Code"),
    SettingSpec("orbPulse", .bool, false, .app, "Pulse with your voice"),
    SettingSpec("orbPulseGrok", .bool, false, .app, "Pulse with Grok's voice"),
    SettingSpec("orbPulseAmount", .number(min: pulseMin, max: pulseMax, places: 3), 0.05, .app, "How much it pulses"),
    SettingSpec("orbStickAnchor", .object, nil, .hidden, "Orb anchor", postable: false),
    SettingSpec("brainEnabled", .bool, true, .secondBrain, "Let Grok ask Claude when a question is hard"),
    SettingSpec("brainModel", .choice(["auto", "haiku", "sonnet", "opus"]), "auto", .secondBrain, "Model"),
    SettingSpec("brainExplore", .bool, true, .secondBrain, "Read the current project"),
    SettingSpec("brainConnection", .choice(["claude-code", "api-key"]), "claude-code", .secondBrain, "Connection"),
    SettingSpec("brainClaudePath", .claudePath, "", .secondBrain, "Claude Code location"),
    SettingSpec("webSearch", .bool, true, .secondBrain, "Let Grok search the web"),
    SettingSpec("voiceEngine", .choice(["grok", "claude"]), "grok", .voiceEngine, "Voice engine"),
    SettingSpec("claudeVoice", .integer(min: 0, max: 7), 0, .voice, "Voice"),
    SettingSpec("claudeVoiceModel", .choice(["haiku", "sonnet", "opus", "fable"]), "haiku", .voiceEngine, "Brain"),
    SettingSpec("claudeVoiceEffort", .choice(["low", "medium", "high"]), "low", .voiceEngine, "Effort"),
    SettingSpec("claudeVoiceStt", .choice(["moonshine", "parakeet-110m", "parakeet-v2"]), "moonshine", .voiceEngine, "Speech to text"),
    SettingSpec("avatar", .choice(avatars), "buddy", .avatar, "Avatar"),
    SettingSpec("buddySize", .integer(min: 1, max: 3), 2, .avatar, "Size"),
    SettingSpec("avatarClickTalk", .strictBool, true, .avatar, "Click your avatar to talk"),
    SettingSpec("avatarThrow", .strictBool, true, .avatar, "Throw your avatar"),
    SettingSpec("avatarThrowSound", .strictBool, true, .avatar, "Sound when thrown"),
    SettingSpec("showOrb", .bool, true, .avatar, "Show the orb"),
    SettingSpec("anywhere", .bool, true, .anywhere, "Let Grok work in the window you're in"),
    SettingSpec("anywhereVision", .bool, false, .anywhere, "Let Claude see windows"),
    SettingSpec("anywhereCdp", .bool, false, .anywhere, "Also use apps' own debugging ports"),
    SettingSpec("anywhereUnderOrbit", .appList, [], .anywhere, "Apps under Grok"),
    SettingSpec("anywhereMouse", .bool, true, .anywhere, "Show Orbit's mouse"),
    SettingSpec("anywhereMouseLeadMs", .number(min: 0, max: 600, places: 0), 220, .hidden, "Mouse lead (ms)"),
    SettingSpec("helperEngine", .choice(["claude-code", "codex"]), "claude-code", .hidden, "Helper engine"),
  ]

  public static let byKey: [String: SettingSpec] = Dictionary(uniqueKeysWithValues: specs.map { ($0.key, $0) })
  public static var defaults: [String: JSONValue] { Dictionary(uniqueKeysWithValues: specs.map { ($0.key, $0.defaultValue) }) }
  public static func specs(in section: SettingsSection) -> [SettingSpec] { specs.filter { $0.section == section } }

  /** JS Math.round (halves go up, also for negatives). */
  static func jsRound(_ v: Double, places: Int) -> Double {
    let f = pow(10, Double(places))
    return (v * f + 0.5).rounded(.down) / f
  }

  /** JS Number(x) for a non-blank string ("" and junk -> nil, like NaN failing Number.isFinite). */
  private static func number(_ v: JSONValue) -> Double? {
    switch v {
    case .number(let n): return n.isFinite ? n : nil
    case .string(let s):
      let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
      if t.isEmpty { return nil }
      if let d = Double(t), d.isFinite { return d }
      return nil
    default: return nil
    }
  }

  private static func text(_ v: JSONValue) -> String? {
    switch v {
    case .string(let s): return s
    case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
    default: return nil
    }
  }

  private static func matches(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }

  /**
   * What the bridge would save for `key = value` (src/config.js coerce + sanitize), or nil when it
   * would ignore it. Unknown keys: nil.
   */
  public static func sanitize(_ key: String, _ value: JSONValue) -> JSONValue? {
    guard let spec = byKey[key] else { return nil }
    switch spec.kind {
    case .bool:
      // coerce(): only true or "true" is yes; anything else (even 1) is no.
      return .bool(value == .bool(true) || value == .string("true"))
    case .strictBool:
      if case .bool(let b) = value { return .bool(b) }
      if value == .string("true") { return .bool(true) }
      if value == .string("false") { return .bool(false) }
      return nil
    case .number(let lo, let hi, let places):
      guard let n = number(value) else { return nil }
      return .number(min(hi, max(lo, jsRound(n, places: places))))
    case .numberRange(let lo, let hi, let places):
      guard let n = number(value), n >= lo, n < hi else { return nil }
      return .number(jsRound(n, places: places))
    case .integer(let lo, let hi):
      guard let n = number(value), n == n.rounded(), n >= Double(lo), n <= Double(hi) else { return nil }
      return .number(n)
    case .choice(let options):
      guard let s = text(value), options.contains(s) else { return nil }
      return .string(s)
    case .token(let pattern, let maxLength, let lowercase):
      guard let s = text(value), !s.isEmpty, s.count <= maxLength, matches(s, pattern) else { return nil }
      return .string(lowercase ? s.lowercased() : s)
    case .claudePath:
      guard let s = text(value) else { return nil }
      if s.isEmpty { return "" }
      let bad = s.unicodeScalars.contains { $0.value < 32 || "\"<>|?*".unicodeScalars.contains($0) }
      guard s.count < 400, s.hasPrefix("/"), !s.hasPrefix("//"), !bad, matches((s as NSString).lastPathComponent, "^(?i)claude(\\.exe)?$") else { return nil }
      return .string(s)
    case .appList:
      guard let arr = value.arrayValue else { return nil }
      var seen = [String]()
      for a in arr {
        guard let s = a.stringValue, matches(s, "^(?i)[A-Za-z0-9_ .()+-]{1,80}(\\.exe)?$") else { continue }
        let l = s.lowercased()
        if !seen.contains(l) { seen.append(l) }
      }
      return .array(seen.prefix(50).map { .string($0) })
    case .object:
      return value // checked by the shell that owns it
    }
  }

  // MARK: - Hotkey label (src/platform/system.js hotkeyLabel, on a Mac)

  private static let macMods: [String: String] = [
    "Control": "⌃", "Ctrl": "⌃", "Alt": "⌥", "Option": "⌥", "AltGr": "⌥", "Shift": "⇧", "Command": "⌘", "Cmd": "⌘",
    "CommandOrControl": "⌘", "CmdOrCtrl": "⌘", "Super": "⌘", "Meta": "⌘",
  ]

  /** "Control+Alt+G" -> "⌃⌥G" (modifiers in the Mac's order ⌃⌥⇧⌘). */
  public static func hotkeyLabel(_ accel: String) -> String {
    let parts = accel.split(separator: "+").map(String.init).filter { !$0.isEmpty }
    var mods = Set<String>()
    var keys = [String]()
    for p in parts {
      if let m = macMods[p] { mods.insert(m) } else { keys.append(p.count == 1 ? p.uppercased() : p) }
    }
    return ["⌃", "⌥", "⇧", "⌘"].filter { mods.contains($0) }.joined() + keys.joined(separator: "+")
  }

  /** Each part of an accelerator as its own key cap: ["⌃", "⌥", "G"] (Settings' hotkey recorder). */
  public static func keyCaps(_ accel: String) -> [String] {
    accel.split(separator: "+").map { macMods[String($0)] ?? String($0) }
  }
}
