// One avatar's window logic (electron/avatar.js): a transparent, click-through strip along the bottom
// of the window he lives on, where the avatar's page (buddy.html or qubit.html, unchanged) draws him.
// It follows that window, sits just above it in z-order (so other apps still cover both; on top of
// everything while that window or Orbit is in front), and hides while the window is minimized (the
// page is told, so it can stop drawing).
//
// Where he lives:
//   - home (the default): the Claude window, standing on its prompt box. The tracker reports where
//     the box is the moment it moves (onBoxRect); that is turned into the strip's coordinates here.
//     No Claude window (none open, minimized, or no Accessibility to see one): hidden, as Electron's.
//   - free (floatsFree: no Claude window tracker at all, e.g. a build without its helper): along the
//     bottom of the screen the cursor is on, just above the Dock, with the floor to himself.
//   - boxless (a guest, "Orbit anywhere": his strip on another app's window, see AvatarHostModel):
//     the same strip on that window, standing on its bottom edge (no box is looked for). Hidden when
//     there's no window.
//
// Switching avatars is a handover: the old one's page fades out (leave()), then its window closes,
// and only then does the new one come up (the host and the facade wait for leave's completion).
//
// Lifted (lift(true), from the page: the user picked him up to throw him): the window grows to cover
// the window he lives on, clipped to the visible frame of its display (never under the menu bar or
// the Dock), keeping the strip's place in the z-order, so he's dragged and flies inside that window
// and never over another one. Free-floating, it covers the visible frame. It stays click-through
// except over him. lift(false) gives the strip back. If the page goes quiet while lifted (no
// lift(true) for liftMaxQuietMs), the strip comes back by itself.
//
// The window is behind AvatarWindowPort (OrbitNative's OverlayWindow + WKWebView in the app; a
// stand-in in the tests), and screens, the cursor and the clock behind AvatarEnvironment.
import Foundation

public enum AvatarKind: String, Codable, Sendable, CaseIterable {
  case buddy, qubit

  public var title: String { self == .buddy ? "Orbit buddy" : "Orbit Qubit" }
  /** The Orbit events its page reacts to. */
  public var events: [String] { self == .buddy ? ["finished", "draft", "sent"] : ["finished", "draft", "sent", "error"] }
  /** Qubit stomps Claude's Send button when a prompt goes. */
  public var sendButton: Bool { self == .qubit }
  public var emotes: Bool { self == .qubit }
  /** The page's view name for the bridge's sign-in link. */
  public var view: String { rawValue }

  /** What the user can ask this avatar to do (src/avatar-commands.js AVATAR_ACTIONS). */
  public func does(_ action: String) -> Bool { AvatarKind.actions[action]?.contains(self) ?? false }
  public static let actions: [String: [AvatarKind]] = [
    "backflip": [.qubit], "frontflip": [.qubit], "roll": [.qubit], "jump": [.qubit, .buddy], "hop": [.qubit, .buddy],
    "grow": [.qubit], "shrink": [.qubit], "celebrate": [.qubit, .buddy], "dance": [.qubit, .buddy], "nod": [.qubit],
    "shake": [.qubit], "look_around": [.qubit, .buddy], "stretch": [.qubit, .buddy], "blink": [.qubit], "happy": [.qubit],
    "sad": [.qubit], "surprised": [.qubit], "curious": [.qubit], "wave": [.buddy], "trip": [.buddy], "kick_ball": [.buddy],
    "sit": [.buddy], "climb": [.buddy], "move": [.qubit, .buddy], "go_home": [.qubit, .buddy], "nap": [.qubit, .buddy], "wake": [.qubit, .buddy],
  ]
}

