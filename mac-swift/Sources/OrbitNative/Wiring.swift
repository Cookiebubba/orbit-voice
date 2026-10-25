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
    fakeRegistered = HotkeyAccelerator.isAcceptable(fakeAccel)
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
  }

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
    let v = VoiceController(endpoints: e, audio: io)
    let fakeHotkey = config.testing && ParityDriver.config(info: info) != nil
    let hk = ShellHotkey(accelerator: "Control+Alt+G", fake: fakeHotkey)
    hk.onPress = { [weak v] in v?.hotkey() }
    hk.onSaved = { [weak self] accel in self?.sidecar?.send(["t": "shellSettings", "patch": ["wakeHotkey": .string(accel)]]) }
    voiceController = v
    shellHotkey = hk
    // Phase 2: Claude voice's speech on this Mac in Swift, when its models are in the profile.
    let wantLocal = !(config.testing && ProcessInfo.processInfo.environment["ORBIT_SPEECH"] == "core")
    if wantLocal {
      let profile = config.profileDir
      let log = self.log
      DispatchQueue.global(qos: .userInitiated).async {
        let engine = NativeLocalSpeech.load(profile: profile) { log.info("speech", $0) }
        DispatchQueue.main.async { [weak v] in v?.localSpeech = engine }
      }
    }
    voice = VoiceUIAdapter(v)
    hotkeys = hk

    let o = Overlays(
      endpoints: e,
      settings: { [weak self] in self?.ui?.settings.values ?? SettingsSchema.defaults },
      send: { [weak self] m in self?.sidecar?.send(m) },
      onTalk: { [weak v] in v?.avatarTalk() },
      onSound: { [weak self, weak v] name in
        v?.playSound(name)
        self?.events.sound(name)
      },
      onOrb: { [weak self, weak v] ev in
        switch ev {
        case .restore: self?.ui?.showMain()
        case .action: v?.hotkey()
        case .save(let patch): self?.sidecar?.send(["t": "shellSettings", "patch": .object(patch)])
        }
      },
      onEvent: { [weak self] type, data in self?.events.add(type, data) },
      log: { [weak self] m in self?.log.info("overlays", m) },
      helperPath: Self.helperPath(config: config)
    )
    overlays = o
    v.onState = { [weak o] s in o?.onVoice(s) }
    v.onEmote = { [weak o] cue in _ = o?.emote(cue) }
    v.onAvatarEvent = { [weak o] ev in o?.event(ev.rawValue) }
    v.onClaudeFinished = { [weak o] _, _ in o?.event("finished") }
    v.onEvent = { [weak self] type, data in
      // ("sound" is recorded where it's played; the rest go to the driver's ring as they are.)
      if type != "sound" { self?.events.add(type, data) }
    }
    Task { @MainActor [weak self, weak v] in
      try? await v?.loadConfig()
      guard let self, let v else { return }
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
    ui.appState.onWake = nil // (the voice controller answers orbit.wake itself)
    ui.appState.onEvent = { [weak self, weak v] evt in
      v?.handleBridgeEvent(evt)
      if evt["type"]?.stringValue == "settings.changed" {
        let keys = evt["changed"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self?.overlays?.settingsChanged(keys)
      }
      if evt["type"]?.stringValue == "claude.status" {
        v?.orbExtras.claudeWorking = !(evt["working"]?.arrayValue?.isEmpty ?? true)
      }
    }
    overlays?.start()
  }
}
