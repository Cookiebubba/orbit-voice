// Updates from GitHub Releases, natively, from the same releases as the Windows app
// (electron/updater.js + electron-updater), but from Orbit Native's own feed in each release:
// latest-mac-native.yml (scripts/package.sh writes it, in electron-builder's latest-mac.yml shape)
// names the version, the Orbit-Native zips and their SHA-512. Only Orbit-Native zips are ever taken
// (file(arch:)), whatever else a release holds (older ones had the Electron Mac build's).
//
// Channels follow the installed version, as electron/updater.js: a stable install (1.2.0) reads
// /releases/latest (never a prerelease); a beta install (1.3.0-beta.1) reads the releases list and
// takes the newest beta or stable above it. Drafts never show (GitHub doesn't list them publicly).
//
// "Update automatically" on: checks 20 s after launch and every 6 hours, downloads in the background.
// Off: nothing is checked until "Check now" (which then downloads what it finds). A download is
// checked against the yml's SHA-512 before it counts as ready, and lands in the profile folder.
// Installing replaces the app bundle when Orbit quits; that needs a signed release, so it runs only
// when `installEnabled` is set (a release build: OrbitUpdateInstall in Info.plist, or
// ORBIT_UPDATE_INSTALL=1), and only for a copy that is Orbit Native, of the version the feed named,
// signed by the same signer as the running app (its designated requirement).
//
// Why not Sparkle: it reads its own EdDSA-signed appcast, so releases would need a second feed and
// signing key; this keeps one release pipeline for both builds and adds no dependency (the
// download is checked by SHA-512 and the install by code signature).
import CryptoKit
import Foundation
import Observation
import Security

public enum UpdateStatus: String, Sendable, Codable {
  /** Running from source: no updates. */
  case dev
  case idle, checking
  /** Up to date. */
  case latest
  /** A newer version was found (download not started). */
  case available
  case downloading
  /** Downloaded and verified: installs when Orbit quits. */
  case ready
  case error
}

public struct UpdateState: Equatable, Sendable {
  public var status: UpdateStatus
  public var version: String?
  public var percent: Int?
  public var message: String?
  public var checkedAt: Date?
  public init(status: UpdateStatus, version: String? = nil, percent: Int? = nil, message: String? = nil, checkedAt: Date? = nil) {
    self.status = status; self.version = version; self.percent = percent; self.message = message; self.checkedAt = checkedAt
  }

  /** Settings' sentence for it (Settings.tsx UpdatesSection). */
  public var sentence: String? {
    switch status {
    case .dev: return "You're running Orbit from source, so it doesn't update itself."
    case .checking: return "Checking for updates…"
    case .available: return "Orbit \(version ?? "") is available."
    case .downloading: return "Downloading Orbit \(version ?? "")… \(percent ?? 0)%"
    case .ready: return "Orbit \(version ?? "") is ready. It installs when you quit Orbit, or now if you restart."
    case .latest: return "Up to date."
    case .error: return message
    case .idle: return nil
    }
  }
}

// MARK: - Versions

/** Semantic versions with prereleases (semver.org precedence: 1.3.0-beta.1 < 1.3.0-beta.2 < 1.3.0). */
public struct SemVer: Comparable, Sendable, CustomStringConvertible {
  public var major: Int, minor: Int, patch: Int
  public var pre: [String]
  public init?(_ text: String) {
    var s = text.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
    if let plus = s.firstIndex(of: "+") { s = String(s[..<plus]) } // build metadata doesn't count
    let main: Substring
    if let dash = s.firstIndex(of: "-") {
      main = s[..<dash]
      pre = s[s.index(after: dash)...].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
      if pre.contains(where: { $0.isEmpty }) { return nil }
    } else { main = Substring(s); pre = [] }
    let nums = main.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
    guard nums.count == 3, let a = nums[0], let b = nums[1], let c = nums[2], a >= 0, b >= 0, c >= 0 else { return nil }
    major = a; minor = b; patch = c
  }
  public var isPrerelease: Bool { !pre.isEmpty }
  public var description: String { "\(major).\(minor).\(patch)" + (pre.isEmpty ? "" : "-" + pre.joined(separator: ".")) }

