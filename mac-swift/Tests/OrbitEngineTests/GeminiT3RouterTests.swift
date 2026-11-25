// Unit tests for Gemini + T3 Code + SP3 Router parity in OrbitEngine.
import Foundation
import XCTest
@testable import OrbitEngine
@testable import OrbitKit

final class GeminiT3RouterTests: XCTestCase {

  // MARK: - EngineConfig & SettingsSchema parity for new keys

  func testEngineConfigSanitizesAllNewKeys() {
    // Valid values
    let valid = EngineConfig.sanitize([
      "voiceEngine": "gemini-live",
      "helperEngine": "gemini",
      "geminiVoice": "Zephyr",
      "geminiVoiceModel": "gemini-2.5-pro",
      "geminiLiveModel": "gemini-2.0-flash-live-001",
      "geminiPath": "/opt/homebrew/bin/gemini",
      "brainProvider": "gemini",
      "targetBackend": "t3-code",
      "t3Endpoint": "http://127.0.0.1:3773/bridge///?foo=1#bar",
      "routingDriftGuard": false,
      "routingDriftThreshold": 0.999,
      "routingQueueBusy": "false",
    ])
    XCTAssertEqual(valid["voiceEngine"], "gemini-live")
    XCTAssertEqual(valid["helperEngine"], "gemini")
    XCTAssertEqual(valid["geminiVoice"], "Zephyr")
    XCTAssertEqual(valid["geminiVoiceModel"], "gemini-2.5-pro")
    XCTAssertEqual(valid["geminiLiveModel"], "gemini-2.0-flash-live-001")
    XCTAssertEqual(valid["geminiPath"], "/opt/homebrew/bin/gemini")
    XCTAssertEqual(valid["brainProvider"], "gemini")
    XCTAssertEqual(valid["targetBackend"], "t3-code")
    XCTAssertEqual(valid["t3Endpoint"], "http://127.0.0.1:3773/bridge")
    XCTAssertEqual(valid["routingDriftGuard"], false)
    XCTAssertEqual(valid["routingDriftThreshold"], 0.98)
    XCTAssertEqual(valid["routingQueueBusy"], false)

    // Lower clamp & empty resets
    let clamped = EngineConfig.sanitize([
      "voiceEngine": "gemini-cli",
      "t3Endpoint": "",
      "geminiPath": "",
      "routingDriftThreshold": 0.1,
    ])
    XCTAssertEqual(clamped["voiceEngine"], "gemini-cli")
    XCTAssertEqual(clamped["t3Endpoint"], "")
    XCTAssertEqual(clamped["geminiPath"], "")
    XCTAssertEqual(clamped["routingDriftThreshold"], 0.5)

    // Localhost default port stripping
    let localhost = EngineConfig.sanitize([
      "t3Endpoint": "http://LOCALHOST:80/mcp/",
    ])
    XCTAssertEqual(localhost["t3Endpoint"], "http://localhost/mcp")

    // Invalid values rejected
    let invalid = EngineConfig.sanitize([
      "voiceEngine": "whisper",
      "helperEngine": "unknown",
      "geminiVoice": "NotAVoice",
      "geminiVoiceModel": "gpt-4o",
      "geminiLiveModel": "not-gemini-model",
      "geminiPath": "/usr/local/bin/notgemini",
      "brainProvider": "openai",
      "targetBackend": "vscode",
      "t3Endpoint": "https://evil.example.com:3773",
      "routingDriftThreshold": "nope",
    ])
    XCTAssertTrue(invalid.isEmpty, "all invalid inputs must be dropped: \(invalid)")

    // Relative / UNC / shell-char geminiPath rejected
    XCTAssertTrue(EngineConfig.sanitize(["geminiPath": "relative/gemini"]).isEmpty)
    XCTAssertTrue(EngineConfig.sanitize(["geminiPath": "//server/share/gemini"]).isEmpty)
    XCTAssertTrue(EngineConfig.sanitize(["geminiPath": "/usr/bin/gemini?bad"]).isEmpty)

    // Non-http(s) and overlong t3Endpoint rejected
    XCTAssertTrue(EngineConfig.sanitize(["t3Endpoint": "ftp://127.0.0.1:3773"]).isEmpty)
    XCTAssertTrue(EngineConfig.sanitize(["t3Endpoint": .string("http://127.0.0.1:3773/" + String(repeating: "a", count: 200))]).isEmpty)
  }

