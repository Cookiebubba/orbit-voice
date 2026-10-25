// The call logic (useVoice.ts, ported): every state transition, in virtual time.
import XCTest
@testable import OrbitKit

final class VoiceSessionTests: XCTestCase {
  final class Rig {
    let clock = ManualClock()
    var out: [VoiceOutput] = []
    let s: VoiceSession
    init(_ o: VoiceOptions = VoiceOptions()) {
      s = VoiceSession(clock: clock, audio: clock, options: o)
      s.onOutput = { [unowned self] in self.out.append($0) }
    }
    var gen: Int { out.compactMap { if case .connect(let g, _) = $0 { return g }; return nil }.last ?? 0 }
    func advance(_ ms: Double) { clock.advance(ms) }
    /** Hotkey → mic → socket → bridge.ready, as a real call goes. */
    func connect() {
      s.hotkey()
      s.micOpened()
      s.socketOpened(generation: gen)
      s.handle(.bridgeReady(model: "m", voice: "v"))
      advance(50)
    }
    func ev(_ json: String) { s.socketMessage(generation: gen, json) }
    var sent: [ClientMessage] { out.compactMap { if case .send(let m) = $0 { return m }; return nil } }
    var sentTypes: [String] { sent.map(\.type) }
    var appends: Int { sent.filter { if case .audioAppend = $0 { return true }; return false }.count }
    var chimes: [Chime] { out.compactMap { if case .chime(let c) = $0 { return c }; return nil } }
    var hungUp: [ByeReason] { out.compactMap { if case .hungUp(let r) = $0 { return r }; return nil } }
    var plays: [PlaybackChunk] { out.compactMap { if case .play(let p) = $0 { return p }; return nil } }
    var stops: Int { out.filter { $0 == .stopPlayback }.count }
    var opens: Int { out.filter { $0 == .openMic }.count }
    var closes: Int { out.filter { $0 == .closeMic }.count }
    var emotes: [String] { out.compactMap { if case .emote(let e) = $0 { return e }; return nil } }
    var avatarEvents: [AvatarEvent] { out.compactMap { if case .avatarEvent(let e) = $0 { return e }; return nil } }
    var phase: VoicePhase { s.state.phase }
    var captions: [Caption] { s.captions }
    var bye: JSONValue? { sent.compactMap { if case .uiBye = $0 { return $0.json }; return nil }.last }
    func clear() { out.removeAll() }

    /** `ms` of a loud tone from Grok, as one audio delta. */
    func audio(_ ms: Double, response: String? = "r1", amp: Double = 0.5) {
      let n = Int(24 * ms)
      let pcm = (0..<n).map { Int16(amp * 32767 * sin(2 * Double.pi * 440 * Double($0) / 24000)) }
      s.handle(.audioDelta(delta: VoiceAudio.base64(pcm), responseId: response, emote: nil))
    }
    func frame(_ level: Int16 = 3000) { s.micFrame([Int16](repeating: level, count: 2400)) }
  }

  // MARK: starting a call

  func testHotkeyStartsOpensTheMicThenConnectsAndListens() {
    let r = Rig()
    r.s.hotkey()
    XCTAssertEqual(r.phase, .connecting)
    XCTAssertEqual(r.opens, 1)
    XCTAssertEqual(r.gen, 0, "no socket until the mic is open")
    r.s.micOpened()
    XCTAssertEqual(r.out.last { if case .connect = $0 { return true }; return false }, .connect(generation: 1, announce: false))
    r.s.socketOpened(generation: 1)
    r.advance(50)
    XCTAssertEqual(r.phase, .connecting, "until bridge.ready")
    r.s.handle(.bridgeReady(model: nil, voice: nil))
    XCTAssertEqual(r.chimes, [.wake])
    XCTAssertEqual(r.sent.last, .uiState(asleep: false))
    r.advance(50)
    XCTAssertEqual(r.phase, .listening)
    XCTAssertTrue(r.s.state.connected)
    XCTAssertTrue(r.out.contains(.setVolume(gain: VoiceAudio.volumeGain(VoiceAudio.defaultVolume))))
  }

  func testAMicThatWontOpenShowsWhyAndHangsUpWithMicError() {
    let r = Rig()
    r.s.hotkey()
    r.s.micFailed(MicError(.notAllowed, "Permission denied"))
    XCTAssertEqual(r.hungUp, [.micError])
    XCTAssertEqual(r.captions.last?.who, .error)
    XCTAssertEqual(r.captions.last?.text, "Microphone problem: Permission denied")
    XCTAssertEqual(r.s.state.errorCount, 0, "a mic problem isn't counted as an error for the avatar")
    XCTAssertEqual(r.gen, 0, "never connected")
    XCTAssertEqual(r.phase, .off)
    XCTAssertEqual(MicError(.notAllowed, "x").plain, "Orbit isn't allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone, then quit and reopen Orbit.")
    XCTAssertEqual(MicError(.notFound, "x").plain, "No microphone found. Plug one in or pick one in your system's sound settings.")
    XCTAssertEqual(MicError(.other, "busy").plain, "Microphone problem: busy")
  }

