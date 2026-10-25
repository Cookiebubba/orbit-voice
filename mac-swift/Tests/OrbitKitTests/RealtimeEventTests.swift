// The /voice protocol: every event the page handles parses, unknown ones are kept, and what the
// client sends is what src/server.js reads.
import XCTest
@testable import OrbitKit

final class RealtimeEventTests: XCTestCase {
  func p(_ s: String) -> ServerEvent? { ServerEvent.parse(s) }

  func testBridgeEvents() {
    XCTAssertEqual(p(#"{"type":"bridge.ready","model":"grok-x","voice":"eve"}"#), .bridgeReady(model: "grok-x", voice: "eve"))
    XCTAssertEqual(p(#"{"type":"bridge.error","message":"No key"}"#), .bridgeError(message: "No key"))
    XCTAssertEqual(p(#"{"type":"bridge.closed","code":1006,"reason":""}"#), .bridgeClosed(code: 1006, reason: ""))
    XCTAssertEqual(p(#"{"type":"bridge.sleep"}"#), .bridgeSleep)
    XCTAssertEqual(p(#"{"type":"bridge.announce","ok":false,"reason":"too soon"}"#), .bridgeAnnounce(ok: false, reason: "too soon"))
    XCTAssertEqual(p(#"{"type":"bridge.announce_ready","spoke":true}"#), .bridgeAnnounceReady(spoke: true))
    XCTAssertEqual(p(#"{"type":"bridge.session","title":"Orbit"}"#), .bridgeSession(title: "Orbit"))
    XCTAssertEqual(p(#"{"type":"bridge.draft","draft":{"id":3,"text":"Fix it","targetTitle":null}}"#), .bridgeDraft(VoiceDraft(id: 3, text: "Fix it", targetTitle: nil)))
    XCTAssertEqual(p(#"{"type":"bridge.draft","draft":null}"#), .bridgeDraft(nil))
    XCTAssertEqual(p(#"{"type":"bridge.copied","chars":120,"preview":"abc"}"#), .bridgeCopied(chars: 120, preview: "abc"))
    XCTAssertEqual(p(#"{"type":"bridge.avatar","action":"wave","fast":true}"#), .bridgeAvatar(action: "wave", fast: true))
    XCTAssertEqual(p(#"{"type":"bridge.tool","name":"send_draft","args":"{}"}"#), .bridgeTool(name: "send_draft"))
    XCTAssertEqual(p(#"{"type":"bridge.tool_result","name":"x","result":{"ok":false}}"#), .bridgeToolResult(name: "x", result: ["ok": false]))
    XCTAssertEqual(p(#"{"type":"bridge.emote","item_id":"i","response_id":"r","cue":"happy","at":12}"#), .bridgeEmote(itemId: "i", responseId: "r", cue: "happy", at: 12))
    XCTAssertEqual(p(#"{"type":"bridge.sent","text":"hi"}"#), .bridgeSent(text: "hi"))
  }

  func testGrokEvents() {
    XCTAssertEqual(p(#"{"type":"response.output_audio.delta","response_id":"r1","item_id":"a","delta":"AAAA"}"#), .audioDelta(delta: "AAAA", responseId: "r1", emote: nil))
    XCTAssertEqual(p(#"{"type":"response.audio.delta","delta":"AAAA","emote":{"name":"nod"}}"#), .audioDelta(delta: "AAAA", responseId: nil, emote: "nod"))
    XCTAssertEqual(p(#"{"type":"response.output_audio.done","response_id":"r1"}"#), .audioDone(responseId: "r1"))
    XCTAssertEqual(p(#"{"type":"response.created","response":{"id":"r9"}}"#), .responseCreated(id: "r9"))
    XCTAssertEqual(p(#"{"type":"response.done","response":{"id":"r9","status":"cancelled"}}"#), .responseDone(id: "r9", status: "cancelled"))
    XCTAssertEqual(p(#"{"type":"input_audio_buffer.speech_started","item_id":"x"}"#), .speechStarted)
    XCTAssertEqual(p(#"{"type":"input_audio_buffer.committed"}"#), .speechStopped)
    XCTAssertEqual(p(#"{"type":"error","error":{"message":"bad"}}"#), .error(message: "bad"))
    XCTAssertEqual(p(#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"u1","transcript":"yes"}"#),
                   .inputTranscription(type: "conversation.item.input_audio_transcription.completed", itemId: "u1", transcript: "yes", delta: nil))
    XCTAssertEqual(p(#"{"type":"response.output_audio_transcript.delta","item_id":"g","delta":"Hi"}"#),
                   .outputText(type: "response.output_audio_transcript.delta", itemId: "g", responseId: nil, delta: "Hi", transcript: nil))
    XCTAssertEqual(p(#"{"type":"response.text.delta","response_id":"r","delta":"x"}"#),
                   .outputText(type: "response.text.delta", itemId: nil, responseId: "r", delta: "x", transcript: nil))
  }

  func testUnknownAndMalformedAreTolerated() {
    if case .unknown(let t, _)? = p(#"{"type":"session.updated","session":{}}"#) { XCTAssertEqual(t, "session.updated") } else { XCTFail() }
    if case .unknown(let t, _)? = p(#"{"type":"bridge.anywhere","action":"stop_all"}"#) { XCTAssertEqual(t, "bridge.anywhere") } else { XCTFail() }
    if case .unknown(let t, _)? = p(#"{"nope":1}"#) { XCTAssertEqual(t, "") } else { XCTFail() }
    XCTAssertNil(p("not json"))
    XCTAssertNil(p("[1,2]"))
    // Numbers as ids still name the reply (String(evt.response_id) in the page).
    XCTAssertEqual(p(#"{"type":"response.created","response":{"id":7}}"#), .responseCreated(id: "7"))
  }

  func testClientMessagesAreWhatTheBridgeReads() throws {
    XCTAssertEqual(ClientMessage.audioAppend(base64: "QUJD").text, #"{"type":"input_audio_buffer.append","audio":"QUJD"}"#)
    let parsed = try JSONValue.parse(ClientMessage.audioAppend(base64: "QUJD").text)
    XCTAssertEqual(parsed["audio"], "QUJD")
    XCTAssertEqual(try JSONValue.parse(ClientMessage.audioClear.text), ["type": "input_audio_buffer.clear"])
    XCTAssertEqual(try JSONValue.parse(ClientMessage.uiState(asleep: true).text), ["type": "ui.state", "asleep": true])
    XCTAssertEqual(try JSONValue.parse(ClientMessage.uiText("hé \"x\"").text), ["type": "ui.text", "text": "hé \"x\""])
    XCTAssertEqual(try JSONValue.parse(ClientMessage.uiListenWindow.text), ["type": "ui.listen_window"])
    let bye = ClientMessage.uiBye(ByeReport(reason: .tapTimeout, audio: "running", scheduled: 1.26, played: 1.24, lead: 0.031, maxLead: 0.5, cut: 1, kept: 2))
    XCTAssertEqual(try JSONValue.parse(bye.text), ["type": "ui.bye", "reason": "tap_timeout", "audio": "running", "scheduled": 1.3, "played": 1.2, "lead": 0, "maxLead": 0.5, "cut": 1, "kept": 2])
  }

  func testByeReasonsAreTheBridgesList() {
    // src/server.js PAGE_REASONS
    XCTAssertEqual(Set(ByeReason.allCases.map(\.rawValue)), ["user", "sleep", "idle", "tap_timeout", "draft_hold", "listen_expired", "heard_no_words", "announce_max", "bridge", "mic_error", "closed", "other"])
  }

  func testJSStringConversions() {
    XCTAssertEqual(jsString(nil), "")
    XCTAssertEqual(jsString(.null), "")
    XCTAssertEqual(jsString(3), "3")
    XCTAssertEqual(jsString(2.5), "2.5")
    XCTAssertEqual(jsString(["a": 1]), "[object Object]")
    XCTAssertEqual(jsString(true), "true")
  }
}
