// What src/platform/system.js knows about a Mac, for finding and running Claude Code: the Claude
// app's data folder and the copies of Claude Code it bundles, the usual install folders, and the
// login shell's PATH (an app opened from Finder only gets /usr/bin:/bin:/usr/sbin:/sbin, so `claude`
// and the `node` an npm-installed Claude Code needs can be missing). The PATH itself is never logged.
import Foundation
import OrbitIntent
import OrbitKit

public enum MacSystem {
  /** ~/Library/Application Support/Claude (claudeAppDataDirs on darwin). */
  public static func claudeAppDataDirs(home: String) -> [String] { [join(home, "Library", "Application Support", "Claude")] }

  /** The folders Claude Code is usually installed in that a Finder-opened app doesn't have on PATH. */
  public static func wellKnownBinDirs(home: String) -> [String] {
    [join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global", "bin")]
  }

  /** The Claude app's own copies of Claude Code, newest version first (<x.y.z>/claude, then <x.y.z>/<build>/claude). */
  public static func desktopClaudeCandidates(home: String) -> [String] {
    var out: [String] = []
    for dir in claudeAppDataDirs(home: home) {
      let root = join(dir, "claude-code")
      let versions = listDirs(root).filter { JSRegExp(#"^\d+\.\d+\.\d+$"#).test($0) }.sorted { compareVersions($0, $1) < 0 }.reversed()
      for v in versions {
        out.append(join(root, v, "claude"))
        for sub in listDirs(join(root, v)) { out.append(join(root, v, sub, "claude")) }
      }
    }
    return out
  }

  /** a - b, numerically per part (as compareVersions: only the first three). */
  public static func compareVersions(_ a: String, _ b: String) -> Double {
    let pa = a.split(separator: ".", omittingEmptySubsequences: false).map { Double($0) ?? .nan }
    let pb = b.split(separator: ".", omittingEmptySubsequences: false).map { Double($0) ?? .nan }
    for i in 0..<3 {
      let x = i < pa.count ? pa[i] : .nan, y = i < pb.count ? pb[i] : .nan
      if x != y { return x - y }
    }
    return 0
  }

  // MARK: the login shell's PATH

  static let markA = "__ORBIT_PATH_START__"
  static let markB = "__ORBIT_PATH_END__"

  /** The login shell (an absolute, plain path from $SHELL, else zsh) asked to print its PATH between markers. */
  public static func loginShellCommand(env: [String: String]) -> (file: String, args: [String]) {
    let s = env["SHELL"] ?? ""
    let shell = s.hasPrefix("/") && !JSRegExp(#"[\s'"`$;&|<>]"#).test(s) ? s : "/bin/zsh"
    return (shell, ["-ilc", "printf '%s%s%s' '\(markA)' \"$PATH\" '\(markB)'"])
  }

  /** The absolute folders between the last start marker and the end marker after it, once each (at most 200). */
  public static func parseShellPath(_ out: String?) -> [String] {
    let s = out ?? ""
    guard let a = s.range(of: markA, options: .backwards), let b = s.range(of: markB, range: a.upperBound..<s.endIndex) else { return [] }
    var seen = Set<String>()
    var dirs: [String] = []
    for part in s[a.upperBound..<b.lowerBound].split(separator: ":", omittingEmptySubsequences: false) {
      let d = JS.trim(String(part))
      guard !d.isEmpty, d.hasPrefix("/"), !JSRegExp(#"[\0\r\n]"#).test(d), seen.insert(d).inserted else { continue }
      dirs.append(d)
    }
    return Array(dirs.prefix(200))
  }

  private static let shellPath = Locked<(key: String, dirs: [String])?>(nil)
  private static let shellJob = Locked<Task<[String], Never>?>(nil)

  /** The login shell's PATH folders: cached; asked once (5 s at most) when not yet known. */
  public static func loginShellPath(env: [String: String] = ProcessInfo.processInfo.environment, log: (@Sendable (String) -> Void)? = nil) async -> [String] {
    let key = env["SHELL"] ?? ""
    if let c = shellPath.get(), c.key == key { return c.dirs }
    let job: Task<[String], Never> = shellJob.update { job in
      if let job { return job }
      let t = Task.detached { () -> [String] in
        let (file, args) = loginShellCommand(env: env)
        var e = env
        e["TERM"] = "dumb"
        let r = await ChildProcess.run(file, args, cwd: NSHomeDirectory(), env: e, stdin: nil, timeout: 5)
        let dirs = parseShellPath(String(decoding: r?.stdout ?? Data(), as: UTF8.self))
        shellPath.update { c in if c == nil || c?.key != key { c = (key, dirs) } }
        log?("login shell PATH: \(dirs.count) folders")
        return shellPath.get()?.dirs ?? dirs
      }
      job = t
      return t
    }
    let dirs = await job.value
    shellJob.set(nil)
    return dirs
  }

  /** What's cached now (nil before the first answer). */
  public static var cachedShellPath: [String]? { shellPath.get()?.dirs }

  /** Tests: forget the cached PATH. */
  public static func resetShellPath() { shellPath.set(nil) }

  /** PATH, then the login shell's PATH, then the well-known folders, each once. */
  public static func searchDirs(env: [String: String], home: String, shellPath: [String]) -> [String] {
    let own = (env["PATH"] ?? env["Path"] ?? "").split(separator: ":").map(String.init)
    var seen = Set<String>()
    return (own + shellPath + wellKnownBinDirs(home: home)).filter { seen.insert($0).inserted }
  }

  /** The environment for Claude Code: this one with PATH widened as searchDirs has it. */
  public static func childEnv(_ base: [String: String], home: String = NSHomeDirectory(), shellPath: [String]) -> [String: String] {
    var e = base
    e["PATH"] = searchDirs(env: base, home: home, shellPath: shellPath).joined(separator: ":")
    return e
  }

  // MARK: small helpers (POSIX paths, as path.posix has them)

  static func join(_ parts: String...) -> String { normalize(parts.filter { !$0.isEmpty }.joined(separator: "/")) }

  /** path.posix.normalize for absolute or relative paths (no trailing slash kept). */
  static func normalize(_ p: String) -> String {
    let abs = p.hasPrefix("/")
    var out: [Substring] = []
    for seg in p.split(separator: "/") {
      if seg == "." { continue }
      if seg == "..", let last = out.last, last != ".." { out.removeLast(); continue }
      if seg == "..", abs { continue }
      out.append(seg)
    }
    let s = out.joined(separator: "/")
    return abs ? "/" + s : (s.isEmpty ? "." : s)
  }

  static func listDirs(_ dir: String) -> [String] {
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
    // (in the directory's own order, as readdirSync gives it: sorted by name on APFS)
    // (Directories themselves, not links to them: a Dirent's isDirectory.)
    return names.sorted().filter { (try? fm.attributesOfItem(atPath: join(dir, $0)))?[.type] as? FileAttributeType == .typeDirectory }
  }
}