  func testAMicThatOpensAfterHangingUpIsClosedAgain() {
    let r = Rig()
    r.s.hotkey()
    r.s.hangup()
    r.clear()
    r.s.micOpened()
    XCTAssertEqual(r.closes, 1)
    XCTAssertEqual(r.gen, 0)
  }

  // MARK: the microphone

  func testMicAudioGoesOutOnlyWhileListening() {
    let r = Rig()
    r.connect()
    r.frame()
    XCTAssertEqual(r.appends, 1)
    if case .audioAppend(let b64) = r.sent.last! { XCTAssertEqual(VoiceAudio.pcm16(base64: b64).count, 2400) } else { XCTFail() }
    r.s.setMuted(true)
    XCTAssertEqual(r.sent.last, .audioClear, "muting drops half-heard speech")
    r.frame()
    XCTAssertEqual(r.appends, 1, "muted: nothing sent")
    r.s.setMuted(false)
    r.frame()
    XCTAssertEqual(r.appends, 2)
    r.advance(50)
    XCTAssertGreaterThan(r.s.state.input, 0, "the orb hears you")
    r.s.sleep()
    r.frame()
    XCTAssertEqual(r.appends, 2, "asleep: nothing sent")
  }

  func testHalfDuplexIsDeafWhileOrbitTalksOrItsOwnSoundPlays() {
    let r = Rig(VoiceOptions(halfDuplex: true))
    r.connect()
    r.audio(500)
    r.frame()
    XCTAssertEqual(r.appends, 0, "Orbit is talking")
    r.advance(1000)
    r.frame()
    XCTAssertEqual(r.appends, 1)
    r.s.ownSound(1400) // the throw sound
    r.frame()
    XCTAssertEqual(r.appends, 1)
    r.advance(1500)
    r.frame()
    XCTAssertEqual(r.appends, 2)
  }

  // MARK: sleep and hanging up

  func testSleepClosesTheMicAtOnceAndHangsUpOnceQuiet() {
    let r = Rig()
    r.connect()
    r.clear()
    r.s.hotkey()
    XCTAssertTrue(r.s.state.asleep)
    XCTAssertEqual(r.sentTypes, ["ui.state", "input_audio_buffer.clear"])
    XCTAssertEqual(r.chimes, [.sleep])
    r.advance(1000)
    XCTAssertEqual(r.hungUp, [], "must stay quiet ~1 s (poll 150 ms, quiet 900 ms)")
    r.advance(100)
    XCTAssertEqual(r.hungUp, [.sleep])
    XCTAssertEqual(r.bye?["reason"], "sleep")
    XCTAssertTrue(r.out.contains(.disconnect(generation: 1)))
    XCTAssertTrue(r.out.contains(.closeMic))
    XCTAssertEqual(r.phase, .off)
    XCTAssertFalse(r.s.state.asleep)
  }

  func testSleepLetsTheReplyPlayOutButNotPastThreeSeconds() {
    let r = Rig()
    r.connect()
    r.audio(1500)
    r.s.sleep()
    r.advance(2000)
    XCTAssertEqual(r.hungUp, [], "still playing / just finished")
    r.advance(1000)
    XCTAssertEqual(r.hungUp, [.sleep], "the 3 s limit")
    let r2 = Rig()
    r2.connect()
    r2.audio(600)
    r2.s.sleep()
    r2.advance(600 + 30 + 600 + 900 + 150)
    XCTAssertEqual(r2.hungUp, [.sleep], "played out, then ~1.5 s of quiet")
  }

  func testBridgeSleepStopsEverythingAndHangsUpNow() {
    let r = Rig()
    r.connect()
    r.audio(2000)
    r.clear()
    r.s.handle(.bridgeSleep)
    XCTAssertEqual(r.stops, 1)
    XCTAssertEqual(r.chimes, [.sleep])
    XCTAssertEqual(r.hungUp, [.sleep])
    XCTAssertEqual(r.bye?["cut"], 1, "a reply was cut short")
  }

  func testTheUsersHangupSaysUser() {
    let r = Rig()
    r.connect()
    r.s.hangup()
    XCTAssertEqual(r.hungUp, [.user])
    XCTAssertEqual(r.bye?["reason"], "user")
  }

  func testAnOrdinaryCallNeverHangsUpByItselfWhenQuiet() {
    let r = Rig()
    r.connect()
    r.advance(10 * 60_000)
    XCTAssertEqual(r.hungUp, [])
    XCTAssertEqual(r.phase, .listening)
  }

