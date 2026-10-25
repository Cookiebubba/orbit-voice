// OverlayDemo: hosts Orbit Native's overlays (OrbitOverlays' facade) against a running bridge, for
// manual and scripted checks, with its own stand-in host window. One binary, three roles:
//
//   OverlayDemo stand-in [--frame x,y,w,h]
//       The stand-in host window (a window with a "Prompt" text box near its bottom and a Send
//       button), plus an "Other app" window for a guest avatar. Never the real Claude app.
//   OverlayDemo claude-window --parent-pid N --pid P
//       A stand-in claude-window helper about that stand-in (no accessibility permission needed);
//       the tracker runs it when ORBIT_CLAUDE_HELPER points at this binary.
//   OverlayDemo --auth <the bridge's main sign-in link> [--avatar qubit|buddy|none] [--size 1-3]
//               [--orb] [--orb-stick] [--check <results.json>] [--shots <dir>]
//       The overlays. With --check it runs the scripted checks (Checks.swift), writes the results
//       and quits; otherwise it stays up for manual looks.
//
// Launch GUI roles with `open -n -g` so they run in the logged-in session, e.g.
//   open -n -g OverlayDemo.app --args stand-in
//   open -n -g --env ORBIT_TEST_CLAUDE_PID=<pid> --env ORBIT_CLAUDE_HELPER=<.../OverlayDemo> \
//        OverlayDemo.app --args --auth "http://127.0.0.1:4531/auth?t=..." --check /tmp/r.json
import AppKit
import OrbitKit
import OrbitOverlays

let argv = Array(CommandLine.arguments.dropFirst())

func flag(_ name: String) -> String? {
  guard let i = argv.firstIndex(of: "--\(name)"), i + 1 < argv.count else { return nil }
  return argv[i + 1]
}

let app = NSApplication.shared

switch argv.first {
case "stand-in":
  var frame = NSRect(x: 160, y: 180, width: 1000, height: 640)
  if let f = flag("frame")?.split(separator: ",").compactMap({ Double($0) }), f.count == 4 {
    frame = MainActor.assumeIsolated { ScreenSpace.appKit(Rect(x: f[0], y: f[1], w: f[2], h: f[3])) }
  }
  let delegate = MainActor.assumeIsolated { StandInApp(frame: frame) }
  app.delegate = delegate
  app.run()

case "claude-window":
  let pid = Int32(flag("pid") ?? "") ?? 0
  let parent = Int32(flag("parent-pid") ?? "") ?? 0
  app.setActivationPolicy(.prohibited)
  let helper = MainActor.assumeIsolated { StandInHelper(pid: pid, parent: parent) }
  MainActor.assumeIsolated { helper.run() }
  app.run()

default:
  guard let authText = flag("auth"), let auth = URL(string: authText), let scheme = auth.scheme, let host = auth.host, let port = auth.port,
        let base = URL(string: "\(scheme)://\(host):\(port)") else {
    FileHandle.standardError.write(Data("usage: OverlayDemo --auth <the bridge's sign-in link> [--avatar qubit|buddy|none] [--check out.json]\n".utf8))
    exit(2)
  }
  let delegate = MainActor.assumeIsolated { DemoHost(base: base, auth: auth) }
  app.delegate = delegate
  app.run()
}