/** The emote cue a word names (src/emote-cues.js cueName), or nil. */
public func emoteCue(_ word: String) -> String? {
  let w = word.lowercased()
  let cues = ["happy", "excited", "curious", "surprised", "proud", "sad", "embarrassed", "nod", "shake", "wonder", "hop"]
  let aliases = ["celebrate": "excited", "think": "wonder", "thinking": "wonder", "laugh": "happy", "smile": "happy", "yes": "nod", "no": "shake", "wow": "surprised"]
  return cues.contains(w) ? w : aliases[w]
}

/** Settings -> Avatar: click it to talk, pick it up and throw it, and the sound when thrown. */
public struct AvatarPrefs: Equatable, Sendable {
  public var clickTalk = true, throwing = true, throwSound = true
  public init(clickTalk: Bool = true, throwing: Bool = true, throwSound: Bool = true) { (self.clickTalk, self.throwing, self.throwSound) = (clickTalk, throwing, throwSound) }
  /** From Orbit's settings (avatarClickTalk, avatarThrow, avatarThrowSound: on unless false). */
  public init(settings s: [String: JSONValue]) {
    clickTalk = s["avatarClickTalk"]?.boolValue != false
    throwing = s["avatarThrow"]?.boolValue != false
    throwSound = s["avatarThrowSound"]?.boolValue != false
  }
  public var json: JSONValue { ["clickTalk": .bool(clickTalk), "throw": .bool(throwing), "throwSound": .bool(throwSound)] }
}

/** Where an overlay sits in z-order: on top of other apps' windows, or just above one window. */
public enum OverlayLayer: Equatable, Sendable {
  case top
  case above(Int)
}

/** An avatar's window, as the model drives it (frames in screen points, top-left origin). */
@MainActor
public protocol AvatarWindowPort: AnyObject {
  var frame: Rect { get }
  func setFrame(_ r: Rect)
  var isVisible: Bool { get }
  func showInactive()
  func hide()
  func setLayer(_ layer: OverlayLayer)
  func setIgnoresMouse(_ ignore: Bool)
  /** A message to the page (window.__orbit.emit(channel, payload)). */
  func send(_ channel: String, _ payload: JSONValue)
  func destroy()
}

/** What an avatar needs from the world: windows, screens, the cursor, settings, the clock, the log. */
@MainActor
public protocol AvatarEnvironment: AnyObject {
  var clock: OverlayClock { get }
  /** A new hidden window loading this avatar's page; `loaded` runs each time the page finishes loading. */
  func makeAvatarWindow(kind: AvatarKind, loaded: @escaping @MainActor () -> Void) -> AvatarWindowPort
  /** The visible frame of the display a rect is (mostly) on. */
  func workArea(matching r: Rect) -> Rect
  /** The visible frame of the display the cursor is on. */
  func cursorWorkArea() -> Rect
  /** The cursor (or the parity driver's test cursor). */
  func cursor() -> ScreenPoint?
  func avatarPrefs() -> AvatarPrefs
  func info(_ message: String)
  func warn(_ message: String)
  /** Its window opened (the page is loading) / closed (after its fade-out, or switched off). */
  func windowOpened()
  func windowClosed()
  /** Its window started (true) or stopped taking the mouse (the parity driver's avatar.mode). */
  func mouseMode(takes: Bool)
}

extension AvatarEnvironment {
  public func windowOpened() {}
  public func windowClosed() {}
  public func mouseMode(takes: Bool) {}
}

/** What the host and the facade need of an avatar (AvatarModel; a stand-in in the tests). */
@MainActor
public protocol AvatarHandle: AnyObject {
  func onClaude(_ state: ClaudeState)
  func onVoice(_ state: JSONValue)
  func setEnabled(_ on: Bool, size: Double, entrance: Bool)
  /** Fade out, then close; `done` runs when it's gone. */
  func leave(_ done: @escaping @MainActor () -> Void)
  func refresh()
  func stop()
  /** The window it lives on now, or 0 (free-floating, or not on one). */
  var hostHwnd: Int { get }
}