  // MARK: playback

  func testChunksPlayBackToBackAndThePhaseFollows() {
    let r = Rig()
    r.connect()
    let t0 = r.clock.audioTime
    r.s.handle(.responseCreated(id: "r1"))
    r.audio(100)
    r.audio(100)
    r.audio(100)
    let p = r.plays
    XCTAssertEqual(p.count, 3)
    XCTAssertEqual(p[0].at, t0 + 0.03, accuracy: 1e-9)
    XCTAssertEqual(p[1].at, p[0].at + 0.1, accuracy: 1e-9)
    XCTAssertEqual(p[2].at, p[1].at + 0.1, accuracy: 1e-9)
    XCTAssertEqual(p[0].samples.count, 2400)
    r.advance(50)
    XCTAssertEqual(r.phase, .speaking)
    XCTAssertGreaterThan(r.s.state.output, 0, "the orb moves with the voice")
    r.advance(300)
    r.s.handle(.responseDone(id: "r1", status: "completed"))
    r.advance(300) // the release and the 250 ms margin
    XCTAssertEqual(r.phase, .listening)
    XCTAssertEqual(r.s.stats.chunks, 3)
    XCTAssertEqual(r.s.stats.scheduled, 0.3, accuracy: 1e-9)
    XCTAssertEqual(r.s.playedSoFar, 0.3, accuracy: 1e-6)
    XCTAssertEqual(r.s.stats.firstLead, 0.03, accuracy: 1e-9)
    XCTAssertEqual(r.s.parity.chunks, 3)
    XCTAssertEqual(r.s.parity.scheduledMs, 300)
  }

  func testAChunkArrivingAfterTheQueueRanDryStartsNow() {
    let r = Rig()
    r.connect()
    r.audio(100)
    r.advance(1000)
    r.audio(100)
    XCTAssertEqual(r.plays.last!.at, r.clock.audioTime + 0.03, accuracy: 1e-9)
  }

  func testAReplyThatEndsAbruptlyGetsAReleaseRightAfterIt() {
    let r = Rig()
    r.connect()
    r.audio(200)
    let end = r.plays[0].at + 0.2
    r.s.handle(.audioDone(responseId: "r1"))
    let tail = r.plays.last!
    XCTAssertTrue(tail.isTail)
    XCTAssertEqual(tail.at, end, accuracy: 1e-9)
    XCTAssertEqual(tail.samples.count, 2880)
    r.s.handle(.responseDone(id: "r1", status: "completed"))
    XCTAssertEqual(r.plays.count, 2, "once per chunk")
    // A reply that ends in quiet gets none; nor one already played out.
    let r2 = Rig()
    r2.connect()
    r2.audio(200, amp: 0)
    r2.s.handle(.audioDone(responseId: "r1"))
    XCTAssertEqual(r2.plays.count, 1)
    let r3 = Rig()
    r3.connect()
    r3.audio(100)
    r3.advance(500)
    r3.s.handle(.responseDone(id: "r1", status: "completed"))
    XCTAssertEqual(r3.plays.count, 1)
  }

  func testTalkingOverAReplyStopsIt() {
    let r = Rig()
    r.connect()
    r.s.handle(.responseCreated(id: "r1"))
    r.audio(3000)
    r.advance(500)
    r.clear()
    r.s.handle(.speechStarted)
    XCTAssertEqual(r.stops, 1)
    XCTAssertTrue(r.s.state.hearing)
    XCTAssertEqual(r.s.stats.cut, 1)
    r.advance(50)
    XCTAssertEqual(r.phase, .listening)
    r.s.handle(.speechStopped)
    XCTAssertFalse(r.s.state.hearing)
    r.advance(50)
    XCTAssertEqual(r.phase, .thinking)
  }

  func testAnsweringTheLastWordsOfAFinishedReplyLetsThemFinish() {
    let r = Rig()
    r.connect()
    r.s.handle(.responseCreated(id: "r1"))
    r.audio(1000)
    r.s.handle(.responseDone(id: "r1", status: "completed"))
    r.advance(500) // 0.53 s + the release left
    r.clear()
    r.s.handle(.speechStarted)
    XCTAssertEqual(r.stops, 0, "\"yes\" over \"...send it?\" plays out")
    XCTAssertEqual(r.s.stats.kept, 1)
    // Still arriving: a real interruption.
    let r2 = Rig()
    r2.connect()
    r2.s.handle(.responseCreated(id: "r1"))
    r2.audio(1000)
    r2.advance(500)
    r2.s.handle(.speechStarted)
    XCTAssertEqual(r2.stops, 1)
  }

