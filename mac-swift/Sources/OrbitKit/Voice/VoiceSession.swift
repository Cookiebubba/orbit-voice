// Orbit's call logic (ui/src/useVoice.ts, ported faithfully) as a deterministic state machine:
// inputs are the bridge's events, mic frames, the user's actions and a clock; outputs are what to
// send, what to play or stop, chimes, captions, and the state the orb, avatars and launcher show.
// No audio device and no socket here: OrbitNative's VoiceController wires these to AVAudioEngine and
// a WebSocket, and the tests drive it in virtual time.
//
// Sleeping means hanging up: nothing is billed, and "Hey Orbit" / the hotkey start a fresh
// connection. The only "connected but not listening" moments are while Grok finishes its
// goodbye, and in "one question" mode while it answers (or while a draft waits for a yes).
//
// Spoken updates ("announce"): when Claude finishes while Grok is asleep, Orbit can connect just
// to say so. The mic isn't even opened until Grok's update has finished playing; then it listens
// for ~3 s. Speech there turns it into a normal conversation; silence hangs up. The bridge
// enforces the same window on its side.
import Foundation

/** A line in the conversation (captions and history). */
public struct Caption: Codable, Equatable, Sendable, Identifiable {
  public enum Who: String, Codable, Sendable { case you, grok, note, error, sent }
  public var id: String
  public var who: Who
  public var text: String
  public var at: Double
  public init(id: String, who: Who, text: String, at: Double) { self.id = id; self.who = who; self.text = text; self.at = at }
}

public enum ListenMode: String, Codable, Sendable { case always, tap }

/** The voice settings the call follows (Settings → Voice). */
public struct VoiceOptions: Equatable, Sendable {
  public var listenMode: ListenMode
  public var halfDuplex: Bool
  public var volume: Double
  public init(listenMode: ListenMode = .always, halfDuplex: Bool = false, volume: Double = VoiceAudio.defaultVolume) {
    self.listenMode = listenMode; self.halfDuplex = halfDuplex; self.volume = volume
  }
}

/** Why the microphone didn't open (getUserMedia's error, as the page sees it). */
public struct MicError: Error, Equatable, Sendable {
  public enum Kind: String, Sendable { case notAllowed, notFound, other }
  public var kind: Kind
  public var message: String
  public init(_ kind: Kind, _ message: String) { self.kind = kind; self.message = message }

  /** A plain reason the mic didn't open (on a Mac, where to allow it). Same words as the page. */
  public var plain: String {
    switch kind {
    case .notAllowed: return "Orbit isn't allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone, then quit and reopen Orbit."
    case .notFound: return "No microphone found. Plug one in or pick one in your system's sound settings."
    case .other: return "Microphone problem: \(message)"
    }
  }
}

/** What the avatar is told happened (desktop.buddyEvent). */
public enum AvatarEvent: String, Sendable { case draft, sent, error }

/** A chunk of the voice to play at `at` on the audio clock (24 kHz mono, -1..1). */
public struct PlaybackChunk: Equatable, Sendable {
  public var id: Int
  public var samples: [Float]
  public var at: Double
  public var duration: Double { Double(samples.count) / VoiceAudio.rate }
  /** The release after a reply's last chunk (see VoiceAudio.releaseTail). */
  public var isTail: Bool
}

/** Everything the session asks of the outside world. */
public enum VoiceOutput: Equatable, Sendable {
  /** Open the WebSocket to the bridge's /voice (with ?announce=1 for a spoken update). */
  case connect(generation: Int, announce: Bool)
  case disconnect(generation: Int)
  case send(ClientMessage)
  /** Open the microphone; answer with micOpened() or micFailed(_:). */
  case openMic
  case closeMic
  case play(PlaybackChunk)
  /** Barge-in or hang-up: stop and drop every scheduled chunk. */
  case stopPlayback
  /** The voice's gain (after the output level is read), from Settings → Voice → Volume. */
  case setVolume(gain: Double)
  case chime(Chime)
  /** An emote for the avatar, now (its words are coming out of the speakers). */
  case emote(String)
  case avatarEvent(AvatarEvent)
  case captions([Caption])
  case draft(VoiceDraft?)
  case sessionTitle(String?)
  case state(VoiceState)
  case hungUp(ByeReason)
}

/** What the orb, the avatars and the launcher show (useVoice's returned state). */
public struct VoiceState: Equatable, Sendable {
  public var phase: VoicePhase = .off
  public var asleep = false
  public var input = 0.0
  public var output = 0.0
  public var hearing = false
  public var muted = false
  public var sending = false
  public var sentCount = 0
  public var errorCount = 0
  public var draft: VoiceDraft?
  public var sessionTitle: String?
  /** The socket to the bridge is open. */
  public var connected = false
  /** A spoken update is on (Grok woke by itself). */
  public var announcing = false
  public var lastError: String?
  public init() {}

  /** The orb / avatar sync message (ui/src/desktop.ts OrbSync); app-level parts are passed in. */
  public func orbSync(claudeWorking: Bool = false, pulseMe: Bool = false, pulseGrok: Bool = false, pulseAmount: Double = 0.05) -> OrbSync {
    var o = OrbSync()
    o.phase = phase; o.input = input; o.output = output; o.asleep = asleep; o.hearing = hearing
    o.claudeWorking = claudeWorking; o.muted = muted; o.draft = draft != nil; o.sending = sending
    o.pulseMe = pulseMe; o.pulseGrok = pulseGrok; o.pulseAmount = pulseAmount
    return o
  }
}