  func testEngineForPassesThroughGeminiAndPreservesLegacyBehavior() {
    XCTAssertEqual(EngineConfig.engineFor(saved: "gemini-cli", hadFile: false, hasKey: false), "gemini-cli")
    XCTAssertEqual(EngineConfig.engineFor(saved: "gemini-live", hadFile: true, hasKey: true), "gemini-live")
    XCTAssertEqual(EngineConfig.engineFor(saved: "claude", hadFile: true, hasKey: true), "claude")
    XCTAssertEqual(EngineConfig.engineFor(saved: "grok", hadFile: false, hasKey: false), "grok")
    XCTAssertEqual(EngineConfig.engineFor(saved: nil, hadFile: false, hasKey: false), "claude")
    XCTAssertEqual(EngineConfig.engineFor(saved: nil, hadFile: true, hasKey: false), "grok")
    XCTAssertEqual(EngineConfig.engineFor(saved: nil, hadFile: false, hasKey: true), "grok")
  }

  // MARK: - Router.swift: Ranking

  func testRankCandidatesPrefersMatchingFileAndProject() {
    let now: Double = 1_700_000_000_000
    let billing = SessionContext(
      id: "s-billing",
      title: "Fix Stripe webhook retries",
      project: "payments-api",
      branch: "fix/stripe-retries",
      status: "idle",
      lastActivityAt: now - 120_000,
      lastFocusedAt: now - 120_000,
      recentFiles: ["src/billing/webhooks.ts", "test/webhooks.test.ts"],
      lastMessages: ["Investigating idempotency key handling in webhooks.ts"]
    )
    let frontend = SessionContext(
      id: "s-frontend",
      title: "Update landing hero layout",
      project: "marketing-web",
      branch: "feat/hero-refresh",
      status: "idle",
      lastActivityAt: now - 60_000,
      lastFocusedAt: now - 60_000,
      recentFiles: ["src/components/Hero.tsx"],
      lastMessages: ["Adjusted responsive spacing for mobile hero banner"]
    )

    let res = SessionRouter.rankCandidates(
      query: "Can you check webhooks.ts in payments-api?",
      contexts: [frontend, billing],
      activeId: "s-frontend",
      now: now
    )
    XCTAssertEqual(res.best?.id, "s-billing")
    XCTAssertFalse(res.suggestNew)
    XCTAssertTrue(res.reasons.contains("fileMatch"))
    XCTAssertTrue(res.reasons.contains("projectMatch"))
    XCTAssertFalse(res.ambiguous)
  }

  func testRankCandidatesSuggestsNewWorkOnExplicitSignal() {
    let now: Double = 1_700_000_000_000
    let existing = SessionContext(
      id: "s-1",
      title: "Refactor auth middleware",
      project: "backend",
      status: "idle",
      lastActivityAt: now - 600_000
    )

    let res = SessionRouter.rankCandidates(
      query: "Start a brand new project from scratch to build a recipe tracker app",
      contexts: [existing],
      activeId: "s-1",
      now: now
    )
    XCTAssertTrue(res.suggestNew)
    XCTAssertNil(res.best)
    XCTAssertTrue(res.reasons.contains("newWorkSignal"))
  }