@MainActor
public final class AvatarModel: AvatarHandle {
  public static let leaveMs: Double = 450 // the page's fade-out, and a little more
  public static let liftMaxQuietMs: Double = 12_000 // lifted with no word from the page: back to the strip
  /** No box report this long after showing on a window: the page stops waiting for one. */
  public static let boxWaitMs: Double = 1500

  public let kind: AvatarKind
  /** A guest on another app's window: no prompt box, never free-floating. */
  public let boxless: Bool
  /** No window tracker: he floats along the bottom of the screen instead of living on a window. */
  public let floatsFree: Bool
  private let env: AvatarEnvironment
  private var clock: OverlayClock { env.clock }

  private var win: AvatarWindowPort?
  private var enabled = false
  public private(set) var leaving = false
  private var scale: Double = 2
  private var claude = ClaudeState.none
  private var host: Rect? // the window it lives on (points), while on one
  private var free = false // floating along the bottom of the screen right now
  private var layer: OverlayLayer?
  private var boxWaitTimer: OverlayTimer?
  private var lastBox: Rect?
  private var lastSend: Rect? // Claude's Send button (Qubit), kept while the box is there
  private var boxKnown = false // a box report (or the wait for one) since showing
  private var lastRaw: BoxReport?
  private var sendOffset: AvatarGeometry.SendOffset?
  private var voice: JSONValue = ["phase": "off"]
  private var pendingEntrance = false
  private var lifted: (strip: Rect, area: Rect)?
  private var liftTimer: OverlayTimer?
  private lazy var hoverLog = RateLimitedLog(everyMs: 10_000, now: { [weak self] in self?.clock.now ?? 0 }) { [weak self] m in self?.env.info(m) }
  private lazy var pressLog = RateLimitedLog(everyMs: 5_000, now: { [weak self] in self?.clock.now ?? 0 }) { [weak self] m in self?.env.info(m) }
  private lazy var pageErrLog = RateLimitedLog(everyMs: 30_000, now: { [weak self] in self?.clock.now ?? 0 }) { [weak self] m in self?.env.warn(m) }
  private lazy var hover: HoverPoller = makeHover()
  private var shownAt: Double = 0

  public init(kind: AvatarKind, boxless: Bool = false, floatsFree: Bool = false, env: AvatarEnvironment) {
    self.kind = kind
    self.boxless = boxless
    self.floatsFree = floatsFree && !boxless
    self.env = env
  }

  private func makeHover() -> HoverPoller {
    let k = kind.rawValue
    return HoverPoller(
      clock: env.clock,
      getCursor: { [weak self] in self?.env.cursor() },
      getBounds: { [weak self] in self?.win?.frame },
      setIgnore: { [weak self] ignore in self?.win?.setIgnoresMouse(ignore) },
      isLive: { [weak self] in guard let self, let w = self.win else { return false }; return w.isVisible && !self.leaving },
      onCursor: { [weak self] c in self?.win?.send("buddy:cursor", c.map { ["x": .number($0.x), "y": .number($0.y)] } ?? .null) },
      onMode: { [weak self] take in
        self?.hoverLog("mode", "\(k): its window \(take ? "takes the mouse (the cursor is on it, or it is held)" : "lets clicks through")")
        self?.env.mouseMode(takes: take)
      },
      onRunning: { [weak self] on in self?.hoverLog(on ? "poll-on" : "poll-off", "\(k): hover polling \(on ? "started" : "stopped")") },
      // (Only logged: the last rect stands, since a page's timers can be slowed while he hasn't moved.)
      onQuiet: { [weak self] ms in self?.hoverLog("quiet", "\(k): no word from its page for \(Int((ms / 1000).rounded())) s (its timers slowed or stalled): keeping where it last was") }
    )
  }

