// Orbit's voice client: VoiceSession (the call logic) wired to AudioIO (mic and speakers), the
// bridge's /voice WebSocket, the chimes and the throw sound. This is the facade the app shell uses
// (see README "Voice"): the hotkey, the orb, the avatar's click, "Hey Orbit" and the parity driver
// all come in here; state, captions and the draft go out.
import AVFoundation
import Combine
import Foundation
import OrbitKit

@MainActor
public final class VoiceController: ObservableObject {
  // MARK: what the UI reads
  @Published public private(set) var state = VoiceState()
  @Published public private(set) var captions: [Caption] = []
  @Published public private(set) var draft: VoiceDraft?
  @Published public private(set) var sessionTitle: String?
  @Published public private(set) var settings = VoiceSettings()
  /** An xAI key is saved (or Claude voice is on): what "Hey Orbit" and the avatar's click need. */
  @Published public private(set) var hasKey = false

  /** The orb / avatar sync message, on every change (levels ~20 fps while a call is on). */
  public var onState: (OrbSync) -> Void = { _ in }
  /** Shell-level happenings for the parity driver's events: "voice.phase" {phase, asleep}, "hotkey" {}, "sound" {name}, "hangup" {reason}. */
  public var onEvent: (String, JSONValue) -> Void = { _, _ in }
  /** An emote as the voice's words play (desktop.buddyEmote). */
  public var onEmote: (String) -> Void = { _ in }
  /** draft / sent / error, for the avatar (desktop.buddyEvent). */
  public var onAvatarEvent: (AvatarEvent) -> Void = { _ in }
  /** Claude finished somewhere (a claude.finished event, announce not off): the avatar celebrates. */
  public var onClaudeFinished: (_ title: String, _ summary: String) -> Void = { _, _ in }
  /** App-level parts of OrbSync (Claude working, the orb's pulse settings). */
  public var orbExtras: (claudeWorking: Bool, pulseMe: Bool, pulseGrok: Bool, pulseAmount: Double) = (false, false, false, 0.05) {
    didSet { onState(orbSync) }
  }

  public let link: BridgeLink
  public let audio: AudioIO
  public let session: VoiceSession
  /** Sounds played (name and time), for the parity driver's state. */
  public private(set) var sounds: [ParitySound] = []

  private let clock: MainQueueClock
  private var socket: VoiceSocket?
  private var socketGen = 0
  private var lastPhase: (VoicePhase, Bool)?
  private var throwData: Data?
  private var throwPlayer: AVAudioPlayer?
  private var events: Task<Void, Never>?
  private weak var wakeWord: WakeWord?

  public init(endpoints: BridgeEndpoints, audio: AudioIO? = nil) {
    link = BridgeLink(endpoints: endpoints)
    let io = audio ?? AudioIO()
    self.audio = io
    clock = MainQueueClock()
    session = VoiceSession(clock: clock, audio: io.clock)
    session.onOutput = { [weak self] o in MainActor.assumeIsolated { self?.perform(o) } }
    io.onFrame = { [weak self] pcm in self?.session.micFrame(pcm) }
    io.onOutputLost = { [weak self] in self?.session.outputLost() }
  }

  // MARK: - the facade

  /** The global hotkey, the orb, "Hey Orbit": start / sleep / wake (and end a spoken update). */
  public func hotkey() {
    onEvent("hotkey", [:])
    session.hotkey()
  }

  public func sleep() { session.sleep() }
  public func wake() { session.wake() }
  /** Claude finished while Orbit is off: connect just to say so (the bridge decides; orbit.wake). */
  public func announce() { if hasKey { session.announceUpdate() } }
  /** A spoken update is on: end it now. False if none. */
  @discardableResult public func endWake() -> Bool { session.endWake() }
  /** Type a message into the conversation. */
  public func type(_ text: String) { session.type(text) }
  /** Ask in text, connecting first if needed (the session switcher). */
  public func ask(_ text: String) { session.ask(text) }
  public func mute(_ on: Bool) { session.setMuted(on) }
  public func toggleMute() { session.toggleMute() }
  public func hangup() { session.hangup(.user) }
  public func note(_ text: String) { session.note(text) }

  /** The avatar was clicked to talk: the wake word's own path, only when Orbit is off or asleep. */
  public func avatarTalk() {
    if hasKey && (state.phase == .off || state.asleep) { hotkey() }
  }

  /**
   * One of Orbit's own sounds. "throw": the avatar's "Wheee!" at the voice volume (a new throw
   * restarts it), only with Settings → Avatar → Throw and Sound when thrown on; while it plays the
   * listening treats it like Orbit's own voice.
   */
  public func playSound(_ name: String) {
    guard name == "throw", settings.avatarThrow, settings.avatarThrowSound else { return }
    record(name)
    session.ownSound(1400) // THROW_SOUND_MS: a little over the 1.36 s clip
    guard !audio.config.muteOutput else { return }
    let volume = Float(VoiceAudio.volumeGain(settings.voiceVolume))
    if let p = throwPlayer {
      p.stop()
      p.currentTime = 0
      p.volume = volume
      p.play()
      return
    }
    Task { [weak self] in
      guard let self else { return }
      if self.throwData == nil { self.throwData = try? await self.link.getData("sounds/wheee.mp3") }
      guard let d = self.throwData, let p = try? AVAudioPlayer(data: d) else { return }
      p.volume = volume
      p.play()
      self.throwPlayer = p
    }
  }

  /** What the parity driver reports as `voice`. */
  public func parityVoice() -> ParityVoice { session.parity }

  /** The fake mic (ORBIT_FAKE_MIC set): play this clip into it now. */
  @discardableResult public func playIntoMic(wav: URL, gapMs: Double = 0) -> Bool { audio.play(wav: wav, gapMs: gapMs) }

