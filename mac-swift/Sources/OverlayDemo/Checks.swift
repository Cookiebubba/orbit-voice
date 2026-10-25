// OverlayDemo's scripted checks against the stand-in host window: the avatar is drawn and stands on
// the box, its window is click-through away from him, a synthetic press/drag/release (delivered to
// its page only) lifts and throws him inside the host window, "Wheee!" only on a real throw, a click
// talks, fast kind switches never show two avatars in one place, a guest on the other window, the
// mouse glides and hides, the orb sticks. Results as JSON (each check: pass + numbers).
import AppKit
import OrbitKit
import OrbitOverlays

@MainActor
final class Checks {
  private let host: DemoHost
  private var o: Overlays { host.overlays }
  private var results: [String: JSONValue] = [:]
  private var order: [String] = []
  private let shots: String?
  private var sampling = false
  private var worstSeen = 0

  init(host: DemoHost) {
    self.host = host
    shots = flag("shots")
  }

  private func sleep(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }

  private func until(_ ms: Int, step: Int = 50, _ cond: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(Double(ms) / 1000)
    while Date() < end {
      if cond() { return true }
      await sleep(step)
    }
    return cond()
  }

  private func record(_ name: String, _ pass: Bool, _ detail: [String: JSONValue]) {
    var d = detail
    d["pass"] = .bool(pass)
    results[name] = .object(d)
    order.append(name)
    DemoHost.say("CHECK \(name): \(pass ? "PASS" : "FAIL") \(JSONValue.object(detail).text)")
  }

  private func home() -> ParityAvatar? { o.parityAvatars().first { $0.id == "home" && !$0.leaving } }
  private func avatar(_ id: String) -> ParityAvatar? { o.parityAvatars().first { $0.id == id && !$0.leaving } }

  private func shot(_ name: String, _ r: Rect?) {
    guard let dir = shots, let r else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-R", "\(Int(r.x)),\(Int(r.y)),\(Int(r.w)),\(Int(r.h))", "\(dir)/\(name).png"]
    try? p.run()
    p.waitUntilExit()
  }

  private func j(_ r: Rect?) -> JSONValue { r?.rectJSON ?? .null }

  func run() async -> JSONValue {
    if argv.contains("--expect-no-claude") {
      // The real helper without Accessibility (or no Claude window): nothing on screen, nothing breaks.
      await sleep(5000)
      let shown = o.parityAvatars().filter(\.visible)
      record("noClaudeNoAvatar", !o.parityClaude().found && shown.isEmpty && o.command(["action": "backflip"])["ok"] == false,
             ["claudeFound": .bool(o.parityClaude().found), "visibleAvatars": .number(Double(shown.count)), "window": o.windowInfo(avatar: "home")])
      return ["checks": .object(results), "order": .array(order.map { .string($0) })]
    }
    await found()
    await drawnAndStanding()
    await clickThrough()
    await throwHim()
    await dropNoSound()
    await clickTalks()
    await guest()
    await switching()
    await mouse()
    await orb()
    let passed = order.filter { results[$0]?["pass"]?.boolValue == true }.count
    return ["checks": .object(results), "order": .array(order.map { .string($0) }), "passed": .number(Double(passed)), "total": .number(Double(order.count))]
  }

  // MARK: -

  private func found() async {
    let ok = await until(15_000) { o.claudeState.found && (home()?.visible ?? false) }
    let c = o.parityClaude()
    let h = home()
    let strip = c.frame.map { AvatarGeometry.stripBounds(host: $0) }
    record("found", ok && h?.frame == strip && h?.host?.frame == c.frame, [
      "claude": j(c.frame), "pid": c.pid.map { .number(Double($0)) } ?? .null, "box": j(c.box), "send": j(c.send),
      "avatarFrame": j(h?.frame), "expectedStrip": j(strip), "window": o.windowInfo(avatar: "home"),
    ])
  }