/** Counts for ui.bye and the parity driver: Grok audio scheduled and played (s), leads, talk-overs. */
public struct VoiceAudioStats: Equatable, Sendable {
  public var scheduled = 0.0
  public var played = 0.0
  public var firstLead = 0.0
  public var maxLead = 0.0
  public var chunks = 0
  public var cut = 0
  public var kept = 0
}

public final class VoiceSession {
  // Timing constants, exactly as useVoice.ts has them.
  public static let tapTimeoutMs = 10_000.0 // "one question" mode: give up if you say nothing for this long
  public static let tapDraftHoldMs = 60_000.0 // "one question" mode: stay connected this long while a draft waits for a yes
  public static let secondBrainMaxMs = 330_000.0 // the longest a second-brain answer can take (Opus: 5 min) plus a margin
  public static let maxHistory = 200
  public static let announceListenMs = 3000.0 // spoken update: how long the mic stays open for a reply
  public static let announceGraceMs = 1000.0 // ...plus this, once, if you were just starting to talk
  public static let announceMaxMs = 45_000.0 // give up on a spoken update that never gets said
  public static let announceHeardMs = 8000.0 // you started talking in the window: this long for it to become words
  public static let announceIdleMs = 20_000.0 // a conversation that began as a spoken update hangs up after this much quiet
  public static let announceSilentOpenMs = 2000.0 // Grok is done but nothing played (or it was silent): open the window anyway
  public static let maxQueuedS = 120.0 // a play head this far ahead of the clock is stale, not a real queue
  static let hangupPollMs = 150.0
  static let announcePollMs = 100.0
  static let idlePollMs = 1000.0
  static let levelTickMs = 50.0
  static let listenWindowChimeMs = 450.0

  static let toolNotes: [String: String] = [
    "get_current_session": "Checking your session…",
    "list_sessions": "Listing sessions…",
    "read_session": "Reading the session…",
    "draft_prompt": "Drafting a prompt…",
    "send_draft": "Sending to Claude…",
    "copy_to_clipboard": "Copying…",
    "switch_session": "Switching session…",
    "new_session": "Starting a new session…",
    "open_claude_sign_in": "Opening the Claude Code sign-in…",
  ]

  // listening: the ~3 s window; heard: you started talking in it, waiting for your words.
  // readyAt: when the bridge said Grok is done (0 = not yet).
  final class Announce {
    enum Stage { case speaking, listening, heard }
    var stage: Stage = .speaking
    let startedAt: Double
    var ready = false
    var readyAt = 0.0
    var grace = false
    var timer: Int?
    init(startedAt: Double) { self.startedAt = startedAt }
  }

  private struct Playing {
    var id: Int
    var at: Double
    var dur: Double
    var samples: [Float]
    var isTail: Bool
  }

  // MARK: wiring
  public var onOutput: (VoiceOutput) -> Void = { _ in }
  public private(set) var options: VoiceOptions
  /** The audio engine's state for ui.bye: running | suspended | closed | interrupted. */
  public var audioStateName = "running"
  private let clock: VoiceClock
  private let audio: AudioClock

  // MARK: published state
  public private(set) var state = VoiceState()
  public private(set) var captions: [Caption] = []
  public private(set) var stats = VoiceAudioStats()
  private var published = VoiceState()
  private var captionsChanged = false

  // MARK: refs (useVoice's useRefs)
  private var generation = 0
  private var connected = false // ws.current exists
  private var wsOpen = false // ws.current.readyState === OPEN
  private var inCall = false // ctx.current exists (start() until stop())
  private var starting = false // waiting for the mic before connecting
  private var micOpen = false // mic.current
  private var micPending: [(Result<Void, MicError>) -> Void] = []
  private var micRequested = false
  private var announce: Announce?
  private var announcePoll: Int?
  private var lastLoudAt = 0.0
  private var idlePoll: Int?
  private var lastActivity = 0.0 // you spoke or typed
  private var toolsRunning = 0 // tool calls still running (a second-brain answer can take minutes)
  private var playing: [Playing] = []
  // When the queued audio should have finished, by the wall clock. "Still playing" is judged by
  // this, not by chunks ending, so audio that never plays (a stopped output) can't keep a spoken
  // update's mic shut, or a hang-up waiting, forever.
  private var audioEndsAt = 0.0
  private var ownSoundUntil = 0.0
  private var playHead = 0.0 // where the next chunk starts, on the audio clock
  private var lastChunk: (pcm: [Int16], endAt: Double, released: Bool)?
  private var inLevel = 0.0
  private var thinking = false
  private var ready = false
  private var pendingText: String?
  private var tapTimer: Int?
  private var tapHold: Int?
  private var hangupPoll: Int?
  private var responding = false
  private var responseDoneAt = 0.0
  private var lastAudioAt = 0.0
  private var toolsInFlight = 0
  private var levelTimer: Int?
  private var meter = LevelMeter()
  private var chunkSeq = 0
  private var captionSeq = 0
  private var replyId = "reply" // the reply now coming in (for events that don't say)
  private var emotes: EmoteSync!

