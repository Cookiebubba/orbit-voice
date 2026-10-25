// One avatar's window logic (AvatarModel, the port of electron/avatar.js) with a stand-in window and
// screen: where the strip goes on a host window and free-floating, z-order, the prompt box and Send
// in the strip, lifting (the host clipped to the visible frame) and the lift watchdog, the handover,
// commands, emotes, and click-through.
import XCTest
@testable import OrbitKit

@MainActor
final class AvatarModelTests: XCTestCase {
  @MainActor final class FakeWindow: AvatarWindowPort {
    var frame = Rect(x: 0, y: 0, w: 400, h: 240)
    var isVisible = false
    var layers: [OverlayLayer] = []
    var ignores: [Bool] = []
    var sent: [(String, JSONValue)] = []
    var destroyed = false
    var frames: [Rect] = []
    func setFrame(_ r: Rect) { frame = r; frames.append(r) }
    func showInactive() { isVisible = true }
    func hide() { isVisible = false }
    func setLayer(_ layer: OverlayLayer) { layers.append(layer) }
    func setIgnoresMouse(_ ignore: Bool) { ignores.append(ignore) }
    func send(_ channel: String, _ payload: JSONValue) { sent.append((channel, payload)) }
    func destroy() { destroyed = true; isVisible = false }
    func last(_ ch: String) -> JSONValue? { sent.last { $0.0 == ch }?.1 }
    func all(_ ch: String) -> [JSONValue] { sent.filter { $0.0 == ch }.map(\.1) }
  }

  @MainActor final class FakeEnv: AvatarEnvironment {
    let manual = ManualClock()
    var clock: OverlayClock { manual }
    var windows: [FakeWindow] = []
    var loaded: [() -> Void] = []
    var area = Rect(x: 0, y: 25, w: 1512, h: 870) // a MacBook's visible frame (menu bar, Dock)
    var cursorAt: ScreenPoint? = ScreenPoint(x: 5000, y: 5000)
    var prefs = AvatarPrefs()
    var opened = 0, closed = 0
    func makeAvatarWindow(kind: AvatarKind, loaded: @escaping @MainActor () -> Void) -> AvatarWindowPort {
      let w = FakeWindow()
      windows.append(w)
      self.loaded.append(loaded)
      return w
    }
    func workArea(matching r: Rect) -> Rect { area }
    func cursorWorkArea() -> Rect { area }
    func cursor() -> ScreenPoint? { cursorAt }
    func avatarPrefs() -> AvatarPrefs { prefs }
    func info(_ message: String) {}
    func warn(_ message: String) {}
    func windowOpened() { opened += 1 }
    func windowClosed() { closed += 1 }
  }

  let host = Rect(x: 100, y: 50, w: 1200, h: 800)
  func claude(front: String = "claude", min: Bool = false, rect: Rect? = nil) -> ClaudeState { ClaudeState(found: true, hwnd: 77, min: min, front: front, rect: rect ?? host, windows: 1) }