  @discardableResult
  private func ensure() -> AvatarWindowPort {
    if let w = win { return w }
    let w = env.makeAvatarWindow(kind: kind) { [weak self] in
      guard let self, self.win != nil else { return }
      self.send()
      if self.pendingEntrance {
        self.pendingEntrance = false
        self.sendEvent("enter")
      }
    }
    win = w
    env.info("\(kind.rawValue): avatar window opened \(boxless ? "on another window" : "for home")")
    env.windowOpened()
    w.setIgnoresMouse(true) // clicks go through to the window underneath
    hover.reset()
    return w
  }

  private func destroyWindow() {
    guard let w = win else { return }
    win = nil
    hover.stop()
    w.destroy()
    env.info("\(kind.rawValue): avatar window closed")
    env.windowClosed()
  }

  private var visible: Bool { win?.isVisible ?? false }
  /** The strip's bounds: the window's own, or (lifted) where the strip would be. */
  private var stripBounds: Rect { lifted?.strip ?? win?.frame ?? Rect(x: 0, y: 0, w: 0, h: 0) }

  private func send() {
    guard let w = win else { return }
    let p = env.avatarPrefs()
    w.send("buddy:state", [
      "voice": voice,
      "box": lastBox?.rectJSON ?? .null,
      "send": lastSend?.rectJSON ?? .null,
      "boxKnown": .bool(boxKnown),
      "scale": .number(scale),
      "visible": .bool(visible),
      "bounds": stripBounds.boundsJSON,
      "lift": lifted.map { ["area": $0.area.boundsJSON, "strip": $0.strip.boundsJSON] } ?? .null,
      "prefs": p.json,
    ])
  }

  private func sendEvent(_ name: String) { win?.send("buddy:event", .string(name)) }

  private func setLayer(_ next: OverlayLayer) {
    guard let w = win, next != layer else { return }
    layer = next
    w.setLayer(next)
  }

  private var hostLayer: OverlayLayer { claude.front == "other" ? .above(claude.hwnd) : .top }

  private func hide() {
    boxWaitTimer?.cancel()
    boxWaitTimer = nil
    drop(quiet: true)
    hover.stop()
    if visible {
      win?.hide()
      send() // the page stops drawing while hidden
    }
  }

  /** The box (and Send button) in the strip from the helper's latest report. True if it changed. */
  @discardableResult
  private func applyRaw() -> Bool {
    guard let raw = lastRaw, visible, let host else { return false }
    let strip = stripBounds
    let usable = AvatarGeometry.usableBox(raw.rect.flatMap { AvatarGeometry.boxInStrip($0, rawWin: raw.win, host: host, strip: strip) }, stripHeight: strip.h)
    var sendRect: Rect?
    if kind.sendButton, usable != nil, let s = raw.send {
      sendRect = AvatarGeometry.sendInStrip(s, rawWin: raw.win, host: host, strip: strip)
      if let sr = sendRect { sendOffset = AvatarGeometry.sendOffset(box: usable, send: sr) }
    }
    let nextSend: Rect? = usable == nil ? nil : (AvatarGeometry.sendAt(box: usable, offset: sendOffset, size: sendRect ?? lastSend) ?? sendRect ?? lastSend)
    let changed = usable != lastBox || nextSend != lastSend || !boxKnown
    if !changed { return false }
    if (usable != nil) != (lastBox != nil) {
      env.info(usable.map { "\(kind.rawValue): standing room on the prompt box (\(Int($0.w))×\(Int(strip.h - $0.y)) px from the bottom)" } ?? "\(kind.rawValue): no prompt box to stand on")
    }
    lastBox = usable
    lastSend = nextSend
    boxKnown = true
    boxWaitTimer?.cancel()
    boxWaitTimer = nil
    send()
    return true
  }

