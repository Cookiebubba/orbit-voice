// Orbit Native's overlays, behind one small facade for the app shell: Qubit / the pixel buddy on the
// Claude window (home) and on other apps' windows (guests, "Orbit anywhere"), the floating orb, and
// Orbit's mouse. The pages (qubit.html, buddy.html, mouse.html, index.html#orb) run unchanged in
// WKWebViews (PageShim); the logic is OrbitKit's (AvatarModel, AvatarHostModel, OrbitMouseModel,
// ClaudeTrackerCore, OrbStick), ported from electron/avatar*.js, orbit-mouse.js, orb-stick.js,
// claude-window.js and the orb/avatar parts of electron/main.js.
//
// How the shell uses it (all on the main actor):
//
//   let overlays = Overlays(endpoints: ready,                 // the sidecar's `ready` (base + auth links)
//                           settings: { currentSettings },    // Orbit's settings (GET /api/config's)
//                           send: { sidecar.send($0) },       // Swift -> sidecar lines (see below)
//                           onTalk: { voice.wakeFromAvatar() },// the avatar was clicked to talk
//                           onSound: { audio.play($0) },      // "throw": play Wheee! at the voice volume
//                           onOrb: { event in ... })          // .restore / .action("toggle-sleep") / .save([key: value])
//   overlays.start()                                          // orb window, avatar from settings, tracker
//   overlays.onVoice(orbSync)                                 // Orbit's voice state, each time it changes
//   overlays.event("finished" | "draft" | "sent" | "error")   // the main page's buddy:event
//   overlays.emote(cue)                                       // the main page's buddy:emote
//   overlays.sidecarMessage(line)                             // avatar.cmd, mouse.glide/press/hide,
//                                                             // contexts, focus, wins, promptBoxWork
//   overlays.settingsChanged(keys)                            // after Orbit's settings changed
//   overlays.showOrb() / hideOrb()                            // main window hidden / shown
//   overlays.stop()                                           // quitting
//
// What it sends the sidecar (`send`): {"t":"avatarState","kind","onScreen"} (when either changes),
// {"t":"wake","win":{...}} (avatar clicked to talk, with the window it lives on), {"t":"homeWindow",
// "id"} and {"t":"frontHint","id"} (the Claude window Orbit lives on), {"t":"screens","displays":
// [{x,y,w,h,scale}]} (visible frames in points: the mouse's glide space on macOS).
//
// For the parity driver: parityAvatars(), parityMouse(), parityOrb(), parityClaude(), pointer(...),
// setTestCursor(_:), eval(avatar:script:), and `onEvent` (the driver's events ring): avatar.created
// {id,kind,role}, avatar.closed {id} (after its fade-out), avatar.talk {id}, avatar.lift {id,on},
// avatar.sound {id,name}, avatar.command {id,action,dir}. Avatar ids: "home", or the context id.
//
// Developer/test environment: ORBIT_TEST_CLAUDE_PID (only that process is "Claude"),
// ORBIT_CLAUDE_HELPER (a stand-in claude-window helper).
import AppKit
import OrbitKit

@MainActor
public final class Overlays {
  public enum OrbEvent: Equatable, Sendable {
    /** The orb was clicked: show the main window. */
    case restore
    /** The orb was right-clicked ("toggle-sleep"): the voice should sleep or wake. */
    case action(String)
    /** Settings to save (orbPosition, orbStickAnchor) after a drag. */
    case save([String: JSONValue])
  }

  private let endpoints: BridgeEndpoints
  private let settings: () -> [String: JSONValue]
  private let sendToSidecar: (JSONValue) -> Void
  private let onTalk: () -> Void
  private let onSound: (String) -> Void
  private let onOrb: (OrbEvent) -> Void
  private let log: (String) -> Void
  /** Happenings for the parity driver's events ring (type, data); see the header. */
  private let onEvent: (String, JSONValue) -> Void

