// Orbit's mouse: its motion maths and the overlay planner with stand-in page windows, the cases of
// test/mouse.test.js ("motion" and "the overlay") against the Swift port.
import XCTest
@testable import OrbitKit

@MainActor
final class MouseTests: XCTestCase {
  func testEasedGlidesNeverJump() {
    XCTAssertEqual(MouseMath.ease(0), 0)
    XCTAssertEqual(MouseMath.ease(1), 1)
    var prev = -1.0
    for i in 0...20 {
      let v = MouseMath.ease(Double(i) / 20)
      XCTAssertGreaterThanOrEqual(v, prev, "never goes back")
      prev = v
    }
    XCTAssertTrue(MouseMath.ease(0.05) < 0.01 && MouseMath.ease(0.95) > 0.99, "soft start and finish")
    let m = MouseMath.Motion(from: ScreenPoint(x: 0, y: 0), to: ScreenPoint(x: 100, y: 50), t0: 1000, ms: 300)
    XCTAssertEqual(MouseMath.glideAt(m, 1000), ScreenPoint(x: 0, y: 0))
    XCTAssertEqual(MouseMath.glideAt(m, 1300), ScreenPoint(x: 100, y: 50))
    XCTAssertEqual(MouseMath.glideAt(m, 5000), ScreenPoint(x: 100, y: 50))
    XCTAssertNil(MouseMath.glideAt(nil, 0))
    XCTAssertTrue(MouseMath.glideMs(0) >= 200 && MouseMath.glideMs(5000) <= 700, "glides take a moment, never long")
    XCTAssertEqual(MouseMath.glideMs(0), 260)
    XCTAssertEqual(MouseMath.glideMs(100), 285)
    XCTAssertEqual(MouseMath.glideMs(.nan), 260)
  }

  func testBoxesAndOverlaps() {
    XCTAssertEqual(MouseMath.boxOf([ScreenPoint(x: 10, y: 20), ScreenPoint(x: 30, y: 5)], pad: 2), Rect(x: 8, y: 3, w: 24, h: 19))
    XCTAssertTrue(MouseMath.overlaps(Rect(x: 0, y: 0, w: 10, h: 10), Rect(x: 9, y: 9, w: 5, h: 5)))
    XCTAssertFalse(MouseMath.overlaps(Rect(x: 0, y: 0, w: 10, h: 10), Rect(x: 10, y: 0, w: 5, h: 5)))
    XCTAssertTrue(MouseMath.inside(Rect(x: 0, y: 0, w: 10, h: 10), ScreenPoint(x: 0, y: 9.9)))
    XCTAssertFalse(MouseMath.inside(Rect(x: 0, y: 0, w: 10, h: 10), ScreenPoint(x: 10, y: 0)))
  }

  @MainActor final class FakePage: MousePagePort {
    var bounds = Rect(x: 0, y: 0, w: 0, h: 0)
    var visible = false
    var destroyed = false
    var sent: [JSONValue] = []
    func setBounds(_ r: Rect) { bounds = r }
    func showInactive() { visible = true }
    func hide() { visible = false }
    func send(_ message: JSONValue) { sent.append(message) }
    func destroy() { destroyed = true }
  }