  public init(clock: VoiceClock, audio: AudioClock, options: VoiceOptions = VoiceOptions()) {
    self.clock = clock
    self.audio = audio
    self.options = options
    // The avatar's feelings as the words play: timed on the audio clock, with the output's latency,
    // so each fires when its words come out of the speakers.
    emotes = EmoteSync(
      now: { [unowned self] in self.audio.audioTime - self.audio.outputLatency },
      fire: { [unowned self] cue in self.onOutput(.emote(cue)) },
      setTimer: { [unowned self] ms, fn in self.clock.after(ms, fn) },
      clearTimer: { [unowned self] id in self.clock.cancel(id) }
    )
  }

  private var now: Double { clock.nowMs }
  private func emit(_ o: VoiceOutput) { onOutput(o) }

  /** Runs an input, then publishes whatever changed. */
  private func run(_ body: () -> Void) {
    body()
    publish()
  }

  private func publish() {
    if captionsChanged {
      captionsChanged = false
      emit(.captions(captions))
    }
    if state != published {
      let old = published
      published = state
      if old.draft != state.draft { emit(.draft(state.draft)) }
      if old.sessionTitle != state.sessionTitle { emit(.sessionTitle(state.sessionTitle)) }
      emit(.state(state))
    }
  }

  // MARK: - small helpers

  private func send(_ m: ClientMessage) { if wsOpen { emit(.send(m)) } }

  private func caption(_ who: Caption.Who, _ idPrefix: String, _ text: String, id fixedId: String? = nil, append: Bool = false) {
    let id: String
    if let fixedId { id = fixedId } else { captionSeq += 1; id = "\(idPrefix)-\(Int64(now))-\(captionSeq)" }
    if let i = captions.firstIndex(where: { $0.id == id }) {
      captions[i].text = append ? captions[i].text + text : text
    } else {
      captions = Array(captions.suffix(VoiceSession.maxHistory - 1)) + [Caption(id: id, who: who, text: text, at: now)]
    }
    if who == .error { state.lastError = text }
    captionsChanged = true
  }

  private func error(_ text: String, count: Bool = true) {
    caption(.error, "err", text)
    if count {
      state.errorCount += 1
      emit(.avatarEvent(.error))
    }
  }

  private func reap() {
    // Chunks that have played out (the page's `ended` events).
    let t = audio.audioTime
    playing.removeAll { p in
      guard t >= p.at + p.dur else { return false }
      if !p.isTail { stats.played += min(p.dur, max(0, t - p.at)) }
      return true
    }
  }

  private var isPlaying: Bool {
    reap()
    return !playing.isEmpty && now < audioEndsAt + 250
  }

  private var soundPlaying: Bool { now < ownSoundUntil }

  private var outLatency: Double {
    let l = audio.outputLatency
    return l.isFinite && l > 0 && l < 1 ? l : 0
  }

  private func setAsleepBoth(_ v: Bool) {
    state.asleep = v
    send(.uiState(asleep: v))
  }

  /** Leave spoken-update mode (it became a normal conversation, or is ending). */
  private func endAnnounce() {
    if let a = announce { clock.cancel(a.timer) }
    clock.cancel(announcePoll)
    announce = nil
    state.announcing = false
  }

  // MARK: - microphone

  /** Open the microphone (if it isn't). `then` runs once it's open or failed. */
  private func openMic(_ then: @escaping (Result<Void, MicError>) -> Void) {
    guard inCall else { return }
    if micOpen { return then(.success(())) }
    micPending.append(then)
    if !micRequested {
      micRequested = true
      emit(.openMic)
    }
  }

  /** The microphone is open (after .openMic). */
  public func micOpened() {
    run {
      micRequested = false
      let waiting = micPending
      micPending = []
      guard inCall else {
        emit(.closeMic) // hung up meanwhile
        return
      }
      micOpen = true
      for w in waiting { w(.success(())) }
    }
  }

  /** The microphone couldn't open (after .openMic). */
  public func micFailed(_ e: MicError) {
    run {
      micRequested = false
      let waiting = micPending
      micPending = []
      for w in waiting { w(.failure(e)) }
    }
  }

  /** Close the microphone device itself (not just stop sending). */
  private func closeMic() {
    if micOpen || micRequested { emit(.closeMic) }
    micOpen = false
    micRequested = false
    micPending = []
    inLevel = 0
  }

  /**
   * ~100 ms of mic audio (24 kHz PCM16). Not listening: asleep, muted, a spoken update whose
   * listening window isn't open, or (half-duplex) Orbit is talking and might hear itself.
   */
  public func micFrame(_ pcm: [Int16]) {
    guard micOpen, !pcm.isEmpty else { return }
    let a = announce
    let deaf = state.muted || state.asleep || (a != nil && a!.stage == .speaking) || (options.halfDuplex && (isPlaying || soundPlaying))
    inLevel = deaf ? 0 : VoiceAudio.rms(pcm)
    if inLevel > 0.02 { lastLoudAt = now }
    if !deaf { send(.audioAppend(base64: VoiceAudio.base64(pcm))) }
  }

