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
  var features: [String] { ["settings"] }

  func snapshot() -> ParityState {
    var st = ParityState()
    st.events = events.recentEvents
    st.sounds = events.recentSounds
    return st
  }

  func act(_ action: String, _ args: JSONValue) async -> JSONValue {
    switch action {
    case "quit":
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
      return ["ok": true]
    default:
      return ["ok": false, "error": .string("\(action) is not in this build yet")]
    }
  }
}