  /** Free-floating: the strip along the bottom of the visible frame, nothing to stand on but the floor. */
  private func placeFree() {
    let w = ensure()
    host = nil
    lastRaw = nil
    if !free { env.info("\(kind.rawValue): no window tracker: floating along the bottom of the screen") }
    free = true
    let b = AvatarGeometry.freeStrip(area: env.cursorWorkArea())
    if lifted != nil { lifted!.strip = b }
    if lifted == nil, w.frame != b { w.setFrame(b) }
    if !boxKnown || lastBox != nil || lastSend != nil {
      lastBox = nil
      lastSend = nil
      boxKnown = true // the page doesn't wait for a prompt box that will never come
    }
    if !w.isVisible {
      w.showInactive()
      shownAt = clock.now
      hover.start()
      layer = nil
    }
    setLayer(.top)
    send()
  }

  /** The visible frame of the display the strip is on. */
  private func areaFor(_ b: Rect) -> Rect { env.workArea(matching: b) }

  /** The lifted window's rect: the host window clipped to the visible frame (free-floating: the visible frame). */
  private func liftRect(_ strip: Rect) -> Rect? {
    let h = free ? nil : host
    return AvatarGeometry.liftRect(host: h, workArea: areaFor(h ?? strip)) ?? AvatarGeometry.liftRect(host: nil, workArea: areaFor(strip))
  }

  private func lift() -> Bool {
    guard let w = win, visible, !leaving else { return false }
    if lifted == nil {
      let strip = w.frame
      guard let area = liftRect(strip) else { return false }
      lifted = (strip, area)
      w.setFrame(area)
      env.info("\(kind.rawValue): picked up (the window covers \(free ? "the visible frame" : "the window it lives on") while it's held or flying)")
    }
    liftTimer?.cancel()
    liftTimer = clock.after(Self.liftMaxQuietMs) { [weak self] in
      guard let self else { return }
      self.env.warn("\(self.kind.rawValue): no word from the page while lifted: the strip comes back")
      self.drop()
    }
    send()
    return true
  }

  /** Back to the strip (where it is now), click-through again. */
  private func drop(quiet: Bool = false) {
    liftTimer?.cancel()
    liftTimer = nil
    guard let l = lifted else { return }
    lifted = nil
    guard let w = win else { return }
    // (His rect stays: the page sends it again within half a second in the strip's px.)
    hover.setHeld(false)
    w.setFrame(l.strip)
    layer = nil
    if quiet { return }
    if free { placeFree() } else if claude.found, !claude.min, enabled { setLayer(hostLayer) }
    send()
  }

  /** Re-place (or hide) the strip for the current host window. */
  private func place() {
    if leaving { return }
    if !enabled { return hide() }
    if floatsFree { return placeFree() }
    if !claude.found || claude.min { return hide() }
    let w = ensure()
    host = claude.rect
    let b = AvatarGeometry.stripBounds(host: claude.rect)
    if let l = lifted {
      // Held or flying: the window covers the host window (its live rect); the page learns where it
      // and the strip are now.
      guard let area = liftRect(b) else { return }
      let moved = area != l.area
      if moved || b != l.strip {
        lifted!.strip = b
        if moved {
          lifted!.area = area
          w.setFrame(area)
        }
        setLayer(hostLayer)
        if !applyRaw() { send() }
      }
      return
    }
    if w.frame != b {
      w.setFrame(b)
      if !applyRaw() { send() } // the box where the helper last saw it, for the new strip
    }
    if !w.isVisible {
      w.showInactive()
      shownAt = clock.now
      hover.start()
      layer = nil
      send()
    }
    setLayer(hostLayer)
    if !hover.isRunning { hover.start() }
    if boxless || !boxKnown {
      if boxless {
        if !boxKnown {
          boxKnown = true // nothing to wait for: he has the window's bottom edge
          send()
        }
        return
      }
      // The tracker reports the box as soon as it's asked to watch it; if nothing comes, stop waiting.
      if boxWaitTimer == nil {
        boxWaitTimer = clock.after(Self.boxWaitMs) { [weak self] in
          guard let self else { return }
          self.boxWaitTimer = nil
          if !self.boxKnown, self.visible {
            self.boxKnown = true
            self.send()
          }
        }
      }
    }
  }

  // MARK: - AvatarHandle

