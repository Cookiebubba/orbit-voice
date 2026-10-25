// The parity driver's view of the shell (../../parity/PROTOCOL.md): state snapshots and actions, run
// on the main actor where the windows live.
import AppKit
import OrbitKit
import OrbitOverlays
import OrbitVoice

final class ParityBridge: ParityDriverDelegate, @unchecked Sendable {
  weak var shell: AppDelegate?
  init(shell: AppDelegate) { self.shell = shell }

  func parityHello() async -> JSONValue {
    await MainActor.run {
      guard let s = shell else { return ["app": "swift"] }
      return [
        "app": "swift",
        "version": .string(OrbitKit.version),
        "pid": .number(Double(getpid())),
        "ready": .bool(s.endpoints != nil && s.ui != nil),
        "bridge": ["base": .string(s.endpoints?.base.absoluteString ?? ""), "authUrl": .string(s.endpoints?.auth["main"]?.absoluteString ?? "")],
        "features": .array(s.features.map { .string($0) }),
      ]
    }
  }

  func parityState() async -> ParityState {
    await MainActor.run { shell?.snapshot() ?? ParityState() }
  }

  func parityAct(action: String, args: JSONValue) async -> JSONValue {
    guard let s = await MainActor.run(body: { shell }) else { return ["ok": false, "error": "gone"] }
    return await s.act(action, args)
  }
}

extension AppDelegate {
  /** What this build implements (a case needing anything else is "unsupported"). */
  var features: [String] {
    var f = ["settings", "onboarding", "login"]
    if shellHotkey != nil { f.append("hotkey") }
    if voiceController != nil { f.append("voice") }
    if overlays != nil { f += ["avatar", "mouse", "window"] }
    return f
  }

  func snapshot() -> ParityState {
    var st = ParityState()
    if let ui {
      st.windows = ui.parityWindows()
      st.onboarding = ui.parityOnboarding()
      st.login = ["enabled": ui.parityLogin()]
    }
    let h = hotkeys.info()
    st.hotkey = ParityHotkey(accelerator: h.accelerator, label: h.label, registered: h.registered)
    if let v = voiceController { st.voice = v.parityVoice() } else {
      st.voice.phase = voice.phase
      st.voice.asleep = voice.asleep
      st.voice.muted = voice.muted
    }
    if let o = overlays {
      st.avatars = o.parityAvatars()
      st.mouse = o.parityMouse()
      st.windows["orb"] = o.parityOrb()
      st.claude = o.parityClaude()
    }
    st.events = events.recentEvents
    st.sounds = events.recentSounds
    return st
  }

  func act(_ action: String, _ args: JSONValue) async -> JSONValue {
    switch action {
    case "quit":
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
      return ["ok": true]
    case "voice.hotkey":
      guard let hk = shellHotkey else { return ["ok": false, "error": "no hotkey"] }
      return hk.press() ? ["ok": true] : ["ok": false, "error": "The hotkey is not registered."]
    case "voice.sleep":
      voiceController?.sleep()
      return ["ok": .bool(voiceController != nil)]
    case "voice.wake":
      voiceController?.wake()
      return ["ok": .bool(voiceController != nil)]
    case "voice.hangup":
      voiceController?.hangup()
      return ["ok": .bool(voiceController != nil)]
    case "voice.type":
      guard let v = voiceController, let t = args["text"]?.stringValue else { return ["ok": false, "error": "no text"] }
      v.type(t)
      return ["ok": true]
    case "mic.play":
      guard let v = voiceController, let p = args["wav"]?.stringValue, p.hasPrefix("/") else { return ["ok": false, "error": "wav must be an absolute path"] }
      return v.playIntoMic(wav: URL(fileURLWithPath: p), gapMs: args["gapMs"]?.doubleValue ?? 0) ? ["ok": true] : ["ok": false, "error": "the fake microphone is off (ORBIT_FAKE_MIC)"]
    case "cursor.set":
      guard let o = overlays else { return ["ok": false, "error": "no overlays"] }
      if let x = args["x"]?.doubleValue, let y = args["y"]?.doubleValue { o.setTestCursor(ScreenPoint(x: x, y: y)) } else { o.setTestCursor(nil) }
      return ["ok": true]
    case "pointer":
      guard let o = overlays, let id = args["avatar"]?.stringValue, let type = args["type"]?.stringValue, let x = args["x"]?.doubleValue, let y = args["y"]?.doubleValue else { return ["ok": false, "error": "bad pointer"] }
      return o.pointer(avatar: id, type: type, x: x, y: y) ? ["ok": true] : ["ok": false, "error": "no such avatar"]
    case "avatar.eval":
      guard let o = overlays, let id = args["avatar"]?.stringValue, let name = args["probe"]?.stringValue,
            name.range(of: "^[a-z0-9-]+[.]js$", options: .regularExpression) != nil else { return ["ok": false, "error": "bad probe"] }
      guard let dir = Bundle.main.resourceURL?.appendingPathComponent("parity-probes"), let script = try? String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8) else { return ["ok": false, "error": .string("no probe \(name)")] }
      let v = await o.eval(avatar: id, script: script)
      if let e = v["error"]?.stringValue, v.objectValue?.count == 1 { return ["ok": false, "error": .string(e)] }
      return ["ok": true, "value": v]
    case "avatar.command":
      guard let o = overlays else { return ["ok": false, "error": "no overlays"] }
      var cmd: [String: JSONValue] = ["action": args["action"] ?? .null]
      if let d = args["dir"] { cmd["dir"] = d }
      return o.command(.object(cmd))
    case "settings.ui":
      guard let ui, let key = args["key"]?.stringValue else { return ["ok": false, "error": "no key"] }
      return await ui.settingsUISet(key: key, value: args["value"] ?? .null)
    case "settings.read":
      guard let ui, let key = args["key"]?.stringValue else { return ["ok": false, "error": "no key"] }
      let v = ui.settingsUIRead(key: key)
      if case .object(let o) = v, o["ok"] != nil { return v }
      return ["ok": true, "value": v]
    case "window.show":
      ui?.show(view: args["name"]?.stringValue ?? "main")
      return ["ok": .bool(ui != nil)]
    case "window.minimize":
      ui?.minimizeToOrb()
      return ["ok": .bool(ui != nil)]
    case "perms.set":
      ui?.setFakePerms(args)
      return ["ok": .bool(ui != nil)]
    case "onboarding.next":
      guard let ui else { return ["ok": false, "error": "not ready"] }
      let step = ui.parityOnboarding().step
      if let kind = ["mic": "microphone", "ax": "accessibility", "screen": "screen"][step] { events.add("perms.request", ["kind": .string(kind)]) }
      await ui.onboardingNext()
      return ["ok": true]
    default:
      return ["ok": false, "error": .string("\(action) is not in this build yet")]
    }
  }
}
