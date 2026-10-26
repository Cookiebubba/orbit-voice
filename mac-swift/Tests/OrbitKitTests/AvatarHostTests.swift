// One avatar per place, at every moment (test/avatar-places.test.js against AvatarHostModel): avatar
// kinds switched quickly, contexts dropped and made again as calls restart, and a window's Qubit on
// the window home's avatar is on. Sampled every millisecond: never two avatars showing in one window,
// counting one still fading out.
import XCTest
@testable import OrbitKit

@MainActor
final class AvatarHostTests: XCTestCase {
  static let fadeMs: Double = 30

  @MainActor final class FakeAvatar: AvatarHandle {
    let kind: AvatarKind
    let home: Bool
    let clock: OverlayTestClock
    var enabled = false
    var claude: ClaudeState?
    var fading = false
    var gone = false
    var voices: [JSONValue] = []
    init(kind: AvatarKind, home: Bool, clock: OverlayTestClock) { (self.kind, self.home, self.clock) = (kind, home, clock) }
    var showing: Bool { !gone && (fading || (enabled && (claude?.found ?? false) && !(claude?.min ?? false))) }
    func onClaude(_ s: ClaudeState) { claude = s }
    func onVoice(_ v: JSONValue) { voices.append(v) }
    func setEnabled(_ on: Bool, size: Double, entrance: Bool) { enabled = on }
    // Like AvatarModel.leave(): a showing one fades out for a while; one never shown just goes.
    func leave(_ done: @escaping @MainActor () -> Void) {
      let was = showing
      enabled = false
      if !was {
        gone = true
        clock.after(0, done)
        return
      }
      fading = true
      clock.after(AvatarHostTests.fadeMs) { [self] in
        gone = true
        fading = false
        done()
      }
    }
    func refresh() {}
    func stop() {}
    var hostHwnd: Int { claude?.found == true ? claude!.hwnd : 0 }
  }

  @MainActor final class World {
    let clock = OverlayTestClock()
    var all: [FakeAvatar] = []
    var worst = 0
    func mk(_ kind: AvatarKind, home: Bool = false) -> FakeAvatar {
      let a = FakeAvatar(kind: kind, home: home, clock: clock)
      all.append(a)
      return a
    }
    func perPlace() -> [Int: Int] {
      var m: [Int: Int] = [:]
      for a in all where a.showing { m[a.claude!.hwnd, default: 0] += 1 }
      return m
    }
    func sample() { worst = max(worst, perPlace().values.max() ?? 0) }
    func sleep(_ ms: Double) { clock.advance(ms, step: 1) { [unowned self] in self.sample() } }
  }

  func wins(_ ids: [Int]) -> [GuestBounds] { ids.enumerated().map { GuestBounds(hwnd: $0.element, rect: Rect(x: Double($0.offset) * 900, y: 0, w: 800, h: 600)) } }

  /** A window Qubit joins is watched (its place comes back as wins); he shows there only once it does. */
  func testAJoinedWindowIsWatchedAndHeShowsOnceItsPlaceIsKnown() {
    let w = World()
    let home = w.mk(.qubit, home: true)
    var watched: [[Int]] = []
    let host = AvatarHostModel(makeAvatar: { k, _ in w.mk(k) }, home: { home }, watch: { watched.append($0) }, now: { w.clock.now })
    host.setKind(.qubit, size: 2)
    host.sync(ContextsSnapshot(activeId: "w20", contexts: [GuestContext(id: "home", hwnd: 0, home: true), GuestContext(id: "w20", hwnd: 20, lastActiveAt: 1)]))
    XCTAssertEqual(watched.last, [20], "System Settings' window is watched")
    let guest = w.all.first { !$0.home }!
    XCTAssertFalse(guest.showing, "not before its place is known")
    host.onWins(wins([20]))
    XCTAssertTrue(guest.showing, "on it once the helper says where it is")
    host.sync(ContextsSnapshot(activeId: "home", contexts: [GuestContext(id: "home", hwnd: 0, home: true)]))
    XCTAssertEqual(watched.last, [], "left: no longer watched")
  }