  func testRankCandidatesBareFollowUpFavorsWaitingAndSpokenSession() {
    let now: Double = 1_700_000_000_000
    let idle = SessionContext(id: "s-idle", title: "Docs cleanup", project: "docs", status: "idle", lastActivityAt: now - 30_000)
    let waiting = SessionContext(id: "s-wait", title: "Deploy staging", project: "infra", status: "waiting", waiting: true, lastActivityAt: now - 20_000)

    XCTAssertTrue(SessionRouter.isBareFollowUp("yes go ahead"))
    XCTAssertFalse(SessionRouter.isBareFollowUp("edit src/router.swift please"))

    let res = SessionRouter.rankCandidates(
      query: "yes go ahead",
      contexts: [idle, waiting],
      activeId: "s-idle",
      lastSpokenId: "s-wait",
      lastSpokenAt: now - 5_000,
      now: now
    )
    XCTAssertEqual(res.best?.id, "s-wait")
    XCTAssertFalse(res.suggestNew)
    XCTAssertTrue(res.reasons.contains("waitingForInput"))
  }

  // MARK: - Router.swift: Topic Drift Guard

  func testTopicDriftDetectsOtherSessionFileAndIgnoresBareFollowUp() async {
    let active = SessionContext(
      id: "s-auth",
      title: "OAuth PKCE login",
      project: "auth-service",
      recentFiles: ["src/oauth.ts"],
      lastMessages: ["Working on PKCE verifier exchange"]
    )
    let other = SessionContext(
      id: "s-ui",
      title: "Dark mode palette",
      project: "design-system",
      recentFiles: ["src/theme/tokens.css"],
      lastMessages: ["Tweaking surface contrast tokens"]
    )

    // Bare follow-up never drifts
    let follow = await SessionRouter.checkTopicDrift(
      prompt: "yes run the tests",
      activeContext: active,
      otherContexts: [other]
    )
    XCTAssertFalse(follow.drifted)

    // Prompt targeting other session's file triggers advisory drift warning
    let drift = await SessionRouter.checkTopicDrift(
      prompt: "Update tokens.css in design-system to increase contrast",
      activeContext: active,
      otherContexts: [other]
    )
    XCTAssertTrue(drift.drifted)
    XCTAssertGreaterThanOrEqual(drift.confidence, SessionRouter.defaultDriftThreshold)
    XCTAssertEqual(drift.suggestedSession?.id, "s-ui")
    XCTAssertEqual(drift.reason, "other_session_file_match")
    XCTAssertNotNil(drift.warning)

    // Explicit new topic shift triggers suggestNew
    let newTopic = await SessionRouter.checkTopicDrift(
      prompt: "Let's start a fresh project from scratch for an invoice parser",
      activeContext: active,
      otherContexts: [other]
    )
    XCTAssertTrue(newTopic.drifted)
    XCTAssertTrue(newTopic.suggestNew)
    XCTAssertNil(newTopic.suggestedSession)
  }

  // MARK: - Router.swift: PromptQueue hard waiting/working guard

  func testPromptQueueHardBlocksWhenWorkingOrWaitingAndRespectsFIFO() {
    let clock = Locked<Double>(1_000_000)
    let queue = PromptQueue(maxPerSession: 2, maxAgeMs: 60_000, now: { clock.get() })

    let e1 = queue.enqueue(sessionId: "sess-1", prompt: "First task")
    let e2 = queue.enqueue(sessionId: "sess-1", prompt: "Second task")
    let e3 = queue.enqueue(sessionId: "sess-1", prompt: "Third task (overflow)")
    XCTAssertTrue(e1.ok)
    XCTAssertEqual(e1.position, 1)
    XCTAssertTrue(e2.ok)
    XCTAssertEqual(e2.position, 2)
    XCTAssertFalse(e3.ok)
    XCTAssertEqual(e3.error, "queue_full")

    // CRITICAL: Never dequeue while working or waiting (or both)
    XCTAssertNil(queue.takeNextIfReady(sessionId: "sess-1", working: true, waiting: false))
    XCTAssertNil(queue.takeNextIfReady(sessionId: "sess-1", working: false, waiting: true))
    XCTAssertNil(queue.takeNextIfReady(sessionId: "sess-1", working: true, waiting: true))
    XCTAssertEqual(queue.list(sessionId: "sess-1").count, 2, "blocked calls must not mutate queue")

    // Ready (idle): dequeues FIFO
    let first = queue.takeNextIfReady(sessionId: "sess-1", working: false, waiting: false)
    XCTAssertEqual(first?.prompt, "First task")

    // Expiration prunes stale entries
    clock.set(1_000_000 + 61_000)
    XCTAssertNil(queue.takeNextIfReady(sessionId: "sess-1", working: false, waiting: false))
    XCTAssertTrue(queue.list(sessionId: "sess-1").isEmpty)
  }

