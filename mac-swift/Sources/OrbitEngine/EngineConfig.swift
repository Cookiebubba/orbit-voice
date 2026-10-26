// Settings, as src/config.js keeps them: defaults, then environment overrides, then settings.json in
// the profile; only known keys with sane values are kept (sanitize, rule for rule), and only values
// that differ from the defaults are saved. Listeners hear which keys changed.
//
// The keys and their defaults are SettingsSchema's (OrbitKit), which a test holds to config.js's.
import Foundation
import OrbitKit

public final class EngineConfig: @unchecked Sendable {
  public typealias Settings = [String: JSONValue]
  public static let limits = (minSpeed: 0.7, maxSpeed: 1.5)
  public static let avatars = ["buddy", "qubit", "none"]
  static let envOverrides = ["GROK_VOICE": "voice", "GROK_VOICE_SPEED": "speed", "WAKE_HOTKEY": "wakeHotkey", "GROK_VOICE_MODEL": "model"]

  /** config.js DEFAULTS, in its order. */
  public static let keys: [String] = SettingsSchema.specs.map(\.key)
  public static let defaults: Settings = SettingsSchema.defaults

  public let dir: URL
  private let lock = NSLock()
  private var settings: Settings = EngineConfig.defaults
  private var listeners: [UUID: @Sendable ([String], Settings) -> Void] = [:]

  public init(dir: URL) {
    self.dir = dir
  }

  var file: URL { dir.appendingPathComponent("settings.json") }

  /**
   * Load: defaults, then the environment's overrides (and a .env next to the core, as in dev), then
   * settings.json. Settings saved before the avatar choice: `buddy: false` means no avatar. The voice
   * engine: a saved choice wins; else a new install starts on Claude voice (and says so in its file
   * at once), and an install from before (a settings file, or `hasKey`: an xAI key saved) on Grok.
   */
  /**
   * `firstRun`: settings a brand-new install starts with on top of config.js's defaults (Orbit
   * Native: Qubit as the avatar), written to its file at once like the voice engine, so they read
   * as chosen. An install with a settings file already keeps what it has.
   */
  @discardableResult
  public func load(env: [String: String] = ProcessInfo.processInfo.environment, dotEnv: URL? = nil, hasKey: Bool = false, firstRun: [String: JSONValue] = [:]) -> Settings {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var e = dotEnv.map { Self.readDotEnv($0) } ?? [:]
    for (k, v) in env { e[k] = v }
    var fromEnv: [String: JSONValue] = [:]
    for (name, key) in Self.envOverrides { if let v = e[name] { fromEnv[key] = .string(v) } }
    let hadFile = FileManager.default.fileExists(atPath: file.path)
    var fromFile: [String: JSONValue] = [:]
    if let data = try? Data(contentsOf: file), let v = try? JSONValue.parse(data), case .object(let o) = v { fromFile = o }
    if fromFile["avatar"] == nil, fromFile["buddy"] == .bool(false) { fromFile["avatar"] = "none" }
    var next = Self.defaults
    for (k, v) in Self.sanitize(fromEnv) { next[k] = v }
    let saved = Self.sanitize(fromFile)
    for (k, v) in saved { next[k] = v }
    let engine = Self.engineFor(saved: saved["voiceEngine"]?.stringValue, hadFile: hadFile, hasKey: hasKey)
    next["voiceEngine"] = .string(engine)
    // A brand-new install says so in its file straight away, so adding an xAI key later (without
    // changing anything else) never reads as an install from before Claude was the default.
    var first: [String: JSONValue] = [:]
    if saved["voiceEngine"] == nil, !hadFile, engine == "claude" { first["voiceEngine"] = "claude" }
    if !hadFile {
      for (k, v) in Self.sanitize(firstRun) where k != "voiceEngine" {
        next[k] = v
        first[k] = v
      }
    }
    if !first.isEmpty { try? JSONValue.object(first).data(pretty: true).write(to: file, options: .atomic) }
    lock.withLock { settings = next }
    return next
  }

  /** config.js engineFor: which voice engine to start on. */
  public static func engineFor(saved: String?, hadFile: Bool, hasKey: Bool) -> String {
    if saved == "grok" || saved == "claude" { return saved! }
    return hadFile || hasKey ? "grok" : "claude"
  }