  /** Close the mic right away (Grok can still finish what it's saying). */
  private func muteMic() {
    setAsleepBoth(true)
    state.hearing = false
    send(.audioClear)
  }

  // MARK: - hanging up, sleep, wake

  /**
   * Hang up once Grok has gone quiet (its audio has played out), or after `maxMs` at most.
   * `afterReply`: also wait for a reply that finishes after now (e.g. Grok's goodbye). `keepIfDraft`
   * ("one question" mode): if a draft is waiting for a yes, stay connected for a minute instead.
   */
  private func hangUpWhenQuiet(_ maxMs: Double, afterReply: Bool = false, keepIfDraft: Bool = false, waitForTools: Bool = false, reason: ByeReason = .sleep) {
    clock.cancel(hangupPoll)
    let t0 = now
    var quietSince = 0.0 // must stay quiet ~1 s: there are short gaps between a tool call and the spoken reply
    hangupPoll = clock.every(VoiceSession.hangupPollMs) { [unowned self] in
      self.run {
        let n = self.now
        let quiet = !self.isPlaying && !self.responding && self.toolsInFlight == 0 && n - self.lastAudioAt > 600 && (!afterReply || self.responseDoneAt > t0)
        quietSince = quiet ? (quietSince == 0 ? n : quietSince) : 0
        // waitForTools: a second-brain question can take up to 5 minutes; don't cut it off.
        let limit = waitForTools && self.toolsInFlight > 0 ? max(maxMs, VoiceSession.secondBrainMaxMs) : maxMs
        if !(quiet && n - quietSince >= 900) && n - t0 < limit { return }
        self.clock.cancel(self.hangupPoll)
        if keepIfDraft && self.state.draft != nil && self.connected {
          self.clock.cancel(self.tapHold)
          self.tapHold = self.clock.after(VoiceSession.tapDraftHoldMs) { [unowned self] in self.run { self.stop(.draftHold) } }
          return
        }
        self.stop(reason)
      }
    }
  }

  /** Go to sleep = hang up (after Grok's goodbye). Nothing is billed while asleep. */
  private func sleepNow(grok: Bool = false, reason: ByeReason = .sleep) {
    clock.cancel(tapTimer)
    clock.cancel(tapHold)
    guard connected else { return }
    endAnnounce()
    muteMic()
    emit(.chime(.sleep))
    hangUpWhenQuiet(grok ? 6000 : 3000, afterReply: grok, reason: reason)
  }

  /** In "one question" mode, listen for one utterance; say nothing for 10 s and it hangs up. */
  private func armTapTimeout() {
    clock.cancel(tapTimer)
    if options.listenMode == .tap {
      tapTimer = clock.after(VoiceSession.tapTimeoutMs) { [unowned self] in self.run { self.sleepNow(reason: .tapTimeout) } }
    }
  }

  /** "One question" mode, while a draft waits: open the mic again for the answer. */
  private func wakeNow() {
    guard state.asleep, connected else { return }
    clock.cancel(hangupPoll)
    clock.cancel(tapHold)
    setAsleepBoth(false)
    emit(.chime(.wake))
    armTapTimeout()
  }

  // MARK: - spoken updates

  /** Spoken update: Grok is done and its audio has played out, so open the mic for a short reply. */
  private func openListenWindow() {
    guard let a = announce, a.stage == .speaking, connected else { return }
    a.stage = .listening
    emit(.chime(.wake)) // you hear when the mic opens; it plays out before the mic starts
    clock.after(VoiceSession.listenWindowChimeMs) { [unowned self] in
      self.run {
        guard self.announce === a, a.stage == .listening else { return }
        self.openMic { [unowned self] r in
          if case .failure(let e) = r {
            self.error("Microphone problem: \(e.message)", count: false)
            self.stop(.micError)
            return
          }
          if self.announce === a && a.stage != .listening { return self.closeMic() } // Grok started speaking again
          guard self.announce === a, self.wsOpen else { return }
          self.send(.uiListenWindow)
          self.caption(.note, "note", "Listening for \(Int(VoiceSession.announceListenMs / 1000)) seconds…")
          self.clock.cancel(a.timer)
          a.timer = self.clock.after(VoiceSession.announceListenMs) { [unowned self] in self.run { self.listenCheck(a) } }
        }
      }
    }
  }

  private func listenCheck(_ a: Announce) {
    guard announce === a, a.stage == .listening else { return }
    // You may have started talking just as the window closed: give the voice detection a moment.
    if !a.grace && now - lastLoudAt < 400 {
      a.grace = true
      a.timer = clock.after(VoiceSession.announceGraceMs) { [unowned self] in self.run { self.listenCheck(a) } }
      return
    }
    stop(.listenExpired) // nothing said: back to sleep (hang up)
  }