  // MARK: - GeminiAuth.swift

  func testGeminiAuthCatalogsDiscoveryAndSignInDetection() {
    XCTAssertNotNil(GeminiAuth.GEMINI_VOICE_MODELS["gemini-2.5-flash"])
    XCTAssertNotNil(GeminiAuth.GEMINI_VOICE_MODELS["gemini-2.5-pro"])
    XCTAssertNotNil(GeminiAuth.GEMINI_VOICE_MODELS["gemini-2.5-flash-lite"])
    XCTAssertNotNil(GeminiAuth.GEMINI_LIVE_MODELS["gemini-2.5-flash-native-audio-preview-12-2025"])
    XCTAssertTrue(GeminiAuth.GEMINI_LIVE_VOICES.contains("Aoede"))
    XCTAssertEqual(GeminiAuth.GEMINI_LIVE_VOICES.count, 8)

    XCTAssertTrue(GeminiAuth.isGeminiFile("/opt/homebrew/bin/gemini"))
    XCTAssertTrue(GeminiAuth.isGeminiFile("/usr/local/bin/GEMINI.EXE"))
    XCTAssertFalse(GeminiAuth.isGeminiFile("/opt/homebrew/bin/gemini-cli"))
    XCTAssertFalse(GeminiAuth.isGeminiFile("/opt/homebrew/bin/bash"))

    // Configured path beats PATH; non-gemini or UNC paths are rejected
    let configured = GeminiAuth.findGemini(
      "/opt/custom/gemini",
      env: [:],
      home: "/Users/test",
      shellPath: [],
      exists: { $0 == "/opt/custom/gemini" }
    )
    XCTAssertEqual(configured?.path, "/opt/custom/gemini")
    XCTAssertEqual(configured?.source, "settings")
    XCTAssertNil(GeminiAuth.findGemini("relative/gemini", env: [:], home: "/Users/test", shellPath: [], exists: { _ in true }))
    XCTAssertNil(GeminiAuth.findGemini("//share/bin/gemini", env: [:], home: "/Users/test", shellPath: [], exists: { _ in true }))

    let fromPath = GeminiAuth.findGemini(
      "",
      env: ["PATH": "/custom/bin:/usr/bin"],
      home: "/Users/test",
      shellPath: [],
      exists: { $0 == "/custom/bin/gemini" }
    )
    XCTAssertEqual(fromPath?.path, "/custom/bin/gemini")
    XCTAssertEqual(fromPath?.source, "path")

    // Sign-in failure detection
    XCTAssertTrue(GeminiAuth.isGeminiSignInProblem("Error: HTTP 401 Unauthorized"))
    XCTAssertTrue(GeminiAuth.isGeminiSignInProblem("invalid_grant: token has been expired or revoked"))
    XCTAssertTrue(GeminiAuth.isGeminiSignInProblem("Please sign in or run `gemini` to sign in"))
    XCTAssertFalse(GeminiAuth.isGeminiSignInProblem("HTTP 429 rate limit exceeded"))
  }

  // MARK: - T3Target.swift

