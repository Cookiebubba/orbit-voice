// UIDemo: OrbitUI's windows against a running bridge, with a fake voice and hotkey, for checks.
//
//   ORBIT_BRIDGE_AUTH=<the bridge's sign-in link> UIDemo                 the launcher, live
//   ... UIDemo --shots <dir>       snapshots: ours and the bridge's own page at 360x580, side by side
//   ... UIDemo --roundtrip         every Settings key both ways (Settings -> bridge, bridge -> Settings)
//   ... UIDemo --menu              prints the menu bar's items
//   ... UIDemo --voice-shots <dir> the onboarding's voice step, Claude then Grok (sets no key)
//
// It never prints keys or the sign-in link. Exit code 0 = all checks passed.
import AppKit
import OrbitKit
import OrbitUI
import WebKit

enum Cfg {
  static let env = ProcessInfo.processInfo.environment
  static let args = CommandLine.arguments
  static let repo = URL(fileURLWithPath: env["ORBIT_REPO"] ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path)
  static let auth: URL? = env["ORBIT_BRIDGE_AUTH"].flatMap(URL.init(string:))
  static var base: URL? {
    guard let auth, var c = URLComponents(url: auth, resolvingAgainstBaseURL: false) else { return nil }
    c.path = ""; c.query = nil
    return c.url
  }
  static let profile = URL(fileURLWithPath: env["ORBIT_PROFILE_DIR"] ?? NSTemporaryDirectory()).appendingPathComponent("uidemo-profile")
}

func say(_ s: String) { FileHandle.standardOutput.write(Data((s + "\n").utf8)) }