  /**
   * Spoken update: wait until the bridge says Grok is done and its audio has finished playing,
   * then open the mic. If nothing played (Grok was silent, or the audio never came out), it opens
   * anyway after a couple of seconds of quiet, so you can always answer or say "go to sleep".
   */
  private func watchAnnounce() {
    clock.cancel(announcePoll)
    guard let a = announce else { return }
    var quietSince = 0.0
    announcePoll = clock.every(VoiceSession.announcePollMs) { [unowned self] in
      self.run {
        guard self.announce === a, a.stage == .speaking else { return self.clock.cancel(self.announcePoll) }
        let n = self.now
        if n - a.startedAt > VoiceSession.announceMaxMs {
          self.clock.cancel(self.announcePoll)
          self.stop(.announceMax)
          return
        }
        let quiet = a.ready && !self.isPlaying && !self.soundPlaying && !self.responding && n - self.lastAudioAt > 300
        quietSince = quiet ? (quietSince == 0 ? n : quietSince) : 0
        let heardIt = self.lastAudioAt > a.startedAt
        if quiet && n - quietSince >= (heardIt ? 300 : VoiceSession.announceSilentOpenMs) {
          self.clock.cancel(self.announcePoll)
          self.openListenWindow()
        }
      }
    }
  }

  /**
   * You answered a spoken update: carry on as a normal conversation. Since you didn't start it,
   * it hangs up by itself after 20 s of quiet (a minute while a draft waits for your yes).
   */
  private func answeredAnnounce() {
    endAnnounce()
    clock.cancel(idlePoll)
    lastActivity = now
    idlePoll = clock.every(VoiceSession.idlePollMs) { [unowned self] in
      self.run {
        guard self.connected else { return self.clock.cancel(self.idlePoll) }
        let busy = self.isPlaying || self.responding || self.toolsRunning > 0 || self.state.asleep
        let last = max(self.lastActivity, self.lastAudioAt, self.responseDoneAt)
        if !busy && self.now - last > (self.state.draft != nil ? VoiceSession.tapDraftHoldMs : VoiceSession.announceIdleMs) {
          self.clock.cancel(self.idlePoll)
          self.sleepNow(reason: .idle)
        }
      }
    }
  }

  // MARK: - playback

  /** Seconds of Grok audio actually played out so far, from what was scheduled and the clock. */
  public var playedSoFar: Double {
    reap()
    let t = audio.audioTime
    var s = stats.played
    if inCall { for p in playing where !p.isTail { s += min(p.dur, max(0, t - p.at)) } }
    return s
  }

  private func stopPlayback() {
    reap()
    let t = audio.audioTime
    if inCall && playHead - t > 0.05 && !playing.isEmpty { stats.cut += 1 }
    lastChunk = nil
    for p in playing where !p.isTail { stats.played += min(p.dur, max(0, t - p.at)) }
    let had = !playing.isEmpty
    playing.removeAll()
    audioEndsAt = 0
    if inCall { playHead = t }
    emotes.clear() // nothing still to play: no feelings for it either
    if had { emit(.stopPlayback) }
  }

  /** Schedule a chunk of the voice; returns when it plays (audio clock), how long, and its samples. */
  private func playPcm(_ b64: String) -> (at: Double, dur: Double, pcm: [Int16])? {
    guard inCall else { return nil }
    let pcm = VoiceAudio.pcm16(base64: b64)
    guard !pcm.isEmpty else { return nil }
    let t = audio.audioTime
    let dur = Double(pcm.count) / VoiceAudio.rate
    // A play head far ahead of the clock is stale (a previous call's), not a real queue.
    if playHead > t + VoiceSession.maxQueuedS { playHead = t }
    playHead = max(playHead, t + 0.03)
    let at = playHead
    playHead += dur
    // Wall-clock end of everything queued (see isPlaying), when it is actually heard.
    audioEndsAt = now + (playHead - t + outLatency) * 1000
    lastChunk = (pcm, playHead, false)
    let lead = at - t
    if stats.chunks == 0 { stats.firstLead = lead }
    stats.maxLead = max(stats.maxLead, lead)
    stats.scheduled += dur
    stats.chunks += 1
    chunkSeq += 1
    let samples = VoiceAudio.float(pcm16: pcm)
    playing.append(Playing(id: chunkSeq, at: at, dur: dur, samples: samples, isTail: false))
    emit(.play(PlaybackChunk(id: chunkSeq, samples: samples, at: at, isTail: false)))
    return (at, dur, pcm)
  }

  /**
   * The reply's audio is all here: if it ends abruptly (still sounding in its last 10 ms), let it fall
   * away over ~120 ms right after its real end, instead of stopping dead. Never before that end, and
   * only if nothing else is queued after it and it hasn't finished playing yet.
   */
  private func addRelease() {
    guard inCall, let lc = lastChunk, !lc.released else { return }
    lastChunk?.released = true
    let t = audio.audioTime
    if abs(playHead - lc.endAt) > 1e-6 || lc.endAt < t + 0.005 { return }
    guard let tail = VoiceAudio.releaseTail(lc.pcm) else { return }
    let dur = Double(tail.count) / VoiceAudio.rate
    playHead = lc.endAt + dur
    audioEndsAt = now + (playHead - t + outLatency) * 1000
    chunkSeq += 1
    playing.append(Playing(id: chunkSeq, at: lc.endAt, dur: dur, samples: tail, isTail: true))
    emit(.play(PlaybackChunk(id: chunkSeq, samples: tail, at: lc.endAt, isTail: true)))
  }

