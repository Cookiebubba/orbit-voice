// Which Claude window Orbit docks on, the helper's lines, and the commands the tracker writes: the
// cases of test/claude-windows.test.js and test/avatar-box.test.js against the Swift port.
import XCTest
@testable import OrbitKit

@MainActor
final class ClaudeWindowTests: XCTestCase {
  func win(_ id: Int, min: Bool = false) -> ClaudeWin { ClaudeWin(hwnd: id, min: min, rect: Rect(x: Double(id * 10), y: 0, w: 1200, h: 800)) }

  func testDocksOnTheClaudeWindowMostRecentlyInFront() {
    var p = ClaudeWindowPicker()
    XCTAssertEqual(p.pick(wins: [win(2), win(1)], fg: 0, front: "other").hwnd, 2)
    XCTAssertEqual(p.pick(wins: [win(1), win(2)], fg: 1, front: "claude").hwnd, 1)
    XCTAssertEqual(p.pick(wins: [win(2), win(1)], fg: 2, front: "claude").hwnd, 2)
    let s = p.pick(wins: [win(1), win(2)], fg: 0, front: "other")
    XCTAssertEqual(s, ClaudeState(found: true, hwnd: 2, min: false, front: "other", rect: Rect(x: 20, y: 0, w: 1200, h: 800), windows: 2))
    XCTAssertEqual(p.recent, [2, 1])
  }

  func testAMinimizedWindowGivesWayAndAllMinimizedHides() {
    var p = ClaudeWindowPicker()
    _ = p.pick(wins: [win(1), win(2), win(3)], fg: 1, front: "claude")
    _ = p.pick(wins: [win(3), win(1), win(2)], fg: 3, front: "claude")
    XCTAssertEqual(p.pick(wins: [win(2), win(1), win(3, min: true)], fg: 0, front: "other").hwnd, 1)
    XCTAssertEqual(p.pick(wins: [win(2), win(1, min: true), win(3, min: true)], fg: 0, front: "other").hwnd, 2)
    let all = p.pick(wins: [win(2, min: true), win(1, min: true), win(3, min: true)], fg: 0, front: "other")
    XCTAssertEqual(all.hwnd, 3)
    XCTAssertTrue(all.min)
    XCTAssertEqual(p.pick(wins: [win(3), win(2, min: true), win(1, min: true)], fg: 3, front: "claude").hwnd, 3)
  }

  func testAClosedWindowIsForgottenAndNoWindowsIsNotFound() {
    var p = ClaudeWindowPicker()
    _ = p.pick(wins: [win(1), win(2)], fg: 1, front: "claude")
    _ = p.pick(wins: [win(2), win(1)], fg: 2, front: "claude")
    XCTAssertEqual(p.pick(wins: [win(1)], fg: 0, front: "other").hwnd, 1, "2 closed")
    XCTAssertEqual(p.recent, [1])
    XCTAssertEqual(p.pick(wins: [win(2), win(1)], fg: 0, front: "other").hwnd, 1)
    XCTAssertEqual(p.pick(wins: [], fg: 0, front: "other"), .none)
  }

