// Whether Orbit can start talking, and what the main page says when it can't (ui/src/talk.js).
//
// Claude voice runs on the user's own Claude Code sign-in (their Claude plan): no xAI key. Grok voice
// needs an xAI key. The main page always shows (the avatar, the orb); a key is only asked for,
// inline, when someone tries to talk to Grok without one.
import Foundation

/** Why a try to talk couldn't start: Grok without a key, or Claude voice not ready. */
public enum TalkBlocked: String, Sendable { case grokKey = "grok-key", claude }

/** The inline notice on the main page. kind: grok-key, claude-missing, claude-signed-out, claude-models, claude-models-error. */
public struct TalkNotice: Equatable, Sendable {
  public var kind: String
  public var text: String
  public init(kind: String, text: String) {
    self.kind = kind
    self.text = text
  }
}

public enum Talk {
  public static let grokNeedsKey = "Grok voice needs an xAI key. Add one in Settings, or switch to Claude voice."

  // Installing Claude Code (Anthropic's own instructions, code.claude.com/docs/en/setup): the native
  // installer's one line for this Mac, and the guide for anyone who'd rather read it there.
  public static let claudeCodeGuide = URL(string: "https://code.claude.com/docs/en/setup")!
  /** The native installer's command (Terminal on a Mac; Orbit never runs it itself). */
  public static let claudeInstallCommand = "curl -fsSL https://claude.ai/install.sh | bash"
  /** Claude Code isn't here (the install command follows it, then the sign-in step). */
  public static let claudeCodeMissing = "Claude voice needs Claude Code on this computer. To install it, paste this into a terminal:"
  /** Found but not signed in. */
  public static let claudeNotSignedIn = "Claude Code isn't signed in. Run claude once in a terminal and sign in with your Claude account."
  /** The line under the install command: Claude Code runs on the user's own Claude sign-in. */
  public static let claudeSignInStep = "Then run claude once in a terminal and sign in with your Claude account."

  /** Claude voice, or Grok voice with a key saved. */
  public static func canTalk(engine: String?, hasKey: Bool) -> Bool {
    if engine == "claude" { return true }
    return engine == "grok" && hasKey
  }

  /**
   * The notice after a try to talk that couldn't start, or nil. `status`: GET /api/claude-voice
   * ({claudeFound, signedIn, models: {state, percent, error}}; signedIn null when it couldn't be checked,
   * which never blocks). It clears by itself once the reason is gone
   * (a key saved, Claude chosen, the models ready).
   */
  public static func notice(_ blocked: TalkBlocked?, engine: String?, hasKey: Bool, status: JSONValue?) -> TalkNotice? {
    if blocked == .grokKey { return canTalk(engine: engine, hasKey: hasKey) ? nil : TalkNotice(kind: "grok-key", text: grokNeedsKey) }
    guard blocked == .claude, engine == "claude", let status, !status.isNull else { return nil }
    if status["claudeFound"]?.boolValue != true { return TalkNotice(kind: "claude-missing", text: claudeCodeMissing) }
    if status["signedIn"]?.boolValue == false { return TalkNotice(kind: "claude-signed-out", text: claudeNotSignedIn) }
    let m = status["models"]
    let state = m?["state"]?.stringValue
    if state == "ready" { return nil }
    if state == "error" {
      let e = m?["error"]?.stringValue ?? ""
      return TalkNotice(kind: "claude-models-error", text: "Claude voice's speech models didn't download: \(e.isEmpty ? "unknown error" : e). Try again, or download them in Settings.")
    }
    // (Its percent is a whole number: the download's own count.)
    let pct = Int(m?["percent"]?.doubleValue ?? 0)
    return TalkNotice(kind: "claude-models", text: "Getting Claude voice ready: downloading its speech models\(state == "downloading" ? "… \(pct)%" : "…")")
  }

  /** Before a call starts on Claude voice: start the models' download if they're not here yet. */
  public static func needsModelDownload(_ status: JSONValue?) -> Bool {
    guard let status, status["claudeFound"]?.boolValue == true else { return false }
    let state = status["models"]?["state"]?.stringValue
    return state == "idle" || state == "error"
  }
}