  /** The voice's level now (before the volume), from the last 512 samples played. */
  private func outputLevel() -> Double {
    let t = audio.audioTime
    let n = 512
    let t0 = t - Double(n) / VoiceAudio.rate
    var sum = 0.0
    for p in playing where p.at < t && p.at + p.dur > t0 {
      let a = max(0, Int(((t0 - p.at) * VoiceAudio.rate).rounded(.down)))
      let b = min(p.samples.count, Int(((t - p.at) * VoiceAudio.rate).rounded(.down)))
      if b > a { for i in a..<b { let x = Double(p.samples[i]); sum += x * x } }
    }
    return (sum / Double(n)).squareRoot()
  }

  /** The output was reset (a device change): what was scheduled is gone. */
  public func outputLost() {
    run { if !playing.isEmpty { stopPlayback() } }
  }

  // MARK: - text

  private func sendText(_ text: String) {
    guard connected, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    if announce != nil {
      // Typing during a spoken update answers it: carry on as a normal conversation.
      answeredAnnounce()
      openMic { [unowned self] r in if case .failure(let e) = r { self.error(e.plain, count: false) } }
    }
    lastActivity = now
    caption(.you, "typed", text)
    send(.uiText(text))
    thinking = true
  }

  // MARK: - the bridge's events

  /** The socket to the bridge opened. */
  public func socketOpened(generation g: Int) {
    run { if g == generation && connected { wsOpen = true; state.connected = true } }
  }

  /** The socket to the bridge closed (or failed). */
  public func socketClosed(generation g: Int) {
    run {
      guard g == generation, connected else { return }
      wsOpen = false // nothing more can be said on it (no goodbye)
      stop(.closed)
    }
  }

  public func socketMessage(generation g: Int, _ text: String) {
    guard g == generation, connected, let evt = ServerEvent.parse(text) else { return }
    handle(evt)
  }

  public func handle(_ evt: ServerEvent) {
    run { handleEvent(evt) }
  }

  private func replyKey(_ responseId: String?) -> String { responseId ?? replyId }