guard Cfg.auth != nil, Cfg.base != nil else {
  say("Set ORBIT_BRIDGE_AUTH to the bridge's sign-in link.")
  exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

@MainActor
final class Demo: NSObject, NSApplicationDelegate {
  let bridge = BridgeClient(base: Cfg.base!, authURL: Cfg.auth!)
  let voice = FakeVoiceUI()
  let hotkey = FakeHotkeyControl()
  var ui: OrbitUI!
  var pageWindow: NSWindow?

  func applicationDidFinishLaunching(_ n: Notification) {
    var e = Cfg.env
    if e["ORBIT_FAKE_PERMS"] == nil { e["ORBIT_FAKE_PERMS"] = #"{"mic":"granted","ax":true,"screen":true}"# }
    e["ORBIT_FAKE_LOGIN"] = "1"
    // Checks start from a first launch (the onboarding hasn't been through yet).
    if Cfg.args.contains("--checks") || voiceShots { try? FileManager.default.removeItem(at: Cfg.profile.appendingPathComponent("onboarding.json")) }
    if voiceShots { e["ORBIT_VOICE_SETUP"] = "1" }
    var o = OrbitUIOptions(profileDir: Cfg.profile, assetsDir: Cfg.repo.appendingPathComponent("assets"), heroRoot: Cfg.repo.appendingPathComponent("ui/src"),
                           version: "dev", testBuild: true, environment: e, heroSeed: Int(Cfg.env["HERO_SEED"] ?? "") ?? 7)
    o.snapshotMode = Cfg.args.contains("--shots")
    ui = OrbitUI(bridge: bridge, voice: voice, hotkey: hotkey, options: o)
    ui.onQuit = { NSApp.terminate(nil) }
    ui.onMinimize = { say("minimize -> orb") }
    // The bridge needs some xAI key to show the launcher: an obviously fake one, never printed.
    Task {
      if voiceShots {
        ui.start()
        return await voiceStepShots()
      }
      if let c = try? await bridge.config(), !c.hasKey { try? await bridge.setXaiKey("xai-FAKE-KEY-FOR-UI-DEMO-000000000000") }
      ui.start()
      if Cfg.args.contains("--shots") { await shots() }
      else if Cfg.args.contains("--roundtrip") { await roundtrip() }
      else if Cfg.args.contains("--checks") { await checks() }
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { ui.handleReopen(); return false }

  var voiceShots: Bool { Cfg.args.contains("--voice-shots") }

  /** The voice step as a new install sees it: Claude chosen, then Grok. */
  func voiceStepShots() async {
    let dir = URL(fileURLWithPath: Cfg.args[(Cfg.args.firstIndex(of: "--voice-shots") ?? 0) + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    await waitLoaded()
    ui.window.setContentSize(NSSize(width: 360, height: 580))
    ui.show(view: "onboarding")
    await ui.settings.set("voiceEngine", .string("claude"))
    try? await Task.sleep(for: .seconds(3))
    png(await ui.snapshotLauncher(), dir.appendingPathComponent("voice-claude.png"))
    await ui.settings.set("voiceEngine", .string("grok"))
    try? await Task.sleep(for: .seconds(1.5))
    png(await ui.snapshotLauncher(), dir.appendingPathComponent("voice-grok.png"))
    ui.window.setContentSize(NSSize(width: 320, height: 480))
    try? await Task.sleep(for: .seconds(1))
    png(await ui.snapshotLauncher(), dir.appendingPathComponent("voice-grok-small.png"))
    NSApp.terminate(nil)
  }

  func waitLoaded() async {
    for _ in 0..<100 where !ui.settings.loaded { try? await Task.sleep(for: .milliseconds(100)) }
  }

  func png(_ rep: NSBitmapImageRep?, _ url: URL) {
    guard let data = rep?.representation(using: .png, properties: [:]) else { return say("! no image for \(url.lastPathComponent)") }
    try? data.write(to: url)
    say("wrote \(url.lastPathComponent) \(rep!.pixelsWide)x\(rep!.pixelsHigh)")
  }

  /** Ours and the bridge's page, same size, same state. */
  func shots() async {
    let dir = URL(fileURLWithPath: Cfg.args[(Cfg.args.firstIndex(of: "--shots") ?? 0) + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    await waitLoaded()
    ui.window.setContentSize(NSSize(width: 360, height: 580))
    ui.window.setFrameOrigin(NSPoint(x: 80, y: 120))
    try? await Task.sleep(for: .seconds(3))
    say("hero: " + (await ui.heroEval("JSON.stringify({hero: !!window.__hero, svg: document.querySelectorAll('svg').length, W: window.__hero && window.__hero.q.W, w: innerWidth, h: innerHeight, engine: !!window.QubitEngine, vis: document.visibilityState})")))
    let nativeMain = await ui.snapshotLauncher()
    png(nativeMain, dir.appendingPathComponent("native-main.png"))
    let wv = await openPage()
    let pageMain = await snap(wv)
    png(pageMain, dir.appendingPathComponent("electron-main.png"))
    png(sideBySide(nativeMain, pageMain), dir.appendingPathComponent("compare-main.png"))
    // Settings, both: the page's own Settings button, and ours.
    _ = try? await wv.evaluateJavaScript("document.querySelector('[aria-label=Settings]').click()")
    ui.show(view: "settings")
    try? await Task.sleep(for: .seconds(2))
    let nativeSettings = await ui.snapshotLauncher()
    let pageSettings = await snap(wv)
    png(nativeSettings, dir.appendingPathComponent("native-settings.png"))
    png(pageSettings, dir.appendingPathComponent("electron-settings.png"))
    png(sideBySide(nativeSettings, pageSettings), dir.appendingPathComponent("compare-settings.png"))
    pageWindow?.orderOut(nil)
    ui.show(view: "main")

    // Live: listening, a few captions, Claude working.
    voice.phase = .listening
    voice.captions = [VoiceCaption(id: "1", who: .you, text: "What is Claude doing?"), VoiceCaption(id: "2", who: .grok, text: "It's fixing the login bug in Orbit.")]
    ui.appState.handle(["type": "claude.status", "working": [["id": "1", "title": "Fix the login bug"]]])
    try? await Task.sleep(for: .seconds(1.5))
    png(await ui.snapshotLauncher(), dir.appendingPathComponent("native-live.png"))
    ui.show(view: "settings")
    try? await Task.sleep(for: .seconds(1.5))
    png(await ui.snapshotLauncher(), dir.appendingPathComponent("native-settings-live.png"))
    ui.show(view: "history")
    try? await Task.sleep(for: .seconds(0.8))
    png(await ui.snapshotLauncher(), dir.appendingPathComponent("native-history.png"))
    ui.setFakePerms(["mic": "not-determined", "ax": false, "screen": false])
    ui.show(view: "onboarding")
    try? await Task.sleep(for: .seconds(0.8))
    png(await ui.snapshotLauncher(), dir.appendingPathComponent("native-onboarding.png"))
    NSApp.terminate(nil)
  }

  /** The windows' behaviour: views, minimize, onboarding with fake permissions, the menu bar. */
  func checks() async {
    await waitLoaded()
    var pass = 0, fail = 0
    func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
      if ok { pass += 1; say("ok   \(name)") } else { fail += 1; say("FAIL \(name) \(detail())") }
    }
    try? await Task.sleep(for: .seconds(1))
    var w = ui.parityWindows()["main"]!
    check("launcher shown, 360x580, main view", w.visible && w.frame?.w == 360 && w.frame?.h == 580 && w.view == "main", "\(w)")
    let clamped = ui.windowWillResize(ui.window, to: NSSize(width: 100, height: 100))
    check("min size 320x480", clamped == NSSize(width: 320, height: 480), "\(clamped)")
    check("hidden title bar with traffic lights", ui.window.titlebarAppearsTransparent && ui.window.standardWindowButton(.closeButton)?.isHidden == false)
    let close = ui.window.standardWindowButton(.closeButton)!.convert(ui.window.standardWindowButton(.closeButton)!.bounds, to: nil)
    check("traffic lights at x 14, y 13 (Electron's trafficLightPosition)", abs(close.minX - 14) < 1 && abs((ui.window.frame.height - close.maxY) - 13) < 1, "\(close)")
    for v in ["settings", "history", "onboarding", "main"] {
      ui.show(view: v)
      check("show(view: \(v))", ui.parityWindows()["main"]?.view == v)
    }
    // Minimize turns into the orb.
    var minimized = false
    ui.onMinimize = { minimized = true }
    ui.window.standardWindowButton(.miniaturizeButton)?.performClick(nil)
    w = ui.parityWindows()["main"]!
    check("minimize hides the launcher and calls onMinimize", minimized && !w.visible)
    ui.handleReopen()
    check("the activation that comes with launching doesn't reopen it", !ui.parityWindows()["main"]!.visible)
    try? await Task.sleep(for: .seconds(2))
    ui.handleReopen()
    check("dock click (after launch) shows it again", ui.parityWindows()["main"]!.visible)
    // Close quits (the closure is called; here it's caught).
    var quit = false
    ui.onQuit = { quit = true }
    ui.window.performClose(nil)
    check("close button quits", quit && ui.window.isVisible)
    // Onboarding with fake permissions.
    ui.setFakePerms(["mic": "not-determined", "ax": false, "screen": false])
    var o = ui.parityOnboarding()
    check("missing mic: onboarding shown at step mic", o.step == "mic" && o.shown && ui.parityWindows()["main"]?.view == "onboarding", "\(o)")
    await ui.onboardingNext()
    check("next asks for the mic (fake: nothing granted)", ui.parityOnboarding().step == "mic")
    ui.setFakePerms(["mic": "granted", "ax": false, "screen": false])
    check("mic granted: step ax", ui.parityOnboarding().step == "ax")
    ui.setFakePerms(["mic": "granted", "ax": true, "screen": false])
    o = ui.parityOnboarding()
    check("ax granted: step screen (optional), still shown on first run", o.step == "screen" && o.shown, "\(o)")
    ui.setFakePerms(["mic": "granted", "ax": true, "screen": true])
    o = ui.parityOnboarding()
    check("all granted: done, back to main", o.step == "done" && !o.shown && ui.parityWindows()["main"]?.view == "main", "\(o)")
    // The menu bar.
    let items = ui.menuBarItems
    check("menu: Open Orbit, Talk / sleep (hotkey), Open at login, Quit", items == ["Open Orbit", "Talk / sleep  (⌃⌥G)", "-", "Open at login", "-", "Quit Orbit"], "\(items)")
    _ = await ui.settingsUISet(key: "wakeHotkey", value: "Control+Alt+K")
    _ = await ui.settingsUISet(key: "openAtLogin", value: true)
    check("menu follows the hotkey and login item", ui.menuBarItems == ["Open Orbit", "Talk / sleep  (⌃⌥K)", "-", "[x] Open at login", "-", "Quit Orbit"], "\(ui.menuBarItems)")
    _ = await ui.settingsUISet(key: "wakeHotkey", value: "Control+Alt+G")
    _ = await ui.settingsUISet(key: "openAtLogin", value: false)
    // Typing goes to the voice.
    voice.phase = .listening
    voice.type("hello")
    check("typing box sends to VoiceUI.type", voice.calls.contains("type"))
    say("checks: \(pass) passed, \(fail) failed")
    exit(fail == 0 ? 0 : 1)
  }

  /** Native on the left, the page on the right, 24 px apart. */
  func sideBySide(_ l: NSBitmapImageRep?, _ r: NSBitmapImageRep?) -> NSBitmapImageRep? {
    guard let l, let r else { return nil }
    let gap = 24, w = l.pixelsWide + gap + r.pixelsWide, h = max(l.pixelsHigh, r.pixelsHigh)
    guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
    NSColor(white: 0.85, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: w, height: h).fill()
    l.draw(in: NSRect(x: 0, y: h - l.pixelsHigh, width: l.pixelsWide, height: l.pixelsHigh))
    r.draw(in: NSRect(x: l.pixelsWide + gap, y: h - r.pixelsHigh, width: r.pixelsWide, height: r.pixelsHigh))
    NSGraphicsContext.restoreGraphicsState()
    return out
  }

  func snap(_ wv: WKWebView) async -> NSBitmapImageRep? {
    let sc = WKSnapshotConfiguration()
    sc.afterScreenUpdates = true
    guard let img = try? await wv.takeSnapshot(configuration: sc), let tiff = img.tiffRepresentation else { return nil }
    return NSBitmapImageRep(data: tiff)
  }

  /** The bridge's own page (/) in a WKWebView at 360x580, with the Electron Mac shell's window.desktop. */
  func openPage() async -> WKWebView {
    let cfg = WKWebViewConfiguration()
    let shim = """
    (() => {
      const off = () => () => {};
      const t = {
        platform: 'darwin',
        hotkey: { get: async () => ({ accelerator: 'Control+Alt+G', label: '⌃⌥G', registered: true, defaultAccelerator: 'Control+Alt+G' }), set: async (a) => ({ accelerator: a, label: a, registered: true, defaultAccelerator: 'Control+Alt+G', ok: true }), suspend: async () => {} },
        startWithWindows: { get: async () => false, set: async (v) => v },
        updates: { get: async () => ({ status: 'dev' }), onChange: off, check: async () => ({ status: 'dev' }), install: async () => {} },
        permissions: { get: async () => ({ platform: 'darwin', accessibility: true, microphone: 'granted', screen: 'granted', helper: true }), request: async () => ({ platform: 'darwin', accessibility: true, microphone: 'granted', screen: 'granted', helper: true }) },
        openLogs: async () => {},
      };
      window.desktop = new Proxy(t, { get: (o, k) => (k in o ? o[k] : (String(k).startsWith('on') ? off : () => {})) });
    })();
    """
    cfg.userContentController.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 360, height: 580), configuration: cfg)
    keepAnimating(wv)
    let w = NSWindow(contentRect: NSRect(x: 480, y: 120, width: 360, height: 580), styleMask: [.borderless], backing: .buffered, defer: false)
    w.contentView = wv
    w.orderFront(nil)
    pageWindow = w
    wv.load(URLRequest(url: Cfg.auth!))
    try? await Task.sleep(for: .seconds(5))
    say("page: " + String(describing: (try? await wv.evaluateJavaScript("JSON.stringify({hero: !!window.__hero, svg: document.querySelectorAll('svg').length, vis: document.visibilityState})")) ?? "nil"))
    return wv
  }

  /** A valid value other than `not` for a key (what a person could pick in Settings). */
  func value(for spec: SettingSpec, not: JSONValue) -> JSONValue? {
    switch spec.kind {
    case .bool, .strictBool: return .bool(!(not.boolValue ?? false))
    case .number(let lo, let hi, let places):
      for f in [0.25, 0.6, 0.9] {
        let v = SettingsSchema.sanitize(spec.key, .number(lo + (hi - lo) * f))!
        if v != not { return v }
      }
      _ = places
      return nil
    case .numberRange: return not == .number(0.1) ? .number(0.12) : .number(0.1)
    case .integer(let lo, let hi): return .number(Double((lo...hi).first { Double($0) != not.doubleValue } ?? lo))
    case .choice(let opts): return opts.first { .string($0) != not }.map { .string($0) }
    case .token: return spec.key == "voice" ? (not == "rex" ? "ara" : "rex") : nil
    case .claudePath: return not == "/usr/local/bin/claude" ? "/opt/homebrew/bin/claude" : "/usr/local/bin/claude"
    case .appList: return not == ["discord.exe"] ? ["slack"] : ["discord.exe"]
    case .object: return nil
    }
  }

  /** Every key Settings shows: Settings -> GET /api/config, then POST /api/settings -> Settings (SSE). */
  func roundtrip() async {
    await waitLoaded()
    var pass = 0, fail = 0
    for spec in SettingsSchema.specs where spec.section != .hidden {
      if spec.key == "wakeHotkey" {
        let r = await ui.settingsUISet(key: "wakeHotkey", value: "Control+Alt+K")
        let shown = ui.settingsUIRead(key: "wakeHotkey")
        if r["ok"]?.boolValue == true, shown == "Control+Alt+K", ui.settings.hotkeyLabel == "⌃⌥K" { pass += 1; say("ok   wakeHotkey (through HotkeyControl)") } else { fail += 1; say("FAIL wakeHotkey \(r) \(shown)") }
        continue
      }
      guard let current = ui.settings[spec.key], let a = value(for: spec, not: current) else { say("skip \(spec.key)"); continue }
      // 1. Settings screen -> bridge.
      let r = await ui.settingsUISet(key: spec.key, value: a)
      let cfg = try? await bridge.config()
      let onBridge = cfg?.settings[spec.key]
      // 2. Bridge -> Settings screen, through the live settings.changed event.
      guard let b = value(for: spec, not: a) else { continue }
      _ = try? await bridge.call("POST", "/api/settings", json: .object([spec.key: b]))
      var shown: JSONValue? = nil
      for _ in 0..<40 {
        shown = ui.settingsUIRead(key: spec.key)
        if shown == b { break }
        try? await Task.sleep(for: .milliseconds(50))
      }
      if r["ok"]?.boolValue == true, onBridge == a, shown == b { pass += 1; say("ok   \(spec.key): ui \(a) -> bridge; bridge \(b) -> ui") }
      else { fail += 1; say("FAIL \(spec.key): set \(r), bridge has \(onBridge.map(\.text) ?? "nil"), ui shows \(shown.map(\.text) ?? "nil") (wanted \(a) then \(b))") }
    }
    // The login item (ORBIT_FAKE_LOGIN: in memory).
    let l = await ui.settingsUISet(key: "openAtLogin", value: true)
    if l["ok"]?.boolValue == true, ui.parityLogin(), ui.settingsUIRead(key: "openAtLogin") == true { pass += 1; say("ok   openAtLogin") } else { fail += 1; say("FAIL openAtLogin \(l)") }
    say("roundtrip: \(pass) passed, \(fail) failed")
    exit(fail == 0 ? 0 : 1)
  }
}

let delegate = Demo()
app.delegate = delegate
app.run()