  func testTheAvatarFastPathStopsWhatGrokStartedSaying() {
    let r = Rig()
    r.connect()
    r.audio(1000)
    r.clear()
    r.s.handle(.bridgeAvatar(action: "wave", fast: true))
    XCTAssertEqual(r.stops, 1)
    r.s.handle(.bridgeAvatar(action: "wave", fast: false))
    XCTAssertEqual(r.stops, 1)
  }

  func testEmotesFireAsTheirAudioPlays() {
    let r = Rig()
    r.connect()
    let pcm = [Int16](repeating: 8000, count: 2400)
    r.s.handle(.audioDelta(delta: VoiceAudio.base64(pcm), responseId: "c1", emote: nil))
    r.s.handle(.audioDelta(delta: VoiceAudio.base64(pcm), responseId: "c1", emote: "happy"))
    r.advance(100)
    XCTAssertEqual(r.emotes, [])
    r.advance(50)
    XCTAssertEqual(r.emotes, ["happy"], "when its chunk starts (0.13 s)")
    // Barge-in clears pending ones.
    r.s.handle(.responseCreated(id: "c2"))
    r.s.handle(.audioDelta(delta: VoiceAudio.base64(pcm), responseId: "c2", emote: nil))
    r.s.handle(.audioDelta(delta: VoiceAudio.base64(pcm), responseId: "c2", emote: "sad"))
    r.s.handle(.speechStarted)
    r.advance(1000)
    XCTAssertEqual(r.emotes, ["happy"])
  }

  func testVolumeChangesApplyAtOnce() {
    let r = Rig()
    r.connect()
    r.clear()
    r.s.setOptions(VoiceOptions(volume: 0.5))
    XCTAssertEqual(r.out, [.setVolume(gain: 0.25)])
  }

  // MARK: "one question" (tap) mode

  func testTapModeHangsUpAfterTenSecondsOfSilence() {
    let r = Rig(VoiceOptions(listenMode: .tap))
    r.connect()
    r.advance(9900)
    XCTAssertEqual(r.chimes, [.wake])
    r.advance(100)
    XCTAssertEqual(r.chimes, [.wake, .sleep])
    XCTAssertTrue(r.s.state.asleep)
    r.advance(1100)
    XCTAssertEqual(r.hungUp, [.tapTimeout])
  }

  func testTapModeClosesTheMicAfterTheQuestionAndHangsUpAfterTheAnswer() {
    let r = Rig(VoiceOptions(listenMode: .tap))
    r.connect()
    r.s.handle(.speechStarted)
    r.advance(10_000)
    XCTAssertEqual(r.hungUp, [], "talking: the tap timeout is off")
    r.s.handle(.speechStopped)
    XCTAssertTrue(r.s.state.asleep, "the question is asked: mic closed")
    r.advance(5000)
    XCTAssertEqual(r.hungUp, [], "waits for the answer")
    r.s.handle(.responseCreated(id: "r1"))
    r.audio(1000)
    r.s.handle(.responseDone(id: "r1", status: "completed"))
    r.advance(1000)
    XCTAssertEqual(r.hungUp, [])
    r.advance(1800)
    XCTAssertEqual(r.hungUp, [.sleep])
  }

  func testTapModeWaitsUpToNinetySecondsForAnAnswerAndLongerForTheSecondBrain() {
    let r = Rig(VoiceOptions(listenMode: .tap))
    r.connect()
    r.s.handle(.speechStopped)
    r.advance(89_900)
    XCTAssertEqual(r.hungUp, [])
    r.advance(200)
    XCTAssertEqual(r.hungUp, [.sleep])
    let r2 = Rig(VoiceOptions(listenMode: .tap))
    r2.connect()
    r2.s.handle(.speechStopped)
    r2.s.handle(.bridgeTool(name: "ask_second_brain"))
    r2.advance(300_000)
    XCTAssertEqual(r2.hungUp, [], "a second-brain answer can take 5 minutes")
    r2.advance(31_000)
    XCTAssertEqual(r2.hungUp, [.sleep])
  }

