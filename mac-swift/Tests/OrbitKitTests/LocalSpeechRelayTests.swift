// Local speech's relay: the words the core sends come out as audio deltas in the core's own order
// (a reply's end after its speech), the user's side never waits, and a cancel lets things through.
import XCTest
@testable import OrbitKit

final class LocalSpeechRelayTests: XCTestCase {
  final class Rig {
    var out: [JSONValue] = []
    var pending: [(String, ([Float]) -> Void)] = []
    lazy var relay = LocalSpeechRelay(speak: { [unowned self] text, _, _, done in self.pending.append((text, done)) },
                                      deliver: { [unowned self] t in self.out.append((try? JSONValue.parse(t)) ?? .null) })
    func say(_ text: String, _ id: String = "r1") { relay.receive(#"{"type":"response.output_audio.delta","response_id":"\#(id)","delta":"","text":"\#(text)","voice":{"sid":2,"speed":1.1}}"#) }
    func event(_ type: String, _ extra: String = "") { relay.receive(#"{"type":"\#(type)"\#(extra)}"#) }
    func finish(_ i: Int = 0, samples: Int = 2400) { let p = pending.remove(at: i); p.1([Float](repeating: 0.25, count: samples)) }
    var types: [String] { out.compactMap { $0["type"]?.stringValue } }
  }

  func testSpokenPiecesBecomeAudioInOrderAndTheEndWaits() {
    let r = Rig()
    r.event("response.created")
    r.event("response.output_audio_transcript.delta", #","delta":"Hello there.""#)
    r.say("Hello there.")
    r.say("How can I help?")
    r.event("response.output_audio_transcript.done")
    r.event("response.done")
    XCTAssertEqual(r.types, ["response.created", "response.output_audio_transcript.delta"], "the reply's end waits for its speech")
    XCTAssertEqual(r.pending.map(\.0), ["Hello there.", "How can I help?"])
    r.finish()
    XCTAssertEqual(r.types.last, "response.output_audio.delta")
    let audio = r.out.last!
    XCTAssertEqual(audio["response_id"], "r1")
    XCTAssertNil(audio["text"], "the words don't go to the session as text")
    XCTAssertEqual(VoiceAudio.pcm16(base64: audio["delta"]?.stringValue ?? "").count, 2400)
    XCTAssertFalse(r.types.contains("response.done"))
    r.finish()
    XCTAssertEqual(r.types.suffix(3), ["response.output_audio.delta", "response.output_audio_transcript.done", "response.done"])
    XCTAssertFalse(r.relay.busy)
    XCTAssertEqual(r.relay.spoken, 2)
  }

  func testTheUsersSideAndTheBridgesEventsNeverWait() {
    let r = Rig()
    r.say("A long answer.")
    r.event("response.done")
    r.event("input_audio_buffer.speech_started")
    r.event("conversation.item.input_audio_transcription.completed", #","transcript":"stop""#)
    r.event("bridge.tool", #","name":"x""#)
    XCTAssertEqual(r.types, ["input_audio_buffer.speech_started", "conversation.item.input_audio_transcription.completed", "bridge.tool"])
  }

  func testCancelDropsSpeechStillBeingMadeAndReleasesWhatWaited() {
    let r = Rig()
    r.say("One.")
    r.event("response.done", #","response":{"status":"cancelled"}"#)
    r.relay.cancel()
    XCTAssertEqual(r.types, ["response.done"])
    // The speech arriving late (made before the cancel took effect) is dropped.
    r.finish()
    XCTAssertEqual(r.types, ["response.done"])
    XCTAssertFalse(r.relay.busy)
  }

  func testOrdinaryAudioPassesUntouched() {
    let r = Rig()
    r.relay.receive(#"{"type":"response.output_audio.delta","delta":"AAAA"}"#)
    XCTAssertEqual(r.out.first?["delta"], "AAAA")
    XCTAssertTrue(r.pending.isEmpty)
  }
}