  func testT3TargetLoopbackValidation() {
    // Valid loopback endpoints normalized to /mcp/call
    if case .success(let u) = T3Target.parseEndpoint("http://127.0.0.1:3773/") {
      XCTAssertEqual(u.absoluteString, "http://127.0.0.1:3773/mcp/call")
    } else {
      XCTFail("expected 127.0.0.1 loopback to succeed")
    }
    if case .success(let u) = T3Target.parseEndpoint("http://localhost:3773/api/mcp/call?foo=1#frag") {
      XCTAssertEqual(u.absoluteString, "http://localhost:3773/api/mcp/call")
    } else {
      XCTFail("expected localhost loopback to succeed")
    }
    if case .success(let u) = T3Target.parseEndpoint("http://[::1]:3773") {
      XCTAssertEqual(u.absoluteString, "http://[::1]:3773/mcp/call")
    } else {
      XCTFail("expected IPv6 ::1 loopback to succeed")
    }

    // Reject empty, non-http, and remote hosts by default
    XCTAssertEqual(T3Target.parseEndpoint(""), .failure(.notConfigured))
    if case .failure(.invalidEndpoint) = T3Target.parseEndpoint("ftp://127.0.0.1:3773") {} else {
      XCTFail("expected ftp scheme to be rejected")
    }
    if case .failure(.remoteEndpointDisallowed) = T3Target.parseEndpoint("https://example.com:3773") {} else {
      XCTFail("expected remote host to be rejected when allowRemote is false")
    }
    // allowRemote overrides loopback check
    if case .success(let u) = T3Target.parseEndpoint("https://example.com:3773", allowRemote: true) {
      XCTAssertEqual(u.absoluteString, "https://example.com:3773/mcp/call")
    } else {
      XCTFail("expected remote host to succeed with allowRemote: true")
    }
  }

  func testT3TargetMCPCallsAndBearerAuth() async {
    let seenRequests = Locked<[(url: String, auth: String?, name: String, args: JSONValue)]>([])

    let target = T3Target(
      endpoint: "http://127.0.0.1:3773",
      token: "secret-test-token",
      transport: { req in
        let body = (try? JSONValue.parse(req.httpBody ?? Data())) ?? .null
        let name = body["name"]?.stringValue ?? ""
        let args = body["arguments"] ?? .object([:])
        seenRequests.update {
          $0.append((req.url?.absoluteString ?? "", req.value(forHTTPHeaderField: "Authorization"), name, args))
        }
        switch name {
        case "t3_thread_list":
          let payload: JSONValue = [
            "threads": [
              ["id": "t-1", "title": "Router parity", "project": "orbit-voice", "status": "idle"],
              ["id": "t-2", "title": "UI polish", "project": "orbit-voice", "status": "waiting"],
            ],
          ]
          return (payload.data(), 200)
        case "t3_thread_launch":
          return (JSONValue.object(["threadId": "t-3", "title": args["title"] ?? "New thread", "branch": "feat/new"]).data(), 200)
        case "t3_thread_send":
          return (JSONValue.object(["runId": "r-1", "mode": args["mode"] ?? "auto"]).data(), 200)
        case "t3_thread_interrupt":
          return (JSONValue.object(["interrupted": true]).data(), 200)
        case "t3_pending_request":
          if args["action"] == "list" {
            return (JSONValue.object(["requestIds": ["req-1"]]).data(), 200)
          } else if args["action"] == "read" {
            return (JSONValue.object(["requestId": "req-1", "question": "Proceed?", "options": ["Yes", "No"]]).data(), 200)
          } else {
            return (JSONValue.object(["ok": true]).data(), 200)
          }
        default:
          return (JSONValue.object(["ok": false, "error": "unknown"]).data(), 400)
        }
      }
    )

    let listed = await target.listSessions()
    XCTAssertTrue(listed.ok)
    XCTAssertEqual(listed.sessions.count, 2)
    XCTAssertEqual(listed.sessions[1].waiting, true)

    let switched = await target.switchSession("UI polish")
    XCTAssertTrue(switched.ok)
    XCTAssertEqual(switched.threadId, "t-2")
    XCTAssertEqual(target.activeThreadId, "t-2")

    let launched = await target.newSession(title: "Worktree task", message: "Hello", projectId: "proj-1", worktree: true, branch: "feat/new")
    XCTAssertTrue(launched.ok)
    XCTAssertEqual(launched.threadId, "t-3")

    let sent = await target.sendPrompt("Run tests", mode: "queue")
    XCTAssertTrue(sent.ok)
    XCTAssertTrue(sent.queued)
    XCTAssertEqual(sent.threadId, "t-3")

    let interrupted = await target.interruptSession()
    XCTAssertTrue(interrupted.ok)
    XCTAssertTrue(interrupted.stopped)

    let pending = await target.getPendingRequest()
    XCTAssertTrue(pending.ok)
    XCTAssertEqual(pending.pending?.id, "req-1")
    XCTAssertEqual(pending.pending?.choices.count, 2)

    let answered = await target.answerPendingRequest(choice: "Yes")
    XCTAssertTrue(answered.ok)
    XCTAssertEqual(answered.requestId, "req-1")

    let reqs = seenRequests.get()
    XCTAssertFalse(reqs.isEmpty)
    for r in reqs {
      XCTAssertEqual(r.url, "http://127.0.0.1:3773/mcp/call")
      XCTAssertEqual(r.auth, "Bearer secret-test-token")
    }
  }