  func testTapModeHoldsAMinuteForADraftThenTheHotkeyAnswersIt() {
    let r = Rig(VoiceOptions(listenMode: .tap))
    r.connect()
    r.s.handle(.speechStopped)
    r.s.handle(.responseCreated(id: "r1"))
    r.s.handle(.bridgeDraft(VoiceDraft(id: 1, text: "Fix the bug", targetTitle: nil)))
    r.advance(100)
    r.s.handle(.responseDone(id: "r1", status: "completed"))
    r.advance(5000)
    XCTAssertEqual(r.hungUp, [], "a draft waits for a yes")
    XCTAssertTrue(r.s.state.asleep)
    r.clear()
    r.s.hotkey()
    XCTAssertFalse(r.s.state.asleep, "the hotkey opens the mic for the answer")
    XCTAssertEqual(r.chimes, [.wake])
    XCTAssertEqual(r.sent, [.uiState(asleep: false)])
    r.advance(10_000)
    XCTAssertTrue(r.s.state.asleep, "and listens for one utterance again")
    // Nobody answers this time: after the minute's hold it hangs up.
    let r2 = Rig(VoiceOptions(listenMode: .tap))
    r2.connect()
    r2.s.handle(.speechStopped)
    r2.s.handle(.responseCreated(id: "r1"))
    r2.s.handle(.bridgeDraft(VoiceDraft(id: 1, text: "x", targetTitle: nil)))
    r2.advance(100)
    r2.s.handle(.responseDone(id: "r1", status: "completed"))
    r2.advance(60_000)
    XCTAssertEqual(r2.hungUp, [])
    r2.advance(2000)
    XCTAssertEqual(r2.hungUp, [.draftHold])
  }

  // MARK: spoken updates

  /** A spoken update up to its listening window being open. */
  func openWindow(_ r: Rig) {
    r.s.announceUpdate()
    XCTAssertEqual(r.out.first { if case .connect = $0 { return true }; return false }, .connect(generation: 1, announce: true))
    XCTAssertEqual(r.opens, 0, "the mic stays closed")
    r.s.socketOpened(generation: 1)
    r.s.handle(.bridgeReady(model: nil, voice: nil))
    XCTAssertEqual(r.chimes, [], "no wake chime: woken only to say it")
    r.advance(200)
    XCTAssertEqual(r.sent, [.uiState(asleep: false)])
    r.s.handle(.bridgeAnnounce(ok: true, reason: nil))
    r.s.handle(.responseCreated(id: "r1"))
    r.audio(1000)
    r.s.handle(.responseDone(id: "r1", status: "completed"))
    r.advance(50)
    XCTAssertEqual(r.phase, .speaking)
    r.frame()
    XCTAssertEqual(r.appends, 0)
    r.s.handle(.bridgeAnnounceReady(spoke: true))
    r.advance(1000)
    XCTAssertEqual(r.chimes, [], "still playing")
    r.advance(500) // (its release ends 120 ms after the reply)
    XCTAssertEqual(r.chimes, [.wake], "played out + 0.3 s quiet: the window opens with a chime")
    XCTAssertEqual(r.opens, 0)
    r.advance(450)
    XCTAssertEqual(r.opens, 1, "the mic opens once the chime has played")
    r.s.micOpened()
    XCTAssertEqual(r.sent.last, .uiListenWindow)
    XCTAssertEqual(r.captions.last?.text, "Listening for 3 seconds…")
  }

  func testASpokenUpdateOpensTheMicOnlyAfterItHasPlayedThenSilenceHangsUp() {
    let r = Rig()
    openWindow(r)
    r.frame(0)
    XCTAssertEqual(r.appends, 1, "listening now")
    r.advance(2900)
    XCTAssertEqual(r.hungUp, [])
    r.advance(100)
    XCTAssertEqual(r.hungUp, [.listenExpired])
  }

  func testAGraceSecondIfYouWereJustStartingToTalk() {
    let r = Rig()
    openWindow(r)
    r.advance(2800)
    r.frame(8000) // loud, just before the window closes
    r.advance(200)
    XCTAssertEqual(r.hungUp, [], "a moment for the voice detection")
    r.advance(1000)
    XCTAssertEqual(r.hungUp, [.listenExpired])
  }

  func testWordsInTheWindowTurnItIntoAConversationThatHangsUpAfterTwentyQuietSeconds() {
    let r = Rig()
    openWindow(r)
    r.s.handle(.speechStarted)
    r.s.handle(.speechStopped)
    r.s.handle(.inputTranscription(type: "conversation.item.input_audio_transcription.completed", itemId: "u1", transcript: "What did it do?", delta: nil))
    XCTAssertFalse(r.s.state.announcing)
    r.s.handle(.responseCreated(id: "r2"))
    r.audio(1000)
    r.s.handle(.responseDone(id: "r2", status: "completed"))
    r.advance(15_000)
    XCTAssertEqual(r.hungUp, [], "no 8 s 'no words' limit any more")
    r.advance(7000)
    XCTAssertEqual(r.chimes.last, .sleep, "20 s of quiet: back to sleep")
    r.advance(1200)
    XCTAssertEqual(r.hungUp, [.idle])
  }

  func testSpeechThatNeverBecomesWordsHangsUp() {
    let r = Rig()
    openWindow(r)
    r.s.handle(.speechStarted)
    r.advance(7900)
    XCTAssertEqual(r.hungUp, [])
    r.advance(100)
    XCTAssertEqual(r.hungUp, [.heardNoWords])
    // A cough's transcript without letters doesn't count as an answer.
    let r2 = Rig()
    openWindow(r2)
    r2.s.handle(.speechStarted)
    r2.s.handle(.inputTranscription(type: "conversation.item.input_audio_transcription.completed", itemId: "u", transcript: "...", delta: nil))
    r2.advance(8000)
    XCTAssertEqual(r2.hungUp, [.heardNoWords])
  }

