// OrbitUI: Orbit Native's windows, behind one small facade for the integrator's AppDelegate.
//
//   let ui = OrbitUI(bridge: BridgeClient(endpoints: ready), voice: controller, hotkey: hotkeys,
//                    options: .init(profileDir: profile, assetsDir: res, heroRoot: res.appending("hero-src"), version: v))
//   ui.onMinimize = { orb.show() }          // the minimize button turns into the orb
//   ui.onQuit = { NSApp.terminate(nil) }    // the close button quits (as Electron)
//   ui.onHotkeyChanged = { sidecar.send(["t": "hotkey", "accel": $0]) }
//   ui.start()                               // loads settings, follows /api/events, shows the launcher
//   // AppDelegate: applicationShouldHandleReopen -> ui.handleReopen(); ⌘, -> ui.show(view: "settings")
//
// The launcher is the main window (360x580, min 320x480, white, hidden title bar with the traffic
// lights); Settings, History and the permissions onboarding are its views, as in the Electron page.
import AppKit
import Observation
import OrbitKit
import SwiftUI

public struct OrbitUIOptions {
  /** The profile folder (ORBIT_PROFILE_DIR): the onboarding's flag and update downloads live here. */
  public var profileDir: URL
  /** Holds trayTemplate.png and trayTemplate@2x.png (the repo's assets/). */
  public var assetsDir: URL?
  /** ui/src's layout with vendor/avatars/{orbit-nav,qubit-engine}.js, hero/hero.js, qubit/director.js. */
  public var heroRoot: URL
  public var version: String
  /** An installed release (updates are checked); false: "running from source". */
  public var isPackaged: Bool
  /** A parity/test build: ORBIT_FAKE_PERMS and ORBIT_FAKE_LOGIN are honoured. */
  public var testBuild: Bool
  public var environment: [String: String]
  /** Started as a login item: stay hidden (Orbit waits in the menu bar and the Dock). */
  public var startHidden: Bool
  /** Fixes Qubit's emote sequence (snapshots); nil: random, as the page. */
  public var heroSeed: Int?
  public var menuBar: Bool
  /** Snapshot runs: Qubit keeps animating even with the display asleep. Never in the app. */
  public var snapshotMode = false
  public init(profileDir: URL, assetsDir: URL?, heroRoot: URL, version: String, isPackaged: Bool = false, testBuild: Bool = false,
              environment: [String: String] = ProcessInfo.processInfo.environment, startHidden: Bool = false, heroSeed: Int? = nil, menuBar: Bool = true) {
    self.profileDir = profileDir; self.assetsDir = assetsDir; self.heroRoot = heroRoot; self.version = version; self.isPackaged = isPackaged
    self.testBuild = testBuild; self.environment = environment; self.startHidden = startHidden; self.heroSeed = heroSeed; self.menuBar = menuBar
  }
}

@MainActor
public final class OrbitUI: NSObject, NSWindowDelegate {
  public let context: UIContext
  public var settings: SettingsModel { context.settings }
  public var appState: AppStateModel { context.app }
  public var onboarding: OnboardingModel { context.onboarding }
  public var updates: UpdateChecker { context.updates }
  public var login: any LoginItemControl { context.login }
  public let window: NSWindow

  /** The launcher was minimized (to the Dock). */
  public var onMinimize: () -> Void = {}
  /** The close button and the menu's Quit. */
  public var onQuit: () -> Void = { NSApp.terminate(nil) }
  /** The hotkey changed through Settings (tell the core: it keeps settings.json). */
  public var onHotkeyChanged: (String) -> Void = { _ in }

  private let options: OrbitUIOptions
  private var menuBar: MenuBarController?
  private var mouseMonitor: Any?
  private var observers: [NSObjectProtocol] = []
  private var activateFrom = Date.distantFuture
  private var started = false

