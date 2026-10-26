// Orbit Native's shell: what electron/main.js does for Electron. It starts Orbit's engine (the
// bridge, in Swift: OrbitEngine) and, behind it, what of the Node core hasn't moved to Swift yet (a
// sidecar on an internal port), then the windows (launcher, orb), the avatar overlays, Orbit's mouse,
// the voice client, the hotkey and the menu bar, and wires them to each other and to the engine. In
// a test build launched with ORBIT_PARITY_PORT it also serves the parity driver.
import AppKit
import OrbitBridge
import OrbitEngine
import OrbitKit
import OrbitOverlays
import OrbitUI
import OrbitVoice

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let info = Bundle.main.infoDictionary
  lazy var config = LaunchConfig.resolve(bundle: Bundle.main.bundleURL, info: info, env: ProcessInfo.processInfo.environment, home: FileManager.default.homeDirectoryForCurrentUser)
  let events = EventLog()
  let log = AppLog()
  var instance: SingleInstance?
  var sidecar: Sidecar?
  var engine: Engine?
  var endpoints: BridgeEndpoints?
  var driver: ParityDriver?
  var parity: ParityBridge?
  var ui: OrbitUI?
  var voice: any VoiceUI = IdleVoice()
  var hotkeys: any HotkeyControl = UnregisteredHotkey()
  var voiceController: VoiceController?
  var shellHotkey: ShellHotkey?
  var overlays: Overlays?
  var wakeWord: (any WakeListening)?
  var localSpeechTask: Task<NativeLocalSpeech?, Never>?
  var quitting = false
  let startedAt = Date()

  func applicationDidFinishLaunching(_ notification: Notification) {
    log.open(dir: config.profileDir)
    guard let inst = SingleInstance(profileDir: config.profileDir) else {
      SingleInstance.signalRunning(profileDir: config.profileDir)
      log.info("app", "Another Orbit Native is running with this profile; showing it instead")
      NSApp.terminate(nil)
      return
    }
    instance = inst
    DistributedNotificationCenter.default().addObserver(forName: SingleInstance.showNotification, object: config.profileDir.path, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.showMain() }
    }
    log.info("app", "Orbit Native \(OrbitKit.version) starting\(config.testing ? " (test build)" : "")")
    startSidecar()
  }

  // MARK: the core

  func startSidecar() {
    let key: Data
    do {
      key = config.testing && ProcessInfo.processInfo.environment["ORBIT_PROFILE_DIR"] != nil ? try SealKey.fromProfile(config.profileDir) : try SealKey.fromKeychain()
    } catch {
      log.warn("app", "Could not get the key store's key: \(error)")
      return fail("Orbit could not use your macOS Keychain (access may have been denied), so it can't keep your keys safe. Quit and open Orbit again, and choose Allow.")
    }
    // The engine first: it keeps the settings, the keys and the log; the core reads the same files.
    let eng: Engine
    do {
      let models = config.testing ? ProcessInfo.processInfo.environment["ORBIT_MODELS_DIR"].map { URL(fileURLWithPath: $0) } : nil
      eng = try Engine(paths: .init(profile: config.profileDir, core: config.coreDir, models: models), port: config.port, sealKey: key, version: OrbitKit.version)
    } catch {
      return fail("Orbit could not start (\(error.localizedDescription)).")
    }
    // A new install on this Mac starts with Qubit as its avatar (the shared default is the pixel buddy).
    eng.firstRunSettings = ["avatar": "qubit"]
    eng.loadSettings()
    engine = eng
    if config.testing, ProcessInfo.processInfo.environment["ORBIT_SWIFT_VOICE"] == "1" { enableSwiftVoice(eng) }
    // The core behind it, on a free port of its own (only the engine talks to it).
    guard let corePort = FreePort.pick() else { return fail("Orbit could not find a free local port for its core.") }
    let sc = Sidecar(config: .init(node: config.node, script: config.sidecarScript, coreDir: config.coreDir, profileDir: config.profileDir, port: Int(corePort), sealKey: key, extraEnv: config.sidecarEnv))
    eng.onSettingsChanged = { [weak sc] _, all in sc?.send(["t": "settings", "all": .object(all)]) }
    eng.onKeyChanged = { [weak sc] in sc?.send(["t": "keyChanged"]) }
    eng.onPrewarm = { [weak sc] in sc?.send(["t": "prewarm"]) }
    eng.onSttReady = { [weak sc] in sc?.send(["t": "sttReady"]) }
    eng.claudePreview = previewSpeaker(profile: config.profileDir)
    sc.onReady = { [weak self] e in DispatchQueue.main.async { self?.coreStarted(e, port: corePort) } }
    sc.onMessage = { [weak self] m in DispatchQueue.main.async { self?.coreMessage(m) } }
    sc.onLog = { [weak self] line in self?.log.raw("core", line) }
    sc.onExit = { [weak self] code in DispatchQueue.main.async { self?.coreExited(code) } }
    sidecar = sc
    do {
      try sc.start()
    } catch {
      log.warn("app", "Could not start the core: \(error)")
      fail("Orbit's core could not start (\(error.localizedDescription)).")
    }
  }

  /**
   * The voice session in Swift instead of the core (a test build with ORBIT_SWIFT_VOICE=1, until Orbit
   * anywhere moves too): the Claude window through the helper's "ax" host, or the parity suite's
   * stand-in desktop. What it has for the shell comes as the core's messages do.
   */
  func enableSwiftVoice(_ eng: Engine) {
    let env = ProcessInfo.processInfo.environment
    let log = eng.log
    let driver: DesktopDriver?
    if let fake = env["ORBIT_FAKE_DESKTOP"], !fake.isEmpty {
      let module = URL(fileURLWithPath: fake)
      driver = FakeDesktopDriver(node: config.node, hostScript: module.deletingLastPathComponent().appendingPathComponent("fake-desktop-host.mjs"), module: module, env: env)
    } else if let bin = Self.helperPath(config: config) {
      let host = HelperHost(launch: HelperHost.helper(bin: URL(fileURLWithPath: bin), mode: "ax"), idleSeconds: 600, requestSeconds: 15, onError: { m in log.warn("claude-window", m) })
      driver = ClaudeDesktop(request: { op, a in await host.request(op, a) }, onlyPid: Int(env["ORBIT_TEST_CLAUDE_PID"] ?? "") ?? 0)
    } else {
      driver = nil
    }
    let desktop = Desktop(driver: driver, log: log)
    desktop.dryRunSends = env["ORBIT_DRY_RUN_SENDS"] == "1"
    let v = eng.enableVoice(desktop: desktop, realtimeURL: env["XAI_REALTIME_URL"])
    v.toShell = { [weak self] m in DispatchQueue.main.async { self?.coreMessage(m) } }
    self.log.info("app", "The voice session runs in Swift (test build)")
  }

  /** The core is up behind the engine: the engine signs in to it, then takes the public port. */
  func coreStarted(_ coreEndpoints: BridgeEndpoints, port: UInt16) {
    guard let eng = engine else { return }
    let token = URLComponents(url: coreEndpoints.auth["main"] ?? coreEndpoints.base, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "t" }?.value ?? ""
    eng.setCore(port: port, token: token)
    Task { @MainActor in
      do {
        try await eng.start()
        self.coreReady(eng.endpoints)
      } catch {
        self.log.warn("app", "The bridge could not listen on \(self.config.port): \(error)")
        self.fail("Port \(self.config.port) is already in use, probably by another copy of Orbit. Close it first.")
      }
    }
  }

  /** Settings the shell owns (the page can't set them through POST /api/settings): the hotkey once it's registered, the orb's place. */
  func saveShellSettings(_ patch: [String: JSONValue]) {
    let allowed = patch.filter { ["wakeHotkey", "orbPosition", "orbStickAnchor"].contains($0.key) }
    if !allowed.isEmpty { engine?.config.update(allowed) }
  }

  func coreReady(_ e: BridgeEndpoints) {
    endpoints = e
    log.info("app", "Core ready on \(e.base.absoluteString) in \(Int(Date().timeIntervalSince(startedAt) * 1000)) ms")
    events.add("core.ready")
    // Five quiet minutes: earlier stops no longer count towards giving up.
    let recovery = CoreRecovery(profileDir: config.profileDir)
    DispatchQueue.main.asyncAfter(deadline: .now() + 300) { [weak self] in
      if self?.quitting == false { recovery.ranWell() }
    }
    startVoiceAndOverlays(e)
    startWindows(e)
    wireBridgeEvents()
    startDriverIfAsked()
  }

  /** The launcher, Settings, onboarding and menu bar (OrbitUI), once the bridge is up. */
  func startWindows(_ e: BridgeEndpoints) {
    let res = Bundle.main.resourceURL ?? Bundle.main.bundleURL
    let inBundle = FileManager.default.fileExists(atPath: res.appendingPathComponent("hero-src").path)
    let options = OrbitUIOptions(
      profileDir: config.profileDir,
      assetsDir: inBundle ? res : config.coreDir.appendingPathComponent("assets"),
      heroRoot: inBundle ? res.appendingPathComponent("hero-src") : config.coreDir.appendingPathComponent("ui/src"),
      version: OrbitKit.version,
      isPackaged: !config.testing,
      testBuild: config.testing,
      startHidden: LoginLaunch.wasOpenedAtLogin || CommandLine.arguments.contains(CoreRecovery.relaunchArgument)
    )
    let u = OrbitUI(bridge: BridgeClient(endpoints: e), voice: voice, hotkey: hotkeys, options: options)
    u.onQuit = { NSApp.terminate(nil) }
    u.onMinimize = { [weak self] in self?.events.add("window.minimize") }
    u.onHotkeyChanged = { [weak self] accel in self?.saveShellSettings(["wakeHotkey": .string(accel)]) }
    ui = u
    u.start()
  }

  func coreMessage(_ m: JSONValue) {
    switch m["t"]?.stringValue {
    case "error":
      let msg = m["message"]?.stringValue ?? "Orbit's core could not start."
      log.warn("app", "Core error: \(msg)")
      fail(msg)
    case "log":
      log.raw(m["scope"]?.stringValue ?? "core", m["message"]?.stringValue ?? "")
    case "logEntry":
      if let e = m["entry"] { engine?.log.append(core: e) }
    case "settingsChanged":
      // A setting the core changed itself (a voice tool, an app okayed for Orbit anywhere).
      if let p = m["patch"]?.objectValue { engine?.config.update(p) }
    case "clipboard":
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(m["text"]?.stringValue ?? "", forType: .string)
    case "openExternal":
      if let s = m["url"]?.stringValue, let u = URL(string: s), u.scheme == "https" { NSWorkspace.shared.open(u) }
    case "avatar.cmd", "mouse.glide", "mouse.press", "mouse.hide", "contexts", "focus", "wins", "promptBoxWork":
      overlays?.sidecarMessage(m)
    default:
      break
    }
  }

  func coreExited(_ code: Int32) {
    guard !quitting else { return }
    log.warn("app", "The core stopped (exit \(code))")
    events.add("core.exit", ["code": .number(Double(code))])
    switch CoreRecovery(profileDir: config.profileDir).coreStopped() {
    case .relaunch:
      log.info("app", "Relaunching Orbit to bring its core back")
      // A test build carries its test run's switches over (a release build honours none of them).
      let env = config.testing ? CoreRecovery.testEnvironment(ProcessInfo.processInfo.environment) : [:]
      let sh = Process()
      sh.executableURL = URL(fileURLWithPath: "/bin/sh")
      sh.arguments = ["-c", CoreRecovery.relaunchScript(pid: ProcessInfo.processInfo.processIdentifier, bundle: Bundle.main.bundleURL, env: env)]
      try? sh.run()
      NSApp.terminate(nil)
    case .giveUp:
      fail("Orbit's core keeps stopping, so Orbit has quit. Open Orbit again to try once more.")
    }
  }

  func fail(_ message: String) {
    guard !quitting else { return }
    if config.testing && driver != nil { events.add("error", ["message": .string(message)]); return }
    let a = NSAlert()
    a.messageText = "Orbit"
    a.informativeText = message
    a.alertStyle = .warning
    a.runModal()
    NSApp.terminate(nil)
  }

  // MARK: the parity driver (test builds only)

  func startDriverIfAsked() {
    guard driver == nil, let (port, token) = ParityDriver.config(info: info) else { return }
    let bridge = ParityBridge(shell: self)
    let d = ParityDriver(token: token, delegate: bridge)
    parity = bridge
    driver = d
    Task {
      do {
        try await d.start(port: port)
        log.info("parity", "Driver listening on 127.0.0.1:\(port)")
      } catch {
        log.warn("parity", "Driver could not listen on \(port): \(error)")
      }
    }
  }

  // MARK: windows (filled in by the launcher and overlays)

  func showMain() {
    overlays?.hideOrb()
    if let ui { ui.showMain() } else { NSApp.activate(ignoringOtherApps: true) }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    ui?.handleReopen()
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    overlays?.stop()
    voiceController?.hangup()
    ui?.stop()
    driver?.stop()
    engine?.stop()
    sidecar?.stop()
    log.info("app", "Quit")
  }
}

/** Was this launch macOS opening Orbit at login? (Then it starts quietly, in the menu bar.) */
enum LoginLaunch {
  static var wasOpenedAtLogin: Bool {
    guard let e = NSAppleEventManager.shared().currentAppleEvent else { return false }
    return e.eventID == kAEOpenApplication && e.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
  }
}