  /** Turn it on or off, at a size (1–3). `entrance`: switched on live, so the page plays an entrance. */
  public func setEnabled(_ on: Bool, size: Double = 2, entrance: Bool = false) {
    enabled = on
    scale = max(1, min(3, size.isFinite && size != 0 ? size : 2))
    if !enabled {
      hide()
      destroyWindow()
      return
    }
    if entrance, win == nil { pendingEntrance = true }
    send()
    place()
  }

  /** Hand over: the page fades out, then the window closes. `done` runs when it's gone. */
  public func leave(_ done: @escaping @MainActor () -> Void) {
    if leaving {
      clock.after(0) { done() }
      return
    }
    drop(quiet: true)
    leaving = true
    enabled = false
    boxWaitTimer?.cancel()
    sendEvent("leave")
    let ms = visible ? Self.leaveMs : 0
    clock.after(ms) { [weak self] in
      self?.destroyWindow()
      done()
    }
  }

  /** The window it lives on changed (from the tracker, or the host for a guest). */
  public func onClaude(_ state: ClaudeState) {
    claude = state
    place()
  }

  /** The display layout changed (a display added or removed, the Dock moved): re-place. */
  public func screensChanged() {
    if enabled, !leaving { place() }
  }

  /** Where the window helper sees the prompt box now. */
  public func onBoxRect(_ b: BoxReport) {
    if boxless || leaving || !enabled || !claude.found || b.hwnd != claude.hwnd { return }
    lastRaw = b
    guard b.win != nil else { return }
    applyRaw()
  }

  /** It's on screen and wants the box watched: the Claude window it's on, or 0. */
  public var boxWindow: Int {
    !boxless && !leaving && enabled && visible && !free && claude.found && !claude.min ? claude.hwnd : 0
  }

  /** Orbit's voice state (as the orb gets it, plus a few things only the avatars use). */
  public func onVoice(_ state: JSONValue) {
    guard case .object(let s) = state else { return }
    voice = [
      "phase": s["phase"] ?? .string("off"),
      "asleep": .bool(s["asleep"]?.boolValue ?? false),
      "hearing": .bool(s["hearing"]?.boolValue ?? false),
      "input": .number(s["input"]?.doubleValue ?? 0),
      "output": .number(s["output"]?.doubleValue ?? 0),
      "claudeWorking": .bool(s["claudeWorking"]?.boolValue ?? false),
      "muted": .bool(s["muted"]?.boolValue ?? false), // the mic is muted (the call stays up)
      "draft": .bool(s["draft"]?.boolValue ?? false), // a drafted prompt is in Claude's box, waiting for a yes
      "sending": .bool(s["sending"]?.boolValue ?? false), // the prompt is being sent
    ]
    send()
  }

  /** Something happened that it reacts to: finished | draft | sent (| error for Qubit). */
  public func event(_ name: String) {
    guard kind.events.contains(name) else { return }
    sendEvent(name)
  }

  /** A feeling as the voice's words play (an emote cue). Qubit only. */
  @discardableResult
  public func emote(_ name: String) -> Bool {
    guard kind.emotes, let cue = emoteCue(name), !leaving, enabled, visible else { return false }
    win?.send("buddy:emote", .string(cue))
    return true
  }

  /** Something the user asked the avatar to do ({ action, dir }), by voice. Only while it's on screen. */
  @discardableResult
  public func command(_ cmd: JSONValue) -> JSONValue {
    guard let action = cmd["action"]?.stringValue, kind.does(action) else { return ["ok": false, "error": "not something this avatar does"] }
    if leaving || !enabled || !visible {
      return ["ok": false, "error": .string(free ? "The avatar isn't on screen right now." : "The avatar isn't on screen right now (the Claude window is minimized or closed).")]
    }
    var c: [String: JSONValue] = ["action": .string(action)]
    if let d = cmd["dir"]?.stringValue, d == "left" || d == "right" { c["dir"] = .string(d) }
    win?.send("buddy:command", .object(c))
    return ["ok": true]
  }