  public static func < (l: SemVer, r: SemVer) -> Bool {
    if l.major != r.major { return l.major < r.major }
    if l.minor != r.minor { return l.minor < r.minor }
    if l.patch != r.patch { return l.patch < r.patch }
    if l.pre.isEmpty != r.pre.isEmpty { return !l.pre.isEmpty } // a prerelease comes before its release
    for (a, b) in zip(l.pre, r.pre) where a != b {
      switch (Int(a), Int(b)) {
      case let (x?, y?): return x < y
      case (_?, nil): return true // numeric identifiers sort before alphanumeric ones
      case (nil, _?): return false
      default: return a < b
      }
    }
    return l.pre.count < r.pre.count
  }
  public static func == (l: SemVer, r: SemVer) -> Bool { !(l < r) && !(r < l) }

  /** electron/updater.js allowsPrereleases */
  public static func allowsPrereleases(_ version: String) -> Bool {
    version.trimmingCharacters(in: .whitespaces).range(of: "^v?\\d+\\.\\d+\\.\\d+-[0-9A-Za-z]", options: .regularExpression) != nil
  }
}

// MARK: - latest-mac.yml

public struct ReleaseFile: Equatable, Sendable {
  public var url: String
  public var sha512: String
  public var size: Int?
}

public struct ReleaseInfo: Equatable, Sendable {
  public var version: String
  public var files: [ReleaseFile]
  public var path: String?
  public var sha512: String?
  public var releaseDate: String?

  /**
   * latest-mac-native.yml, in electron-builder's latest-mac.yml shape (small and fixed; no YAML library needed):
   *   version: 1.3.0
   *   files:
   *     - url: Orbit-Native-1.3.0-arm64-mac.zip
   *       sha512: <base64>
   *       size: 123
   *   path: Orbit-Native-1.3.0-arm64-mac.zip
   *   sha512: <base64>
   *   releaseDate: '2026-10-01T00:00:00.000Z'
   */
  public static func parse(yml text: String) -> ReleaseInfo? {
    func unquote(_ s: Substring) -> String {
      var v = s.trimmingCharacters(in: .whitespaces)
      if v.count >= 2, let f = v.first, let l = v.last, (f == "'" && l == "'") || (f == "\"" && l == "\"") { v = String(v.dropFirst().dropLast()) }
      return v
    }
    var top = [String: String]()
    var files = [ReleaseFile]()
    var cur: [String: String]? = nil
    var inFiles = false
    func flush() {
      if let c = cur, let url = c["url"] { files.append(ReleaseFile(url: url, sha512: c["sha512"] ?? "", size: c["size"].flatMap { Int($0) })) }
      cur = nil
    }
    for raw in text.split(whereSeparator: \.isNewline) {
      let line = raw.replacingOccurrences(of: "\t", with: "  ")
      if line.trimmingCharacters(in: .whitespaces).isEmpty || line.trimmingCharacters(in: .whitespaces).hasPrefix("#") { continue }
      let indent = line.prefix(while: { $0 == " " }).count
      var body = Substring(line.dropFirst(indent))
      if indent == 0 {
        flush(); inFiles = false
        guard let colon = body.firstIndex(of: ":") else { continue }
        let key = String(body[..<colon])
        let value = unquote(body[body.index(after: colon)...])
        if key == "files" { inFiles = true } else { top[key] = value }
        continue
      }
      guard inFiles else { continue }
      if body.hasPrefix("- ") { flush(); cur = [:]; body = body.dropFirst(2) }
      guard cur != nil, let colon = body.firstIndex(of: ":") else { continue }
      cur![String(body[..<colon]).trimmingCharacters(in: .whitespaces)] = unquote(body[body.index(after: colon)...])
    }
    flush()
    guard let version = top["version"], !version.isEmpty else { return nil }
    return ReleaseInfo(version: version, files: files, path: top["path"], sha512: top["sha512"], releaseDate: top["releaseDate"])
  }