  private func drawnAndStanding() async {
    let drawn = await until(10_000) { home()?.figure != nil }
    let engine = await o.eval(avatar: "home", script: "!!(window.__qubit ? window.__qubit.q : true)")
    var shim = await o.eval(avatar: "home", script: "({ desktop: typeof window.desktop, orbit: typeof window.__orbit, bounds: window.__qubit ? window.__qubit.state.bounds : null })")
    if home()?.figure == nil {
      // Plumbing probes: a listener on the page, and a message from it.
      let listen = await o.eval(avatar: "home", script: "(() => { let got = null; const off = window.desktop.onBuddyCursor((c) => (got = c)); window.__orbit.emit('buddy:cursor', { x: 1, y: 2 }); off(); return got; })()")
      _ = await o.eval(avatar: "home", script: "(window.desktop.buddyHit({ x: 1, y: 2, w: 30, h: 40 }), true)")
      await sleep(200)
      let vis = await o.eval(avatar: "home", script: "new Promise((res) => { const t = setTimeout(() => res({ raf: false, vis: document.visibilityState, running: __qubit.running, st: __qubit.state }), 500); requestAnimationFrame(() => { clearTimeout(t); res({ raf: true, vis: document.visibilityState, running: __qubit.running, st: __qubit.state }); }); })")
      shim = ["first": shim, "listen": listen, "hitAfterProbe": j(home()?.figure), "vis": vis]
    }
    record("drawn", drawn && engine.boolValue == true, ["figure": j(home()?.figure), "engine": engine, "shim": shim])
    let onBox = await until(15_000) { home()?.standingOn == "box" }
    let page = await o.eval(avatar: "home", script: "window.__qubit ? { box: __qubit.state.box, bounds: __qubit.state.bounds, cx: __qubit.q && __qubit.q.cx, cy: __qubit.q && __qubit.q.cy, ground: __qubit.q && __qubit.q.ground, side: __qubit.q && __qubit.q.side, frame: __qubit.frame } : null")
    let h = home()
    record("standsOnBox", onBox, ["standingOn": h?.standingOn.map { .string($0) } ?? .null, "figure": j(h?.figure), "page": page, "claudeBox": j(o.parityClaude().box)])
    shot("1-standing", o.parityClaude().frame)
  }

  private func clickThrough() async {
    guard let h = home(), let f = h.frame, let fig = h.figure else { return record("clickThrough", false, ["why": "no figure"]) }
    // Away from him (still inside his strip): clicks go through.
    let away = ScreenPoint(x: fig.midX > f.midX ? f.x + 20 : f.maxX - 20, y: f.y + 20)
    o.setTestCursor(away)
    await sleep(250)
    let awayInfo = o.windowInfo(avatar: "home")
    let awayTakes = home()?.takesMouse ?? true
    // On him: the window takes the mouse.
    let fig2 = home()?.figure ?? fig
    o.setTestCursor(ScreenPoint(x: fig2.midX, y: fig2.midY))
    await sleep(250)
    let onInfo = o.windowInfo(avatar: "home")
    let onTakes = home()?.takesMouse ?? false
    o.setTestCursor(away)
    await sleep(250)
    let backTakes = home()?.takesMouse ?? true
    o.setTestCursor(nil)
    let ok = !awayTakes && awayInfo["ignoresMouse"]?.boolValue == true && onTakes && onInfo["ignoresMouse"]?.boolValue == false && !backTakes
    record("clickThrough", ok, ["away": awayInfo, "on": onInfo, "awayTakes": .bool(awayTakes), "onTakes": .bool(onTakes), "backTakes": .bool(backTakes)])
  }