  /** Picked up (true: the window covers the host while it's held or flying) or put back (false). */
  @discardableResult
  public func lift(_ on: Bool) -> Bool {
    if on { return lift() }
    drop()
    return true
  }

  public var isLifted: Bool { lifted != nil }

  public var hostHwnd: Int { !free && claude.found ? claude.hwnd : 0 }

  /** The settings it reads changed (click to talk, throwing): tell the page. */
  public func refresh() { send() }

  /** The page: the cursor is over the avatar, and whether it's held (a press or drag under way). */
  public func pageHover(_ on: Bool, held: Bool = false) { hover.setPageHover(on, held: held) }

  /** The page: where the avatar is drawn (window px), so the window takes the mouse over it. */
  public func pageHit(_ rect: Rect?) { hover.setHit(rect) }

  static let pressOutcomes: Set<String> = ["click", "pickup", "ignored"]
  static let pressWhy: Set<String> = ["talk", "poke", "throw-off", "too-long-for-a-click", "drag", "hold", "leaving", "press-already", "not-on-him"]

  /** The page: what a press on it came to (logged, rate-limited, fixed words only). */
  public func pressed(_ outcome: String, why: String) {
    guard Self.pressOutcomes.contains(outcome) else { return }
    let reason = Self.pressWhy.contains(why) ? why : ""
    pressLog("press-\(outcome)-\(reason)", "\(kind.rawValue): a press on it: \(outcome)\(reason.isEmpty ? "" : " (\(reason))")")
  }

  /** The page had an error (its message only, never anything anyone said). */
  public func pageError(_ message: String) {
    pageErrLog("err", "\(kind.rawValue): its page had an error: \(String(message.prefix(160)))")
  }

  /** Its page is loading again, or its process went: nothing to hit until the page says where he is. */
  public func pageReset(stopped: String?) {
    if let stopped { env.info("\(kind.rawValue): its page stopped (\(String(stopped.prefix(40))))") }
    hover.reset()
  }

  public var takingMouse: Bool { hover.isTaking }
  public var isEnabled: Bool { enabled }
  public var isFree: Bool { free }
  public var window: AvatarWindowPort? { win }

  public func stop() {
    boxWaitTimer?.cancel()
    liftTimer?.cancel()
    hover.stop()
  }

  /** Close the window now (Orbit quits). */
  public func close() {
    stop()
    destroyWindow()
  }

  // MARK: - what the parity driver reports

  public struct Snapshot: Equatable, Sendable {
    public var visible: Bool
    public var frame: Rect?
    public var host: Rect?
    public var hostHwnd: Int
    public var figure: Rect?
    public var standingOn: String?
    public var lifted: Bool
    public var asleep: Bool
    public var takesMouse: Bool
    public var leaving: Bool
    public var box: Rect?
    public var send: Rect?
  }

  public var snapshot: Snapshot {
    let f = win?.frame
    let hit = hover.lastHit
    let figure = (f != nil && hit != nil && visible) ? Rect(x: f!.x + hit!.x, y: f!.y + hit!.y, w: hit!.w, h: hit!.h) : nil
    let stripH = stripBounds.h
    // Lifted, the page reports his rect in the lifted window's px: no surface to compare with.
    let on = visible ? AvatarGeometry.standingOn(kind: kind.rawValue, hit: hit, stripHeight: stripH, box: lastBox, size: scale, lifted: lifted != nil) : nil
    let asleep = voice["phase"]?.stringValue == "off" || voice["asleep"]?.boolValue == true
    return Snapshot(visible: visible, frame: f, host: free ? nil : host, hostHwnd: hostHwnd, figure: figure, standingOn: on, lifted: lifted != nil,
                    asleep: asleep, takesMouse: hover.isTaking, leaving: leaving, box: lastBox, send: lastSend)
  }
}