  // MARK: - Alfred Persona & Kokoro English TTS parity

  func testEngineConfigSanitizesPersonaAndKokoroKeys() {
    // Defaults match src/config.js
    XCTAssertEqual(EngineConfig.defaults["persona"], "default")
    XCTAssertEqual(EngineConfig.defaults["claudeVoiceTts"], "kitten")
    XCTAssertEqual(EngineConfig.defaults["kokoroVoice"], 9)

    // Valid values accepted
    let valid = EngineConfig.sanitize([
      "persona": "alfred",
      "claudeVoiceTts": "kokoro-en",
      "kokoroVoice": 10,
    ])
    XCTAssertEqual(valid["persona"], "alfred")
    XCTAssertEqual(valid["claudeVoiceTts"], "kokoro-en")
    XCTAssertEqual(valid["kokoroVoice"], 10)

    // String coercion & boundary values
    let boundaries = EngineConfig.sanitize([
      "persona": "default",
      "claudeVoiceTts": "kitten",
      "kokoroVoice": "0",
    ])
    XCTAssertEqual(boundaries["persona"], "default")
    XCTAssertEqual(boundaries["claudeVoiceTts"], "kitten")
    XCTAssertEqual(boundaries["kokoroVoice"], 0)

    // Invalid values rejected
    let invalid = EngineConfig.sanitize([
      "persona": "jarvis",
      "claudeVoiceTts": "piper",
      "kokoroVoice": 54,
    ])
    XCTAssertTrue(invalid.isEmpty, "invalid persona/TTS values must be dropped: \(invalid)")
    XCTAssertTrue(EngineConfig.sanitize(["kokoroVoice": -1]).isEmpty)
    XCTAssertTrue(EngineConfig.sanitize(["kokoroVoice": 4.5]).isEmpty)
    XCTAssertTrue(EngineConfig.sanitize(["kokoroVoice": "not-a-number"]).isEmpty)

    // SettingsSchema parity
    XCTAssertEqual(SettingsSchema.sanitize("persona", "alfred"), "alfred")
    XCTAssertNil(SettingsSchema.sanitize("persona", "jarvis"))
    XCTAssertEqual(SettingsSchema.sanitize("claudeVoiceTts", "kokoro-en"), "kokoro-en")
    XCTAssertEqual(SettingsSchema.sanitize("claudeVoiceTts", "kokoro-v1"), "kokoro-v1")
    XCTAssertNil(SettingsSchema.sanitize("claudeVoiceTts", "piper"))
    XCTAssertEqual(SettingsSchema.sanitize("kokoroVoice", 9), 9)
    XCTAssertEqual(SettingsSchema.sanitize("kokoroVoice", 24), 24)
    XCTAssertNil(SettingsSchema.sanitize("kokoroVoice", 54))
    XCTAssertNil(SettingsSchema.sanitize("kokoroVoice", -1))
  }