  private func handleEvent(_ evt: ServerEvent) {
    switch evt {
    case .bridgeReady:
      ready = true
      if announce != nil {
        // Woken only to say what Claude finished: no wake chime, mic still closed.
        send(.uiState(asleep: false))
        watchAnnounce()
        return
      }
      emit(.chime(.wake))
      send(.uiState(asleep: state.asleep))
      if let p = pendingText {
        pendingText = nil
        sendText(p)
      } else {
        armTapTimeout()
      }
    case .bridgeError(let m):
      error(jsString(m))
    case .bridgeClosed(_, let reason):
      let r = reason?.truthy == true ? ": \(jsString(reason))" : "."
      error("Grok disconnected\(r)")
    case .bridgeSleep:
      // "Go to sleep" means now: no goodbye, no waiting for Grok to finish. Stop what's playing,
      // close the mic and hang up straight away (the chime says it happened).
      clock.cancel(tapTimer)
      clock.cancel(tapHold)
      stopPlayback()
      emit(.chime(.sleep))
      stop(.sleep)
    case .bridgeAnnounce(let ok, _):
      if !ok { stop(.bridge) } // nothing (left) to say, or the window ended: hang up
    case .bridgeAnnounceReady:
      if let a = announce { a.ready = true; a.readyAt = now }
    case .bridgeSession(let title):
      state.sessionTitle = title
    case .bridgeDraft(let d):
      let old = state.draft
      state.draft = d
      if let d, d.id != old?.id { emit(.avatarEvent(.draft)) }
    case .bridgeCopied(let chars, let preview):
      // Show what was copied, so nothing lands on the clipboard unseen before you paste it.
      let more = chars > Double(preview.utf16.count) ? "…" : ""
      caption(.note, "copied", "Copied to clipboard ✓ (\(jsNumber(chars)) characters): \(preview)\(more)")
    case .bridgeAvatar(_, let fast):
      // The avatar is doing what you asked. By the fast path (no model turn): nothing more is
      // coming, so stop anything Grok had already started saying, and stop "thinking".
      if fast {
        stopPlayback()
        thinking = false
      }
    case .bridgeBrain(let project):
      caption(.note, "brain", "Claude is reading \(jsString(project))…")
    case .bridgeSent(let text):
      caption(.sent, "sent", jsString(text))
      state.sentCount += 1
      emit(.avatarEvent(.sent))
    case .bridgeTool(let name):
      thinking = true
      toolsInFlight += 1
      toolsRunning += 1
      // Own keys only: a tool name like "__proto__" from Grok is not a note.
      if let n = name?.stringValue, let note = VoiceSession.toolNotes[n] { caption(.note, "tool", note) }
      if name?.stringValue == "send_draft" { state.sending = true }
    case .bridgeToolResult(let name, let result):
      toolsInFlight = max(0, toolsInFlight - 1)
      toolsRunning = max(0, toolsRunning - 1)
      if name?.stringValue == "send_draft" { state.sending = false }
      if let r = result, r.truthy, (r["error"]?.truthy ?? false) || r["ok"] == .bool(false) {
        let m = r["message"]?.truthy == true ? r["message"] : r["error"]?.truthy == true ? r["error"] : nil
        error(m.map { jsString($0) } ?? "That didn't work.")
      }
      if let open = result?["open_in_app"], open.truthy { state.sessionTitle = open.stringValue ?? jsString(open) }
      if result?["deferred"]?.truthy == true { caption(.note, "brain", "Claude is still thinking. Grok will tell you when the answer is ready.") }
    case .error(let m):
      error(m?.truthy == true ? jsString(m) : "Grok reported an error.")
    case .audioDelta(let delta, let rid, let emote):
      thinking = false
      lastAudioAt = now
      let r = playPcm(delta)
      let cue = emote.map { EmoteSync.ChunkCue(name: $0, offset: 0) }
      if let r { emotes.audio(replyKey(rid), at: r.at, dur: r.dur, samples: VoiceAudio.float(pcm16: r.pcm), cue: cue) }
      else if let cue, inCall { emotes.audio(replyKey(rid), at: max(playHead, audio.audioTime), dur: 0, samples: nil, cue: cue) } // a feeling after the last words
    case .audioDone(let rid):
      emotes.audioDone(replyKey(rid))
      addRelease()
    case .bridgeEmote(let item, let rid, let cue, let at):
      // A cue in the reply's transcript (Grok): placed on the reply's audio when its words play.
      _ = item
      emotes.cue(replyKey(rid), cue, .at(Int(at)))
    case .responseCreated(let id):
      if let id { replyId = id }
      responding = true
      if let a = announce {
        // Spoken update: Grok speaks again before you said anything. Close the mic again; it
        // reopens for a fresh window once Grok is done.
        a.ready = false
        if a.stage == .listening {
          clock.cancel(a.timer)
          a.stage = .speaking
          a.grace = false
          closeMic()
        }
        watchAnnounce()
      }
    case .speechStarted:
      if let a = announce, a.stage == .listening {
        // You started talking in the window. It only counts once it's words (a cough doesn't);
        // keep listening a few seconds for them.
        clock.cancel(a.timer)
        a.stage = .heard
        a.timer = clock.after(VoiceSession.announceHeardMs) { [unowned self] in self.run { if self.announce === a { self.stop(.heardNoWords) } } }
      }
      lastActivity = now
      clock.cancel(tapTimer)
      state.hearing = true
      thinking = false
      // You started talking: Grok is interrupted. Except over the very end of a reply that has all
      // arrived ("yes" over "...send it?"): that's you answering it, so its last word plays out.
      reap()
      let remainingS = inCall && !playing.isEmpty ? playHead - audio.audioTime + outLatency : 0
      if VoiceAudio.letItFinish(remainingS: remainingS, replyDone: !responding) { stats.kept += 1 }
      else { stopPlayback() }
    case .speechStopped:
      state.hearing = false
      thinking = true
      // "One question" mode: you've asked it, so close the mic; hang up once Grok has answered
      // (or wait a minute if it drafted a prompt that needs your yes).
      if options.listenMode == .tap && !state.asleep {
        clock.cancel(tapTimer)
        muteMic()
        hangUpWhenQuiet(90_000, afterReply: true, keepIfDraft: true, waitForTools: true)
      }
    case .responseDone(let id, let status):
      emotes.audioDone(replyKey(id))
      if status != "cancelled" { addRelease() }
      thinking = false
      responding = false
      toolsInFlight = 0
      responseDoneAt = now
    case .inputTranscription(_, let itemId, let transcript, let delta):
      // Real words in reply to a spoken update: from here on, a normal conversation.
      if announce != nil, let t = transcript, hasLetterOrNumber(t) { answeredAnnounce() }
      let id = "you-\(itemId ?? "undefined")"
      if let t = transcript { caption(.you, "you", t, id: id) }
      else if let d = delta, d.truthy { caption(.you, "you", jsString(d), id: id, append: true) }
    case .outputText(let type, let itemId, let rid, let delta, let transcript):
      let id = "grok-\(itemId ?? rid ?? "undefined")"
      if type.hasSuffix(".delta"), let d = delta, d.truthy { caption(.grok, "grok", jsString(d), id: id, append: true) }
      else if type.hasSuffix(".done"), let t = transcript, t.truthy { caption(.grok, "grok", jsString(t), id: id) }
      if type.hasSuffix(".delta"), let d = delta?.stringValue { emotes.text(replyKey(rid), d) }
      else if type.hasSuffix(".done") { emotes.textDone(replyKey(rid), transcript?.stringValue) }
    case .unknown:
      break
    }
  }

  // MARK: - starting and stopping

  /** Hang up now. `reason` goes to the bridge's log (a code, nothing else). */
  private func stop(_ reason: ByeReason = .other) {
    let wasLive = inCall || connected || starting
    clock.cancel(tapTimer)
    clock.cancel(tapHold)
    clock.cancel(hangupPoll)
    clock.cancel(idlePoll)
    endAnnounce()
    toolsRunning = 0
    responding = false
    if wsOpen {
      send(.uiBye(ByeReport(reason: reason, audio: inCall ? audioStateName : "none", scheduled: stats.scheduled, played: playedSoFar,
                            lead: stats.firstLead, maxLead: stats.maxLead, cut: stats.cut, kept: stats.kept)))
    }
    if connected { emit(.disconnect(generation: generation)) }
    connected = false
    wsOpen = false
    starting = false
    stopPlayback()
    closeMic()
    inCall = false
    clock.cancel(levelTimer)
    levelTimer = nil
    playHead = 0 // the next call starts its play head afresh
    ready = false
    thinking = false
    state.asleep = false
    state.phase = .off
    state.input = 0
    state.output = 0
    meter.reset()
    state.hearing = false
    state.sending = false
    state.connected = false
    if wasLive { emit(.hungUp(reason)) }
  }