  private var home: AvatarModel?
  private var homeEnv: AvatarEnv?
  private var departing: [AvatarModel] = [] // old home avatars fading out (one per place still holds)
  private var pendingHomeUp: (@MainActor () -> Void)?
  private var guestModels: [WeakModel] = [] // every guest made, to report the ones still fading
  private lazy var host = AvatarHostModel(
    makeAvatar: { [unowned self] kind, id in self.makeAvatar(kind: kind, boxless: true, id: id) },
    home: { [weak self] in self?.home },
    current: { [weak self] in self?.front },
    log: { [weak self] m in self?.log(m) },
    now: { MainClock.shared.now }
  )
  private var tracker: ClaudeWindowTracker?
  private var claude = ClaudeState.none
  private var lastBox: BoxReport?
  private var orb: OrbController?
  private var mouse: MouseOverlay?
  private var mouseWarm = false
  private var front: FrontWindow?
  private var recent: [JSONValue] = []
  private var lastOrbState: JSONValue?
  fileprivate var testCursor: ScreenPoint?
  private var stateTimer: OverlayTimer?
  private var lastAvatarState: JSONValue?
  private var lastHomeWindow: Int?
  private var screenObserver: NSObjectProtocol?
  private var started = false
  /** The floating orb at all (Orbit Native has none: the launcher minimizes to the Dock like any Mac app). */
  private let orbWanted: Bool

  public init(endpoints: BridgeEndpoints, settings: @escaping () -> [String: JSONValue], send: @escaping (JSONValue) -> Void,
              onTalk: @escaping () -> Void, onSound: @escaping (String) -> Void, onOrb: @escaping (OrbEvent) -> Void = { _ in },
              onEvent: @escaping (String, JSONValue) -> Void = { _, _ in },
              log: @escaping (String) -> Void = { NSLog("overlays: %@", $0) }, helperPath: String? = ClaudeWindowTracker.defaultHelperPath(),
              orb: Bool = true) {
    self.orbWanted = orb
    self.endpoints = endpoints
    self.settings = settings
    self.sendToSidecar = send
    self.onTalk = onTalk
    self.onSound = onSound
    self.onOrb = onOrb
    self.onEvent = onEvent
    self.log = log
    OverlayPage.log = log
    if let p = helperPath {
      let t = ClaudeWindowTracker(helperPath: p)
      t.onChange = { [weak self] s in self?.claudeChanged(s) }
      t.onBox = { [weak self] b in
        self?.lastBox = b
        self?.home?.onBoxRect(b)
      }
      t.onError = { [weak self] m in self?.log(m) }
      t.log = { [weak self] m in self?.log(m) }
      tracker = t
    } else {
      log("no claude-window helper: the avatar floats free along the bottom of the screen and the orb doesn't stick to Claude")
    }
  }

  // MARK: - settings

  private var s: [String: JSONValue] { settings() }
  private var avatarKind: AvatarKind? { s["avatar"]?.stringValue.flatMap(AvatarKind.init(rawValue:)) }
  private var avatarSize: Double { s["buddySize"]?.doubleValue ?? 2 }
  /** With an avatar on, the orb can be turned off (the avatar stands in for it); without one it always shows. */
  private var orbAllowed: Bool { s["showOrb"]?.boolValue != false || avatarKind == nil }
  private var mouseWanted: Bool { s["anywhere"]?.boolValue != false && s["anywhereMouse"]?.boolValue != false }
  private var needTracker: Bool { (orbWanted && s["orbStick"]?.boolValue == true) || avatarKind != nil }

  // MARK: - lifecycle

