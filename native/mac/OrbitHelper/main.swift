// orbit-helper: Orbit's native helper on macOS (one small binary, several modes), the counterpart of
// the PowerShell helpers on Windows. Built by scripts/build-mac-helper.mjs, shipped inside Orbit.app
// (Contents/Resources/mac/orbit-helper), started by Orbit with JSON over stdin/stdout.
//
//   orbit-helper ax              --parent-pid N   reading and acting in windows (uia.ps1's protocol; AxServer.swift)
//   orbit-helper focus           --parent-pid N   the window in front (focus.ps1's protocol; Focus.swift)
//   orbit-helper claude-window   --parent-pid N   Claude's windows and prompt box (claude-window.ps1's; ClaudeWindow.swift)
//   orbit-helper capture --window ID --out PATH [--max-width N] [--no-ocr]   one picture + OCR (Capture.swift)
//   orbit-helper proc --pid N                     one process's program and arguments (Proc.swift)
//   orbit-helper perms [--prompt]                 {"ax":bool,"screen":bool}; --prompt asks for Accessibility
//   orbit-helper version | selftest
//
// The helper runs as a child of Orbit, so macOS counts it as Orbit for privacy permissions: the
// Accessibility and Screen Recording switches the user turns on for Orbit cover it.

import AppKit
import ApplicationServices

let helperVersion = "1.0.0"

let argv = Array(CommandLine.arguments.dropFirst())
let mode = argv.first ?? "version"
let flags = Flags(Array(argv.dropFirst()))
let parentPid = pid_t(flags.int("parent-pid", Int(getppid())))
Wins.orbitPid = parentPid
AX.setup()

func runForever() -> Never {
  _ = NSApplication.shared
  NSApplication.shared.setActivationPolicy(.prohibited) // no Dock icon, never active
  IO.watchParent(parentPid)
  RunLoop.main.run()
  exit(0)
}

switch mode {
case "ax":
  let server = AxServer()
  server.run()
  runForever()
case "focus":
  let f = FocusMode()
  DispatchQueue.main.async { f.run() }
  runForever()
case "claude-window":
  let c = ClaudeWindowMode(onlyPid: pid_t(flags.int("pid", 0)))
  DispatchQueue.main.async { c.run() }
  runForever()
case "capture":
  Capture.run(flags)
case "proc":
  Proc.run(flags)
case "perms":
  if flags.has("prompt") {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
  }
  if flags.has("prompt-screen") { _ = CGRequestScreenCaptureAccess() }
  IO.emit(["ax": AX.trusted, "screen": CGPreflightScreenCaptureAccess()])
case "selftest":
  SelfTest.run()
case "version":
  IO.emit(["version": helperVersion, "arch": machineArch()])
default:
  IO.emit(["ok": false, "error": "bad_mode", "message": "Unknown mode \(mode)."])
  exit(2)
}

func machineArch() -> String {
  #if arch(arm64)
  return "arm64"
  #else
  return "x86_64"
  #endif
}