  /** Connect. `announce`: woken only to say what Claude finished (the mic stays closed for now). */
  private func start(announce wantAnnounce: Bool = false) {
    guard !connected, !starting, !inCall else { return }
    state.phase = .connecting
    state.muted = false // every call starts with the mic live
    inCall = true
    // Playback is timed afresh for this call.
    playHead = 0
    audioEndsAt = 0
    stats = VoiceAudioStats()
    playing.removeAll()
    lastChunk = nil
    emit(.setVolume(gain: VoiceAudio.volumeGain(options.volume)))
    startLevelLoop()
    if wantAnnounce {
      announce = Announce(startedAt: now)
      state.announcing = true
      connect(announce: true)
    } else {
      starting = true
      openMic { [unowned self] r in
        self.starting = false
        switch r {
        case .failure(let e):
          self.error("Microphone problem: \(e.message)", count: false)
          self.stop(.micError)
        case .success:
          if self.inCall { self.connect(announce: false) }
        }
      }
    }
  }

  private func connect(announce a: Bool) {
    generation += 1
    connected = true
    wsOpen = false
    emit(.connect(generation: generation, announce: a))
  }

  /** ~20 fps: work out the phase and the volume levels that drive the orb. */
  private func startLevelLoop() {
    clock.cancel(levelTimer)
    levelTimer = clock.every(VoiceSession.levelTickMs) { [unowned self] in
      self.run {
        guard self.inCall else { return }
        let l = self.meter.tick(input: self.inLevel, output: self.outputLevel())
        self.state.input = l.input
        self.state.output = l.output
        self.state.phase = !self.ready ? .connecting
          : self.isPlaying ? .speaking
          : self.thinking || self.announce?.stage == .speaking ? .thinking // spoken update: the mic is closed
          : .listening
      }
    }
  }

  // MARK: - the user's actions (useVoice's returned API)

  /** Hotkey, orb click and "Hey Orbit": start if hung up; during a spoken update, hang up; asleep, wake; else sleep. */
  public func hotkey() {
    run {
      if !connected && !starting { start() }
      else if announce != nil { stop(.user) }
      else if state.asleep { wakeNow() } // "one question" mode: a draft is waiting for your answer
      else if connected { sleepNow() }
    }
  }

  public func startCall() { run { start() } }
  /** Hang up now (the stop button, quitting). */
  public func hangup(_ reason: ByeReason = .user) { run { stop(reason) } }
  public func sleep() { run { sleepNow() } }
  public func wake() { run { wakeNow() } }

  /** Claude finished while Orbit is off: connect just to say so, then listen ~3 s for a reply. */
  public func announceUpdate() { run { if !connected && !starting { start(announce: true) } } }

  /** A spoken update is on (Grok woke by itself): end it now. False if there is none. */
  @discardableResult public func endWake() -> Bool {
    guard announce != nil, connected else { return false }
    run { stop(.user) }
    return true
  }

  /** Type a message into the conversation. */
  public func type(_ text: String) { run { sendText(text) } }

  /** Ask in text, connecting first if needed (the session switcher). */
  public func ask(_ text: String) {
    run {
      if connected && ready { sendText(text) } else {
        pendingText = text
        start()
      }
    }
  }

  /** Mute or unmute the mic for this call. Muting also drops any half-heard speech. */
  public func setMuted(_ m: Bool) {
    run {
      state.muted = m
      if m {
        state.hearing = false
        send(.audioClear)
      }
    }
  }

  public func toggleMute() { setMuted(!state.muted) }

  /** A sound of Orbit's own is playing for `ms` (the avatar's throw sound): listened to like its voice. */
  public func ownSound(_ ms: Double) { ownSoundUntil = max(ownSoundUntil, now + max(0, ms)) }

  public func note(_ text: String) { run { caption(.note, "note", text) } }

  /** New settings: the volume applies at once (the chimes follow it). */
  public func setOptions(_ o: VoiceOptions) {
    let volumeChanged = o.volume != options.volume
    options = o
    if volumeChanged && inCall { emit(.setVolume(gain: VoiceAudio.volumeGain(o.volume))) }
  }

  // MARK: - for the parity driver and tests

  public var isConnected: Bool { connected }
  public var isInCall: Bool { inCall }
  public var isMicOpen: Bool { micOpen }

  public var parity: ParityVoice {
    let d = state.draft.map { ParityDraft(id: $0.id, text: $0.text, targetTitle: $0.targetTitle) }
    return ParityVoice(phase: state.phase, asleep: state.asleep, connected: wsOpen, muted: state.muted, playedMs: (playedSoFar * 1000).rounded(),
                       scheduledMs: (stats.scheduled * 1000).rounded(), chunks: stats.chunks, lastError: state.lastError, draft: d, sentCount: state.sentCount)
  }
}