  /**
   * Orbit Native's zip for this Mac (arm64 names say so; the Intel one doesn't). Only files named
   * for Orbit Native ("Orbit-Native-1.4.0-arm64-mac.zip"): never the Electron app's.
   */
  public func file(arch: String) -> ReleaseFile? {
    let pool = files.filter {
      let name = ($0.url as NSString).lastPathComponent.lowercased()
      return name.hasSuffix(".zip") && name.contains("native")
    }
    if arch == "arm64" { return pool.first { $0.url.contains("arm64") } ?? pool.first { !$0.url.contains("x64") } }
    return pool.first { !$0.url.contains("arm64") }
  }
}

/** electron/updater.js describeUpdateError: a short, plain reason for Settings. */
public func describeUpdateError(_ message: String) -> String {
  func has(_ p: String) -> Bool { message.range(of: p, options: [.regularExpression, .caseInsensitive]) != nil }
  if has("net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|offline|could not connect|timed out|cannot find host|network connection") { return "Couldn't reach GitHub. Check your connection." }
  if has("(latest|beta)(-mac)?(-native)?\\.yml|404") { return "The newest release has no update info yet." }
  if has("code signature|code ?sign|not signed|SecCode|designated requirement") { return "Updates on a Mac need a signed copy of Orbit. Download the new version from GitHub instead." }
  if has("sha512|checksum") { return "The download was damaged, so it was thrown away. It will retry." }
  return "Couldn't check for updates."
}

/** Where releases are read from (GitHub; a local HTTP fixture in tests). */
public struct UpdateFeed: Sendable {
  /** https://github.com/<owner>/<repo> */
  public var web: URL
  /** https://api.github.com/repos/<owner>/<repo> */
  public var api: URL
  public init(web: URL, api: URL) { self.web = web; self.api = api }
  public static let github = UpdateFeed(web: URL(string: "https://github.com/Cookiebubba/orbit-voice")!, api: URL(string: "https://api.github.com/repos/Cookiebubba/orbit-voice")!)
}

private struct UpdateFailure: Error { var message: String }

/** A download task's progress, as whole percents. */
private final class DownloadProgress: NSObject, URLSessionDownloadDelegate, Sendable {
  let report: @Sendable (Int) -> Void
  init(_ report: @escaping @Sendable (Int) -> Void) { self.report = report }
  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    if totalBytesExpectedToWrite > 0 { report(Int(totalBytesWritten * 100 / totalBytesExpectedToWrite)) }
  }
  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}

@MainActor
@Observable
public final class UpdateChecker {
  public private(set) var state: UpdateState
  public let currentVersion: String
  @ObservationIgnored public var onChange: ((UpdateState) -> Void)?
  /** Replace the app on quit (needs a signed release). */
  @ObservationIgnored public var installEnabled: Bool
  /** The verified download, once ready. */
  public private(set) var downloaded: URL?

  @ObservationIgnored private let isPackaged: Bool
  @ObservationIgnored private let feed: UpdateFeed
  @ObservationIgnored private let downloadsDir: URL
  @ObservationIgnored private let arch: String
  @ObservationIgnored private let session: URLSession
  @ObservationIgnored private var timer: Task<Void, Never>?
  @ObservationIgnored private var found: (info: ReleaseInfo, assetBase: URL)?
  @ObservationIgnored private let log: (String) -> Void

  /** Orbit Native's feed in each GitHub release (Electron's is latest-mac.yml). */
  public nonisolated static let feedFile = "latest-mac-native.yml"
  /** The bundle identifier an update must have. */
  public nonisolated static let bundleID = "dev.orbit.voice.native"
  /** A release build may replace itself (build-app.sh writes this key for a Developer ID build). */
  public nonisolated static var releaseInstallAllowed: Bool {
    ProcessInfo.processInfo.environment["ORBIT_UPDATE_INSTALL"] == "1" || (Bundle.main.object(forInfoDictionaryKey: "OrbitUpdateInstall") as? Bool) == true
  }