  public init(bridge: BridgeClient, voice: any VoiceUI, hotkey: any HotkeyControl, options: OrbitUIOptions) {
    self.options = options
    HeroBridge.ignoreOcclusion = options.snapshotMode
    let settings = SettingsModel(transport: bridge)
    let app = AppStateModel(settings: settings)
    let env = options.environment
    let probe: PermissionProbe = options.testBuild ? OnboardingModel.probe(environment: env, real: SystemPermissionProbe()) : SystemPermissionProbe()
    let onboarding = OnboardingModel(probe: probe, store: FileOnboardingStore(directory: options.profileDir))
    let updates = UpdateChecker(currentVersion: options.version, isPackaged: options.isPackaged, downloadsDir: options.profileDir)
    // ORBIT_FAKE_LOGIN=1 (test builds): the login item lives in memory, never registered with macOS.
    let login: any LoginItemControl = options.testBuild && env["ORBIT_FAKE_LOGIN"] == "1" ? MemoryLoginItem() : MainAppLoginItem()
    context = UIContext(bridge: bridge, settings: settings, app: app, onboarding: onboarding, updates: updates, voice: voice, hotkey: hotkey, login: login,
                        heroRoot: options.heroRoot, heroSeed: options.heroSeed)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 580), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    super.init()
    window.title = "Orbit"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.backgroundColor = .white // the page is white: no dark flash while it loads
    window.contentMinSize = NSSize(width: 320, height: 480) // the content is the whole window (full-size content view)
    window.isReleasedWhenClosed = false
    window.collectionBehavior.insert(.fullScreenNone)
    window.acceptsMouseMovedEvents = true
    window.delegate = self
    window.setFrameAutosaveName("OrbitLauncher")
    let host = NSHostingView(rootView: LauncherView(ctx: context))
    host.sizingOptions = [] // the window's own min size (320x480) rules, not SwiftUI's (which adds the title bar)
    window.contentView = host
    window.contentMinSize = NSSize(width: 320, height: 480) // (after the content view, which resets it)
    if window.frame.width < 320 { window.setContentSize(NSSize(width: 360, height: 580)) }
    window.center()
    // (The minimize button minimizes to the Dock, as any Mac app's: Orbit Native has no floating orb.)
    positionTrafficLights()
    context.hotkeyChanged = { [weak self] accel in
      self?.onHotkeyChanged(accel)
      self?.menuBar?.refresh()
    }
  }

  // MARK: lifecycle

  /** Load settings, follow the bridge's events, show the launcher (or the onboarding) and the menu bar. */
  public func start() {
    guard !started else { return }
    started = true
    activateFrom = Date().addingTimeInterval(2) // the activation that comes with launching isn't a dock click
    onboarding.onNeededChange = { [weak self] needed in
      guard let self else { return }
      if needed { self.context.screen = .onboarding } else if self.context.screen == .onboarding { self.context.screen = .main }
    }
    if onboarding.needed { context.screen = .onboarding }
    appState.onEvent = { [weak self] e in
      guard let self, e["type"]?.stringValue == "settings.changed" else { return }
      if (e["changed"]?.arrayValue ?? []).contains("autoUpdate") { self.updates.setAuto(self.settings.bool("autoUpdate")) }
      if (e["changed"]?.arrayValue ?? []).contains("wakeHotkey") { self.menuBar?.refresh() }
    }
    appState.onOpen = { [weak self] title in self?.context.voice.sessionTitle = title }
    Task {
      await settings.load()
      updates.setAuto(settings.bool("autoUpdate"))
      refreshSessionTitle()
    }
    appState.follow(context.bridge.events())
    if options.menuBar {
      let m = MenuBarController(assets: options.assetsDir)
      m.openOrbit = { [weak self] in self?.showMain() }
      m.talk = { [weak self] in self?.context.voice.hotkey() }
      m.quit = { [weak self] in self?.onQuit() }
      m.hotkeyLabel = { [weak self] in self?.settings.hotkeyLabel ?? "⌃⌥G" }
      m.login = context.login
      m.onLoginChanged = { [weak self] in self?.context.shellRevision += 1 }
      menuBar = m
    }
    // Qubit's eye follows the cursor anywhere in the window.
    mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .mouseExited]) { [weak self] e in
      MainActor.assumeIsolated {
        guard let self, e.window === self.window else { return }
        self.context.hero.pointer(e.type == .mouseExited ? nil : e.locationInWindow)
      }
      return e
    }
    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.appDidBecomeActive() }
    })
    observers.append(nc.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.refreshSessionTitle() }
    })
    if !options.startHidden { showMain() }
  }

  public func stop() {
    appState.stop()
    updates.stop()
    if let m = mouseMonitor { NSEvent.removeMonitor(m) }
    mouseMonitor = nil
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers = []
    menuBar?.remove()
    menuBar = nil
  }

  /** Orbit came to the front again (e.g. back from System Settings): re-check the permissions. */
  public func appDidBecomeActive() { onboarding.recheck() }

  /** The dock icon was clicked: the launcher (not on the activation that comes with launching). */
  public func handleReopen() {
    if Date() >= activateFrom { showMain() }
  }

  public func showMain() {
    window.makeKeyAndOrderFront(nil)
    positionTrafficLights()
    NSApp.activate(ignoringOtherApps: true)
  }

  public func hideMain() { window.orderOut(nil) }

  /** main | settings | history | onboarding (the launcher's views); shows the window. */
  public func show(view: String) {
    if let s = LauncherScreen(rawValue: view) { context.screen = s }
    showMain()
  }

  /** Minimize the launcher to the Dock (the parity driver's window.minimize). */
  @objc public func minimize() {
    window.miniaturize(nil)
    onMinimize()
  }

  /** Show which session is open in Claude (straight away and whenever the window comes back). */
  private func refreshSessionTitle() {
    Task {
      if let t = try? await context.bridge.sessions().openInApp { context.voice.sessionTitle = t }
    }
  }

  // MARK: window

  public func windowShouldClose(_ sender: NSWindow) -> Bool {
    onQuit() // the close button quits, as in Electron
    return false
  }

  public func windowDidResize(_ notification: Notification) { positionTrafficLights() }

  /** The launcher's minimum (Electron: minWidth 320, minHeight 480), kept here so no layout pass can undo it. */
  public static let minSize = NSSize(width: 320, height: 480)

  public func windowWillResize(_ sender: NSWindow, to size: NSSize) -> NSSize {
    NSSize(width: max(Self.minSize.width, size.width), height: max(Self.minSize.height, size.height))
  }

  /** Electron's trafficLightPosition {x: 14, y: 13}: the buttons sit in the page's 44 pt title bar. */
  private func positionTrafficLights() {
    let kinds: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
    guard let close = window.standardWindowButton(.closeButton), let bar = close.superview, let container = bar.superview else { return }
    let barHeight: CGFloat = 44
    var f = container.frame
    f.size.height = barHeight
    f.origin.y = window.frame.height - barHeight
    container.frame = f
    let gap = (window.standardWindowButton(.miniaturizeButton)?.frame.minX ?? 27) - close.frame.minX
    for (i, k) in kinds.enumerated() {
      guard let b = window.standardWindowButton(k) else { continue }
      b.setFrameOrigin(NSPoint(x: 14 + CGFloat(i) * (gap > 0 ? gap : 20), y: bar.frame.height - 13 - b.frame.height))
    }
  }

  // MARK: parity driver (parity/PROTOCOL.md)

  /** Screen points, top-left origin on the main display. */
  static func topLeft(_ r: NSRect) -> Rect {
    let h = NSScreen.screens.first?.frame.height ?? 0
    return Rect(x: r.minX, y: h - r.maxY, w: r.width, h: r.height)
  }

  public func parityWindows() -> [String: ParityWindow] {
    let shown = context.voice.phase == .off ? context.voice.talkNotice : nil
    return ["main": ParityWindow(visible: window.isVisible && !window.isMiniaturized, frame: Self.topLeft(window.frame), view: context.screen.rawValue,
                                 notice: shown.map { ParityNotice(kind: $0.kind, text: $0.text, buttons: ParityNotice.buttons(for: $0.kind)) },
                                 focusKey: context.screen == .settings && context.focusKey)]
  }

  /** The main page's Start talking button (parity main.start). */
  public func parityStart() {
    if context.voice.phase == .off { context.voice.start() }
  }

  /**
   * Press a button of the main page's notice (parity main.notice): nil if it isn't showing, else its
   * answer. Copy install command: the command it copies (a test leaves the Mac's clipboard alone);
   * Install guide: its link (opened nowhere in a test).
   */
  public func parityPressNotice(_ label: String) -> JSONValue? {
    guard context.voice.phase == .off, let n = context.voice.talkNotice, ParityNotice.buttons(for: n.kind).contains(label) else { return nil }
    switch label {
    case "Open Settings": context.openSettings(focusKey: n.kind == "grok-key")
    case "Use Claude voice": context.voice.useClaudeVoice()
    case "Copy install command": return ["ok": true, "copied": .string(Talk.claudeInstallCommand)]
    case "Install guide": return ["ok": true, "url": .string(Talk.claudeCodeGuide.absoluteString)]
    default: context.voice.start()
    }
    return ["ok": true]
  }

  public func parityOnboarding() -> ParityOnboarding {
    onboarding.parity(shown: window.isVisible && context.screen == .onboarding)
  }

  public func parityLogin() -> Bool { context.login.enabled }

  /**
   * Change a setting through the Settings screen's own model (settings.ui). wakeHotkey goes through
   * the hotkey (the shell owns it), openAtLogin through the login item. Answers {ok, value} or
   * {ok: false, error}.
   */
  @discardableResult
  public func settingsUISet(key: String, value: JSONValue) async -> JSONValue {
    switch key {
    case "openAtLogin":
      guard let on = value.boolValue else { return ["ok": false, "error": "openAtLogin takes true or false"] }
      let now = context.login.set(on)
      context.shellRevision += 1
      menuBar?.refresh()
      return now == on ? ["ok": true, "value": .bool(now)] : ["ok": false, "value": .bool(now), "error": .string(context.login.lastError ?? "not changed")]
    case "wakeHotkey":
      guard let accel = value.stringValue else { return ["ok": false, "error": "wakeHotkey takes an accelerator"] }
      let r = context.hotkey.set(accel)
      if r.ok == true {
        settings.showHotkey(r.accelerator)
        context.hotkeyChanged(r.accelerator)
        context.shellRevision += 1
        return ["ok": true, "value": .string(r.accelerator)]
      }
      return ["ok": false, "error": .string(r.error ?? "not taken")]
    default:
      switch await settings.set(key, value) {
      case .saved(let v): return ["ok": true, "value": v]
      case .refused(let why): return ["ok": false, "error": .string(why)]
      case .failed(let why): return ["ok": false, "error": .string(why)]
      }
    }
  }

  /** What the Settings screen shows for a key (settings.read). */
  public func settingsUIRead(key: String) -> JSONValue {
    switch key {
    case "openAtLogin": return .bool(context.login.enabled)
    case "wakeHotkey": return .string(context.hotkey.info().accelerator)
    default: return settings[key] ?? .null
    }
  }

  /** The onboarding's primary button (onboarding.next). */
  public func onboardingNext() async { await onboarding.primary() }

  /** perms.set: replace the fake permissions and re-check as on returning to Orbit. */
  public func setFakePerms(_ value: JSONValue) {
    guard let st = PermissionState(fake: value) else { return }
    onboarding.setFake(st)
  }

  /** The menu bar's items (checks). */
  public var menuBarItems: [String] { menuBar?.itemTitles ?? [] }

  // MARK: snapshots

  /** Runs a script in Qubit's hero page and answers its result as text (checks and debugging). */
  public func heroEval(_ js: String) async -> String {
    guard let wv = context.hero.webView else { return "no web view" }
    do { return String(describing: try await wv.evaluateJavaScript(js) ?? "nil") } catch { return "error: \(error.localizedDescription)" }
  }

  /** The launcher as an image: the SwiftUI window (cacheDisplay) with Qubit's web view drawn in. */
  public func snapshotLauncher() async -> NSBitmapImageRep? {
    guard let view = window.contentView else { return nil }
    view.layoutSubtreeIfNeeded()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
    view.cacheDisplay(in: view.bounds, to: rep)
    if let wv = context.hero.webView, wv.window === window, let hero = await context.hero.snapshot() {
      let r = wv.convert(wv.bounds, to: view)
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
      hero.draw(in: view.isFlipped ? NSRect(x: r.minX, y: view.bounds.height - r.maxY, width: r.width, height: r.height) : r)
      NSGraphicsContext.restoreGraphicsState()
    }
    return rep
  }
}
