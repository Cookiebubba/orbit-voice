// How the shell's parts talk to each other once the core is up (electron/main.js's IPC handlers and
// window plumbing, natively): the voice client drives the orb and the avatars; the avatars' clicks,
// lifts and throws come back to the voice; the core's messages reach the overlays; the hotkey, the
// wake word and the launcher all go through the voice controller.
import AppKit
import Combine
import Observation
import OrbitKit
import OrbitOverlays
import OrbitUI
import OrbitVoice
import OrbitWake

/** The global hotkey for the launcher's Settings: the real Carbon one, or in a test build driven by
 *  the parity suite an in-memory one (never registered with macOS, as the Electron driver does). */
@MainActor
final class ShellHotkey: HotkeyControl {
  private let real: GlobalHotkey?
  private var fakeAccel: String
  private var fakeRegistered = false
  private var suspended = false
  var onPress: () -> Void = {}
  var onSaved: (String) -> Void = { _ in }

  init(accelerator: String, fake: Bool) {
    fakeAccel = accelerator
    real = fake ? nil : GlobalHotkey(accelerator: accelerator)
    real?.onPress = { [weak self] in self?.onPress() }
    real?.onSaved = { [weak self] a in self?.onSaved(a) }
  }

  @discardableResult func start() -> Bool {
    if let real { return real.start() }
    fakeRegistered = HotkeyAccelerator.isAcceptable(fakeAccel) && HotkeyAccelerator.parse(fakeAccel) != nil
    return fakeRegistered
  }

  var registered: Bool { real?.info.registered ?? (fakeRegistered && !suspended) }

  func info() -> HotkeyControlInfo {
    if let real { let i = real.info; return HotkeyControlInfo(accelerator: i.accelerator, label: i.label, registered: i.registered) }
    return HotkeyControlInfo(accelerator: fakeAccel, registered: fakeRegistered && !suspended)
  }

  func set(_ accel: String) -> HotkeyControlInfo {
    if let real {
      let i = real.set(accel)
      return HotkeyControlInfo(accelerator: i.accelerator, label: i.label, registered: i.registered, ok: i.ok, error: i.error)
    }
    guard HotkeyAccelerator.isAcceptable(accel) else {
      var i = info(); i.ok = false; i.error = HotkeyAccelerator.noShortcutError; return i
    }
    // (One the system couldn't register: the real hotkey refuses it, and so does this stand-in.)
    guard HotkeyAccelerator.parse(accel) != nil else {
      var i = info(); i.ok = false; i.error = HotkeyAccelerator.takenError; return i
    }
    fakeAccel = accel
    fakeRegistered = true
    onSaved(accel)
    var i = info(); i.ok = true; return i
  }

  func suspend(_ s: Bool) {
    if let real { real.suspend(s) } else { suspended = s }
  }

  /** The parity driver's voice.hotkey: what pressing it does, if it's held. */
  func press() -> Bool {
    guard registered else { return false }
    onPress()
    return true
  }
}

/** The voice controller as the launcher reads and drives it (OrbitUI's VoiceUI). */
@MainActor
@Observable
final class VoiceUIAdapter: VoiceUI {
  var phase: VoicePhase = .off
  var asleep = false
  var hearing = false
  var muted = false
  var inputLevel = 0.0
  var outputLevel = 0.0
  var captions: [VoiceCaption] = []
  var draft: VoiceDraft?
  var sending = false
  var sessionTitle: String?
  var talkNotice: TalkNotice?
  @ObservationIgnored private let voice: VoiceController
  @ObservationIgnored private var subs: Set<AnyCancellable> = []