  func testKindsSwitchedQuicklyNeverShowTwoInOneWindow() {
    let w = World()
    let home = w.mk(.qubit, home: true)
    home.setEnabled(true, size: 2, entrance: false)
    home.onClaude(ClaudeState(found: true, hwnd: 1))
    let host = AvatarHostModel(makeAvatar: { k, _ in w.mk(k) }, home: { home }, now: { w.clock.now })
    host.setKind(.qubit, size: 2)
    host.sync(ContextsSnapshot(activeId: "home", contexts: [GuestContext(id: "home", hwnd: 0, home: true), GuestContext(id: "w10", hwnd: 10, lastActiveAt: 1), GuestContext(id: "w11", hwnd: 11, lastActiveAt: 2)]))
    host.onWins(wins([10, 11]))
    w.sample()
    w.sleep(5)
    for i in 0..<6 {
      host.setKind(i % 2 == 1 ? .qubit : .buddy, size: 2)
      w.sample()
      w.sleep(i % 3 == 0 ? 1 : 12) // faster than a fade, and slower
      host.onWins(wins([10, 11]))
      w.sample()
    }
    w.sleep(Self.fadeMs * 3)
    XCTAssertEqual(w.worst, 1, "at most one avatar showing per window at every sample")
    XCTAssertEqual(w.perPlace()[10], 1, "and each window has its one at the end")
    XCTAssertEqual(w.perPlace()[11], 1)
  }

  func testContextsMadeAgainAsCallsRestartNeverDoubleUp() {
    let w = World()
    let home = w.mk(.qubit, home: true)
    home.setEnabled(true, size: 2, entrance: false)
    home.onClaude(ClaudeState(found: true, hwnd: 1))
    let host = AvatarHostModel(makeAvatar: { k, _ in w.mk(k) }, home: { home }, now: { w.clock.now })
    host.setKind(.qubit, size: 2)
    let homeCtx = GuestContext(id: "home", hwnd: 0, home: true)
    for i in 0..<8 {
      // A call starts in Notepad (its Qubit pops in), ends; "go away" drops it; the next call makes it again at once.
      host.sync(ContextsSnapshot(activeId: "w10", contexts: [homeCtx, GuestContext(id: "w10", hwnd: 10, lastActiveAt: w.clock.now)]))
      host.onWins(wins([10]))
      w.sample()
      w.sleep(i % 2 == 1 ? 2 : 9)
      host.sync(ContextsSnapshot(activeId: "home", contexts: [homeCtx]))
      w.sample()
      w.sleep(1)
    }
    host.sync(ContextsSnapshot(activeId: "w10", contexts: [homeCtx, GuestContext(id: "w10", hwnd: 10, lastActiveAt: w.clock.now)]))
    host.onWins(wins([10]))
    w.sleep(Self.fadeMs * 3)
    XCTAssertEqual(w.worst, 1, "never two showing in that window (or on Claude)")
    XCTAssertEqual(w.perPlace()[10], 1)
  }

  func testAWindowsQubitNeverShowsOnTheWindowHomeIsOn() {
    let w = World()
    let home = w.mk(.qubit, home: true)
    home.setEnabled(true, size: 2, entrance: false)
    home.onClaude(ClaudeState(found: true, hwnd: 1))
    let host = AvatarHostModel(makeAvatar: { k, _ in w.mk(k) }, home: { home }, now: { w.clock.now })
    host.setKind(.qubit, size: 2)
    host.sync(ContextsSnapshot(activeId: "w7", contexts: [GuestContext(id: "home", hwnd: 0, home: true), GuestContext(id: "w7", hwnd: 7, lastActiveAt: 1)]))
    host.onWins([GuestBounds(hwnd: 7, rect: Rect(x: 0, y: 0, w: 800, h: 600))])
    w.sleep(1)
    XCTAssertEqual(w.perPlace()[7], 1, "its own window: shown")
    home.onClaude(ClaudeState(found: true, hwnd: 7))
    host.onFocus()
    XCTAssertEqual(w.perPlace()[7], 1, "only one there: the guest steps aside")
    XCTAssertEqual(w.all.first { !$0.home && !$0.gone }?.claude?.found, false)
    home.onClaude(ClaudeState(found: true, hwnd: 1))
    host.onFocus()
    XCTAssertEqual(w.perPlace()[7], 1, "home gone back: the guest shows again")
    w.sample()
    XCTAssertEqual(w.worst, 1)
  }