  public var all: Settings { lock.withLock { settings } }
  public subscript(key: String) -> JSONValue? { lock.withLock { settings[key] } }
  public func string(_ key: String) -> String { self[key]?.stringValue ?? "" }
  public func bool(_ key: String) -> Bool { self[key]?.boolValue ?? false }
  public func number(_ key: String) -> Double { self[key]?.doubleValue ?? 0 }

  /** Merge and save. Returns the keys that actually changed (and tells the listeners). */
  @discardableResult
  public func update(_ patch: [String: JSONValue]) -> [String] {
    let clean = Self.sanitize(patch)
    let (changed, snapshot): ([String], Settings) = lock.withLock {
      let changed = Self.keys.filter { k in clean[k].map { $0 != settings[k] } ?? false }
      if changed.isEmpty { return ([], settings) }
      for k in changed { settings[k] = clean[k] }
      return (changed, settings)
    }
    guard !changed.isEmpty else { return [] }
    save(snapshot)
    let fns = lock.withLock { Array(listeners.values) }
    for fn in fns { fn(changed, snapshot) }
    return changed
  }

  private func save(_ s: Settings) {
    var toSave: [String: JSONValue] = [:]
    // The voice engine is always written out, even at its default, so the file says it was chosen
    // (an older file without it was a Grok install: see engineFor).
    for k in Self.keys where k == "voiceEngine" || s[k] != Self.defaults[k] { toSave[k] = s[k] }
    let data = JSONValue.object(toSave).data(pretty: true)
    try? data.write(to: file, options: .atomic)
  }

  /** Listen for changes: (changed keys, all settings). The returned function stops it. */
  @discardableResult
  public func onChange(_ fn: @escaping @Sendable ([String], Settings) -> Void) -> () -> Void {
    let id = UUID()
    lock.withLock { listeners[id] = fn }
    return { [weak self] in _ = self?.lock.withLock { self?.listeners.removeValue(forKey: id) } }
  }

  /** What the page gets (GET /api/config, POST /api/settings): no orb places, plus the hotkey's label. */
  public func publicSettings() -> Settings {
    var s = all
    s.removeValue(forKey: "orbPosition")
    s.removeValue(forKey: "orbStickAnchor")
    s["hotkeyLabel"] = .string(SettingsSchema.hotkeyLabel(s["wakeHotkey"]?.stringValue ?? ""))
    return s
  }

  /** settings.changed's settings: all but the orb's places. */
  public func visibleSettings() -> Settings {
    var s = all
    s.removeValue(forKey: "orbPosition")
    s.removeValue(forKey: "orbStickAnchor")
    return s
  }

  // MARK: .env

  public static func readDotEnv(_ file: URL) -> [String: String] {
    guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [:] }
    var out: [String: String] = [:]
    let re = try! NSRegularExpression(pattern: #"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$"#, options: [.caseInsensitive])
    for line in text.components(separatedBy: CharacterSet(charactersIn: "\n")) {
      let l = line.hasSuffix("\r") ? String(line.dropLast()) : line
      if l.trimmingCharacters(in: .whitespaces).hasPrefix("#") { continue }
      let ns = l as NSString
      guard let m = re.firstMatch(in: l, range: NSRange(location: 0, length: ns.length)) else { continue }
      var v = ns.substring(with: m.range(at: 2))
      if v.count >= 2, let f = v.first, let la = v.last, (f == "'" || f == "\""), la == f { v = String(v.dropFirst().dropLast()) }
      out[ns.substring(with: m.range(at: 1))] = v
    }
    return out
  }

  // MARK: sanitize (config.js, rule for rule)

  /** coerce(): only plain values are converted (an object with toString would make Number() throw). */
  static func coerce(_ key: String, _ value: JSONValue) -> JSONValue? {
    switch defaults[key] {
    case .bool?:
      return .bool(value == .bool(true) || value == .string("true"))
    case .number?:
      if case .number = value { return value }
      if case .string(let s) = value, !JSNumber.trimmed(s).isEmpty { return .number(JSNumber.parse(s)) }
      return nil
    case .string?:
      if case .string = value { return value }
      if case .number(let n) = value { return .string(JSNumber.string(n)) }
      return nil
    default:
      return value
    }
  }