  private func throwHim() async {
    guard let h = home(), let fig = h.figure, let hostRect = o.parityClaude().frame else { return record("throw", false, ["why": "no figure"]) }
    let expected = AvatarGeometry.liftRect(host: hostRect, workArea: ScreenSpace.visibleFrame(matching: hostRect))
    let sounds0 = host.sounds.count
    let lifts0 = host.events.filter { $0.type == "avatar.lift" && $0.data["on"]?.boolValue == true }.count
    var p = ScreenPoint(x: fig.midX, y: fig.midY)
    o.setTestCursor(p)
    o.pointer(avatar: "home", type: "down", x: p.x, y: p.y)
    await sleep(30)
    for _ in 0..<7 {
      p = ScreenPoint(x: p.x + 22, y: p.y - 26)
      o.pointer(avatar: "home", type: "move", x: p.x, y: p.y)
      await sleep(16)
    }
    o.pointer(avatar: "home", type: "up", x: p.x, y: p.y)
    o.setTestCursor(nil)
    var liftedFrame: Rect?
    var outside = 0, samples = 0, maxOut: Double = 0, sawLifted = false, sawAir = false
    let end = Date().addingTimeInterval(9)
    var shotTaken = false
    while Date() < end {
      if let a = home() {
        if a.lifted {
          sawLifted = true
          liftedFrame = liftedFrame ?? a.frame
          if !shotTaken, let fr = a.frame { shot("2-flying", fr); shotTaken = true }
          if let hit = a.figure, let area = expected {
            samples += 1
            // His body, not his hit rect (0.62 sides each way around his centre; his body is 0.5).
            let pad = hit.w * 0.12 / 1.24
            let fg = Rect(x: hit.x + pad, y: hit.y + pad, w: hit.w - 2 * pad, h: hit.h - 2 * pad)
            let out = max(area.x - fg.x, fg.maxX - area.maxX, area.y - fg.y, fg.maxY - area.maxY, 0)
            if out > 2 { outside += 1 }
            maxOut = max(maxOut, out)
            if fg.maxY < hostRect.maxY - 40 { sawAir = true }
          }
        } else if sawLifted, ["box", "floor"].contains(a.standingOn ?? "") {
          break
        }
      }
      await sleep(30)
    }
    let landed = await until(8000) { !(self.home()?.lifted ?? true) && ["box", "floor"].contains(self.home()?.standingOn ?? "") }
    let lifts = host.events.filter { $0.type == "avatar.lift" && $0.data["on"]?.boolValue == true }.count - lifts0
    let soundCount = host.sounds.count - sounds0
    shot("3-landed", hostRect)
    let ok = sawLifted && liftedFrame == expected && outside == 0 && sawAir && landed && soundCount == 1 && lifts >= 1
    record("throw", ok, [
      "lifted": .bool(sawLifted), "liftedFrame": j(liftedFrame), "expectedLiftRect": j(expected), "samples": .number(Double(samples)),
      "samplesOutsideHost": .number(Double(outside)), "maxOutside": .number(maxOut), "flewUp": .bool(sawAir), "landed": .bool(landed),
      "standingOn": home()?.standingOn.map { .string($0) } ?? .null, "wheee": .number(Double(soundCount)), "liftEvents": .number(Double(lifts)),
      "frameAfter": j(home()?.frame),
    ])
  }

  private func dropNoSound() async {
    await sleep(1500)
    guard let fig = home()?.figure else { return record("putDownNoWheee", false, ["why": "no figure"]) }
    let sounds0 = host.sounds.count
    var p = ScreenPoint(x: fig.midX, y: fig.midY)
    o.setTestCursor(p)
    o.pointer(avatar: "home", type: "down", x: p.x, y: p.y)
    await sleep(500) // held still: picked up
    let picked = home()?.lifted ?? false
    for _ in 0..<5 {
      p = ScreenPoint(x: p.x + 2, y: p.y)
      o.pointer(avatar: "home", type: "move", x: p.x, y: p.y)
      await sleep(80)
    }
    await sleep(150)
    o.pointer(avatar: "home", type: "up", x: p.x, y: p.y)
    o.setTestCursor(nil)
    let landed = await until(8000) { !(self.home()?.lifted ?? true) && ["box", "floor"].contains(self.home()?.standingOn ?? "") }
    let n = host.sounds.count - sounds0
    record("putDownNoWheee", picked && landed && n == 0, ["pickedUp": .bool(picked), "landed": .bool(landed), "wheee": .number(Double(n))])
  }

  private func clickTalks() async {
    await sleep(1500)
    guard let fig = home()?.figure else { return record("clickTalks", false, ["why": "no figure"]) }
    let talks0 = host.talks, sounds0 = host.sounds.count
    let p = ScreenPoint(x: fig.midX, y: fig.midY)
    o.pointer(avatar: "home", type: "down", x: p.x, y: p.y)
    await sleep(60)
    o.pointer(avatar: "home", type: "up", x: p.x, y: p.y)
    let talked = await until(1500) { self.host.talks > talks0 }
    let wake = host.sent.last { $0["t"]?.stringValue == "wake" }
    await sleep(300)
    record("clickTalks", talked && !(home()?.lifted ?? true) && host.sounds.count == sounds0, ["talks": .number(Double(host.talks - talks0)), "wake": wake ?? .null, "lifted": .bool(home()?.lifted ?? false)])
  }

  private var otherWindow: (id: Int, rect: Rect)? {
    let pid = Int32(ClaudeWindowTracker.testClaudePid)
    guard pid > 0, let d = try? Data(contentsOf: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("orbit-standin-\(pid).json")),
          let g = try? JSONValue.parse(d), let w = g["other"], let id = w["id"]?.intValue, let r = Rect(json: w) else { return nil }
    return (id, r)
  }