  func testAgentAlfredPersonaAndGeminiLiveAccentHint() throws {
    XCTAssertTrue(Agent.contextSettings.contains("persona"))
    XCTAssertEqual(Agent.contextSettings.firstIndex(of: "persona"), 2, "persona follows showOrb as in src/agent.js")
    XCTAssertTrue(Agent.personaOk("default"))
    XCTAssertTrue(Agent.personaOk("alfred"))
    XCTAssertFalse(Agent.personaOk("jarvis"))
    XCTAssertEqual(Agent.personaPrompt("default"), "")
    XCTAssertEqual(Agent.personaPrompt("unknown"), "")

    let alfredPrompt = Agent.personaPrompt("alfred", engine: "claude")
    XCTAssertTrue(alfredPrompt.hasPrefix("Who you are (Alfred):"))
    XCTAssertTrue(alfredPrompt.contains("aristocratic British chief of staff"))
    XCTAssertFalse(alfredPrompt.contains("Received Pronunciation (RP)"), "non-live engines omit live accent hint")

    let alfredLive = Agent.personaPrompt("alfred", engine: "gemini-live")
    XCTAssertTrue(alfredLive.hasPrefix(alfredPrompt + "\n- "))
    XCTAssertTrue(alfredLive.contains("British Received Pronunciation (RP) accent"))

    // Verify Agent.context injects Alfred persona (overriding default Orbit/avatar persona) and appends RP hint on gemini-live
    var baseSettings = EngineConfig.defaults
    baseSettings["persona"] = "alfred"
    baseSettings["voiceEngine"] = "claude"
    let claudeCtx = Agent.context(baseSettings)
    XCTAssertTrue(claudeCtx.instructions.hasPrefix("Who you are (Alfred):"))
    XCTAssertFalse(claudeCtx.instructions.contains("Received Pronunciation (RP)"))
    XCTAssertFalse(claudeCtx.instructions.contains("You are Orbit, the voice of the Orbit app"))

    baseSettings["voiceEngine"] = "gemini-live"
    let liveCtx = Agent.context(baseSettings)
    XCTAssertTrue(liveCtx.instructions.hasPrefix(alfredLive))

    // Word-for-word parity against live src/personas.js when Node is available
    let personasURL = Oracle.repo.appendingPathComponent("src/personas.js").absoluteString
    if let liveOut = try? Oracle.node("""
      import { PERSONA_PRESETS, personaPrompt } from '\(personasURL)';
      console.log(JSON.stringify({
        claude: personaPrompt('alfred', { engine: 'claude' }),
        live: personaPrompt('alfred', { engine: 'gemini-live' }),
        def: personaPrompt('default', { engine: 'gemini-live' }),
        recommended: PERSONA_PRESETS.alfred.recommended,
      }));
      """),
       let v = try? JSONValue.parse(liveOut) {
      XCTAssertEqual(alfredPrompt, v["claude"]?.stringValue, "Alfred prompt must match src/personas.js word-for-word")
      XCTAssertEqual(alfredLive, v["live"]?.stringValue, "Alfred Gemini Live prompt must match src/personas.js word-for-word")
      XCTAssertEqual(Agent.personaPrompt("default", engine: "gemini-live"), v["def"]?.stringValue)
      XCTAssertEqual(Agent.personaPresets["alfred"]?.recommended, v["recommended"]?.objectValue)
    }
  }