  public static let firstCheckDelay: Duration = .seconds(20)
  public static let checkEvery: Duration = .seconds(6 * 3600)

  public init(currentVersion: String, isPackaged: Bool, downloadsDir: URL, feed: UpdateFeed = .github, arch: String = UpdateChecker.machineArch,
              session: URLSession? = nil, installEnabled: Bool = UpdateChecker.releaseInstallAllowed,
              log: @escaping (String) -> Void = { _ in }) {
    self.currentVersion = currentVersion
    self.isPackaged = isPackaged
    self.downloadsDir = downloadsDir
    self.feed = feed
    self.arch = arch
    self.installEnabled = installEnabled
    self.log = log
    if let session { self.session = session } else {
      let cfg = URLSessionConfiguration.ephemeral
      cfg.timeoutIntervalForRequest = 30
      cfg.httpAdditionalHeaders = ["User-Agent": "Orbit-Native-Updater"]
      self.session = URLSession(configuration: cfg)
    }
    state = UpdateState(status: isPackaged ? .idle : .dev)
  }

  public nonisolated static var machineArch: String {
    #if arch(arm64)
    return "arm64"
    #else
    return "x64"
    #endif
  }

  private func set(_ s: UpdateState) {
    state = s
    onChange?(s)
  }

  /** "Update automatically": check after 20 s and every 6 hours (off: only "Check now"). */
  public func setAuto(_ on: Bool, first: Duration = UpdateChecker.firstCheckDelay, every: Duration = UpdateChecker.checkEvery) {
    timer?.cancel()
    timer = nil
    guard isPackaged, on else { return }
    timer = Task { [weak self] in
      try? await Task.sleep(for: first)
      while !Task.isCancelled {
        await self?.check()
        try? await Task.sleep(for: every)
      }
    }
  }

  public func stop() { timer?.cancel(); timer = nil }

  /** Find the newest release for this install's channel: its yml and where its files are. */
  func findRelease() async throws -> (info: ReleaseInfo, assetBase: URL)? {
    if SemVer.allowsPrereleases(currentVersion) {
      // A beta install: the releases list (newest first), betas and stables both.
      let list = try await fetch(feed.api.appendingPathComponent("releases").appending(queryItems: [URLQueryItem(name: "per_page", value: "20")]))
      guard let releases = (try? JSONValue.parse(list))?.arrayValue else { throw UpdateFailure(message: "bad releases list") }
      let current = SemVer(currentVersion)
      var best: (SemVer, String)?
      for r in releases where r["draft"]?.boolValue != true {
        guard let tag = r["tag_name"]?.stringValue, let v = SemVer(tag) else { continue }
        if let c = current, !(c < v) { continue }
        if best == nil || best!.0 < v { best = (v, tag) }
      }
      guard let (_, tag) = best else { return nil }
      let base = feed.web.appendingPathComponent("releases/download/\(tag)")
      guard let info = ReleaseInfo.parse(yml: String(decoding: try await fetch(base.appendingPathComponent(Self.feedFile)), as: UTF8.self)) else { throw UpdateFailure(message: "\(Self.feedFile) unreadable") }
      return (info, base)
    }
    // A stable install: the latest release only (GitHub never points "latest" at a prerelease).
    let base = feed.web.appendingPathComponent("releases/latest/download")
    guard let info = ReleaseInfo.parse(yml: String(decoding: try await fetch(base.appendingPathComponent(Self.feedFile)), as: UTF8.self)) else { throw UpdateFailure(message: "\(Self.feedFile) unreadable") }
    return (info, base)
  }