  func testOnlyTheActiveWindowsAvatarIsAliveAndAtMostFourShow() {
    let w = World()
    let home = w.mk(.qubit, home: true)
    let host = AvatarHostModel(makeAvatar: { k, _ in w.mk(k) }, home: { home }, now: { w.clock.now })
    host.setKind(.qubit, size: 2)
    let ctxs = (1...6).map { GuestContext(id: "w\($0)", hwnd: $0 * 10, lastActiveAt: Double($0)) }
    host.sync(ContextsSnapshot(activeId: "w6", contexts: [GuestContext(id: "home", hwnd: 0, home: true)] + ctxs))
    host.onWins(wins(ctxs.map(\.hwnd)))
    let shown = host.guestList.filter(\.shown).map(\.id)
    XCTAssertEqual(Set(shown), ["w3", "w4", "w5", "w6"], "the four most recently active")
    XCTAssertEqual(w.perPlace().count, 4)
    let speaking: JSONValue = ["phase": "speaking"]
    host.onVoice(speaking)
    let active = host.active() as! FakeAvatar
    XCTAssertEqual(active.voices.last, speaking)
    XCTAssertEqual((host.guestList.first { $0.id == "w5" }!.avatar as! FakeAvatar).voices.last, AvatarHostModel.rest, "the others rest")
    XCTAssertEqual(home.voices.last, AvatarHostModel.rest, "home rests while the talk is elsewhere")
    XCTAssertEqual(host.activeId, "w6")
  }

  func testTheWindowInFrontSetsEachGuestsZOrder() {
    let w = World()
    var front: FrontWindow? = FrontWindow(hwnd: 10, kind: "app")
    let host = AvatarHostModel(makeAvatar: { k, _ in w.mk(k) }, home: { nil }, current: { front }, now: { w.clock.now })
    host.setKind(.qubit, size: 2)
    host.sync(ContextsSnapshot(activeId: "w10", contexts: [GuestContext(id: "w10", hwnd: 10, lastActiveAt: 1)]))
    host.onWins(wins([10]))
    let g = host.guestList[0].avatar as! FakeAvatar
    XCTAssertEqual(g.claude?.front, "claude", "its own window in front: on top")
    front = FrontWindow(hwnd: 99, kind: "orbit")
    host.onFocus()
    XCTAssertEqual(g.claude?.front, "orbit")
    front = FrontWindow(hwnd: 99, kind: "app")
    host.onFocus()
    XCTAssertEqual(g.claude?.front, "other", "another app in front: just above its window")
    host.onWins([GuestBounds(hwnd: 10, cloaked: true, rect: Rect(x: 0, y: 0, w: 800, h: 600))])
    XCTAssertEqual(g.claude?.found, false, "on another Space: hidden")
  }

  func testParsesTheSidecarsSnapshotAndWins() {
    let snap = ContextsSnapshot(json: ["active": ["id": "w1"], "contexts": [["id": "home", "home": true], ["id": "w1", "hwnd": 42, "lastActiveAt": 5], ["hwnd": 3]]])
    XCTAssertEqual(snap, ContextsSnapshot(activeId: "w1", contexts: [GuestContext(id: "home", hwnd: 0, home: true), GuestContext(id: "w1", hwnd: 42, lastActiveAt: 5)]))
    XCTAssertEqual(GuestBounds(json: ["hwnd": 42, "min": true, "x": 1, "y": 2, "w": 3, "h": 4]), GuestBounds(hwnd: 42, min: true, rect: Rect(x: 1, y: 2, w: 3, h: 4)))
    XCTAssertNil(GuestBounds(json: ["hwnd": 42, "x": "a", "y": 2, "w": 3, "h": 4]))
  }
}