  /** Make the orb window, put the avatar up from the settings, start the tracker if needed. */
  public func start() {
    guard !started else { return }
    started = true
    if orbWanted, let u = endpoints.auth["orb"] {
      orb = OrbController(url: u, base: endpoints.base, settings: settings, allowed: { [weak self] in self?.orbAllowed ?? true }, emit: { [weak self] e in self?.onOrb(e) })
    }
    mouse = MouseOverlay(url: { [weak self] in self?.endpoints.auth["mouse"] }, base: endpoints.base, enabled: { [weak self] in self?.mouseWanted ?? false })
    setAvatar(kind: avatarKind, size: avatarSize, live: false)
    if needTracker { tracker?.start() }
    screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.screensChanged() }
    }
    sendScreens()
    // The avatar's state for the sidecar (kind, on screen) and the box watch, kept current.
    stateTimer = MainClock.shared.every(250) { [weak self] in self?.syncState() }
  }

  public func stop() {
    stateTimer?.cancel()
    if let o = screenObserver { NotificationCenter.default.removeObserver(o) }
    tracker?.stop()
    home?.close()
    for d in departing { d.close() }
    host.stop()
    for g in guestModels { g.model?.close() }
    mouse?.model.stop()
    orb?.stop()
  }

  /** Orbit's settings changed (the keys that changed): the overlays follow. */
  public func settingsChanged(_ keys: [String]) {
    let k = Set(keys)
    if !k.isDisjoint(with: ["avatarClickTalk", "avatarThrow", "avatarThrowSound"]) { refreshPrefs() }
    if k.contains("avatar") || k.contains("buddySize") { setAvatar(kind: avatarKind, size: avatarSize, live: true) }
    if !k.isDisjoint(with: ["orbStick", "avatar"]) {
      if needTracker { tracker?.start() } else {
        tracker?.stop()
        claudeChanged(.none)
      }
    }
    if !k.isDisjoint(with: ["showOrb", "orbStick", "avatar", "orbStickAnchor"]) { orb?.place() }
    if (k.contains("anywhereMouse") || k.contains("anywhere")) && !mouseWanted { mouse?.model.hide() }
  }

  /** The avatar settings it reads changed (click to talk, throwing): every page hears. */
  public func refreshPrefs() {
    home?.refresh()
    host.refresh()
  }

  // MARK: - the avatar

  /**
   * Settings -> Avatar: the pixel buddy, Qubit or none, at a size (1-3). `live`: switched while
   * Orbit runs, so the new one plays an entrance. One avatar per place at every moment: the old one
   * fades out and its window closes first, and only then does the new one come up.
   */
  public func setAvatar(kind: AvatarKind?, size: Double, live: Bool) {
    if let h = home, h.kind == kind {
      host.setKind(kind, size: size)
      h.setEnabled(true, size: size, entrance: false)
      return
    }
    let old = home
    home = nil
    homeEnv = nil
    pendingHomeUp = nil
    if let old {
      departing.append(old)
      old.leave { [weak self, weak old] in self?.homeGone(old) }
    }
    if let kind {
      let next = makeAvatar(kind: kind, boxless: false, id: "home")
      home = next
      if let v = lastOrbState { host.onVoice(v) } // (home gets it, or rests while the talk is elsewhere)
      next.onClaude(claude)
      let up: @MainActor () -> Void = { [weak self, weak next] in
        guard let self, let next, self.home === next else { return }
        next.setEnabled(true, size: size, entrance: live)
      }
      if departing.isEmpty { up() } else { pendingHomeUp = up }
    }
    // The Qubits in other windows (Orbit anywhere) become the same avatar, or go.
    host.setKind(kind, size: size)
    host.setEnabled(kind != nil)
    syncState()
  }

  /** An old home avatar has gone: once none is left fading out, the new one comes up. */
  private func homeGone(_ old: AvatarModel?) {
    departing.removeAll { $0 === old }
    guard departing.isEmpty, let up = pendingHomeUp else { return }
    pendingHomeUp = nil
    up()
  }

  private func makeAvatar(kind: AvatarKind, boxless: Bool, id: String) -> AvatarModel {
    let env = AvatarEnv(owner: self, id: id, kind: kind, role: boxless ? "guest" : "home")
    // Free-floating only without a tracker (no helper binary), as Electron's freeAvatar().
    let m = AvatarModel(kind: kind, boxless: boxless, floatsFree: !boxless && tracker == nil, env: env)
    env.model = m
    if boxless {
      guestModels.removeAll { $0.model == nil || $0.model?.window == nil && $0.model?.leaving == true }
      guestModels.append(WeakModel(model: m))
    } else {
      homeEnv = env
    }
    return m
  }

  fileprivate func makeWindow(for env: AvatarEnv, kind: AvatarKind, loaded: @escaping @MainActor () -> Void) -> AvatarWindowPort {
    let url = endpoints.auth[kind.view] ?? endpoints.base
    return AvatarWindow(kind: kind, url: url, base: endpoints.base, onMessage: { [weak self, weak env] ch, args in
      guard let self, let m = env?.model else { return }
      self.pageMessage(from: m, ch, args)
    }, loaded: loaded)
  }

  /** Only the current home avatar's page or a current guest's (not one fading out after a switch). */
  private func isCurrent(_ m: AvatarModel) -> Bool { m === home || host.guestId(of: m) != nil }

  private func pageMessage(from m: AvatarModel, _ ch: String, _ args: [JSONValue]) {
    guard isCurrent(m) else { return }
    let prefs = AvatarPrefs(settings: s)
    switch ch {
    case "buddy:hover":
      m.pageHover(args.first?.boolValue ?? false, held: args.count > 1 ? args[1].boolValue ?? false : false)
    case "buddy:hit":
      let r = Rect(json: args.first)
      let ok = r.map { [$0.x, $0.y, $0.w, $0.h].allSatisfy { abs($0) < 100_000 } } ?? false
      m.pageHit(ok ? r : nil)
    case "buddy:press":
      m.pressed(args.first?.stringValue ?? "", why: args.count > 1 ? args[1].stringValue ?? "" : "")
    case "page:error":
      m.pageError(args.first?.stringValue ?? "")
    case "page:reset":
      m.pageReset(stopped: args.first?.stringValue)
    case "buddy:talk":
      // A quick click on the avatar: start talking, as "Hey Orbit" with its window in front.
      guard prefs.clickTalk else { return }
      let hwnd = m.hostHwnd
      if hwnd != 0 {
        let known = recent.first { $0["hwnd"]?.intValue == hwnd }
        let win: JSONValue = known ?? (m === home ? ["hwnd": .number(Double(hwnd)), "kind": "app", "app": "Claude", "title": "Claude"] : ["hwnd": .number(Double(hwnd)), "kind": "app"])
        sendToSidecar(["t": "wake", "win": win])
      }
      onEvent("avatar.talk", ["id": .string(id(of: m))])
      onTalk()
    case "buddy:sound":
      // Thrown for real: "Wheee!", played by the shell at the voice volume.
      guard args.first?.stringValue == "throw", prefs.throwing, prefs.throwSound else { return }
      onEvent("avatar.sound", ["id": .string(id(of: m)), "name": "throw"])
      onSound("throw")
    case "buddy:lift":
      let on = args.first?.boolValue ?? false
      if on && !prefs.throwing { m.lift(false) } else { m.lift(on) }
      onEvent("avatar.lift", ["id": .string(id(of: m)), "on": .bool(on && prefs.throwing)])
    default:
      break
    }
  }

  private func id(of m: AvatarModel) -> String { m === home ? "home" : host.guestId(of: m) ?? "leaving" }

  // MARK: - Orbit's state and events

  /** Orbit's voice state (the orb, every avatar, the mouse). */
  public func onVoice(_ sync: OrbSync) {
    let v = JSONValue.from(sync)
    lastOrbState = v
    orb?.onState(v)
    host.onVoice(v) // the window the conversation is in gets it; the others rest
    mouse?.model.onVoice(v)
    // Orbit woke: the mouse's windows get ready (hidden), so its first glide has its page loaded.
    if !mouseWarm, sync.phase != .off, mouseWanted {
      mouseWarm = true
      mouse?.model.prewarm()
    }
  }

  /** Something happened the home avatar reacts to: finished | draft | sent | error. */
  public func event(_ name: String) { home?.event(name) }

  /** A feeling as the voice's words play (an emote cue), for the avatar the user is talking to. */
  @discardableResult
  public func emote(_ name: String) -> Bool { (host.active() as? AvatarModel)?.emote(name) ?? false }

  /** Something the user asked the avatar to do ({ action, dir }): the active avatar does it. */
  @discardableResult
  public func command(_ cmd: JSONValue) -> JSONValue {
    guard let a = host.active() as? AvatarModel else { return ["ok": false, "error": "There is no avatar on screen."] }
    let r = a.command(cmd)
    if r["ok"]?.boolValue == true {
      let d = cmd["dir"]?.stringValue
      onEvent("avatar.command", ["id": .string(id(of: a)), "action": cmd["action"] ?? .null, "dir": d == "left" || d == "right" ? .string(d!) : .null])
    }
    return r
  }

  /** A line from the sidecar meant for the overlays (others are ignored). */
  public func sidecarMessage(_ m: JSONValue) {
    switch m["t"]?.stringValue {
    case "avatar.cmd": if let c = m["cmd"] { command(c) }
    case "mouse.glide":
      guard let x = m["x"]?.doubleValue, let y = m["y"]?.doubleValue else { return }
      mouse?.model.glide(x: x, y: y, ms: m["ms"]?.doubleValue, holdMs: m["holdMs"]?.doubleValue ?? 1500)
    case "mouse.press": mouse?.model.doPress()
    case "mouse.hide": mouse?.model.hide()
    case "contexts": if let snap = ContextsSnapshot(json: m["snap"]) { host.sync(snap) }
    case "focus":
      if let c = m["current"], let h = c["hwnd"]?.intValue { front = FrontWindow(hwnd: h, kind: c["kind"]?.stringValue ?? "app") } else { front = nil }
      recent = m["recent"]?.arrayValue ?? recent
      host.onFocus()
    case "wins": host.onWins((m["wins"]?.arrayValue ?? []).compactMap(GuestBounds.init(json:)))
    case "promptBoxWork": tracker?.burst()
    default: break
    }
  }

  // MARK: - the orb

  public func showOrb() { orb?.show() }
  public func hideOrb() { orb?.hide() }

  // MARK: - the Claude window

  private func claudeChanged(_ s: ClaudeState) {
    claude = s
    home?.onClaude(s)
    host.onFocus() // (a window's Qubit never stands on the window home is on)
    orb?.claude = s
    orb?.place()
    syncState()
    let id = s.found ? s.hwnd : 0
    if id != lastHomeWindow {
      lastHomeWindow = id
      sendToSidecar(["t": "homeWindow", "id": .number(Double(id))])
      sendToSidecar(["t": "frontHint", "id": .number(Double(id))])
    }
  }

  private func screensChanged() {
    home?.screensChanged()
    mouse?.model.displaysChanged()
    orb?.place()
    sendScreens()
  }

  private func sendScreens() {
    let ds = ScreenSpace.displays().map { d -> JSONValue in
      ["x": .number(d.visible.x), "y": .number(d.visible.y), "w": .number(d.visible.w), "h": .number(d.visible.h), "scale": .number(d.scale)]
    }
    sendToSidecar(["t": "screens", "displays": .array(ds)])
  }

  /** The box watch follows the home avatar, and the sidecar hears the avatar's kind and whether it shows. */
  private func syncState() {
    tracker?.watchBox(home?.boxWindow ?? 0)
    let a = host.active() as? AvatarModel
    let st: JSONValue = ["t": "avatarState", "kind": home.map { .string($0.kind.rawValue) } ?? .null, "onScreen": .bool(a?.window?.isVisible ?? false)]
    if st != lastAvatarState {
      lastAvatarState = st
      sendToSidecar(st)
    }
  }

  // MARK: - for the parity driver

  /** Every avatar with a window (home, guests, and any still fading out). */
  public func parityAvatars() -> [ParityAvatar] {
    var out: [ParityAvatar] = []
    func add(_ m: AvatarModel, id: String, role: String) {
      let sn = m.snapshot
      let hostInfo = sn.host.map { ParityHost(pid: pidOf(window: sn.hostHwnd), frame: $0) }
      out.append(ParityAvatar(id: id, kind: m.kind.rawValue, role: role, visible: sn.visible, frame: m.window != nil ? sn.frame : nil, host: hostInfo,
                              figure: sn.figure, standingOn: sn.standingOn, lifted: sn.lifted, asleep: sn.asleep, takesMouse: sn.takesMouse, leaving: sn.leaving))
    }
    if let h = home { add(h, id: "home", role: "home") }
    for d in departing where d.window != nil { add(d, id: "home", role: "home") }
    for g in host.guestList { if let m = g.avatar as? AvatarModel { add(m, id: g.id, role: "guest") } }
    for w in guestModels { if let m = w.model, m.leaving, m.window != nil { add(m, id: "leaving", role: "guest") } }
    return out
  }

  public func parityMouse() -> ParityMouse {
    guard let m = mouse?.model else { return ParityMouse(visible: false, pos: nil, windows: 0) }
    return ParityMouse(visible: m.isVisible, pos: m.now.map { ["x": $0.x, "y": $0.y] }, windows: m.shownWindows)
  }

  public func parityOrb() -> ParityWindow { orb?.parity ?? ParityWindow(visible: false, frame: nil, view: "orb") }

  /**
   * Claude's window, and its prompt box and Send as Qubit stands on them: the home avatar's own
   * (the rounded box you see, padded out from the text field the helper reports), on screen, as the
   * Electron driver reports them. Nothing while no home avatar lives on this window.
   */
  public func parityClaude() -> ParityClaude {
    guard claude.found else { return ParityClaude(found: false) }
    let snap = lastBox?.hwnd == claude.hwnd ? home?.snapshot : nil
    return ParityClaude(found: true, pid: pidOf(window: claude.hwnd), frame: claude.rect, box: snap?.boxOnScreen, send: snap?.sendOnScreen)
  }

  /** A synthetic mouse event delivered to that avatar's page only (never to the system). */
  @discardableResult
  public func pointer(avatar: String, type: String, x: Double, y: Double) -> Bool {
    guard let m = model(id: avatar), let w = m.window as? AvatarWindow else { return false }
    w.pointer(type: type, at: ScreenPoint(x: x, y: y))
    return true
  }

  /** Overrides where the avatars' hover poll thinks the cursor is (nil: the real one again). */
  public func setTestCursor(_ p: ScreenPoint?) { testCursor = p }

  /** Run a script in an avatar's page and return its result. */
  public func eval(avatar: String, script: String) async -> JSONValue {
    guard let m = model(id: avatar), let w = m.window as? AvatarWindow else { return ["error": "no such avatar"] }
    return await w.page.eval(script)
  }

  /** An avatar's window as AppKit has it (window number, click-through, level), for checks. */
  public func windowInfo(avatar: String) -> JSONValue {
    guard let m = model(id: avatar), let w = m.window as? AvatarWindow else { return .null }
    return ["number": .number(Double(w.panel.windowNumber)), "ignoresMouse": .bool(w.panel.ignoresMouseEvents),
            "level": .number(Double(w.panel.level.rawValue)), "visible": .bool(w.panel.isVisible), "frame": w.panel.topLeftFrame.rectJSON]
  }

  private func model(id: String) -> AvatarModel? {
    if id == "home" { return home }
    return host.guestList.first { $0.id == id }?.avatar as? AvatarModel
  }

  /** The process that owns a window (CGWindowList: no permission needed for the owner). */
  private func pidOf(window id: Int) -> Int? {
    if id == claude.hwnd, ClaudeWindowTracker.testClaudePid > 0 { return ClaudeWindowTracker.testClaudePid }
    guard id > 0, let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]], let w = list.first else { return nil }
    return (w[kCGWindowOwnerPID as String] as? NSNumber)?.intValue
  }

  /** The home avatar's model (OverlayDemo's checks). */
  public var homeAvatar: AvatarModel? { home }
  public var claudeState: ClaudeState { claude }
}