  private func fetch(_ url: URL) async throws -> Data {
    let (data, resp) = try await session.data(from: url)
    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
    guard code == 200 else { throw UpdateFailure(message: "HTTP \(code) for \(url.lastPathComponent)\(code == 404 ? " (404)" : "")") }
    return data
  }

  /** "Check now" (and the timer): find a newer release and download it. */
  @discardableResult
  public func check(download: Bool = true) async -> UpdateState {
    guard isPackaged, ![.checking, .downloading, .ready].contains(state.status) else { return state }
    set(UpdateState(status: .checking))
    do {
      guard let (info, base) = try await findRelease(), let v = SemVer(info.version), let c = SemVer(currentVersion), c < v else {
        set(UpdateState(status: .latest, checkedAt: Date()))
        return state
      }
      found = (info, base)
      set(UpdateState(status: .available, version: info.version, checkedAt: Date()))
      if download { await self.download() }
    } catch {
      let msg = (error as? UpdateFailure)?.message ?? error.localizedDescription
      log("Update check failed: \(msg.prefix(300))")
      set(UpdateState(status: .error, message: describeUpdateError(msg)))
    }
    return state
  }

  /** Download what check() found, verify its SHA-512, keep it in the profile's updates folder. */
  public func download() async {
    guard let (info, base) = found, let file = info.file(arch: arch) else {
      if found != nil { set(UpdateState(status: .error, message: "The newest release has no update info yet.")) }
      return
    }
    set(UpdateState(status: .downloading, version: info.version, percent: 0))
    let dir = downloadsDir.appendingPathComponent("updates", isDirectory: true)
    let name = (file.url as NSString).lastPathComponent
    let dest = dir.appendingPathComponent(name)
    let part = dir.appendingPathComponent(name + ".part")
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: part)
      // electron-builder writes file names relative to the release; an absolute https URL is used as is.
      let absolute = file.url.hasPrefix("https://") || file.url.hasPrefix("http://")
      let url = absolute ? (URL(string: file.url) ?? base.appendingPathComponent(name)) : base.appendingPathComponent(file.url)
      let version = info.version
      // A download task (off the main thread), its progress reported back here.
      let progress = DownloadProgress { [weak self] pct in
        Task { @MainActor in
          guard let self, self.state.status == .downloading, (self.state.percent ?? 0) < pct else { return }
          self.set(UpdateState(status: .downloading, version: version, percent: min(99, pct)))
        }
      }
      let (tmp, resp) = try await session.download(from: url, delegate: progress)
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      guard code == 200 else { try? FileManager.default.removeItem(at: tmp); throw UpdateFailure(message: "HTTP \(code) for \(name)") }
      try FileManager.default.moveItem(at: tmp, to: part)
      let digest = try await Task.detached { try Self.sha512Base64(of: part) }.value
      guard !file.sha512.isEmpty, digest == file.sha512 else {
        try? FileManager.default.removeItem(at: part)
        throw UpdateFailure(message: "sha512 checksum mismatch")
      }
      try? FileManager.default.removeItem(at: dest)
      try FileManager.default.moveItem(at: part, to: dest)
      downloaded = dest
      log("Orbit \(info.version) downloaded; it installs when Orbit quits")
      set(UpdateState(status: .ready, version: info.version))
    } catch {
      try? FileManager.default.removeItem(at: part)
      let msg = (error as? UpdateFailure)?.message ?? error.localizedDescription
      log("Update download failed: \(msg.prefix(300))")
      set(UpdateState(status: .error, message: describeUpdateError(msg)))
    }
  }

  /** SHA-512 of a file, read in 1 MB chunks, as base64 (latest-mac.yml's form). */
  nonisolated static func sha512Base64(of file: URL) throws -> String {
    let h = try FileHandle(forReadingFrom: file)
    defer { try? h.close() }
    var hasher = SHA512()
    while let chunk = try h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
    return Data(hasher.finalize()).base64EncodedString()
  }

  /**
   * On quit (or "Restart to update"): unpack the verified zip next to the running app and swap it in
   * after Orbit exits. Only with installEnabled (a signed release); answers whether it was started.
   */
  @discardableResult
  public func installOnQuit(appBundle: URL = Bundle.main.bundleURL, relaunch: Bool = false) -> Bool {
    guard installEnabled, state.status == .ready, let zip = downloaded, appBundle.pathExtension == "app" else { return false }
    let staging = downloadsDir.appendingPathComponent("updates/staged", isDirectory: true)
    try? FileManager.default.removeItem(at: staging)
    try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
    // ditto keeps the bundle's signature, symlinks and extended attributes intact.
    let unzip = Process()
    unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    unzip.arguments = ["-x", "-k", zip.path, staging.path]
    guard (try? unzip.run()) != nil else { return false }
    unzip.waitUntilExit()
    guard unzip.terminationStatus == 0,
          let newApp = (try? FileManager.default.contentsOfDirectory(at: staging, includingPropertiesForKeys: nil))?.first(where: { $0.pathExtension == "app" }) else { return false }
    // Only a copy that passes Gatekeeper's signature check replaces this one.
    let verify = Process()
    verify.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    verify.arguments = ["--verify", "--deep", "--strict", newApp.path]
    guard (try? verify.run()) != nil else { return false }
    verify.waitUntilExit()
    guard verify.terminationStatus == 0 else {
      set(UpdateState(status: .error, message: describeUpdateError("code signature invalid")))
      return false
    }
    // And it is Orbit Native, the version the feed named, from the same signer as this copy.
    if let why = Self.refuseUpdate(newApp, replacing: appBundle, version: state.version) {
      log("Update not installed: \(why)")
      set(UpdateState(status: .error, message: describeUpdateError("code signature invalid")))
      return false
    }
    // A tiny shell waits for this process to exit, then swaps the bundles (and reopens if asked).
    let pid = ProcessInfo.processInfo.processIdentifier
    func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    let old = appBundle.path + ".old"
    let script = "while kill -0 \(pid) 2>/dev/null; do sleep 0.2; done; rm -rf \(q(old)); mv \(q(appBundle.path)) \(q(old)) && mv \(q(newApp.path)) \(q(appBundle.path)) && rm -rf \(q(old))\(relaunch ? "; open \(q(appBundle.path))" : "")"
    let sh = Process()
    sh.executableURL = URL(fileURLWithPath: "/bin/sh")
    sh.arguments = ["-c", script]
    return (try? sh.run()) != nil
  }
}

