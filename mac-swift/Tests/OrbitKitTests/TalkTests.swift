// Opening Orbit never needs an xAI key (test/no-key-launch.test.js against the Swift port of
// ui/src/talk.js): Claude voice can always talk, Grok only with a key, and a try to talk that can't
// start says why, inline, until the reason is gone.
import XCTest
@testable import OrbitKit

final class TalkTests: XCTestCase {
  func testCanTalkClaudeVoiceAlwaysGrokOnlyWithAKey() {
    XCTAssertTrue(Talk.canTalk(engine: "claude", hasKey: false))
    XCTAssertTrue(Talk.canTalk(engine: "claude", hasKey: true))
    XCTAssertTrue(Talk.canTalk(engine: "grok", hasKey: true))
    XCTAssertFalse(Talk.canTalk(engine: "grok", hasKey: false))
    XCTAssertFalse(Talk.canTalk(engine: nil, hasKey: true), "still loading")
  }

  func testGrokWithoutAKeyTheNoticeSaysSoAndGoesOnceItCanTalk() {
    XCTAssertEqual(Talk.notice(.grokKey, engine: "grok", hasKey: false, status: nil), TalkNotice(kind: "grok-key", text: Talk.grokNeedsKey))
    XCTAssertEqual(Talk.grokNeedsKey, "Grok voice needs an xAI key. Add one in Settings, or switch to Claude voice.")
    XCTAssertNil(Talk.notice(.grokKey, engine: "grok", hasKey: true, status: nil), "a key saved")
    XCTAssertNil(Talk.notice(.grokKey, engine: "claude", hasKey: false, status: nil), "switched to Claude")
    XCTAssertNil(Talk.notice(nil, engine: "grok", hasKey: false, status: nil), "nothing shows before a try to talk")
  }

  func testClaudeVoiceNotReady() {
    func st(_ found: Bool, _ state: String, _ percent: Double = 0, _ error: String = "") -> JSONValue {
      ["claudeFound": .bool(found), "models": ["state": .string(state), "percent": .number(percent), "error": .string(error)]]
    }
    XCTAssertEqual(Talk.notice(.claude, engine: "claude", hasKey: false, status: st(false, "ready")), TalkNotice(kind: "claude-missing", text: Talk.claudeCodeMissing))
    // Found but signed out: its own line. Unknown (null) never blocks.
    let signedOut: JSONValue = ["claudeFound": .bool(true), "signedIn": .bool(false), "models": ["state": .string("ready")]]
    XCTAssertEqual(Talk.notice(.claude, engine: "claude", hasKey: false, status: signedOut), TalkNotice(kind: "claude-signed-out", text: Talk.claudeNotSignedIn))
    let unknown: JSONValue = ["claudeFound": .bool(true), "signedIn": .null, "models": ["state": .string("ready")]]
    XCTAssertNil(Talk.notice(.claude, engine: "claude", hasKey: false, status: unknown))
    XCTAssertEqual(Talk.notice(.claude, engine: "claude", hasKey: false, status: st(true, "downloading", 42))?.kind, "claude-models")
    XCTAssertTrue(Talk.notice(.claude, engine: "claude", hasKey: false, status: st(true, "downloading", 42))?.text.contains("42%") == true)
    XCTAssertEqual(Talk.notice(.claude, engine: "claude", hasKey: false, status: st(true, "idle"))?.kind, "claude-models")
    XCTAssertEqual(Talk.notice(.claude, engine: "claude", hasKey: false, status: st(true, "error", 0, "HTTP 503"))?.kind, "claude-models-error")
    XCTAssertTrue(Talk.notice(.claude, engine: "claude", hasKey: false, status: st(true, "error", 0, "HTTP 503"))?.text.contains("HTTP 503") == true)
    XCTAssertNil(Talk.notice(.claude, engine: "claude", hasKey: false, status: st(true, "ready")), "ready: the notice goes")
    XCTAssertNil(Talk.notice(.claude, engine: "grok", hasKey: false, status: st(true, "idle")), "not on Claude voice any more")
    // The download starts on a try to talk only when it isn't running or done (and Claude Code is here).
    XCTAssertTrue(Talk.needsModelDownload(st(true, "idle")))
    XCTAssertTrue(Talk.needsModelDownload(st(true, "error")))
    XCTAssertFalse(Talk.needsModelDownload(st(true, "downloading")))
    XCTAssertFalse(Talk.needsModelDownload(st(true, "ready")))
    XCTAssertFalse(Talk.needsModelDownload(st(false, "idle")))
    XCTAssertFalse(Talk.needsModelDownload(nil))
  }

  func testClaudeCodeMissingSaysHowToInstallIt() {
    // Anthropic's own one-line installer and guide (code.claude.com/docs/en/setup), as ui/src/talk.js has them for a Mac.
    XCTAssertEqual(Talk.claudeInstallCommand, "curl -fsSL https://claude.ai/install.sh | bash")
    XCTAssertEqual(Talk.claudeCodeGuide.absoluteString, "https://code.claude.com/docs/en/setup")
    XCTAssertEqual(Talk.claudeCodeMissing, "Claude voice needs Claude Code on this computer. To install it, paste this into a terminal:")
    XCTAssertEqual(Talk.claudeNotSignedIn, "Claude Code isn't signed in. Run claude once in a terminal and sign in with your Claude account.")
    XCTAssertEqual(ParityNotice.buttons(for: "claude-missing"), ["Copy", "Check again", "Setup guide", "Open Settings"])
    XCTAssertEqual(ParityNotice.buttons(for: "claude-signed-out"), ["Check again", "Open Settings"])
    XCTAssertEqual(ParityNotice.buttons(for: "grok-key"), ["Open Settings", "Use Claude voice"])
    XCTAssertEqual(ParityNotice.buttons(for: "claude-models-error"), ["Open Settings", "Try again"])
    XCTAssertEqual(ParityNotice.buttons(for: "claude-models"), [])
  }

  func testTheDefaultEngineIsClaude() {
    XCTAssertEqual(SettingsSchema.defaults["voiceEngine"], "claude")
  }
}