private struct WeakModel {
  weak var model: AvatarModel?
}

/** One avatar's world: its window, the screens, the cursor (or the test cursor), the settings, the log. */
@MainActor
final class AvatarEnv: AvatarEnvironment {
  weak var owner: Overlays?
  weak var model: AvatarModel?
  let id: String, kind: AvatarKind, role: String
  init(owner: Overlays, id: String, kind: AvatarKind, role: String) { (self.owner, self.id, self.kind, self.role) = (owner, id, kind, role) }
  func windowOpened() { owner?.emit("avatar.created", ["id": .string(id), "kind": .string(kind.rawValue), "role": .string(role)]) }
  func windowClosed() { owner?.emit("avatar.closed", ["id": .string(id)]) }
  func mouseMode(takes: Bool) { owner?.emit("avatar.mode", ["id": .string(id), "takes": .bool(takes)]) }

  var clock: OverlayClock { MainClock.shared }
  func makeAvatarWindow(kind: AvatarKind, loaded: @escaping @MainActor () -> Void) -> AvatarWindowPort {
    owner!.makeWindow(for: self, kind: kind, loaded: loaded)
  }
  func workArea(matching r: Rect) -> Rect { ScreenSpace.visibleFrame(matching: r) }
  func cursorWorkArea() -> Rect { ScreenSpace.visibleFrame(at: cursor() ?? ScreenSpace.cursor) }
  func cursor() -> ScreenPoint? { owner?.testCursor ?? ScreenSpace.cursor }
  func avatarPrefs() -> AvatarPrefs { owner.map { AvatarPrefs(settings: $0.currentSettings) } ?? AvatarPrefs() }
  func info(_ message: String) { owner?.logLine(message) }
  func warn(_ message: String) { owner?.logLine(message) }
}

extension Overlays {
  fileprivate var currentSettings: [String: JSONValue] { settings() }
  fileprivate func logLine(_ m: String) { log(m) }
  fileprivate func emit(_ type: String, _ data: JSONValue) { onEvent(type, data) }
}
