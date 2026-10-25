// Where Orbit Native keeps things and how it was started: the bundle's embedded Node and core, the
// profile folder, the bridge's port. The test switches (ORBIT_PROFILE_DIR, PORT, the fakes) count
// only in a test build (OrbitParityAllowed in Info.plist); a release build ignores them.
import Foundation

public struct LaunchConfig: Sendable, Equatable {
  public var testing: Bool
  public var profileDir: URL
  public var port: Int
  public var node: URL
  public var coreDir: URL
  public var sidecarScript: URL
  /** Env passed through to the sidecar (test switches only in test builds). */
  public var sidecarEnv: [String: String]
  /**
   * Claude voice's listening and speaking run in the app (phase 2), not the core; a test build can
   * switch back with ORBIT_SPEECH=core. The sidecar is told (ORBIT_SHELL_SPEECH=1), so the core
   * doesn't load the same speech models a second time.
   */
  public var speechInApp: Bool

  public static let testEnvKeys = ["XAI_REALTIME_URL", "ORBIT_FAKE_DESKTOP", "ORBIT_TEST_CLAUDE_PID", "ORBIT_PERSONA", "ORBIT_DRY_RUN_SENDS", "ORBIT_MCP_HOME"]

  public static func resolve(bundle: URL, info: [String: Any]?, env: [String: String], home: URL) -> LaunchConfig {
    let testing = (info?["OrbitParityAllowed"] as? Bool) == true || (info?["OrbitParityAllowed"] as? String) == "1"
    let res = bundle.appendingPathComponent("Contents/Resources")
    // Running from `swift run` (no bundle): the repo's own core and the Node on PATH.
    let inBundle = FileManager.default.fileExists(atPath: res.appendingPathComponent("core/src/server.js").path)
    let core: URL
    let node: URL
    if inBundle {
      core = res.appendingPathComponent("core")
      node = res.appendingPathComponent("node/bin/node")
    } else {
      core = URL(fileURLWithPath: env["ORBIT_CORE_DIR"] ?? FileManager.default.currentDirectoryPath)
      node = URL(fileURLWithPath: env["ORBIT_NODE"] ?? "/opt/homebrew/bin/node")
    }
    let defaultProfile = home.appendingPathComponent("Library/Application Support/Orbit Native")
    let profile = testing && env["ORBIT_PROFILE_DIR"].map({ !$0.isEmpty }) == true ? URL(fileURLWithPath: env["ORBIT_PROFILE_DIR"]!) : defaultProfile
    var port = 4317
    if testing, let p = env["PORT"].flatMap(Int.init), (1025...65535).contains(p) { port = p }
    var passed: [String: String] = [:]
    if testing {
      passed["ORBIT_PARITY_ALLOWED"] = "1"
      for k in testEnvKeys { if let v = env[k] { passed[k] = v } }
    }
    let speechInApp = !(testing && env["ORBIT_SPEECH"] == "core")
    if speechInApp { passed["ORBIT_SHELL_SPEECH"] = "1" }
    return LaunchConfig(testing: testing, profileDir: profile, port: port, node: node, coreDir: core, sidecarScript: core.appendingPathComponent("mac-swift/sidecar/sidecar.mjs"), sidecarEnv: passed, speechInApp: speechInApp)
  }
}