  func testGrokSpeakingAgainClosesTheWindowUntilItIsDone() {
    let r = Rig()
    openWindow(r)
    r.clear()
    r.s.handle(.responseCreated(id: "r2"))
    XCTAssertEqual(r.closes, 1, "the mic closes again")
    r.audio(500)
    r.s.handle(.responseDone(id: "r2", status: "completed"))
    r.advance(5000)
    XCTAssertEqual(r.hungUp, [], "the window's timer is off while Grok speaks")
    XCTAssertEqual(r.chimes, [], "and waits for announce_ready again")
    r.s.handle(.bridgeAnnounceReady(spoke: true))
    r.advance(500)
    XCTAssertEqual(r.chimes, [.wake])
  }

  func testASilentUpdateStillOpensTheWindowAfterTwoSeconds() {
    let r = Rig()
    r.s.announceUpdate()
    r.s.socketOpened(generation: 1)
    r.s.handle(.bridgeReady(model: nil, voice: nil))
    r.s.handle(.responseCreated(id: "r1"))
    r.s.handle(.responseDone(id: "r1", status: "completed"))
    r.s.handle(.bridgeAnnounceReady(spoke: false))
    r.advance(1900)
    XCTAssertEqual(r.chimes, [])
    r.advance(300)
    XCTAssertEqual(r.chimes, [.wake])
  }

  func testAnUpdateThatNeverGetsSaidGivesUpAfter45Seconds() {
    let r = Rig()
    r.s.announceUpdate()
    r.s.socketOpened(generation: 1)
    r.s.handle(.bridgeReady(model: nil, voice: nil))
    r.advance(44_900)
    XCTAssertEqual(r.hungUp, [])
    r.advance(200)
    XCTAssertEqual(r.hungUp, [.announceMax])
  }

  func testTheBridgeSayingNoHangsUp() {
    let r = Rig()
    r.s.announceUpdate()
    r.s.socketOpened(generation: 1)
    r.s.handle(.bridgeAnnounce(ok: false, reason: "too soon"))
    XCTAssertEqual(r.hungUp, [.bridge])
    XCTAssertEqual(r.bye?["reason"], "bridge")
  }

  func testTheHotkeyDuringASpokenUpdateHangsUpRightAway() {
    let r = Rig()
    r.s.announceUpdate()
    r.s.socketOpened(generation: 1)
    r.s.handle(.bridgeReady(model: nil, voice: nil))
    r.s.hotkey()
    XCTAssertEqual(r.hungUp, [.user])
    XCTAssertFalse(r.s.endWake(), "nothing left to end")
  }

  func testTypingDuringASpokenUpdateAnswersIt() {
    let r = Rig()
    r.s.announceUpdate()
    r.s.socketOpened(generation: 1)
    r.s.handle(.bridgeReady(model: nil, voice: nil))
    r.s.type("tell me more")
    XCTAssertEqual(r.sent.last, .uiText("tell me more"))
    XCTAssertEqual(r.opens, 1, "the mic opens to carry on talking")
    XCTAssertFalse(r.s.state.announcing)
    XCTAssertEqual(r.captions.last?.who, .you)
  }

  func testAnUpdateDoesntStartWhileACallIsOn() {
    let r = Rig()
    r.connect()
    r.clear()
    r.s.announceUpdate()
    XCTAssertEqual(r.out, [])
  }

  // MARK: the bridge's events

  func testToolNotesAndResults() {
    let r = Rig()
    r.connect()
    r.s.handle(.bridgeTool(name: "get_current_session"))
    XCTAssertEqual(r.captions.last?.text, "Checking your session…")
    r.advance(50)
    XCTAssertEqual(r.phase, .thinking)
    let n = r.captions.count
    r.s.handle(.bridgeTool(name: "__proto__"))
    r.s.handle(.bridgeTool(name: .object([:])))
    XCTAssertEqual(r.captions.count, n, "own tool names only")
    r.s.handle(.bridgeTool(name: "send_draft"))
    XCTAssertTrue(r.s.state.sending)
    r.s.handle(.bridgeToolResult(name: "send_draft", result: ["ok": false, "message": "The send button moved."]))
    XCTAssertFalse(r.s.state.sending)
    XCTAssertEqual(r.captions.last?.text, "The send button moved.")
    XCTAssertEqual(r.captions.last?.who, .error)
    XCTAssertEqual(r.s.state.errorCount, 1)
    XCTAssertEqual(r.avatarEvents, [.error])
    r.s.handle(.bridgeToolResult(name: "x", result: ["error": "nope"]))
    XCTAssertEqual(r.captions.last?.text, "nope")
    r.s.handle(.bridgeToolResult(name: "x", result: ["ok": false]))
    XCTAssertEqual(r.captions.last?.text, "That didn't work.")
    r.s.handle(.bridgeToolResult(name: "switch_session", result: ["ok": true, "open_in_app": "Docs"]))
    XCTAssertEqual(r.s.state.sessionTitle, "Docs")
    XCTAssertTrue(r.out.contains(.sessionTitle("Docs")))
    r.s.handle(.bridgeToolResult(name: "ask_second_brain", result: ["deferred": true]))
    XCTAssertEqual(r.captions.last?.text, "Claude is still thinking. Grok will tell you when the answer is ready.")
  }

