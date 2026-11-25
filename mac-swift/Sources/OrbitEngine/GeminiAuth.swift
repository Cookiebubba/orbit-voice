// Gemini CLI discovery, model/voice catalogs, and sign-in checks (src/gemini/auth.js).
//
// Security posture: never logs API keys, OAuth tokens, or user words; never runs through a shell;
// checks only plain `gemini` executables on local absolute paths.
import Foundation
import OrbitIntent
import OrbitKit

public enum GeminiAuth {
  public struct ModelInfo: Sendable, Equatable {
    public let label: String
    public let speed: String
    public init(label: String, speed: String) {
      self.label = label
      self.speed = speed
    }
  }

  public static let GEMINI_VOICE_MODELS: [String: ModelInfo] = [
    "gemini-3.8-flash-low": ModelInfo(label: "Gemini 3.8 Flash", speed: "fastest, Antigravity subscription"),
    "gemini-4-neon-low": ModelInfo(label: "Gemini 4 Neon", speed: "flagship reasoning, Antigravity subscription"),
    "gemini-2.5-flash": ModelInfo(label: "Gemini 2.5 Flash", speed: "fast, balanced"),
    "gemini-2.5-pro": ModelInfo(label: "Gemini 2.5 Pro", speed: "slower, deeper reasoning"),
    "gemini-2.5-flash-lite": ModelInfo(label: "Gemini 2.5 Flash Lite", speed: "fastest, lightweight"),
  ]

  public static let GEMINI_LIVE_MODELS: [String: ModelInfo] = [
    "gemini-2.5-flash-native-audio-preview-12-2025": ModelInfo(label: "Gemini 2.5 Flash Native Audio", speed: "native audio, lowest latency"),
    "gemini-2.0-flash-live-001": ModelInfo(label: "Gemini 2.0 Flash Live", speed: "fast multimodal live"),
  ]

  public static let GEMINI_LIVE_VOICES: [String] = [
    "Puck",
    "Charon",
    "Kore",
    "Fenrir",
    "Aoede",
    "Leda",
    "Orus",
    "Zephyr",
  ]

  public static var voiceModels: [String: ModelInfo] { GEMINI_VOICE_MODELS }
  public static var liveModels: [String: ModelInfo] { GEMINI_LIVE_MODELS }
  public static var liveVoices: [String] { GEMINI_LIVE_VOICES }

  private static let agyFileRegex = JSRegExp(#"^agy(\.exe)?$"#, "i")
  private static let geminiFileRegex = JSRegExp(#"^(?:gemini|agy)(\.exe)?$"#, "i")
  private static let uncRegex = JSRegExp(#"^[\\/]{2}"#)
  private static let signInRegex = JSRegExp(
    #"session expired|could not be refreshed|token.*expired|invalid_grant|not logged in|not authenticated|unauthenticated|please (?:log ?in|sign ?in|authenticate)|run [`'"]?(?:gemini|agy)[`'"]? to sign in|auth(?:entication)? (?:failed|required|error)|invalid (?:api ?key|credentials)|api[ _]?key.*(?:not valid|invalid|missing)|unauthori[sz]ed|\b401\b"#,
    "i"
  )

  /** An absolute path on this machine (not a UNC network share). */
  public static func isLocalAbsolute(_ path: String) -> Bool {
    path.hasPrefix("/") && !uncRegex.test(path)
  }

  /** path.posix.basename (trailing slashes ignored). */
  static func basename(_ path: String) -> String {
    var s = Substring(path)
    while s.count > 1, s.hasSuffix("/") { s = s.dropLast() }
    if s == "/" { return "" }
    return String(s.split(separator: "/", omittingEmptySubsequences: false).last ?? "")
  }

  /** True when `path` points to the Google Antigravity CLI (`agy`). */
  public static func isAgyFile(_ path: String) -> Bool {
    agyFileRegex.test(basename(path))
  }

  /** Only ever run something that is plainly the Gemini CLI (`gemini`) or Antigravity CLI (`agy`). */
  public static func isGeminiFile(_ path: String) -> Bool {
    geminiFileRegex.test(basename(path))
  }

  /**
   * Finds the Gemini/Antigravity CLI executable: a configured local absolute path first, then
   * Antigravity CLI (`agy` in Gemini.app or on PATH), then standalone `gemini` via `MacSystem.searchDirs`.
   */
  public static func findGemini(
    _ configured: String = "",
    env: [String: String] = ProcessInfo.processInfo.environment,
    home: String = NSHomeDirectory(),
    shellPath: [String] = [],
    exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
  ) -> (path: String, source: String)? {
    if !configured.isEmpty {
      return isGeminiFile(configured) && isLocalAbsolute(configured) && exists(configured)
        ? (configured, "settings")
        : nil
    }
    for bundleAgy in [
      "/Applications/Gemini.app/Contents/Helpers/agy",
      MacSystem.join(home, "Applications", "Gemini.app", "Contents", "Helpers", "agy"),
    ] {
      if exists(bundleAgy) { return (bundleAgy, "antigravity-app") }
    }
    let dirs = MacSystem.searchDirs(env: env, home: home, shellPath: shellPath)
    for dir in dirs {
      let file = MacSystem.join(dir, "agy")
      if exists(file) { return (file, "path") }
    }
    for dir in dirs {
      let file = MacSystem.join(dir, "gemini")
      if exists(file) { return (file, "path") }
    }
    return nil
  }

  /** Gemini CLI or Google API sign-in is missing or expired (as opposed to a rate limit or crash). */
  public static func isGeminiSignInProblem(_ text: String) -> Bool {
    signInRegex.test(text)
  }

  /** Inspects `~/.gemini/oauth_creds.json` (or `$GEMINI_CLI_HOME/.gemini`) without touching the network. */
  public static func readCachedOAuth(
    home: String = NSHomeDirectory(),
    env: [String: String] = ProcessInfo.processInfo.environment,
    nowMs: Double = Date().timeIntervalSince1970 * 1000
  ) -> (found: Bool, valid: Bool, expired: Bool) {
    let root = (env["GEMINI_CLI_HOME"].flatMap { $0.isEmpty ? nil : $0 }) ?? home
    guard !root.isEmpty else { return (false, false, false) }
    let file = MacSystem.join(root, ".gemini", "oauth_creds.json")
    guard FileManager.default.fileExists(atPath: file) else { return (false, false, false) }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
          let parsed = try? JSONValue.parse(data),
          case .object(let obj) = parsed else {
      return (true, false, false)
    }
    let hasRefresh = !(obj["refresh_token"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    let hasAccess = !(obj["access_token"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    if hasRefresh { return (true, true, false) }
    if hasAccess {
      if let expiry = obj["expiry_date"]?.doubleValue, expiry.isFinite, expiry > 0, expiry <= nowMs {
        return (true, false, true)
      }
      return (true, true, false)
    }
    return (true, false, false)
  }

  /** The Mac sign-in's .command file: removes itself, then launches Gemini/Antigravity CLI interactively in Terminal. */
  public static func geminiSignInScript(file: String, geminiPath: String) -> String {
    if isAgyFile(geminiPath) {
      return "#!/bin/sh\nrm -f \(Brain.shellQuote(file))\nexec env -u GEMINI_HOME \(Brain.shellQuote(geminiPath))\n"
    }
    return "#!/bin/sh\nrm -f \(Brain.shellQuote(file))\nexec \(Brain.shellQuote(geminiPath))\n"
  }
}
