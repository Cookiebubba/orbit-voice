// Whether an avatar's window takes the mouse, from the real cursor and the avatar's rect: the cases of
// test/avatar-hover.test.js against the Swift port.
import XCTest
@testable import OrbitKit

@MainActor
final class HoverTests: XCTestCase {
  @MainActor final class Rig {
    let clock = ManualClock()
    var calls: [Bool] = []
    var cursors: [ScreenPoint?] = []
    var modes: [Bool] = []
    var cursor = ScreenPoint(x: 0, y: 0)
    var live = true
    let bounds = Rect(x: -4200, y: 680, w: 1200, h: 240)
    lazy var p = HoverPoller(clock: clock, getCursor: { [unowned self] in self.cursor }, getBounds: { [unowned self] in self.bounds },
                             setIgnore: { [unowned self] in self.calls.append($0) }, isLive: { [unowned self] in self.live },
                             onCursor: { [unowned self] in self.cursors.append($0) }, onMode: { [unowned self] in self.modes.append($0) })
    func move(_ x: Double, _ y: Double) {
      cursor = ScreenPoint(x: x, y: y)
      clock.advance(HoverPoller.pollMs)
    }
  }

  func testTakesTheMouseOnlyWhenTheRealCursorIsOnHim() {
    let r = Rig()
    r.p.start()
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    XCTAssertEqual(r.calls.last, true, "away from him: clicks go through")
    r.move(-4200 + 920, 680 + 120)
    XCTAssertEqual(r.calls.last, false, "on him: the window takes the mouse")
    XCTAssertTrue(r.p.isTaking)
    r.move(-4200 + 300, 680 + 120)
    XCTAssertEqual(r.calls.last, true, "off him again")
    r.p.setHit(Rect(x: 280, y: 100, w: 44, h: 44)) // he moves under a still cursor
    XCTAssertEqual(r.calls.last, false)
    r.p.setHit(nil)
    XCTAssertEqual(r.calls.last, true, "no rect: never takes the mouse")
  }

  func testAPressKeepsTheMouseWhereverTheCursorGoes() {
    let r = Rig()
    r.p.start()
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    r.move(-4200 + 920, 680 + 120)
    r.p.setPageHover(true, held: true)
    r.move(-4200 + 10, 680 + 5)
    XCTAssertEqual(r.calls.last, false, "held: still takes the mouse")
    r.p.setPageHover(false, held: false)
    XCTAssertEqual(r.calls.last, true, "let go away from him: clicks go through")
  }

  func testHiddenOrStoppedNeverTakesTheMouseAndThePageHearsTheCursorOnlyNearIt() {
    let r = Rig()
    r.p.start()
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    r.move(-4200 + 920, 680 + 120)
    XCTAssertEqual(r.calls.last, false)
    r.live = false
    r.move(-4200 + 921, 680 + 120)
    XCTAssertEqual(r.calls.last, true)
    r.live = true
    r.move(-4200 + 920, 680 + 120)
    r.p.stop()
    XCTAssertEqual(r.calls.last, true, "stopped: lets everything through")
    let near = r.cursors.compactMap { $0 }
    XCTAssertTrue(near.count >= 1)
    r.p.start()
    r.move(5000, 5000)
    XCTAssertFalse(r.cursors.isEmpty)
    XCTAssertNil(r.cursors.last!, "far away: the page is told the cursor is away")
  }

  func testOnlyChangesAreSent() {
    let r = Rig()
    r.p.start()
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    let n = r.calls.count
    for i in 0..<50 { r.move(-4200 + 100 + Double(i), 680 + 120) }
    XCTAssertEqual(r.calls.count, n, "cursor moving about away from him: nothing sent")
    r.p.reset()
    XCTAssertEqual(r.calls.count, n + 1, "after a reset the state is sent again")
  }

  func testAStaleRectIsForgottenAndTheHeartbeatPutsItRight() {
    let r = Rig()
    r.cursor = ScreenPoint(x: -4200 + 920, y: 680 + 120)
    r.p.start()
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    XCTAssertEqual(r.calls.last, false)
    r.clock.advance(HoverPoller.hitStaleMs + 34)
    XCTAssertEqual(r.calls.last, true, "an old rect is never trusted")
    XCTAssertFalse(r.p.state.hit)
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    XCTAssertEqual(r.calls.last, false, "the heartbeat restores it")
    for _ in 0..<200 {
      r.clock.advance(500)
      r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    }
    XCTAssertEqual(r.calls.last, false)
    XCTAssertEqual(r.modes, [false, true, false, true], "the first mode and each change reported once")
    r.cursor = ScreenPoint(x: -4200 + 100, y: 680 + 10)
    r.p.setHeld(true)
    XCTAssertEqual(r.calls.last, false)
    r.clock.jump(6000)
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    XCTAssertEqual(r.calls.last, true, "a stale press lets go")
    r.p.setPageHover(true, held: false)
    XCTAssertEqual(r.calls.last, true, "the page's own hover guess never holds the window")
  }

  func testLogLinesAreRateLimited() {
    var t = 0.0
    var lines: [String] = []
    let log = RateLimitedLog(everyMs: 10_000, now: { t }) { lines.append($0) }
    XCTAssertTrue(log("mode", "qubit: its window lets clicks through"))
    for _ in 0..<20 {
      t += 100
      log("mode", "qubit: its window takes the mouse")
    }
    log("poll", "qubit: hover polling started")
    t += 10_000
    log("mode", "qubit: its window lets clicks through")
    XCTAssertEqual(lines, ["qubit: its window lets clicks through", "qubit: hover polling started", "qubit: its window lets clicks through (and 20 more like it before)"])
  }
}
