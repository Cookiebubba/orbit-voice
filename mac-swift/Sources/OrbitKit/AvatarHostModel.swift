// A Qubit in every window Orbit is in ("Orbit anywhere"; electron/avatar-host.js). The home avatar
// (on the Claude window) is the facade's; this hosts the others: one avatar strip per context window
// (src/anywhere/contexts.js, from the sidecar's `contexts` messages), placed with the same geometry
// along that window's bottom edge, z-ordered just above it (so other apps still cover him), hidden
// while it's minimized or on another Space. Those windows have no prompt box, so he stands on the
// window's bottom edge.
//
// Only the active context's avatar is fully alive (listening, talking, emotes, tricks); the others
// rest (Orbit's voice state reads "off" to them) until the conversation comes back to their window.
// A new context's avatar pops in with an entrance; a closed or dismissed one fades out. At most 4
// guests show at once (the most recently active).
//
// One avatar per place, at every moment: a window's Qubit never shows on the window home's avatar is
// on, and a window's new Qubit comes up only once one fading out of that window has gone.
import Foundation

/** A context window's place, from the sidecar's `wins` messages (points, top-left origin). */
public struct GuestBounds: Equatable, Sendable {
  public var hwnd: Int
  public var min: Bool
  public var cloaked: Bool
  public var rect: Rect
  public init(hwnd: Int, min: Bool = false, cloaked: Bool = false, rect: Rect) { (self.hwnd, self.min, self.cloaked, self.rect) = (hwnd, min, cloaked, rect) }
  public init?(json: JSONValue) {
    guard let h = json["hwnd"]?.intValue, let r = Rect(json: json) else { return nil }
    self.init(hwnd: h, min: json["min"]?.boolValue ?? false, cloaked: json["cloaked"]?.boolValue ?? false, rect: r)
  }
}

/** One Orbit-anywhere context (the sidecar's `contexts` snapshot entries). */
public struct GuestContext: Equatable, Sendable {
  public var id: String
  public var hwnd: Int
  public var home: Bool
  public var lastActiveAt: Double?
  public init(id: String, hwnd: Int, home: Bool = false, lastActiveAt: Double? = nil) { (self.id, self.hwnd, self.home, self.lastActiveAt) = (id, hwnd, home, lastActiveAt) }
}

/** The contexts snapshot: which one is active, and all of them. */
public struct ContextsSnapshot: Equatable, Sendable {
  public var activeId: String?
  public var contexts: [GuestContext]
  public init(activeId: String?, contexts: [GuestContext]) { (self.activeId, self.contexts) = (activeId, contexts) }
  public init?(json: JSONValue?) {
    guard let j = json, case .object = j else { return nil }
    activeId = j["active"]?["id"]?.stringValue
    contexts = (j["contexts"]?.arrayValue ?? []).compactMap { c in
      guard let id = c["id"]?.stringValue else { return nil }
      let la = c["lastActiveAt"]?.doubleValue
      return GuestContext(id: id, hwnd: c["hwnd"]?.intValue ?? 0, home: c["home"]?.boolValue ?? false, lastActiveAt: (la?.isFinite ?? false) ? la : nil)
    }
  }
}

/** The window in front, as far as guests care: its id and kind ("orbit" for Orbit's own windows). */
public struct FrontWindow: Equatable, Sendable {
  public var hwnd: Int
  public var kind: String
  public init(hwnd: Int, kind: String) { (self.hwnd, self.kind) = (hwnd, kind) }
}

@MainActor
public final class AvatarHostModel {
  public static let maxGuests = 4
  public static let rest: JSONValue = ["phase": "off", "asleep": true]

  /** Waits for every avatar still fading out of one window (Promise.all in the Electron build). */
  @MainActor private final class Fade {
    private var pending = 0
    private var waiters: [@MainActor () -> Void] = []
    var done: Bool { pending == 0 }
    func add() { pending += 1 }
    func finish() {
      pending -= 1
      if pending == 0 {
        let w = waiters
        waiters = []
        for f in w { f() }
      }
    }
    func then(_ f: @escaping @MainActor () -> Void) { if done { f() } else { waiters.append(f) } }
  }