  private func guest() async {
    guard let w = otherWindow else { return record("guest", false, ["why": "no stand-in other window"]) }
    o.sidecarMessage(["t": "contexts", "snap": ["active": ["id": "home"], "contexts": [["id": "home", "home": true], ["id": "w-other", "hwnd": .number(Double(w.id)), "lastActiveAt": .number(MainClock.shared.now)]]]])
    o.sidecarMessage(["t": "wins", "wins": [["hwnd": .number(Double(w.id)), "min": false, "x": .number(w.rect.x), "y": .number(w.rect.y), "w": .number(w.rect.w), "h": .number(w.rect.h)]]])
    let ok = await until(6000) { self.avatar("w-other")?.visible == true && self.avatar("w-other")?.figure != nil }
    let g = avatar("w-other")
    let strip = AvatarGeometry.stripBounds(host: w.rect)
    record("guest", ok && g?.frame == strip && g?.role == "guest", ["frame": j(g?.frame), "expectedStrip": j(strip), "standingOn": g?.standingOn.map { .string($0) } ?? .null])
    shot("4-guest", w.rect)
  }

  /** Avatars showing per place right now (counting ones fading out): the most in any one place. */
  private func worstPerPlace() -> Int {
    var per: [String: Int] = [:]
    for a in o.parityAvatars() where a.visible {
      let place = a.role == "home" ? "home" : "guest:\(a.host?.frame?.description ?? a.id)"
      per[place, default: 0] += 1
    }
    return per.values.max() ?? 0
  }

  private func switching() async {
    sampling = true
    worstSeen = 0
    let sampler = Task { @MainActor in
      while self.sampling {
        self.worstSeen = max(self.worstSeen, self.worstPerPlace())
        try? await Task.sleep(for: .milliseconds(4))
      }
    }
    let seq: [(String, Int)] = [("buddy", 0), ("qubit", 0), ("buddy", 30), ("qubit", 120), ("buddy", 260), ("qubit", 600)]
    for (k, gap) in seq {
      host.change("avatar", .string(k))
      if gap > 0 { await sleep(gap) }
    }
    let settled = await until(5000) {
      let as_ = self.o.parityAvatars()
      return as_.filter { $0.role == "home" && $0.visible }.count == 1 && as_.first { $0.id == "home" && !$0.leaving }?.kind == "qubit" && !as_.contains { $0.leaving }
    }
    await sleep(800)
    sampling = false
    _ = await sampler.value
    let worst = max(worstSeen, worstPerPlace())
    let final = o.parityAvatars()
    let guestBack = final.contains { $0.id == "w-other" && $0.visible && $0.kind == "qubit" }
    record("switchNoDuplicates", worst <= 1 && settled && guestBack, [
      "worstPerPlace": .number(Double(worst)), "settled": .bool(settled), "guestBack": .bool(guestBack),
      "final": .array(final.map { ["id": .string($0.id), "kind": .string($0.kind), "visible": .bool($0.visible), "leaving": .bool($0.leaving)] }),
    ])
  }

  private func mouse() async {
    guard let c = o.parityClaude().frame else { return record("mouse", false, ["why": "no host"]) }
    o.sidecarMessage(["t": "mouse.glide", "x": .number(c.midX), "y": .number(c.midY), "holdMs": 400])
    let shown = await until(1500) { self.o.parityMouse().visible && self.o.parityMouse().windows >= 1 }
    await sleep(500)
    let at = o.parityMouse().pos
    o.sidecarMessage(["t": "mouse.press"])
    let hidden = await until(4000) { !self.o.parityMouse().visible && self.o.parityMouse().windows == 0 }
    let arrived = at.map { abs($0["x"]! - c.midX) < 1 && abs($0["y"]! - c.midY) < 1 } ?? false
    record("mouse", shown && arrived && hidden, ["shown": .bool(shown), "pos": at.map { ["x": .number($0["x"]!), "y": .number($0["y"]!)] } ?? .null, "hiddenAfter": .bool(hidden)])
  }

  private func orb() async {
    host.change("showOrb", true)
    host.change("orbStick", true)
    o.showOrb()
    let c = o.parityClaude().frame
    let want = c.map { OrbStick.orbPosition(win: $0, anchor: nil) }
    let ok = await until(3000) { self.o.parityOrb().visible && self.o.parityOrb().frame?.x == want?.x && self.o.parityOrb().frame?.y == want?.y }
    record("orbSticks", ok, ["orb": j(o.parityOrb().frame), "expected": want.map { ["x": .number($0.x), "y": .number($0.y)] } ?? .null])
    o.hideOrb()
  }
}