  func testVoiceModelsKokoroTtsCatalogConfigAndReadiness() throws {
    XCTAssertEqual(VoiceModels.ttsIds, ["kitten", "kokoro-en", "kokoro-v1"])
    XCTAssertTrue(VoiceModels.ttsOk("kitten"))
    XCTAssertTrue(VoiceModels.ttsOk("kokoro-en"))
    XCTAssertTrue(VoiceModels.ttsOk("kokoro-v1"))
    XCTAssertFalse(VoiceModels.ttsOk("piper"))

    let kokoro = try XCTUnwrap(VoiceModels.tts.first { $0.id == "kokoro-en" })
    XCTAssertFalse(kokoro.bundled)
    XCTAssertEqual(kokoro.download?.sha256, "c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd")
    XCTAssertEqual(kokoro.download?.size, 103_248_205)
    XCTAssertEqual(kokoro.download?.url, "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2")
    XCTAssertEqual(kokoro.files, ["model.int8.onnx", "voices.bin", "tokens.txt"])
    XCTAssertEqual(kokoro.voices.count, 11)
    XCTAssertEqual(kokoro.voices.first?.id, "9")
    XCTAssertEqual(kokoro.voices.first?.speaker, "bm_george")

    // ttsConfig for kitten vs kokoro-en vs unknown
    let root = "/tmp/orbit-voice-models-test"
    let kittenCfg = VoiceModels.ttsConfig(root: root, id: "kitten")
    XCTAssertEqual(kittenCfg["kitten"]?["model"], .string("\(root)/kitten-nano-en-v0_8-fp32/model.fp32.onnx"))
    let fallbackCfg = VoiceModels.ttsConfig(root: root, id: "unknown")
    XCTAssertEqual(fallbackCfg, kittenCfg)

    let kokoroCfg = VoiceModels.ttsConfig(root: root, id: "kokoro-en")
    XCTAssertEqual(kokoroCfg["kokoro"]?["model"], .string("\(root)/kokoro-int8-en-v0_19/model.int8.onnx"))
    XCTAssertEqual(kokoroCfg["kokoro"]?["voices"], .string("\(root)/kokoro-int8-en-v0_19/voices.bin"))
    XCTAssertEqual(kokoroCfg["kokoro"]?["tokens"], .string("\(root)/kokoro-int8-en-v0_19/tokens.txt"))
    XCTAssertEqual(kokoroCfg["kokoro"]?["dataDir"], .string("\(root)/kokoro-int8-en-v0_19/espeak-ng-data"))

    // Readiness and status on a temporary directory
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-kokoro-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmp) }

    let models = VoiceModels(root: tmp.path)
    XCTAssertFalse(models.ttsReady("kokoro-en"))
    XCTAssertFalse(models.ttsReady("unknown"))
    let idleStatus = models.ttsStatus()
    XCTAssertEqual(idleStatus["kokoro-en"]?["state"], "idle")
    XCTAssertEqual(idleStatus["kokoro-en"]?["mb"], 98)

    // Populate verified Kokoro files and confirm ttsReady + ttsStatus flip to ready
    let kDir = tmp.appendingPathComponent("kokoro-int8-en-v0_19")
    try FileManager.default.createDirectory(at: kDir, withIntermediateDirectories: true)
    for f in kokoro.files {
      try Data("stub".utf8).write(to: kDir.appendingPathComponent(f))
    }
    // Wrong sha256 stays unready
    try Data(#"{"sha256":"0000"}"#.utf8).write(to: kDir.appendingPathComponent("verified.json"))
    XCTAssertFalse(models.ttsReady("kokoro-en"))

    // Matching pinned sha256 becomes ready
    try Data(#"{"sha256":"c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd"}"#.utf8).write(to: kDir.appendingPathComponent("verified.json"))
    XCTAssertTrue(models.ttsReady("kokoro-en"))
    XCTAssertEqual(models.ttsStatus()["kokoro-en"]?["state"], "ready")
    XCTAssertEqual(models.ttsStatus()["kokoro-en"]?["percent"], 100)
  }
}