  func testOnAHostWindowTheStripIsItsBottomAndFollowsItsZOrder() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    a.onClaude(claude())
    a.setEnabled(true, size: 2, entrance: true)
    let w = env.windows[0]
    XCTAssertTrue(w.isVisible)
    XCTAssertEqual(w.frame, AvatarGeometry.stripBounds(host: host))
    XCTAssertEqual(w.layers.last, .top, "Claude in front: on top")
    XCTAssertEqual(w.ignores.first, true, "click-through from the start")
    XCTAssertEqual(a.hostHwnd, 77)
    XCTAssertEqual(a.boxWindow, 77, "wants the box watched")
    XCTAssertEqual(env.opened, 1)
    // The page loads: its state, then the entrance.
    env.loaded[0]()
    XCTAssertEqual(w.sent.last?.0, "buddy:event")
    XCTAssertEqual(w.sent.last?.1, "enter")
    let st = w.last("buddy:state")!
    XCTAssertEqual(st["bounds"], AvatarGeometry.stripBounds(host: host).boundsJSON)
    XCTAssertEqual(st["boxKnown"], false)
    XCTAssertEqual(st["visible"], true)
    XCTAssertEqual(st["prefs"], ["clickTalk": true, "throw": true, "throwSound": true])
    a.onClaude(claude(front: "other"))
    XCTAssertEqual(w.layers.last, .above(77), "another app in front: just above Claude")
    let moved = Rect(x: 300, y: 100, w: 1000, h: 700)
    a.onClaude(claude(front: "other", rect: moved))
    XCTAssertEqual(w.frame, AvatarGeometry.stripBounds(host: moved), "follows the window")
    a.onClaude(claude(min: true))
    XCTAssertFalse(w.isVisible, "Claude minimized: hidden")
    XCTAssertEqual(w.last("buddy:state")?["visible"], false, "and the page knows (it stops drawing)")
    XCTAssertEqual(a.boxWindow, 0)
  }

  func testThePromptBoxAndSendLandInTheStrip() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    a.onClaude(claude())
    a.setEnabled(true)
    let w = env.windows[0]
    let strip = AvatarGeometry.stripBounds(host: host)
    let raw = Rect(x: 400, y: 760, w: 600, h: 40)
    let send = Rect(x: 950, y: 765, w: 30, h: 30)
    a.onBoxRect(BoxReport(hwnd: 77, rect: raw, win: host, send: send))
    let st = w.last("buddy:state")!
    let box = AvatarGeometry.boxInStrip(raw, rawWin: host, host: host, strip: strip)!
    XCTAssertEqual(st["box"], box.rectJSON)
    XCTAssertEqual(st["send"], AvatarGeometry.sendInStrip(send, rawWin: host, host: host, strip: strip)!.rectJSON)
    XCTAssertEqual(st["boxKnown"], true)
    // The box grows (no Send in this report): Send keeps its place from the box's right end and bottom.
    a.onBoxRect(BoxReport(hwnd: 77, rect: Rect(x: 400, y: 730, w: 600, h: 70), win: host))
    XCTAssertEqual(w.last("buddy:state")?["send"], AvatarGeometry.sendInStrip(send, rawWin: host, host: host, strip: strip)!.rectJSON)
    // Another window's report: ignored. The box gone: no box, no Send.
    let n = w.sent.count
    a.onBoxRect(BoxReport(hwnd: 5, rect: nil, win: host))
    XCTAssertEqual(w.sent.count, n)
    a.onBoxRect(BoxReport(hwnd: 77, rect: nil, win: host))
    XCTAssertEqual(w.last("buddy:state")?["box"], .null)
    XCTAssertEqual(w.last("buddy:state")?["send"], .null)
    // The pixel buddy never gets a Send button.
    let b = AvatarModel(kind: .buddy, env: env)
    b.onClaude(claude())
    b.setEnabled(true)
    b.onBoxRect(BoxReport(hwnd: 77, rect: raw, win: host, send: send))
    XCTAssertEqual(env.windows[1].last("buddy:state")?["send"], .null)
  }

  func testNoBoxReportStopsThePageWaiting() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    a.onClaude(claude())
    a.setEnabled(true)
    XCTAssertEqual(env.windows[0].last("buddy:state")?["boxKnown"], false)
    env.manual.advance(AvatarModel.boxWaitMs + 1)
    XCTAssertEqual(env.windows[0].last("buddy:state")?["boxKnown"], true)
  }

  func testNoClaudeWindowFloatsFreeAboveTheDock() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    a.onClaude(.none)
    a.setEnabled(true)
    let w = env.windows[0]
    XCTAssertTrue(w.isVisible)
    XCTAssertEqual(w.frame, AvatarGeometry.freeStrip(area: env.area))
    XCTAssertEqual(w.layers.last, .top)
    XCTAssertTrue(a.isFree)
    XCTAssertEqual(a.hostHwnd, 0)
    XCTAssertEqual(a.boxWindow, 0)
    XCTAssertEqual(w.last("buddy:state")?["boxKnown"], true, "no box will ever come: the page doesn't wait")
    // Claude turns up: onto its window.
    a.onClaude(claude())
    XCTAssertEqual(w.frame, AvatarGeometry.stripBounds(host: host))
    XCTAssertFalse(a.isFree)
    XCTAssertEqual(env.windows.count, 1, "the same window moves")
  }

  func testAGuestStandsOnItsWindowsBottomEdgeAndHidesWithoutOne() {
    let env = FakeEnv()
    let g = AvatarModel(kind: .qubit, boxless: true, env: env)
    g.onClaude(claude(front: "other"))
    g.setEnabled(true)
    let w = env.windows[0]
    XCTAssertTrue(w.isVisible)
    XCTAssertEqual(w.last("buddy:state")?["boxKnown"], true, "nothing to wait for")
    XCTAssertEqual(g.boxWindow, 0, "no box is looked for")
    g.onClaude(.none)
    XCTAssertFalse(w.isVisible, "no window: hidden, never free-floating")
  }

  func testLiftedTheWindowCoversTheHostClippedAndComesBackByItself() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    let big = Rect(x: -8, y: 0, w: 1530, h: 990) // hangs under the menu bar and the Dock
    a.onClaude(claude(rect: big))
    a.setEnabled(true)
    let w = env.windows[0]
    let strip = w.frame
    XCTAssertTrue(a.lift(true))
    let area = AvatarGeometry.liftRect(host: big, workArea: env.area)!
    XCTAssertEqual(w.frame, area)
    XCTAssertEqual(area, Rect(x: 0, y: 25, w: 1512, h: 870))
    let st = w.last("buddy:state")!
    XCTAssertEqual(st["lift"], ["area": area.boundsJSON, "strip": strip.boundsJSON])
    XCTAssertEqual(st["bounds"], strip.boundsJSON, "the page still learns where its strip is")
    // The page keeps saying so: still lifted. Then it goes quiet: the strip comes back by itself.
    env.manual.advance(AvatarModel.liftMaxQuietMs - 1000)
    XCTAssertTrue(a.lift(true))
    env.manual.advance(AvatarModel.liftMaxQuietMs - 1000)
    XCTAssertTrue(a.isLifted)
    env.manual.advance(1001)
    XCTAssertFalse(a.isLifted, "no word for the watchdog's time: back to the strip")
    XCTAssertEqual(w.frame, strip)
    XCTAssertEqual(w.last("buddy:state")?["lift"], .null)
    // Picked up and put back by the page.
    a.lift(true)
    a.lift(false)
    XCTAssertEqual(w.frame, strip)
    // Free-floating, it covers the visible frame.
    a.onClaude(.none)
    a.lift(true)
    XCTAssertEqual(w.frame, env.area)
    a.lift(false)
    XCTAssertEqual(w.frame, AvatarGeometry.freeStrip(area: env.area))
  }

  func testTheHostMovingMidThrowMovesTheLiftedWindow() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    a.onClaude(claude())
    a.setEnabled(true)
    a.lift(true)
    let moved = Rect(x: 200, y: 80, w: 1000, h: 700)
    a.onClaude(claude(rect: moved))
    let w = env.windows[0]
    XCTAssertEqual(w.frame, AvatarGeometry.liftRect(host: moved, workArea: env.area))
    XCTAssertEqual(w.last("buddy:state")?["lift"]?["strip"], AvatarGeometry.stripBounds(host: moved).boundsJSON)
    a.lift(false)
    XCTAssertEqual(w.frame, AvatarGeometry.stripBounds(host: moved))
  }

  func testLeaveFadesOutThenCloses() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    a.onClaude(claude())
    a.setEnabled(true)
    let w = env.windows[0]
    var gone = false
    a.leave { gone = true }
    XCTAssertEqual(w.sent.last?.1, "leave")
    XCTAssertTrue(a.leaving)
    env.manual.advance(AvatarModel.leaveMs - 1)
    XCTAssertFalse(gone)
    XCTAssertFalse(w.destroyed, "still fading out")
    env.manual.advance(1)
    XCTAssertTrue(gone)
    XCTAssertTrue(w.destroyed)
    XCTAssertEqual(env.closed, 1)
    // One never shown just goes.
    let b = AvatarModel(kind: .buddy, env: env)
    var bGone = false
    b.leave { bGone = true }
    env.manual.advance(0)
    XCTAssertTrue(bGone)
  }

  func testCommandsOnlyWhileOnScreenAndOnlyItsOwn() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    XCTAssertEqual(a.command(["action": "backflip"])["ok"], false, "not on screen")
    a.onClaude(claude())
    a.setEnabled(true)
    XCTAssertEqual(a.command(["action": "backflip"]), ["ok": true])
    XCTAssertEqual(env.windows[0].last("buddy:command"), ["action": "backflip"])
    XCTAssertEqual(a.command(["action": "roll", "dir": "left"]), ["ok": true])
    XCTAssertEqual(env.windows[0].last("buddy:command"), ["action": "roll", "dir": "left"])
    a.command(["action": "move", "dir": "up"])
    XCTAssertEqual(env.windows[0].last("buddy:command"), ["action": "move"], "only left or right")
    XCTAssertEqual(a.command(["action": "wave"])["error"], "not something this avatar does")
    XCTAssertEqual(a.command(["action": "toString"])["ok"], false)
    // Emotes: Qubit only, as cues.
    XCTAssertTrue(a.emote("smile"))
    XCTAssertEqual(env.windows[0].last("buddy:emote"), "happy")
    XCTAssertFalse(a.emote("nonsense"))
    let b = AvatarModel(kind: .buddy, env: env)
    b.onClaude(claude())
    b.setEnabled(true)
    XCTAssertFalse(b.emote("happy"))
    XCTAssertEqual(b.command(["action": "wave"]), ["ok": true])
    // Events: each kind its own.
    b.event("error")
    XCTAssertNil(env.windows[1].last("buddy:event").flatMap { $0 == "error" ? $0 : nil })
    a.event("error")
    XCTAssertEqual(env.windows[0].last("buddy:event"), "error")
  }

  func testClickThroughExceptOverHim() {
    let env = FakeEnv()
    let a = AvatarModel(kind: .qubit, env: env)
    a.onClaude(claude())
    a.setEnabled(true)
    let w = env.windows[0]
    a.pageHit(Rect(x: 500, y: 150, w: 44, h: 44))
    XCTAssertEqual(w.ignores.last, true)
    env.cursorAt = ScreenPoint(x: w.frame.x + 520, y: w.frame.y + 170)
    env.manual.advance(HoverPoller.pollMs)
    XCTAssertEqual(w.ignores.last, false, "the cursor on him: the window takes the mouse")
    XCTAssertTrue(a.takingMouse)
    XCTAssertEqual(w.last("buddy:cursor"), ["x": .number(w.frame.x + 520), "y": .number(w.frame.y + 170)], "his eye follows the cursor")
    env.cursorAt = ScreenPoint(x: w.frame.x + 20, y: w.frame.y + 20)
    env.manual.advance(HoverPoller.pollMs)
    XCTAssertEqual(w.ignores.last, true)
    // The snapshot: his figure on screen, standing on the floor (feet 3 px above the strip's bottom).
    let side = 36.0, r = side * 0.62
    let feet = w.frame.h - 3
    a.pageHit(Rect(x: jsRound(300 - r), y: jsRound(feet - side / 2 - r), w: jsRound(2 * r), h: jsRound(2 * r)))
    let sn = a.snapshot
    XCTAssertEqual(sn.standingOn, "floor")
    XCTAssertEqual(sn.figure?.x, w.frame.x + jsRound(300 - r))
    XCTAssertEqual(sn.host, host)
    XCTAssertTrue(sn.asleep, "Orbit off: asleep")
    a.onVoice(["phase": "listening"])
    XCTAssertFalse(a.snapshot.asleep)
  }

  func testPrefsReachThePage() {
    let env = FakeEnv()
    env.prefs = AvatarPrefs(settings: ["avatarThrow": false])
    let a = AvatarModel(kind: .qubit, env: env)
    a.onClaude(claude())
    a.setEnabled(true)
    XCTAssertEqual(env.windows[0].last("buddy:state")?["prefs"], ["clickTalk": true, "throw": false, "throwSound": true])
    XCTAssertEqual(AvatarPrefs(settings: ["avatarClickTalk": false, "avatarThrowSound": "no"]), AvatarPrefs(clickTalk: false, throwing: true, throwSound: true))
  }

  func testEmoteCues() {
    XCTAssertEqual(emoteCue("Happy"), "happy")
    XCTAssertEqual(emoteCue("celebrate"), "excited")
    XCTAssertEqual(emoteCue("wow"), "surprised")
    XCTAssertNil(emoteCue("constructor"))
  }
}
