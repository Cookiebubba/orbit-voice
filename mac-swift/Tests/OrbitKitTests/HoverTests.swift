// Whether an avatar's window takes the mouse, from the real cursor and the avatar's rect: the cases of
// test/avatar-hover.test.js against the Swift port. Regression (main 0edbf9b, 346a5bc): a rect not
// heard for 3 s was dropped, so a press on him went to the app below whenever the page's timers were
// slowed; and the mouse mode could flap at his edge.
import XCTest
@testable import OrbitKit

@MainActor
final class HoverTests: XCTestCase {
  @MainActor final class Rig {
    let clock = OverlayTestClock()
    var calls: [Bool] = []
    var changes: [(at: Double, ignore: Bool)] = []
    var cursors: [ScreenPoint?] = []
    var modes: [Bool] = []
    var quiet: [Double] = []
    var cursor = ScreenPoint(x: 0, y: 0)
    var live = true
    var bounds = Rect(x: -4200, y: 680, w: 1200, h: 240)
    lazy var p = HoverPoller(clock: clock, getCursor: { [unowned self] in self.cursor }, getBounds: { [unowned self] in self.bounds },
                             setIgnore: { [unowned self] in
                               self.calls.append($0)
                               self.changes.append((self.clock.now, $0))
                             },
                             isLive: { [unowned self] in self.live },
                             onCursor: { [unowned self] in self.cursors.append($0) }, onMode: { [unowned self] in self.modes.append($0) },
                             onQuiet: { [unowned self] in self.quiet.append($0) })
    /** The cursor moves there, and the poll runs for `ms` (default: long enough to let go). */
    func move(_ x: Double, _ y: Double, ms: Double = HoverPoller.leaveMs + 40) {
      cursor = ScreenPoint(x: x, y: y)
      p.tick()
      clock.advance(ms)
    }
    /** As the JS tests do: time moves on, then one poll. */
    func wait(_ ms: Double) {
      clock.jump(ms)
      p.tick()
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
    XCTAssertEqual(r.calls.last, false, "just let go: a moment more (no flapping)")
    r.wait(HoverPoller.leaveMs + 10)
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

  func testTheLastRectStandsHoweverLongThePageIsQuiet() {
    let r = Rig()
    r.cursor = ScreenPoint(x: -4200 + 100, y: 680 + 10) // off him
    r.p.start()
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    XCTAssertEqual(r.calls.last, true)
    // Ten minutes without a word from the page (a throttled page: a beat a minute, or none).
    for _ in 0..<(600 * 30) { r.wait(33) }
    XCTAssertTrue(r.p.state.hit, "the rect is kept")
    XCTAssertEqual(r.quiet.count, 1, "the quiet spell is logged once")
    XCTAssertGreaterThan(r.quiet.first ?? 0, HoverPoller.quietLogMs)
    r.cursor = ScreenPoint(x: -4200 + 920, y: 680 + 120) // onto him
    r.p.tick()
    XCTAssertEqual(r.calls.last, false, "a press on him still reaches his page")
    XCTAssertEqual(r.modes, [false, true], "no flapping meanwhile")
    // The page speaks again: a new quiet spell can be logged later.
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    XCTAssertFalse(r.p.state.quiet)
    // Only the page or the window going ends it.
    r.p.setHit(nil)
    XCTAssertEqual(r.calls.last, true, "no rect: clicks go through at once")
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    XCTAssertEqual(r.calls.last, false)
    r.p.reset()
    XCTAssertFalse(r.p.state.hit, "a reset forgets him")
    XCTAssertEqual(r.calls.last, true)
    // A press the page stopped mentioning (its pointerup lost) doesn't hold the mouse for ever.
    r.p.setHit(Rect(x: 900, y: 100, w: 44, h: 44))
    r.cursor = ScreenPoint(x: -4200 + 100, y: 680 + 10)
    r.p.setHeld(true)
    XCTAssertEqual(r.calls.last, false)
    for _ in 0..<(20 * 30) { r.wait(33) }
    XCTAssertEqual(r.calls.last, true, "a press not mentioned for a long while lets go")
    // The page's own hover guess never holds the window.
    r.p.setPageHover(true, held: false)
    XCTAssertEqual(r.calls.last, true)
  }

  func testTheModeNeverFlapsFasterThanLeaveMs() {
    let r = Rig()
    r.bounds = Rect(x: 0, y: 0, w: 1200, h: 240)
    r.p.start()
    // Tiny Qubit (a 36 px box) walking under a hand trying to catch him: the cursor wobbles across his
    // edge every 40 ms, and he moves a px a frame.
    var x = 500.0
    for i in 0..<300 {
      r.clock.jump(16)
      x += 1
      if i % 2 == 0 { r.p.setHit(Rect(x: x, y: 100, w: 36, h: 36)) }
      r.cursor = ScreenPoint(x: x + 36 + (Int((Double(i) / 2.5).rounded(.down)) % 2 == 1 ? 4 : -3), y: 118)
      r.p.tick()
    }
    let flips = Array(r.changes.dropFirst())
    var fast = 0
    for i in flips.indices.dropFirst() where flips[i].ignore != flips[i - 1].ignore && flips[i].at - flips[i - 1].at < HoverPoller.leaveMs { fast += 1 }
    XCTAssertEqual(fast, 0, "no change within \(HoverPoller.leaveMs) ms of the last (\(flips.count) changes)")
    XCTAssertLessThanOrEqual(flips.count, 3, "it held on at his edge")
    // Right onto him: takes the mouse at once; leaves only after leaveMs off.
    r.cursor = ScreenPoint(x: 2000, y: 2000)
    for _ in 0..<10 { r.wait(33) }
    XCTAssertEqual(r.changes.last?.ignore, true)
    r.p.setHit(Rect(x: 600, y: 100, w: 36, h: 36))
    r.cursor = ScreenPoint(x: 618, y: 118)
    r.p.tick()
    XCTAssertEqual(r.changes.last?.ignore, false, "onto him: at once")
    let at = r.clock.now
    r.cursor = ScreenPoint(x: 700, y: 118)
    r.p.tick()
    r.wait(HoverPoller.leaveMs - 40)
    XCTAssertEqual(r.changes.last?.ignore, false, "just off him: still takes the mouse for a moment")
    r.wait(60)
    XCTAssertEqual(r.changes.last?.ignore, true, "off him for leaveMs: clicks go through")
    XCTAssertGreaterThanOrEqual((r.changes.last?.at ?? 0) - at, HoverPoller.leaveMs)
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