  init(_ voice: VoiceController) {
    self.voice = voice
    voice.$state.sink { [weak self] s in
      guard let self else { return }
      self.phase = s.phase; self.asleep = s.asleep; self.hearing = s.hearing; self.muted = s.muted
      self.inputLevel = s.input; self.outputLevel = s.output; self.sending = s.sending
    }.store(in: &subs)
    voice.$captions.sink { [weak self] cs in
      self?.captions = cs.map { VoiceCaption(id: $0.id, who: VoiceCaption.Who(rawValue: $0.who.rawValue) ?? .note, text: $0.text, at: Date(timeIntervalSince1970: $0.at / 1000)) }
    }.store(in: &subs)
    voice.$draft.sink { [weak self] d in self?.draft = d }.store(in: &subs)
    voice.$sessionTitle.sink { [weak self] t in self?.sessionTitle = t }.store(in: &subs)
    voice.$talkNotice.sink { [weak self] n in self?.talkNotice = n }.store(in: &subs)
  }

  func useClaudeVoice() { voice.useClaudeVoice() }

  func hotkey() { voice.hotkey() }
  func start() { if voice.state.phase == .off { voice.hotkey() } }
  func wake() { voice.wake() }
  func sleep() { voice.sleep() }
  func toggleMute() { voice.toggleMute() }
  func type(_ text: String) { voice.type(text) }
  func ask(_ text: String) { voice.ask(text) }
}

extension AppDelegate {
  /**
   * The voice client, the hotkey, "Hey Orbit" and the overlays, wired together and to the core (the
   * launcher comes up in startWindows with the voice adapter this makes).
   */
  func startVoiceAndOverlays(_ e: BridgeEndpoints) {
    // The test switches (fake mic, muted output) only in a test build; a release always uses the real ones.
    let io = AudioIO(config: config.testing ? .fromEnvironment() : AudioIO.Config())
    io.log = { [weak self] m in self?.log.info("audio", m) }
    let v = VoiceController(endpoints: e, audio: io)
    let fakeHotkey = config.testing && ParityDriver.config(info: info) != nil
    let hk = ShellHotkey(accelerator: HotkeyAccelerator.defaultAccelerator, fake: fakeHotkey)
    hk.onPress = { [weak v] in v?.hotkey() }
    hk.onSaved = { [weak self] accel in self?.saveShellSettings(["wakeHotkey": .string(accel)]) }
    voiceController = v
    shellHotkey = hk
    // Phase 2: Claude voice's speech on this Mac in Swift (syncLocalSpeech, once the settings are in).
    voice = VoiceUIAdapter(v)
    hotkeys = hk

    let o = Overlays(
      endpoints: e,
      settings: { [weak self] in self?.ui?.settings.values ?? SettingsSchema.defaults },
      send: { [weak self] m in
        self?.sidecar?.send(m)
        self?.engine?.voice?.shellMessage(m) // (the avatar on screen, the Claude window in front)
      },
      onTalk: { [weak v] in v?.avatarTalk() },
      onSound: { [weak self, weak v] name in
        v?.playSound(name)
        self?.events.sound(name)
      },
      onOrb: { [weak self, weak v] ev in
        switch ev {
        case .restore: self?.ui?.showMain()
        case .action: v?.hotkey()
        case .save(let patch): self?.saveShellSettings(patch)
        }
      },
      onEvent: { [weak self] type, data in self?.events.add(type, data) },
      log: { [weak self] m in self?.log.info("overlays", m) },
      helperPath: Self.helperPath(config: config),
      orb: false // Orbit Native has no floating orb: the launcher minimizes to the Dock like any Mac app
    )
    overlays = o
    v.onState = { [weak o] s in o?.onVoice(s) }
    v.onEmote = { [weak o] cue in _ = o?.emote(cue) }
    v.onAvatarEvent = { [weak o] ev in o?.event(ev.rawValue) }
    v.onClaudeFinished = { [weak o] _, _ in o?.event("finished") }
    v.onEvent = { [weak self] type, data in
      // ("sound" is recorded where it's played; the rest go to the driver's ring as they are.)
      if type != "sound" { self?.events.add(type, data) }
      if type == "voice.phase" { self?.syncLocalSpeech() }
    }
    Task { @MainActor [weak self, weak v] in
      try? await v?.loadConfig()
      guard let self, let v else { return }
      self.syncLocalSpeech()
      let accel = v.settings.wakeHotkey
      if !accel.isEmpty { _ = hk.set(accel) } else { hk.start() }
      if !hk.registered { hk.start() }
      if !hk.registered { self.log.warn("hotkey", "Could not register \(accel); another app may be using it") }
      // "Hey Orbit" on this Mac in Swift (phase 2): Vosk natively, on the app's own mic stream.
      let w = NativeWake(audio: io, archive: self.config.coreDir.appendingPathComponent("resources/models/\(WakeModel.file)"),
                         cache: self.config.profileDir.appendingPathComponent("cache"), log: { [weak self] m in self?.log.info("wake", m) })
      v.attach(wakeWord: w)
      self.wakeWord = w
    }
  }