  @MainActor private final class Guest {
    let id: String
    let hwnd: Int
    let avatar: AvatarHandle
    var bounds: GuestBounds?
    var lastActiveAt: Double
    init(id: String, hwnd: Int, avatar: AvatarHandle, lastActiveAt: Double) { (self.id, self.hwnd, self.avatar, self.lastActiveAt) = (id, hwnd, avatar, lastActiveAt) }
  }

  private let makeAvatar: (AvatarKind, String) -> AvatarHandle
  private let home: () -> AvatarHandle?
  private let watch: ([Int]) -> Void
  private let current: () -> FrontWindow?
  private let log: (String) -> Void
  private let now: () -> Double
  private var guests: [String: Guest] = [:]
  private var order: [String] = [] // insertion order, so iteration is stable
  private var kind: AvatarKind?
  private var size: Double = 2
  public private(set) var activeId = "home"
  private var voice: JSONValue = AvatarHostModel.rest
  private var enabled = true
  private var lastSnap: ContextsSnapshot?
  private var leaving: [String: Fade] = [:] // context id -> its old avatars fading out

  public init(makeAvatar: @escaping (_ kind: AvatarKind, _ contextId: String) -> AvatarHandle, home: @escaping () -> AvatarHandle?, watch: @escaping ([Int]) -> Void = { _ in },
              current: @escaping () -> FrontWindow? = { nil }, log: @escaping (String) -> Void = { _ in }, now: @escaping () -> Double) {
    self.makeAvatar = makeAvatar
    self.home = home
    self.watch = watch
    self.current = current
    self.log = log
    self.now = now
  }

  private var all: [Guest] { order.compactMap { guests[$0] } }

  private func frontFor(_ hwnd: Int) -> String {
    let c = current()
    if c?.hwnd == hwnd { return "claude" } // (its own window in front: "on top", like Claude in front)
    if c?.kind == "orbit" { return "orbit" }
    return "other"
  }

  private var homeHwnd: Int { home()?.hostHwnd ?? 0 }

  private func place(_ g: Guest) {
    guard let b = g.bounds, !(g.hwnd != 0 && g.hwnd == homeHwnd) else { return g.avatar.onClaude(.none) }
    g.avatar.onClaude(ClaudeState(found: !b.cloaked, hwnd: g.hwnd, min: b.min, front: frontFor(g.hwnd), rect: b.rect))
  }

  private func voiceFor(_ id: String) -> JSONValue { id == activeId ? voice : Self.rest }

  /** The guests that show (the most recently active, up to maxGuests). */
  private func shown() -> Set<String> {
    Set(all.sorted { $0.lastActiveAt > $1.lastActiveAt }.prefix(Self.maxGuests).map(\.id))
  }

  private func add(_ ctx: GuestContext, entrance: Bool) {
    guard let kind, enabled else { return }
    let avatar = makeAvatar(kind, ctx.id)
    let g = Guest(id: ctx.id, hwnd: ctx.hwnd, avatar: avatar, lastActiveAt: ctx.lastActiveAt ?? now())
    guests[ctx.id] = g
    order.removeAll { $0 == ctx.id }
    order.append(ctx.id)
    avatar.onVoice(voiceFor(ctx.id))
    let up: @MainActor () -> Void = { [weak self] in
      guard let self, self.guests[ctx.id] === g else { return }
      avatar.setEnabled(true, size: self.size, entrance: entrance)
      self.place(g)
    }
    if let fading = leaving[ctx.id], !fading.done { fading.then(up) } else { up() }
    log("avatar: \(kind.rawValue) joined a window (\(guests.count) beside home)")
  }