  static func isFinite(_ v: JSONValue) -> Bool { if case .number(let n) = v { return n.isFinite }; return false }
  static func isInteger(_ v: JSONValue) -> Bool { if case .number(let n) = v { return n.isFinite && n.rounded(.towardZero) == n }; return false }
  /** JS Math.round. */
  static func round(_ x: Double) -> Double { (x + 0.5).rounded(.down) }
  static func round(_ x: Double, places: Double) -> Double { round(x * places) / places }
  static func matches(_ s: String, _ pattern: String, _ opts: NSRegularExpression.Options = []) -> Bool {
    (try? NSRegularExpression(pattern: pattern, options: opts))?.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
  }

  public static func sanitize(_ input: [String: JSONValue]) -> [String: JSONValue] {
    var out: [String: JSONValue] = [:]
    for (k, v) in input {
      guard defaults[k] != nil, let val = coerce(k, v) else { continue }
      switch k {
      case "voice":
        if case .string(let s) = val, matches(s, "^[a-z0-9_-]{1,40}$", .caseInsensitive) { out[k] = .string(s.lowercased()) }
      case "speed":
        if case .number(let n) = val, n.isFinite { out[k] = .number(min(limits.maxSpeed, max(limits.minSpeed, round(n, places: 100)))) }
      case "listenMode":
        if val == "always" || val == "tap" { out[k] = val }
      case "announce":
        if ["speak", "chime", "off"].contains(val.stringValue ?? "\u{0}") { out[k] = val }
      case "costPerMinute":
        if case .number(let n) = val, n.isFinite, n >= 0, n < 10 { out[k] = .number(round(n, places: 1000)) }
      case "wakeHotkey", "model":
        if case .string(let s) = val, (s as NSString).length > 0, (s as NSString).length < 60, matches(s, #"^[A-Za-z0-9_+.-]+$"#) { out[k] = val }
      case "brainModel":
        if ["auto", "haiku", "sonnet", "opus"].contains(val.stringValue ?? "\u{0}") { out[k] = val }
      case "brainConnection":
        if val == "claude-code" || val == "api-key" { out[k] = val }
      case "helperEngine":
        if val == "claude-code" || val == "codex" { out[k] = val }
      case "voiceEngine":
        if val == "grok" || val == "claude" { out[k] = val }
      case "claudeVoice":
        if isInteger(val), let n = val.doubleValue, n >= 0, n <= 7 { out[k] = val }
      case "claudeVoiceModel":
        if ["haiku", "sonnet", "opus", "fable"].contains(val.stringValue ?? "\u{0}") { out[k] = val }
      case "claudeVoiceEffort":
        if ["low", "medium", "high"].contains(val.stringValue ?? "\u{0}") { out[k] = val }
      case "claudeVoiceStt":
        if ["moonshine", "parakeet-110m", "parakeet-v2"].contains(val.stringValue ?? "\u{0}") { out[k] = val }
      case "avatar":
        if avatars.contains(val.stringValue ?? "\u{0}") { out[k] = val }
      case "avatarClickTalk", "avatarThrow", "avatarThrowSound", "onboarded":
        // Only a real yes or no (true/false, or their strings): anything else is ignored.
        if case .bool = v { out[k] = val } else if v == "true" || v == "false" { out[k] = val }
      case "buddySize":
        if isInteger(val), let n = val.doubleValue, n >= 1, n <= 3 { out[k] = val }
      case "brainClaudePath":
        if case .string(let s) = val, s.isEmpty || isClaudePath(s) { out[k] = val }
      case "voiceVolume":
        if case .number(let n) = val, n.isFinite { out[k] = .number(min(1, max(0, round(n, places: 100)))) }
      case "orbPulseAmount":
        if case .number(let n) = val, n.isFinite { out[k] = .number(min(0.1, max(0.01, round(n, places: 1000)))) }
      case "orbStickAnchor":
        if val == .null {
          out[k] = .null
        } else if case .object(let o) = val, let c = o["corner"]?.stringValue, ["tl", "tr", "bl", "br"].contains(c),
                  let dx = o["dx"], let dy = o["dy"], [dx, dy].allSatisfy({ isFinite($0) && ($0.doubleValue ?? -1) >= 0 && ($0.doubleValue ?? 1e9) <= 10000 }) {
          out[k] = .object(["corner": .string(c), "dx": .number(round(dx.doubleValue!)), "dy": .number(round(dy.doubleValue!))])
        }
      case "anywhereUnderOrbit":
        if case .array(let a) = val {
          var seen = Set<String>()
          var list: [JSONValue] = []
          for item in a {
            guard case .string(let s) = item, matches(s, #"^[A-Za-z0-9_ .()+-]{1,80}(\.exe)?$"#, .caseInsensitive) else { continue }
            let low = s.lowercased()
            if seen.insert(low).inserted { list.append(.string(low)) }
          }
          out[k] = .array(Array(list.prefix(50)))
        }
      case "anywhereMouseLeadMs":
        if case .number(let n) = val, n.isFinite { out[k] = .number(min(600, max(0, round(n)))) }
      case "orbPosition":
        if val == .null {
          out[k] = .null
        } else if case .array(let a) = val, a.count == 2, a.allSatisfy(isFinite) {
          out[k] = .array(a.map { .number(round($0.doubleValue!)) })
        }
      default:
        if sameType(val, defaults[k]!) { out[k] = val }
      }
    }
    return out
  }

  static func sameType(_ a: JSONValue, _ b: JSONValue) -> Bool {
    switch (a, b) {
    case (.bool, .bool), (.number, .number), (.string, .string): return true
    // typeof null, [] and {} are all "object".
    case (.null, .null), (.null, .array), (.null, .object), (.array, .null), (.array, .array), (.array, .object), (.object, .null), (.object, .array), (.object, .object): return true
    default: return false
    }
  }

  /**
   * brainClaudePath: only ever a local absolute path (no network share) to `claude` (isClaudeFile in
   * brain.js on a Mac: claude or claude.exe), without control or shell-ish characters.
   */
  static func isClaudePath(_ s: String) -> Bool {
    guard (s as NSString).length < 400, s.hasPrefix("/"), !matches(s, #"^[\\/]{2}"#) else { return false }
    for u in s.utf16 where u < 32 { return false }
    if s.contains(where: { "\"<>|?*".contains($0) }) { return false }
    return matches((s as NSString).lastPathComponent, #"^claude(\.exe)?$"#, .caseInsensitive)
  }
}

/** JavaScript's Number(string) and String(number), for settings that arrive as the other type. */
public enum JSNumber {
  /** The whitespace JS trims (StrWhiteSpaceChar: Unicode spaces and line terminators). */
  static func trimmed(_ s: String) -> String {
    s.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}")))
  }

  public static func parse(_ raw: String) -> Double {
    let s = trimmed(raw)
    if s.isEmpty { return 0 }
    let lower = s.lowercased()
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] where lower.hasPrefix(prefix) {
      let digits = String(s.dropFirst(2))
      guard !digits.isEmpty, let v = UInt64(digits, radix: radix) else { return .nan }
      return Double(v)
    }
    if s == "Infinity" || s == "+Infinity" { return .infinity }
    if s == "-Infinity" { return -.infinity }
    // StrDecimalLiteral: sign, digits with an optional point, optional exponent; nothing else.
    guard EngineConfig.matches(s, #"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$"#) else { return .nan }
    return Double(s) ?? .nan
  }

  /** Number::toString: the shortest digits that round-trip, laid out as JavaScript does. */
  public static func string(_ x: Double) -> String {
    if x.isNaN { return "NaN" }
    if x.isInfinite { return x > 0 ? "Infinity" : "-Infinity" }
    if x == 0 { return "0" }
    if x < 0 { return "-" + string(-x) }
    // Swift's description has the same shortest digits; take them and the decimal exponent apart.
    let d = "\(x)"
    var mantissa = d
    var exp10 = 0
    if let e = d.firstIndex(where: { $0 == "e" || $0 == "E" }) {
      mantissa = String(d[..<e])
      exp10 = Int(d[d.index(after: e)...]) ?? 0
    }
    let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
    let intPart = String(parts[0])
    let fracPart = parts.count > 1 ? String(parts[1]) : ""
    var digits = intPart + fracPart
    var point = intPart.count + exp10 // where the decimal point goes in `digits`
    while digits.hasPrefix("0") && digits.count > 1 {
      digits.removeFirst()
      point -= 1
    }
    while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
    let k = digits.count
    let n = point
    if k <= n && n <= 21 { return digits + String(repeating: "0", count: n - k) }
    if 0 < n && n <= 21 { return String(digits.prefix(n)) + "." + String(digits.dropFirst(n)) }
    if -6 < n && n <= 0 { return "0." + String(repeating: "0", count: -n) + digits }
    let e = n - 1
    let sign = e < 0 ? "-" : "+"
    let head = k == 1 ? digits : String(digits.prefix(1)) + "." + String(digits.dropFirst())
    return "\(head)e\(sign)\(abs(e))"
  }
}
