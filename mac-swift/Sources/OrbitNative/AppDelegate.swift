// Orbit Native's shell: what electron/main.js does for Electron. It starts Orbit's Node core as a
// sidecar (the bridge), then the windows (launcher, orb), the avatar overlays, Orbit's mouse, the
// voice client, the hotkey and the menu bar, and wires them to each other and to the core. In a test
// build launched with ORBIT_PARITY_PORT it also serves the parity driver.
import AppKit
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
    let sc = Sidecar(config: .init(node: config.node, script: config.sidecarScript, coreDir: config.coreDir, profileDir: config.profileDir, port: config.port, sealKey: key, extraEnv: config.sidecarEnv))
    sc.onReady = { [weak self] e in DispatchQueue.main.async { self?.coreReady(e) } }
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
    u.onMinimize = { [weak self] in
      self?.events.add("window.minimize")
      self?.overlays?.showOrb() // minimizing turns into the orb
    }
    u.onHotkeyChanged = { [weak self] accel in self?.sidecar?.send(["t": "shellSettings", "patch": ["wakeHotkey": .string(accel)]]) }
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
    sidecar?.stop()
    log.info("app", "Quit")
  }
}

/** Was this launch macOS opening Orbit at login? (Then it starts quietly, as the orb.) */
enum LoginLaunch {
  static var wasOpenedAtLogin: Bool {
    guard let e = NSAppleEventManager.shared().currentAppleEvent else { return false }
    return e.eventID == kAEOpenApplication && e.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
  }
}