  func testJunkInAReportIsIgnored() {
    let line = #"{"wins":[null,{"hwnd":-1,"x":0,"y":0,"w":1,"h":1},{"hwnd":5,"x":"a"},{"hwnd":7,"min":false,"x":70,"y":0,"w":1200,"h":800},{"hwnd":1.5,"x":0,"y":0,"w":1,"h":1}],"fg":99,"front":"evil"}"#
    guard case .wins(let wins, let fg, let front)? = ClaudeWindowLine.parse(line) else { return XCTFail("not parsed") }
    XCTAssertEqual(wins.map(\.hwnd), [7])
    XCTAssertEqual(front, "other")
    var p = ClaudeWindowPicker()
    let s = p.pick(wins: wins, fg: fg, front: front)
    XCTAssertEqual(s.hwnd, 7)
    XCTAssertEqual(p.recent, [], "a foreground window that is not one of Claude's")
    XCTAssertNil(ClaudeWindowLine.parse("{not json"))
    XCTAssertNil(ClaudeWindowLine.parse(#""{not json""#))
    XCTAssertNil(ClaudeWindowLine.parse(#"{"something":"else"}"#))
  }

  func testTheHelpersBoxLines() {
    let l = ClaudeWindowLine.parse(#"{"box":{"hwnd":7,"rect":{"x":300,"y":700,"w":600,"h":24},"win":{"x":0,"y":0,"w":1200,"h":800}}}"#)
    XCTAssertEqual(l, .box(BoxReport(hwnd: 7, rect: Rect(x: 300, y: 700, w: 600, h: 24), win: Rect(x: 0, y: 0, w: 1200, h: 800))))
    let none = ClaudeWindowLine.parse(#"{"box":{"hwnd":7,"rect":null,"win":null}}"#)
    XCTAssertEqual(none, .box(BoxReport(hwnd: 7, rect: nil, win: nil)))
    let send = ClaudeWindowLine.parse(#"{"box":{"hwnd":7,"rect":null,"win":{"x":0,"y":0,"w":1,"h":1},"send":{"x":1,"y":2,"w":3,"h":4}}}"#)
    XCTAssertEqual(send, .box(BoxReport(hwnd: 7, rect: nil, win: Rect(x: 0, y: 0, w: 1, h: 1), send: Rect(x: 1, y: 2, w: 3, h: 4))))
  }

  // avatar-box.test.js "the tracker passes box reports on, and asks the helper to watch the box and to look often"
  func testTheTrackerPassesBoxReportsOnAndWatchesTheBox() {
    let core = ClaudeTrackerCore()
    var got: [String] = []
    var changes: [ClaudeState] = []
    var boxes: [BoxReport] = []
    core.write = { got.append($0) }
    core.onChange = { changes.append($0) }
    core.onBox = { boxes.append($0) }
    core.started()
    core.handle(line: #"{"wins":[{"hwnd":7,"min":false,"x":0,"y":0,"w":1200,"h":800}],"fg":7,"front":"claude"}"#)
    XCTAssertEqual(changes.last?.hwnd, 7)
    core.burst() // not watching yet: nothing to burst
    core.watchBox(7)
    core.watchBox(7) // the same again: not repeated
    core.burst()
    XCTAssertEqual(got, ["pause", "box 7", "burst"])
    core.handle(line: #"{"box":{"hwnd":7,"rect":{"x":300,"y":700,"w":600,"h":24},"win":{"x":0,"y":0,"w":1200,"h":800}}}"#)
    XCTAssertEqual(boxes, [BoxReport(hwnd: 7, rect: Rect(x: 300, y: 700, w: 600, h: 24), win: Rect(x: 0, y: 0, w: 1200, h: 800))])
    XCTAssertEqual(changes.count, 1, "a box report is not a window change")
    // The helper dies: the new one gets the watch again.
    XCTAssertEqual(core.exited(at: 1000), 1000)
    got = []
    core.started()
    XCTAssertEqual(got, ["pause", "box 7"])
    core.watchBox(0)
    XCTAssertEqual(got.last, "box 0")
    core.burst()
    XCTAssertEqual(got.last, "box 0", "no burst while nothing is watched")
    core.stop()
    XCTAssertEqual(core.current, .none)
  }

  func testRestartsGiveUpAfterFiveCrashesInAMinute() {
    let core = ClaudeTrackerCore()
    for i in 0..<5 { XCTAssertEqual(core.exited(at: Double(i) * 1000), 1000) }
    XCTAssertNil(core.exited(at: 5000), "the sixth in a minute: give up")
    let later = ClaudeTrackerCore()
    for i in 0..<10 { XCTAssertEqual(later.exited(at: Double(i) * 20_000), 1000, "spread out: always restarted") }
  }

  func testTheTrackerFollowsTheActiveWindow() {
    let core = ClaudeTrackerCore()
    var seen: [ClaudeState] = []
    core.onChange = { seen.append($0) }
    core.handle(line: #"{"wins":[{"hwnd":1,"x":10,"y":0,"w":1200,"h":800},{"hwnd":2,"x":20,"y":0,"w":1200,"h":800}],"fg":1,"front":"claude"}"#)
    core.handle(line: #"{"wins":[{"hwnd":2,"x":20,"y":0,"w":1200,"h":800},{"hwnd":1,"x":10,"y":0,"w":1200,"h":800}],"fg":2,"front":"claude"}"#)
    XCTAssertEqual(core.current.hwnd, 2)
    core.handle(line: #"{"wins":[{"hwnd":1,"x":10,"y":0,"w":1200,"h":800},{"hwnd":2,"x":20,"y":0,"w":1200,"h":800}],"fg":0,"front":"other"}"#)
    XCTAssertEqual(seen.last?.hwnd, 2)
    XCTAssertEqual(seen.last?.front, "other")
    core.handle(line: "{not json")
    XCTAssertEqual(seen.count, 3)
  }
}
