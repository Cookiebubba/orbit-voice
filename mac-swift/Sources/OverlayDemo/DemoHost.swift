// OverlayDemo's host role: the Overlays facade against a bridge, with settings from the command line
// standing in for Orbit's, and the sidecar's side played by a log (and, in the checks, by hand).
import AppKit
import OrbitKit
import OrbitOverlays

@MainActor
final class DemoHost: NSObject, NSApplicationDelegate {
  let base: URL
  let auth: URL
  var settings: [String: JSONValue] = [:]
  private(set) var overlays: Overlays!
  /** The facade's events (avatar.created/closed/talk/lift/sound/command), with when (ms). */
  var events: [(at: Double, type: String, data: JSONValue)] = []
  var sounds: [String] = []
  var talks = 0
  var sent: [JSONValue] = []

  init(base: URL, auth: URL) {
    self.base = base
    self.auth = auth
  }

  static func say(_ s: String) {
    let line = "[\(String(format: "%.3f", Date().timeIntervalSince1970))] \(s)\n"
    FileHandle.standardOutput.write(Data(line.utf8))
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.setActivationPolicy(.accessory) // no Dock icon, never the active app
    let kind = flag("avatar") ?? "qubit"
    settings = [
      "avatar": kind == "none" ? .null : .string(kind),
      "buddySize": .number(Double(flag("size") ?? "2") ?? 2),
      "showOrb": .bool(argv.contains("--orb")),
      "orbStick": .bool(argv.contains("--orb-stick")),
      "avatarClickTalk": true, "avatarThrow": true, "avatarThrowSound": true,
      "anywhere": true, "anywhereMouse": true,
    ]
    var authLinks: [String: URL] = ["main": auth]
    for v in ["orb", "qubit", "buddy", "mouse"] { authLinks[v] = URL(string: auth.absoluteString + "&view=\(v)") }
    overlays = Overlays(
      endpoints: BridgeEndpoints(base: base, auth: authLinks),
      settings: { [unowned self] in self.settings },
      send: { [unowned self] m in
        self.sent.append(m)
        DemoHost.say("-> sidecar \(m.text)")
      },
      onTalk: { [unowned self] in
        self.talks += 1
        DemoHost.say("talk (the avatar was clicked)")
      },
      onSound: { [unowned self] name in
        self.sounds.append(name)
        DemoHost.say("sound \(name)")
      },
      onOrb: { e in DemoHost.say("orb \(e)") },
      onEvent: { [unowned self] type, data in
        self.events.append((MainClock.shared.now, type, data))
        DemoHost.say("event \(type) \(data.text)")
      },
      log: { m in DemoHost.say(m) }
    )
    overlays.start()
    if argv.contains("--orb") { overlays.showOrb() }
    DemoHost.say("overlays up: avatar \(kind), helper \(ClaudeWindowTracker.defaultHelperPath() ?? "none"), test pid \(ClaudeWindowTracker.testClaudePid)")
    if let out = flag("check") {
      Task { @MainActor in
        let results = await Checks(host: self).run()
        try? results.data(pretty: true).write(to: URL(fileURLWithPath: out))
        DemoHost.say("checks written to \(out)")
        self.overlays.stop()
        try? await Task.sleep(for: .milliseconds(300))
        exit(0)
      }
    }
  }

  func change(_ key: String, _ value: JSONValue) {
    settings[key] = value
    overlays.settingsChanged([key])
  }
}