  private func remove(_ id: String) {
    guard let g = guests[id] else { return }
    guests[id] = nil
    order.removeAll { $0 == id }
    // (Wait for every avatar still fading out of that window, not just this one.)
    let fade = Fade()
    if let prev = leaving[id], !prev.done {
      fade.add()
      prev.then { fade.finish() }
    }
    fade.add()
    leaving[id] = fade
    fade.then { [weak self] in
      if self?.leaving[id] === fade { self?.leaving[id] = nil }
    }
    g.avatar.leave { fade.finish() }
  }

  private func rewatch() { watch(all.map(\.hwnd)) }

  /** The contexts changed: add, remove and wake avatars. */
  public func sync(_ snapshot: ContextsSnapshot) {
    lastSnap = snapshot
    activeId = snapshot.activeId ?? "home"
    let wanted = snapshot.contexts.filter { !$0.home }
    let wantedIds = Set(wanted.map(\.id))
    for id in order where !wantedIds.contains(id) { remove(id) }
    for c in wanted {
      if let g = guests[c.id], let la = c.lastActiveAt { g.lastActiveAt = la } else if guests[c.id] == nil { add(c, entrance: true) }
    }
    // Beyond the cap, the least recently active rest hidden (their windows keep their context).
    let visible = shown()
    for g in all {
      g.avatar.onVoice(voiceFor(g.id))
      if !visible.contains(g.id) { g.avatar.onClaude(.none) } else { place(g) }
    }
    home()?.onVoice(voiceFor("home"))
    rewatch()
  }

  /** The watched windows moved, resized, minimized or hid. */
  public func onWins(_ wins: [GuestBounds]) {
    let visible = shown()
    for w in wins {
      for g in all where g.hwnd == w.hwnd {
        g.bounds = w
        if visible.contains(g.id) { place(g) }
      }
    }
  }

  /** The window in front changed (or home moved): each guest's z-order follows. */
  public func onFocus() {
    let visible = shown()
    for g in all where visible.contains(g.id) && g.bounds != nil { place(g) }
  }

  /** Orbit's voice state: the active window's avatar gets it, the others rest. */
  public func onVoice(_ state: JSONValue) {
    if case .object = state { voice = state } else { voice = Self.rest }
    for g in all { g.avatar.onVoice(voiceFor(g.id)) }
    home()?.onVoice(voiceFor("home"))
  }

  /** The avatar kind or size changed (Settings): guests are made again as the new one. */
  public func setKind(_ next: AvatarKind?, size nextSize: Double? = nil) {
    let changed = next != kind
    kind = next
    if let s = nextSize { size = s }
    if !changed {
      for g in all { g.avatar.setEnabled(true, size: size, entrance: false) }
      return
    }
    let bounds = Dictionary(all.map { ($0.id, $0.bounds) }, uniquingKeysWith: { a, _ in a })
    for id in order { remove(id) }
    if let s = lastSnap { sync(s) }
    for g in all {
      g.bounds = bounds[g.id] ?? nil
      place(g)
    }
    rewatch()
  }

  /** The avatar the user is talking to now: the active window's, else home's. */
  public func active() -> AvatarHandle? { guests[activeId]?.avatar ?? home() }

  /** Is this one of the current guests (not one fading out)? Its id if so. */
  public func guestId(of avatar: AnyObject) -> String? { all.first { $0.avatar === avatar }?.id }

  /** The avatar settings changed (click to talk, throwing): every guest's page hears. */
  public func refresh() { for g in all { g.avatar.refresh() } }

  public func setEnabled(_ on: Bool) {
    let was = enabled
    enabled = on
    if !enabled { for id in order { remove(id) } } else if !was, let s = lastSnap { sync(s) }
    rewatch()
  }

  public func stop() { for g in all { g.avatar.stop() } }

  /** The current guests: id, window, whether it's among those shown, and the avatar. */
  public var guestList: [(id: String, hwnd: Int, shown: Bool, avatar: AvatarHandle)] {
    let s = shown()
    return all.map { ($0.id, $0.hwnd, s.contains($0.id), $0.avatar) }
  }
}
