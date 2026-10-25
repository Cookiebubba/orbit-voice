// When Orbit's core (the Node sidecar) stops by itself, the shell can't carry on: the bridge, the
// voice and every page are behind it. Electron has no such case (its core runs in its own process, so
// the app goes with it); Orbit Native relaunches itself instead, quietly (as the orb, as after login),
// so the user gets Orbit back without doing anything. A core that keeps stopping is not relaunched
// forever: after `maxRestarts` stops within `window`, Orbit says so and stays quit.
//
// The stops are remembered in the profile (core-restarts.json), since every relaunch is a new process.
import Foundation

public struct CoreRecovery: Sendable {
  public enum Decision: Equatable, Sendable {
    /** Relaunch Orbit (quietly). */
    case relaunch
    /** It keeps stopping: tell the user, and quit. */
    case giveUp
  }

  public static let maxRestarts = 3
  public static let window: TimeInterval = 10 * 60
  /** The argument a relaunch passes, so the new copy starts quietly. */
  public static let relaunchArgument = "--orbit-restarted"

  private let file: URL

  public init(profileDir: URL) {
    file = profileDir.appendingPathComponent("core-restarts.json")
  }

  /** The core stopped at `now`: record it, and say what to do. */
  public func coreStopped(at now: Date = Date()) -> Decision {
    let recent = (stops() + [now.timeIntervalSince1970]).filter { now.timeIntervalSince1970 - $0 <= Self.window }
    save(recent)
    return recent.count > Self.maxRestarts ? .giveUp : .relaunch
  }

  /** The core has run well for a while: forget old stops. */
  public func ranWell(at now: Date = Date()) {
    let recent = stops().filter { now.timeIntervalSince1970 - $0 <= Self.window }
    if recent.isEmpty { try? FileManager.default.removeItem(at: file) } else { save(recent) }
  }

  func stops() -> [TimeInterval] {
    guard let data = try? Data(contentsOf: file), let v = try? JSONDecoder().decode([TimeInterval].self, from: data) else { return [] }
    return v.filter(\.isFinite)
  }

  private func save(_ v: [TimeInterval]) {
    guard let data = try? JSONEncoder().encode(Array(v.suffix(20))) else { return }
    try? data.write(to: file, options: .atomic)
  }

  /**
   * The shell line that waits for `pid` to exit, then opens `bundle` again in the background with
   * the relaunch argument (the single-instance lock is free by then), and `env` (a test run's own
   * variables, so the new copy uses the same profile and ports).
   */
  public static func relaunchScript(pid: Int32, bundle: URL, env: [String: String] = [:]) -> String {
    func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    let vars = env.sorted { $0.key < $1.key }.map { " --env " + q("\($0.key)=\($0.value)") }.joined()
    return "while kill -0 \(pid) 2>/dev/null; do sleep 0.2; done; open -n -g\(vars) \(q(bundle.path)) --args \(relaunchArgument)"
  }

  /** What a test build's relaunch passes on: its test switches (ORBIT_*, PORT, the fake Grok) and PATH. */
  public static func testEnvironment(_ env: [String: String]) -> [String: String] {
    env.filter { $0.key.hasPrefix("ORBIT_") || ["PORT", "XAI_REALTIME_URL", "PATH"].contains($0.key) }
  }
}
