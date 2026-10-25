// The avatar's strip, the prompt box and Send in strip coordinates, the free strip above the Dock,
// the lifted rect, and the orb's spot on the Claude window: the cases of test/buddy.test.js,
// test/avatar-box.test.js, test/throw.test.js and test/orb-stick.test.js, against the Swift port.
import XCTest
@testable import OrbitKit

final class GeometryTests: XCTestCase {
  typealias G = AvatarGeometry
  func R(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> Rect { Rect(x: x, y: y, w: w, h: h) }

  func testJsRoundMatchesMathRound() {
    XCTAssertEqual(jsRound(2.5), 3)
    XCTAssertEqual(jsRound(-2.5), -2)
    XCTAssertEqual(jsRound(-2.6), -3)
    XCTAssertEqual(jsRound(0.49), 0)
  }

  // buddy.test.js "the strip is the bottom of the Claude window, full width, and never taller than 60% of it"
  func testStripIsTheBottomOfTheHostFullWidthAtMost60Percent() {
    XCTAssertEqual(G.stripBounds(host: R(100, 50, 1200, 800)), R(100, 850 - G.buddyHeight, 1200, G.buddyHeight))
    let small = G.stripBounds(host: R(0, 0, 500, 200))
    XCTAssertEqual(small.h, 120)
    XCTAssertEqual(small.y, 80)
  }

  // buddy.test.js "the prompt box lands in the right place in the strip at any display scaling"
  func testBoxLandsInTheStripAtAnyScaling() {
    let rawWin = R(300, 150, 1500, 1000)
    let rawBox = R(300 + 450, 150 + 820, 600, 150)
    let host = R(200, 100, 1000, 666.67)
    let strip = G.stripBounds(host: host)
    let r = G.boxInStrip(rawBox, rawWin: rawWin, host: host, strip: strip)!
    XCTAssertEqual(r.x, 300 - G.boxPadX)
    XCTAssertEqual(r.w, 400 + 2 * G.boxPadX)
    XCTAssertEqual(r.y, jsRound(100 + 0.82 * 666.67 - strip.y - G.boxPadTop))
    XCTAssertEqual(r.h, 100 + G.boxPadTop)
    XCTAssertNil(G.boxInStrip(nil, rawWin: rawWin, host: host, strip: strip))
    XCTAssertNil(G.boxInStrip(R(5000, 0, 10, 10), rawWin: rawWin, host: host, strip: strip), "a box off the window is ignored")
    XCTAssertNil(G.boxInStrip(rawBox, rawWin: R(0, 0, 0, 0), host: host, strip: strip))
  }

  // avatar-box.test.js "box geometry: a grown box, at any scaling, and the Send button moving with it"
  func testGrownBoxAndSendMovingWithIt() {
    let host = R(100, 50, 1000, 600)
    let strip = R(100, 410, 1000, 240)
    let win = R(150, 75, 1500, 900)
    let box1 = G.boxInStrip(R(150 + 450, 75 + 840, 900, 36), rawWin: win, host: host, strip: strip)!
    let box3 = G.boxInStrip(R(150 + 450, 75 + 780, 900, 96), rawWin: win, host: host, strip: strip)!
    XCTAssertEqual(box1.y - box3.y, 40)
    XCTAssertEqual(box1.maxY, box3.maxY)
    let send1 = R(box1.x + box1.w - 40, box1.y + box1.h - 34, 32, 32)
    let off = G.sendOffset(box: box1, send: send1)
    XCTAssertEqual(G.sendAt(box: box1, offset: off, size: send1), send1)
    XCTAssertEqual(G.sendAt(box: box3, offset: off, size: send1), send1, "the box grew upward: Send stays put")
    var moved = box1
    moved.x += 120
    XCTAssertEqual(G.sendAt(box: moved, offset: off, size: send1), R(send1.x + 120, send1.y, send1.w, send1.h))
    XCTAssertNil(G.sendAt(box: box1, offset: nil, size: send1))
    XCTAssertNil(G.sendOffset(box: box1, send: nil))
    XCTAssertNil(G.usableBox(R(0, 10, 100, 300), stripHeight: 240))
    XCTAssertNil(G.usableBox(R(0, 250, 100, 10), stripHeight: 240))
    XCTAssertEqual(G.usableBox(box1, stripHeight: 240), box1)
  }

  func testSendInStripIsRounded() {
    let s = G.sendInStrip(R(10.4, 20.6, 30.5, 30.5), rawWin: R(0, 0, 100, 100), host: R(0, 0, 100, 100), strip: R(0, 0, 100, 100))
    XCTAssertEqual(s, R(10, 21, 31, 31))
  }

  // buddy.test.js "free-floating avatar: a strip along the bottom of the work area (above the Dock), centred, capped"
  func testFreeStripAboveTheDockCentredAndCapped() {
    let mac = R(0, 25, 1512, 870)
    let s = G.freeStrip(area: mac)
    XCTAssertEqual(s.w, G.freeStripMaxWidth)
    XCTAssertEqual(s.y + s.h, mac.y + mac.h, "stands on the top of the Dock")
    XCTAssertEqual(s.x, jsRound((1512 - G.freeStripMaxWidth) / 2))
    let small = G.freeStrip(area: R(100, 0, 600, 300))
    XCTAssertEqual(small.w, 552, "24 px margin each side")
    XCTAssertEqual(small.h, 180, "at most 60% of a short screen")
    XCTAssertEqual(small.x, 124)
  }

  // throw.test.js "the lifted rect: the host window clipped to the work area; no host, the work area"
  func testLiftRectIsTheHostClippedToTheVisibleFrame() {
    let area = R(0, 0, 1920, 1040)
    XCTAssertEqual(G.liftRect(host: R(300, 100, 1000, 700), workArea: area), R(300, 100, 1000, 700))
    XCTAssertEqual(G.liftRect(host: R(-8, -8, 1936, 1056), workArea: area), R(0, 0, 1920, 1040))
    XCTAssertEqual(G.liftRect(host: R(1500, 600, 1000, 700), workArea: area), R(1500, 600, 420, 440))
    XCTAssertEqual(G.liftRect(host: nil, workArea: area), area, "no window to live on: the visible frame")
    XCTAssertNil(G.liftRect(host: R(5000, 0, 800, 600), workArea: area), "not on this screen at all")
    XCTAssertNil(G.liftRect(host: R(0, 0, 800, 600), workArea: nil))
    // Under the menu bar and above the Dock on a Mac.
    XCTAssertEqual(G.liftRect(host: R(0, 0, 1512, 982), workArea: R(0, 25, 1512, 870)), R(0, 25, 1512, 870))
  }

  func testStandingOn() {
    // Qubit at size 2: side 36, hit 0.62 sides each way (45x45), feet half a side below his centre.
    let side = 36.0, r = side * 0.62
    func qubitHit(cx: Double, feet: Double) -> Rect { let cy = feet - side / 2; return R(jsRound(cx - r), jsRound(cy - r), jsRound(2 * r), jsRound(2 * r)) }
    let box = R(200, 150, 500, 60)
    XCTAssertEqual(G.standingOn(kind: "qubit", hit: qubitHit(cx: 400, feet: 150), stripHeight: 240, box: box, size: 2, lifted: false), "box")
    XCTAssertEqual(G.standingOn(kind: "qubit", hit: qubitHit(cx: 100, feet: 237), stripHeight: 240, box: box, size: 2, lifted: false), "floor")
    XCTAssertEqual(G.standingOn(kind: "qubit", hit: qubitHit(cx: 100, feet: 90), stripHeight: 240, box: box, size: 2, lifted: false), "air")
    XCTAssertEqual(G.standingOn(kind: "qubit", hit: qubitHit(cx: 100, feet: 237), stripHeight: 240, box: box, size: 2, lifted: true), "air")
    // The pixel buddy at scale 2: its rect is 21 art px tall, its feet 2 art px above its bottom.
    XCTAssertEqual(G.standingOn(kind: "buddy", hit: R(100, 240 - 42, 32, 42), stripHeight: 240, box: box, size: 2, lifted: false), "floor")
    XCTAssertEqual(G.standingOn(kind: "buddy", hit: R(300, 150 + 4 - 42, 32, 42), stripHeight: 240, box: box, size: 2, lifted: false), "box")
    XCTAssertNil(G.standingOn(kind: "qubit", hit: nil, stripHeight: 240, box: box, size: 2, lifted: false))
  }

  // MARK: - orb-stick.test.js

  func testOrbDefaultSpotBottomRightAbovePromptBox() {
    let win = R(1720, 0, 1720, 1392)
    XCTAssertEqual(OrbStick.orbPosition(win: win, anchor: nil, size: 128), ScreenPoint(x: 1720 + 1720 - 24 - 128, y: 1392 - 140 - 128))
  }

  func testDroppedOrbRoundTripsThroughTheNearestCorner() {
    let win = R(100, 50, 1200, 800)
    for pos in [ScreenPoint(x: 120, y: 70), ScreenPoint(x: 1100, y: 60), ScreenPoint(x: 130, y: 650), ScreenPoint(x: 1150, y: 700), ScreenPoint(x: 600, y: 400)] {
      let a = OrbStick.anchorFor(win: win, pos: pos, size: 128)
      XCTAssertTrue(OrbStick.isAnchor(a))
      XCTAssertEqual(OrbStick.orbPosition(win: win, anchor: a, size: 128), pos, "round trip via \(a.corner)")
    }
    XCTAssertEqual(OrbStick.anchorFor(win: win, pos: ScreenPoint(x: 1150, y: 700), size: 128).corner, "br")
    XCTAssertEqual(OrbStick.anchorFor(win: win, pos: ScreenPoint(x: 120, y: 70), size: 128).corner, "tl")
  }

  func testOrbKeepsItsDistanceWhenResizedOrMoved() {
    let a = OrbStick.Anchor(corner: "br", dx: 30, dy: 150)
    let small = OrbStick.orbPosition(win: R(0, 0, 900, 700), anchor: a, size: 128)
    let big = OrbStick.orbPosition(win: R(-2560, -1440, 2560, 1400), anchor: a, size: 128)
    XCTAssertEqual([900 - (small.x + 128), 700 - (small.y + 128)], [30, 150])
    XCTAssertEqual([0 - (big.x + 128), -40 - (big.y + 128)], [30, 150])
  }

  func testOrbNeverLeavesTheWindowAndCentresInATinyOne() {
    let win = R(0, 0, 400, 300)
    XCTAssertEqual(OrbStick.orbPosition(win: win, anchor: OrbStick.Anchor(corner: "tl", dx: 5000, dy: 5000), size: 128), ScreenPoint(x: 400 - 128, y: 300 - 128))
    XCTAssertEqual(OrbStick.orbPosition(win: R(10, 10, 100, 80), anchor: OrbStick.defaultAnchor, size: 128), ScreenPoint(x: 10 + jsRound((100 - 128) / 2), y: 10 + jsRound((80 - 128) / 2)))
    let outside = OrbStick.anchorFor(win: win, pos: ScreenPoint(x: -300, y: 900), size: 128)
    XCTAssertEqual(OrbStick.orbPosition(win: win, anchor: outside, size: 128), ScreenPoint(x: 0, y: 300 - 128), "dragged off the window: snaps back inside")
  }

  func testOnlyWellFormedAnchors() {
    XCTAssertTrue(OrbStick.isAnchor(OrbStick.Anchor(corner: "br", dx: 24, dy: 141)))
    for bad in [OrbStick.Anchor(corner: "middle", dx: 1, dy: 1), OrbStick.Anchor(corner: "tl", dx: -5, dy: 0), OrbStick.Anchor(corner: "tl", dx: .nan, dy: 0), OrbStick.Anchor(corner: "tl", dx: 10001, dy: 0)] {
      XCTAssertFalse(OrbStick.isAnchor(bad), "\(bad)")
    }
    XCTAssertNil(OrbStick.Anchor(json: ["corner": "br", "dx": "x", "dy": 0]))
    XCTAssertEqual(OrbStick.Anchor(json: ["corner": "br", "dx": 24, "dy": 140]), OrbStick.defaultAnchor)
  }

  func testOrbStartPosition() {
    let areas = [R(0, 25, 1512, 870)]
    XCTAssertEqual(OrbStick.startPosition(saved: ScreenPoint(x: 200, y: 300), areas: areas, main: areas[0]), ScreenPoint(x: 200, y: 300))
    XCTAssertEqual(OrbStick.startPosition(saved: ScreenPoint(x: 5000, y: 300), areas: areas, main: areas[0]), ScreenPoint(x: 1512 - 128 - 24, y: 25 + 870 - 128 - 24))
    XCTAssertEqual(OrbStick.startPosition(saved: nil, areas: areas, main: areas[0]), ScreenPoint(x: 1512 - 128 - 24, y: 25 + 870 - 128 - 24))
  }
}
