// The Claude window tracker's logic (electron/claude-window.js + claude-windows.js), with the helper
// process left out: the macOS helper's `claude-window` mode (orbit-helper claude-window --parent-pid
// <pid> [--pid <claude pid>]) prints one JSON line per change, and Orbit writes commands to it:
//
//   {"wins":[{"hwnd":id,"min":false,"x":0,"y":0,"w":1200,"h":800},...],"fg":id,"front":"claude"|"orbit"|"other"}
//       Claude's windows, highest first (points, top-left origin); fg: the one in front, or 0.
//   {"box":{"hwnd":id,"rect":{x,y,w,h}|null,"win":{x,y,w,h}|null[,"send":{x,y,w,h}|null]}}
//       where the watched window's prompt box is (only where; never what's in it). ("send" is only
//       there from a stand-in helper; the real one finds Send through the accessibility API.)
//   commands: "follow ...", "pause" (accepted, unused on macOS), "box <id>" (watch that window's
//   prompt box; 0 stops), "burst" (Orbit is about to type into the box: look often for a moment).
//
// The process side (spawning, restarting) is in OrbitNative's ClaudeWindowTracker.
import Foundation

/** One of Claude's windows as the helper reports it. */
public struct ClaudeWin: Equatable, Sendable {
  public var hwnd: Int
  public var min: Bool
  public var rect: Rect
  public init(hwnd: Int, min: Bool, rect: Rect) { (self.hwnd, self.min, self.rect) = (hwnd, min, rect) }

  public init?(json: JSONValue?) {
    guard let j = json, let id = j["hwnd"]?.doubleValue, id > 0, id == id.rounded(), id < 9_007_199_254_740_992,
          let r = Rect(json: j) else { return nil }
    self.init(hwnd: Int(id), min: j["min"]?.boolValue ?? false, rect: r)
  }
}

/** The Claude window Orbit lives on (or none): what the tracker reports to the avatar and the orb. */
public struct ClaudeState: Equatable, Sendable {
  public var found: Bool
  public var hwnd: Int = 0
  public var min: Bool = false
  /** "claude" (a Claude window is in front), "orbit", or "other". */
  public var front: String = "other"
  public var rect: Rect = Rect(x: 0, y: 0, w: 0, h: 0)
  public var windows: Int = 0
  public init(found: Bool, hwnd: Int = 0, min: Bool = false, front: String = "other", rect: Rect = Rect(x: 0, y: 0, w: 0, h: 0), windows: Int = 0) {
    self.found = found; self.hwnd = hwnd; self.min = min; self.front = front; self.rect = rect; self.windows = windows
  }
  public static let none = ClaudeState(found: false)
}

/** Where the helper sees the prompt box of the watched window (and, from a stand-in, Send). */
public struct BoxReport: Equatable, Sendable {
  public var hwnd: Int
  public var rect: Rect?
  public var win: Rect?
  public var send: Rect?
  public init(hwnd: Int, rect: Rect?, win: Rect?, send: Rect? = nil) { (self.hwnd, self.rect, self.win, self.send) = (hwnd, rect, win, send) }
}

public enum ClaudeWindowLine: Equatable, Sendable {
  case wins(wins: [ClaudeWin], fg: Int, front: String)
  case box(BoxReport)

  /** One line from the helper; nil for a partial line or anything else. */
  public static func parse(_ line: String) -> ClaudeWindowLine? {
    guard let v = try? JSONValue.parse(line), case .object = v else { return nil }
    if let b = v["box"], case .object = b {
      return .box(BoxReport(hwnd: b["hwnd"]?.intValue ?? 0, rect: Rect(json: b["rect"]), win: Rect(json: b["win"]), send: Rect(json: b["send"])))
    }
    guard let list = v["wins"]?.arrayValue else { return nil }
    let front = v["front"]?.stringValue ?? "other"
    return .wins(wins: list.compactMap { ClaudeWin(json: $0) }, fg: v["fg"]?.intValue ?? 0, front: ["claude", "orbit", "other"].contains(front) ? front : "other")
  }
}