  /** Where the macOS helper is (the core's copy in the bundle, or the repo's when run from source). */
  static func helperPath(config: LaunchConfig) -> String? {
    let p = config.coreDir.appendingPathComponent("resources/mac/orbit-helper").path
    return FileManager.default.isExecutableFile(atPath: p) ? p : nil
  }

  /** After the launcher is up: the bridge's events reach the voice and the overlays too. */
  func wireBridgeEvents() {
    guard let ui, let v = voiceController else { return }
    ui.settings.onKeySaved = { [weak v] in v?.keySaved() }
    ui.appState.onWake = nil // (the voice controller answers orbit.wake itself)
    ui.appState.onEvent = { [weak self, weak v] evt in
      v?.handleBridgeEvent(evt)
      if evt["type"]?.stringValue == "settings.changed" {
        self?.syncLocalSpeech()
        let keys = evt["changed"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self?.overlays?.settingsChanged(keys)
      }
      if evt["type"]?.stringValue == "claude.status" {
        v?.orbExtras.claudeWorking = !(evt["working"]?.arrayValue?.isEmpty ?? true)
      }
    }
    // The avatar comes up from the settings, so only once they've loaded (else it would start as the
    // default, the pixel buddy, and switch).
    Task { @MainActor [weak self, weak ui] in
      for _ in 0..<200 where !(ui?.settings.loaded ?? true) { try? await Task.sleep(nanoseconds: 25_000_000) }
      self?.overlays?.start()
    }
  }
}

extension AppDelegate {
  /**
   * Claude voice's speech models in the app while Claude voice is the engine, and only then (as the
   * core loads its own only then): loaded in the background when they're in the profile (at start,
   * on a settings change, and when a call starts, so models downloaded since are picked up by the
   * next call), and let go when the engine is Grok and no call is on. Meanwhile, or if they can't
   * load, the core does the speech as it does for Electron.
   */
  func syncLocalSpeech() {
    guard config.speechInApp, !quitting, let v = voiceController else { return }
    if v.settings.voiceEngine != "claude" {
      if v.localSpeech != nil, v.state.phase == .off {
        v.localSpeech = nil
        log.info("speech", "on-device speech in Swift released (Grok is the voice)")
      }
      return
    }
    guard v.localSpeech == nil, localSpeechTask == nil else { return }
    let profile = config.profileDir
    let log = self.log
    let task = Task.detached(priority: .userInitiated) { NativeLocalSpeech.load(profile: profile) { log.info("speech", $0) } }
    localSpeechTask = task
    // A call starting meanwhile waits for them (at most 10 s; loading takes a second or two).
    v.localSpeechLoading = {
      await withTaskGroup(of: NativeLocalSpeech?.self) { g in
        g.addTask { await task.value }
        g.addTask {
          try? await Task.sleep(nanoseconds: 10_000_000_000)
          return nil
        }
        let first = await g.next() ?? nil
        g.cancelAll()
        return first
      }
    }
    Task { @MainActor [weak self] in
      let engine = await task.value
      guard let self else { return }
      self.localSpeechTask = nil
      self.voiceController?.localSpeechLoading = nil
      // Still wanted (the engine may have changed while loading), and not replacing one in use.
      if let engine, self.voiceController?.settings.voiceEngine == "claude", self.voiceController?.localSpeech == nil {
        self.voiceController?.localSpeech = engine
      }
    }
  }
}