  // mouse.test.js "the overlay: per display, click-through, never focused; glides, presses, fades and hides"
  func testTheOverlayGlidesPressesFadesAndHides() {
    let clock = OverlayTestClock(now: 10_000)
    let displays = [
      MouseDisplay(id: 1, area: Rect(x: 0, y: 0, w: 1920, h: 1040), workArea: Rect(x: 0, y: 0, w: 1920, h: 1040)),
      MouseDisplay(id: 2, area: Rect(x: 1920, y: 0, w: 1920, h: 1020), workArea: Rect(x: 1920, y: 0, w: 1280, h: 680)), // 150%
    ]
    var made: [FakePage] = []
    let m = OrbitMouseModel(clock: clock, displays: { displays }) { _, ready in
      let p = FakePage()
      made.append(p)
      clock.after(1, ready)
      return p
    }
    XCTAssertEqual(made.count, 0, "no windows until it is used")
    XCTAssertTrue(m.onScreen(ScreenPoint(x: 500, y: 500)))
    XCTAssertFalse(m.onScreen(ScreenPoint(x: 500, y: 1070)), "below the visible frame is not covered")
    XCTAssertEqual(m.glide(x: -50, y: 10).why, "off_screen")
    let g = m.glide(x: 740, y: 135, holdMs: 120)
    XCTAssertTrue(g.shown)
    XCTAssertEqual(made.count, 1, "only the display it is on")
    let w = made[0]
    XCTAssertTrue(w.visible)
    XCTAssertTrue(w.bounds.w < 700 && w.bounds.h < 600 && w.bounds.x >= 0 && w.bounds.y >= 0, "sized to the glide, not the whole display")
    let b0 = w.bounds
    clock.advance(5)
    var last: JSONValue { w.sent.last! }
    XCTAssertEqual(last["visible"], true)
    XCTAssertEqual(last["enter"], true, "a fresh appearance fades in near the target")
    XCTAssertEqual(last["motion"]?["to"], ["x": 740, "y": 135])
    XCTAssertTrue(last["motion"]!["from"]!["x"]!.doubleValue! < 740 && last["motion"]!["from"]!["y"]!.doubleValue! < 135, "and glides in from up and left")
    XCTAssertNil(last["ring"], "no ring: the arrow alone")
    // Mid-glide, a new target: it starts from where it is (no jump).
    clock.jump(g.ms! / 2)
    let g2 = m.glide(x: 1200, y: 600, ms: 220, holdMs: 100)
    let fromX = last["motion"]!["from"]!["x"]!.doubleValue!
    XCTAssertTrue(fromX > 690 && fromX < 740, "from where it was (\(fromX))")
    XCTAssertEqual(last["enter"], false)
    XCTAssertEqual(g2.ms, 220)
    XCTAssertTrue(w.bounds.x <= b0.x && w.bounds.y <= b0.y && w.bounds.maxX >= b0.maxX, "while showing, it only grows")
    // The voice state reaches it.
    m.onVoice(["phase": "speaking", "output": 0.7, "hearing": false, "extra": "x"])
    XCTAssertEqual(last["voice"], ["output": 0.7, "phase": "speaking", "asleep": false, "hearing": false, "muted": false, "draft": false, "sending": false, "claudeWorking": false])
    XCTAssertTrue(m.doPress())
    XCTAssertEqual(last["press"]?["at"]?.doubleValue, clock.now)
    // Across to the second display (scaled 150%): both show while it crosses.
    clock.jump(300)
    m.glide(x: 2400, y: 300, ms: 200, holdMs: 60)
    XCTAssertEqual(made.count, 2)
    let w2 = made[1]
    XCTAssertTrue(w2.visible)
    XCTAssertTrue(w.visible, "still crossing")
    clock.advance(10)
    XCTAssertEqual(w2.sent.last?["scale"], 1.5)
    XCTAssertEqual(w2.sent.last?["area"], ["x": 1920, "y": 0], "its display, in glide space")
    XCTAssertEqual(w2.sent.last?["wa"], ["x": 1920, "y": 0])
    XCTAssertTrue(w2.bounds.w < 1280 && w2.bounds.x >= 1920, "its window only as big as the glide needs, inside its display")
    clock.advance(230)
    XCTAssertFalse(w.visible, "the first display hides once it is across")
    clock.advance(460)
    XCTAssertEqual(w2.sent.last?["visible"], false)
    XCTAssertFalse(w2.visible)
    XCTAssertFalse(m.doPress(), "nothing to press while hidden")
    m.stop()
    XCTAssertTrue(made.allSatisfy(\.destroyed))
  }

  func testOffInSettingsMeansNoGlide() {
    var made = 0
    let m = OrbitMouseModel(clock: OverlayTestClock(), displays: { [MouseDisplay(id: 1, area: Rect(x: 0, y: 0, w: 100, h: 100), workArea: Rect(x: 0, y: 0, w: 100, h: 100))] }, enabled: { false }) { _, _ in
      made += 1
      return FakePage()
    }
    XCTAssertEqual(m.glide(x: 10, y: 10).why, "off")
    m.prewarm()
    XCTAssertEqual(made, 0)
  }

  func testPrewarmAndDisplaysChanging() {
    let clock = OverlayTestClock()
    var displays = [MouseDisplay(id: 1, area: Rect(x: 0, y: 0, w: 800, h: 600), workArea: Rect(x: 0, y: 0, w: 800, h: 600)),
                    MouseDisplay(id: 2, area: Rect(x: 800, y: 0, w: 800, h: 600), workArea: Rect(x: 800, y: 0, w: 800, h: 600))]
    var made: [FakePage] = []
    let m = OrbitMouseModel(clock: clock, displays: { displays }) { _, ready in
      let p = FakePage()
      made.append(p)
      clock.after(1, ready)
      return p
    }
    m.prewarm()
    XCTAssertEqual(made.count, 2)
    XCTAssertFalse(made.contains { $0.visible }, "made ahead of time, hidden")
    displays.removeLast()
    m.displaysChanged()
    XCTAssertTrue(made[1].destroyed, "a display that's gone takes its window with it")
    XCTAssertFalse(made[0].destroyed)
    XCTAssertEqual(m.windowCount, 1)
  }
}