extension UpdateChecker {
  /**
   * Why `newApp` may not replace `current`, or nil when it may: it must be Orbit Native (bundle
   * identifier), of `version` (when given), and satisfy the running copy's designated requirement,
   * so only the same signer's build installs (an ad-hoc build's requirement is its own cdhash, so it
   * never takes another build).
   */
  public nonisolated static func refuseUpdate(_ newApp: URL, replacing current: URL, version: String?) -> String? {
    guard let info = NSDictionary(contentsOf: newApp.appendingPathComponent("Contents/Info.plist")) else { return "no Info.plist" }
    guard info["CFBundleIdentifier"] as? String == bundleID else { return "not Orbit Native" }
    if let version, info["CFBundleShortVersionString"] as? String != version { return "not version \(version)" }
    var mine: SecStaticCode?
    var theirs: SecStaticCode?
    var req: SecRequirement?
    guard SecStaticCodeCreateWithPath(current as CFURL, [], &mine) == errSecSuccess, let mine,
          SecCodeCopyDesignatedRequirement(mine, [], &req) == errSecSuccess, let req else { return "this copy's signature can't be read" }
    guard SecStaticCodeCreateWithPath(newApp as CFURL, [], &theirs) == errSecSuccess, let theirs else { return "the update's signature can't be read" }
    let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
    return SecStaticCodeCheckValidity(theirs, flags, req) == errSecSuccess ? nil : "signed by someone else"
  }
}