  public var orbSync: OrbSync {
    state.orbSync(claudeWorking: orbExtras.claudeWorking, pulseMe: orbExtras.pulseMe, pulseGrok: orbExtras.pulseGrok, pulseAmount: orbExtras.pulseAmount)
  }

  // MARK: - settings and the bridge's events

  /** Load /api/config (settings, whether a key is saved). */
  public func loadConfig() async throws {
    let c = try await link.getJSON("api/config")
    hasKey = c["hasKey"]?.boolValue ?? false
    if let s = c["settings"] { apply(settings: s) }
  }

  /** New settings (the whole object or a changed part). */
  public func apply(settings s: JSONValue) {
    var next = settings
    next.merge(s)
    if next.voiceEngine == "claude" { hasKey = true } // Claude voice needs no xAI key
    settings = next
    session.setOptions(next.options)
    updateWakeWord()
  }

  public func setHasKey(_ v: Bool) {
    hasKey = v
    updateWakeWord()
  }

  /**
   * One event from the bridge's /api/events stream: orbit.wake (a spoken update), settings.changed,
   * claude.finished (the "done" chime and a note, unless announcements are off).
   */
  public func handleBridgeEvent(_ e: JSONValue) {
    switch e["type"]?.stringValue {
    case "orbit.wake":
      announce()
    case "settings.changed":
      if let s = e["settings"] { apply(settings: s) }
    case "claude.finished":
      let title = e["title"]?.stringValue ?? ""
      onClaudeFinished(title, e["summary"]?.stringValue ?? "")
      guard settings.announce != "off" else { return }
      chime(.done, volume: 0.1)
      session.note("Claude finished in “\(title)”")
    default: break
    }
  }

  /** Follow /api/events by itself (for VoiceDemo, or a shell without its own events client). */
  public func followBridgeEvents() {
    events?.cancel()
    events = link.events { [weak self] e in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.handleBridgeEvent(e) } }
    }
  }

  // MARK: - "Hey Orbit"

  /** The wake word listens only while the call is off or asleep, the setting is on and there's a key (App.tsx). */
  public func attach(wakeWord w: WakeWord) {
    wakeWord = w
    w.onWake = { [weak self] in self?.hotkey() }
    updateWakeWord()
  }

  public var wakeWordShouldRun: Bool { settings.wakeWord && hasKey && (state.phase == .off || state.asleep) }

  private func updateWakeWord() { wakeWord?.setActive(wakeWordShouldRun) }

  // MARK: - the session's outputs

  private func perform(_ o: VoiceOutput) {
    switch o {
    case .connect(let gen, let announce):
      connect(gen, announce: announce)
    case .disconnect(let gen):
      if gen == socketGen { socket?.close(); socket = nil }
    case .send(let m):
      socket?.send(m.text)
    case .openMic:
      audio.prepareOutput()
      audio.startCapture { [weak self] r in
        guard let self else { return }
        switch r {
        case .success: self.session.micOpened()
        case .failure(let e): self.session.micFailed(e)
        }
      }
    case .closeMic:
      audio.stopCapture()
    case .play(let chunk):
      audio.schedule(chunk)
    case .stopPlayback:
      audio.stopPlayback()
    case .setVolume(let g):
      audio.prepareOutput()
      audio.setVolume(gain: g)
      session.audioStateName = audio.stateName
    case .chime(let c):
      chime(c, volume: VoiceAudio.chimeLevel(settings.voiceVolume))
    case .emote(let e):
      onEmote(e)
    case .avatarEvent(let e):
      onAvatarEvent(e)
    case .captions(let c):
      captions = c
    case .draft(let d):
      draft = d
    case .sessionTitle(let t):
      sessionTitle = t
    case .state(let s):
      state = s
      onState(orbSync)
      if lastPhase.map({ $0 != (s.phase, s.asleep) }) ?? true {
        lastPhase = (s.phase, s.asleep)
        onEvent("voice.phase", ["phase": .string(s.phase.rawValue), "asleep": .bool(s.asleep)])
        updateWakeWord()
      }
    case .hungUp(let reason):
      onEvent("hangup", ["reason": .string(reason.rawValue)])
      audio.callEnded()
    }
  }

  private func chime(_ c: Chime, volume: Double) {
    record(c.rawValue)
    audio.chime(c, volume: volume)
  }

  private func record(_ name: String) {
    sounds.append(ParitySound(name: name, at: (Date().timeIntervalSince1970 * 1000).rounded()))
    if sounds.count > 100 { sounds.removeFirst(sounds.count - 100) }
    onEvent("sound", ["name": .string(name)])
  }

  private func connect(_ gen: Int, announce: Bool) {
    socket?.close()
    socketGen = gen
    let s = VoiceSocket()
    socket = s
    s.onOpen = { [weak self] in self?.session.socketOpened(generation: gen) }
    s.onText = { [weak self] t in self?.session.socketMessage(generation: gen, t) }
    s.onClose = { [weak self] in
      guard let self else { return }
      if self.socketGen == gen { self.socket = nil }
      self.session.socketClosed(generation: gen)
    }
    Task { [weak self] in
      guard let self else { return }
      do {
        let req = try await self.link.voiceRequest(announce: announce)
        guard self.socketGen == gen, self.socket === s else { return }
        s.open(req)
      } catch {
        // Not signed in (the bridge isn't there, or restarted): the call ends as a dropped socket would.
        self.link.signOut()
        self.session.handle(.bridgeError(message: "Orbit isn't signed in to its local bridge."))
        self.session.socketClosed(generation: gen)
      }
    }
  }
}
