// The parity driver's view of the shell (../../parity/PROTOCOL.md): state snapshots and actions, run
// on the main actor where the windows live.
import AppKit
import OrbitKit

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
    if !(hotkeys is UnregisteredHotkey) { f.append("hotkey") }
    if !(voice is IdleVoice) { f.append("voice") }
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
    st.voice.phase = voice.phase
    st.voice.asleep = voice.asleep
    st.voice.muted = voice.muted
    st.events = events.recentEvents
    st.sounds = events.recentSounds
    return st
  }

  func act(_ action: String, _ args: JSONValue) async -> JSONValue {
    switch action {
    case "quit":
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
      return ["ok": true]
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