/**
 * Which Claude window Orbit docks on, when Claude has several: the one most recently in front (the
 * foreground one, or the last Claude window that was in front while another app is). If that one is
 * minimized, the most recent one that isn't; with every Claude window minimized, that first one (and
 * the orb hides). Before any Claude window has been in front, the highest one in z-order.
 */
public struct ClaudeWindowPicker: Sendable {
  private var mru: [Int] = [] // Claude windows by when they were last in front, latest first
  public init() {}

  public mutating func pick(wins: [ClaudeWin], fg: Int, front: String) -> ClaudeState {
    let byId = Dictionary(wins.map { ($0.hwnd, $0) }, uniquingKeysWith: { a, _ in a })
    mru = mru.filter { byId[$0] != nil } // closed windows drop out
    if byId[fg] != nil { mru = [fg] + mru.filter { $0 != fg } }
    if wins.isEmpty { return .none }
    let order = mru.compactMap { byId[$0] } + wins.filter { !mru.contains($0.hwnd) }
    let w = order.first(where: { !$0.min }) ?? order[0]
    return ClaudeState(found: true, hwnd: w.hwnd, min: w.min, front: ["claude", "orbit", "other"].contains(front) ? front : "other", rect: w.rect, windows: wins.count)
  }

  /** Latest first (for tests). */
  public var recent: [Int] { mru }
}

/**
 * The tracker's side of the conversation with the helper: what to write (and to write again to a
 * restarted helper), and what its lines mean. `write` sends one line to the running helper (it may
 * be dropped while one restarts: the commands are replayed by started()).
 */
@MainActor
public final class ClaudeTrackerCore {
  public static let restartDelayMs: Double = 1000
  public static let maxRestartsPerMinute = 5

  private var picker = ClaudeWindowPicker()
  private var command = "pause" // the last instruction, replayed after a restart
  private var boxCommand: String? // "box <id>" while the avatar wants the prompt box watched
  private var restarts: [Double] = []
  public private(set) var current = ClaudeState.none
  public var write: (String) -> Void = { _ in }
  public var onChange: (ClaudeState) -> Void = { _ in }
  public var onBox: (BoxReport) -> Void = { _ in }

  public init() {}

  /** A (re)started helper: the last instructions again. */
  public func started() {
    write(command)
    if let b = boxCommand { write(b) }
  }

  /** One line from the helper. */
  public func handle(line: String) {
    guard let l = ClaudeWindowLine.parse(line) else { return } // a partial line
    switch l {
    case .box(let b): onBox(b)
    case .wins(let wins, let fg, let front):
      current = picker.pick(wins: wins, fg: fg, front: front)
      onChange(current)
    }
  }

  /** Watch this Claude window's prompt box (0: stop): its rects come to onBox as it moves. */
  public func watchBox(_ hwnd: Int) {
    let line = "box \(max(0, hwnd))"
    if line == (boxCommand ?? "box 0") { return }
    boxCommand = line == "box 0" ? nil : line
    write(line)
  }

  /** Orbit is about to type into (or clear) the box: the helper looks often for a moment. */
  public func burst() {
    guard boxCommand != nil else { return }
    write("burst")
  }

  public func pause() {
    if command != "pause" {
      command = "pause"
      write("pause")
    }
  }

  /** The helper exited at `now` (ms): restart after a second, or give up after too many in a minute. */
  public func exited(at now: Double) -> Double? {
    restarts = restarts.filter { now - $0 < 60_000 } + [now]
    return restarts.count > Self.maxRestartsPerMinute ? nil : Self.restartDelayMs
  }

  public func resetRestarts() { restarts = [] }

  /** Stopped: forget everything but the picker's history. */
  public func stop() {
    command = "pause"
    boxCommand = nil
    current = .none
  }

  public var watchedBox: Int { boxCommand.flatMap { Int($0.dropFirst(4)) } ?? 0 }
}