  func testDraftsSendsCopiesAndErrors() {
    let r = Rig()
    r.connect()
    r.s.handle(.bridgeDraft(VoiceDraft(id: 4, text: "Add tests", targetTitle: "Orbit")))
    r.s.handle(.bridgeDraft(VoiceDraft(id: 4, text: "Add more tests", targetTitle: "Orbit")))
    XCTAssertEqual(r.avatarEvents, [.draft], "once per draft")
    XCTAssertEqual(r.s.parity.draft, ParityDraft(id: 4, text: "Add more tests", targetTitle: "Orbit"))
    r.s.handle(.bridgeSent(text: "Add more tests"))
    XCTAssertEqual(r.captions.last?.who, .sent)
    XCTAssertEqual(r.s.state.sentCount, 1)
    XCTAssertEqual(r.avatarEvents, [.draft, .sent])
    r.s.handle(.bridgeDraft(nil))
    XCTAssertNil(r.s.state.draft)
    XCTAssertTrue(r.out.contains(.draft(nil)))
    r.s.handle(.bridgeCopied(chars: 10, preview: "abc"))
    XCTAssertEqual(r.captions.last?.text, "Copied to clipboard ✓ (10 characters): abc…")
    r.s.handle(.bridgeCopied(chars: 3, preview: "abc"))
    XCTAssertEqual(r.captions.last?.text, "Copied to clipboard ✓ (3 characters): abc")
    r.s.handle(.bridgeBrain(project: "orbit"))
    XCTAssertEqual(r.captions.last?.text, "Claude is reading orbit…")
    r.s.handle(.error(message: nil))
    XCTAssertEqual(r.captions.last?.text, "Grok reported an error.")
    r.s.handle(.bridgeError(message: "No xAI API key yet."))
    XCTAssertEqual(r.s.parity.lastError, "No xAI API key yet.")
    XCTAssertEqual(r.s.state.errorCount, 2)
  }

