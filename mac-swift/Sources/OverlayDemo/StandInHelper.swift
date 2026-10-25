// A stand-in for orbit-helper's claude-window mode (OverlayDemo claude-window --parent-pid N --pid P):
// the same JSON lines and commands, about the stand-in host window of process P only, read from the
// geometry file that window writes (StandIn.swift). It needs no accessibility permission, so the
// overlays can be checked on a Mac where Orbit hasn't been granted it. Developer use only (the
// tracker runs it when ORBIT_CLAUDE_HELPER points at OverlayDemo).
import AppKit
import OrbitKit

@MainActor
final class StandInHelper {
  private let pid: Int32
  private let parent: Int32
  private var boxWin = 0
  private var lastWins = ""
  private var lastBox = ""
  private var timer: Timer?

  init(pid: Int32, parent: Int32) { (self.pid, self.parent) = (pid, parent) }

  func run() {
    readStdin()
    timer = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { _ in MainActor.assumeIsolated { self.tick() } }
    tick()
  }

  private func emit(_ v: JSONValue) {
    FileHandle.standardOutput.write(Data((v.text + "\n").utf8))
  }

  private func geometry() -> JSONValue? {
    guard pid > 0, kill(pid, 0) == 0, let d = try? Data(contentsOf: StandInApp.geometryFile(pid: pid)) else { return nil }
    return try? JSONValue.parse(d)
  }

  private func tick() {
    if parent > 0, kill(parent, 0) != 0 { exit(0) }
    let g = geometry()
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    let front = frontPid == pid ? "claude" : frontPid == parent ? "orbit" : "other"
    var wins: [JSONValue] = []
    var mainId = 0
    if let m = g?["main"], let id = m["id"]?.intValue {
      mainId = id
      wins.append(["hwnd": .number(Double(id)), "min": m["min"] ?? false, "x": m["x"] ?? 0, "y": m["y"] ?? 0, "w": m["w"] ?? 0, "h": m["h"] ?? 0])
    }
    let report: JSONValue = ["wins": .array(wins), "fg": .number(front == "claude" ? Double(mainId) : 0), "front": .string(front)]
    if report.text != lastWins {
      lastWins = report.text
      emit(report)
    }
    if boxWin != 0 {
      let box: JSONValue
      if let g, boxWin == mainId, let m = g["main"] {
        if m["min"]?.boolValue == true { return }
        box = ["box": ["hwnd": .number(Double(boxWin)), "rect": g["box"] ?? .null, "win": ["x": m["x"] ?? 0, "y": m["y"] ?? 0, "w": m["w"] ?? 0, "h": m["h"] ?? 0], "send": g["send"] ?? .null]]
      } else {
        box = ["box": ["hwnd": .number(Double(boxWin)), "rect": .null, "win": .null]]
      }
      if box.text != lastBox {
        lastBox = box.text
        emit(box)
      }
    }
  }

  private func command(_ line: String) {
    let parts = line.split(separator: " ").map(String.init)
    switch parts.first ?? "" {
    case "box":
      let id = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
      if id != boxWin {
        boxWin = id
        lastBox = ""
        tick()
      }
    case "quit": exit(0)
    default: break // follow / pause / burst: nothing to do (it looks every 30 ms anyway)
    }
  }

  private func readStdin() {
    let t = Thread {
      while let line = readLine(strippingNewline: true) {
        let l = line.trimmingCharacters(in: .whitespaces)
        if l.isEmpty { continue }
        DispatchQueue.main.async { MainActor.assumeIsolated { self.command(l) } }
      }
      DispatchQueue.main.async { exit(0) }
    }
    t.start()
  }
}