  func testCaptionsForYourWordsAndGroksAndAHistoryOf200() {
    let r = Rig()
    r.connect()
    r.s.handle(.inputTranscription(type: "conversation.item.input_audio_transcription.delta", itemId: "u1", transcript: nil, delta: "Hel"))
    r.s.handle(.inputTranscription(type: "conversation.item.input_audio_transcription.delta", itemId: "u1", transcript: nil, delta: "lo"))
    XCTAssertEqual(r.captions.last?.text, "Hello")
    r.s.handle(.inputTranscription(type: "conversation.item.input_audio_transcription.completed", itemId: "u1", transcript: "Hello.", delta: nil))
    XCTAssertEqual(r.captions.last?.text, "Hello.")
    XCTAssertEqual(r.captions.filter { $0.who == .you }.count, 1)
    r.ev(#"{"type":"response.output_audio_transcript.delta","item_id":"g1","delta":"Hi "}"#)
    r.ev(#"{"type":"response.output_audio_transcript.delta","item_id":"g1","delta":"there"}"#)
    XCTAssertEqual(r.captions.last?.text, "Hi there")
    XCTAssertEqual(r.captions.last?.who, .grok)
    r.ev(#"{"type":"response.output_audio_transcript.done","item_id":"g1","transcript":"Hi there."}"#)
    XCTAssertEqual(r.captions.last?.text, "Hi there.")
    for i in 0..<250 { r.s.note("n\(i)") }
    XCTAssertEqual(r.captions.count, 200)
    XCTAssertEqual(r.captions.last?.text, "n249")
    XCTAssertTrue(r.out.contains { if case .captions = $0 { return true }; return false })
  }

  func testAskWhileHungUpConnectsThenSendsIt() {
    let r = Rig()
    r.s.ask("What's happening in my Claude session called \"Docs\"?")
    r.s.micOpened()
    r.s.socketOpened(generation: 1)
    XCTAssertFalse(r.sentTypes.contains("ui.text"))
    r.s.handle(.bridgeReady(model: nil, voice: nil))
    XCTAssertEqual(r.sent.last, .uiText("What's happening in my Claude session called \"Docs\"?"))
    r.advance(50)
    XCTAssertEqual(r.phase, .thinking)
  }

  // MARK: the bridge dropping, and starting again

  func testTheBridgeDroppingHangsUpAndTheHotkeyConnectsAfresh() {
    let r = Rig()
    r.connect()
    r.audio(2000)
    r.s.handle(.bridgeClosed(code: 1006, reason: "gone"))
    XCTAssertEqual(r.captions.last?.text, "Grok disconnected: gone")
    r.s.handle(.bridgeClosed(code: 1000, reason: ""))
    XCTAssertEqual(r.captions.last?.text, "Grok disconnected.")
    r.s.socketClosed(generation: 1)
    XCTAssertEqual(r.hungUp, [.closed])
    XCTAssertEqual(r.phase, .off)
    XCTAssertFalse(r.sentTypes.contains("ui.bye"), "nothing to say goodbye on: the socket is gone")
    // A late close or message from the old socket changes nothing.
    r.s.socketClosed(generation: 1)
    XCTAssertEqual(r.hungUp, [.closed])
    r.clear()
    r.advance(5000)
    r.s.hotkey()
    XCTAssertEqual(r.opens, 1)
    r.s.micOpened()
    XCTAssertEqual(r.gen, 2)
    r.s.socketOpened(generation: 2)
    r.ev(#"{"type":"bridge.ready"}"#)
    XCTAssertEqual(r.chimes, [.wake])
    r.s.socketMessage(generation: 1, #"{"type":"bridge.sleep"}"#)
    XCTAssertEqual(r.hungUp, [], "the old socket is ignored")
    XCTAssertEqual(r.s.stats.chunks, 0, "counts start afresh")
    r.audio(100)
    XCTAssertEqual(r.plays.last!.at, r.clock.audioTime + 0.03, accuracy: 1e-9, "the play head starts afresh")
  }

  func testOutputLostDropsWhatWasScheduled() {
    let r = Rig()
    r.connect()
    r.audio(2000)
    r.advance(50)
    XCTAssertEqual(r.phase, .speaking)
    r.s.outputLost()
    r.advance(50)
    XCTAssertEqual(r.phase, .listening)
  }

  func testTheGoodbyeReportCarriesTheCounts() {
    let r = Rig()
    r.connect()
    r.audio(500)
    r.advance(300)
    r.s.hangup()
    let b = r.bye!
    XCTAssertEqual(b["scheduled"], 0.5)
    XCTAssertEqual(b["played"], 0.3)
    XCTAssertEqual(b["lead"], 0)
    XCTAssertEqual(b["audio"], "running")
    XCTAssertEqual(b["cut"], 0, "counted before the hang-up stops playback, as the page does")
    XCTAssertEqual(b["kept"], 0)
  }

  func testSettingsFromTheBridge() {
    var s = VoiceSettings()
    s.merge(["listenMode": "tap", "halfDuplex": true, "voiceVolume": 0.4, "wakeWord": true, "announce": "off", "avatarThrowSound": false,
             "voiceEngine": "claude", "wakeHotkey": "Control+Alt+K", "other": 1])
    XCTAssertEqual(s.options, VoiceOptions(listenMode: .tap, halfDuplex: true, volume: 0.4))
    XCTAssertTrue(s.wakeWord)
    XCTAssertEqual(s.announce, "off")
    XCTAssertFalse(s.avatarThrowSound)
    XCTAssertTrue(s.avatarThrow, "missing keys keep their value")
    XCTAssertEqual(s.voiceEngine, "claude")
    XCTAssertEqual(s.wakeHotkey, "Control+Alt+K")
    s.merge(["listenMode": "sometimes", "voiceVolume": "loud", "announce": 3, "wakeHotkey": "Control+!"])
    XCTAssertEqual(s.listenMode, .tap, "a bad value changes nothing")
    XCTAssertEqual(s.voiceVolume, 0.4)
    XCTAssertEqual(s.wakeHotkey, "Control+Alt+K")
  }

  func testOrbSyncCarriesThePagesKeys() {
    var st = VoiceState()
    st.phase = .listening
    st.draft = VoiceDraft(id: 1, text: "x", targetTitle: nil)
    st.muted = true
    let o = st.orbSync(claudeWorking: true, pulseMe: true, pulseGrok: false, pulseAmount: 0.1)
    XCTAssertEqual(o.phase, .listening)
    XCTAssertEqual(o.draft, true)
    XCTAssertEqual(o.muted, true)
    XCTAssertEqual(o.claudeWorking, true)
    XCTAssertEqual(o.pulseAmount, 0.1)
  }
}
