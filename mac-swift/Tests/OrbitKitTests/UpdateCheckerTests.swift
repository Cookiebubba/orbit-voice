// The updater against a local fake of GitHub's release URLs (never the network).
import CryptoKit
import Foundation
import XCTest
@testable import OrbitKit

final class FakeGitHub: @unchecked Sendable {
  var server: TestHTTPServer!
  let zip = Data((0..<300_000).map { UInt8($0 % 251) })
  var latestVersion = "1.4.0"
  var corrupt = false
  var releases = #"[{"tag_name":"v1.5.0-beta.2","draft":false,"prerelease":true},{"tag_name":"v1.4.0","draft":false,"prerelease":false},{"tag_name":"v9.0.0","draft":true}]"#
  init() throws { server = try TestHTTPServer { [unowned self] in self.handle($0) } }
  var feed: UpdateFeed { UpdateFeed(web: server.base.appendingPathComponent("o/r"), api: server.base.appendingPathComponent("api/repos/o/r")) }
  var sha: String { Data(SHA512.hash(data: zip)).base64EncodedString() }

  func yml(_ v: String) -> String {
    """
    version: \(v)
    files:
      - url: Orbit-\(v)-x64-mac.zip
        sha512: \(corrupt ? "AAAA" : sha)
        size: \(zip.count)
      - url: Orbit-\(v)-arm64-mac.zip
        sha512: \(corrupt ? "AAAA" : sha)
        size: \(zip.count)
    path: Orbit-\(v)-arm64-mac.zip
    sha512: \(sha)
    releaseDate: '2026-10-01T00:00:00.000Z'
    """
  }

  func handle(_ r: TestHTTPServer.Request) -> TestHTTPServer.Response {
    switch r.path {
    case "/o/r/releases/latest/download/latest-mac.yml": return .text(yml(latestVersion))
    case "/o/r/releases/download/v1.5.0-beta.2/latest-mac.yml": return .text(yml("1.5.0-beta.2"))
    case "/api/repos/o/r/releases": return .json(releases)
    default:
      if r.path.hasSuffix(".zip") { return .init(status: 200, headers: ["Content-Type": "application/zip"], body: zip) }
      return .text("Not Found", status: 404)
    }
  }
}

final class UpdateLogicTests: XCTestCase {
  func testSemver() {
    func lt(_ a: String, _ b: String) -> Bool { SemVer(a)! < SemVer(b)! }
    XCTAssertTrue(lt("1.2.0", "1.3.0"))
    XCTAssertTrue(lt("1.3.0-beta.1", "1.3.0"))
    XCTAssertTrue(lt("1.3.0-beta.1", "1.3.0-beta.2"))
    XCTAssertTrue(lt("1.3.0-beta.2", "1.3.0-beta.10"))
    XCTAssertTrue(lt("1.3.0-alpha", "1.3.0-beta"))
    XCTAssertTrue(lt("1.3.0-1", "1.3.0-alpha"))
    XCTAssertTrue(lt("1.3.0-beta", "1.3.0-beta.1"))
    XCTAssertFalse(lt("v1.3.0", "1.3.0"))
    XCTAssertEqual(SemVer("v1.3.0+build.5")!, SemVer("1.3.0")!)
    XCTAssertNil(SemVer("1.3"))
    XCTAssertTrue(SemVer.allowsPrereleases("1.3.0-beta.1"))
    XCTAssertFalse(SemVer.allowsPrereleases("1.3.0"))
  }

  func testYmlAndArch() {
    let y = FakeGitHub.yml(nil)
    let info = ReleaseInfo.parse(yml: y)!
    XCTAssertEqual(info.version, "1.4.0")
    XCTAssertEqual(info.files.count, 2)
    XCTAssertEqual(info.file(arch: "arm64")?.url, "Orbit-1.4.0-arm64-mac.zip")
    XCTAssertEqual(info.file(arch: "x64")?.url, "Orbit-1.4.0-x64-mac.zip")
    XCTAssertEqual(info.files[0].size, 300_000)
    XCTAssertEqual(info.releaseDate, "2026-10-01T00:00:00.000Z")
    XCTAssertNil(ReleaseInfo.parse(yml: "files: []"))
  }

  func testErrorWords() {
    XCTAssertEqual(describeUpdateError("The Internet connection appears to be offline."), "Couldn't reach GitHub. Check your connection.")
    XCTAssertEqual(describeUpdateError("HTTP 404 for latest-mac.yml (404)"), "The newest release has no update info yet.")
    XCTAssertEqual(describeUpdateError("sha512 checksum mismatch"), "The download was damaged, so it was thrown away. It will retry.")
    XCTAssertEqual(describeUpdateError("weird"), "Couldn't check for updates.")
  }
}

extension FakeGitHub {
  static func yml(_: Void?) -> String {
    "version: 1.4.0\nfiles:\n  - url: Orbit-1.4.0-x64-mac.zip\n    sha512: abc\n    size: 300000\n  - url: Orbit-1.4.0-arm64-mac.zip\n    sha512: def\n    size: 300000\npath: Orbit-1.4.0-arm64-mac.zip\nsha512: def\nreleaseDate: '2026-10-01T00:00:00.000Z'\n"
  }
}

@MainActor
final class UpdateCheckerTests: XCTestCase {
  var dir: URL!
  override func setUp() async throws { dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-upd-\(UUID().uuidString)") }
  override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

  func testDevBuildsNeverCheck() async {
    let u = UpdateChecker(currentVersion: "1.3.0", isPackaged: false, downloadsDir: dir)
    XCTAssertEqual(u.state.status, .dev)
    let s = await u.check()
    XCTAssertEqual(s.status, .dev)
  }

  func testStableFindsDownloadsAndVerifies() async throws {
    let gh = try FakeGitHub()
    defer { gh.server.stop() }
    let u = UpdateChecker(currentVersion: "1.3.0", isPackaged: true, downloadsDir: dir, feed: gh.feed, arch: "arm64")
    var seen: [UpdateStatus] = []
    u.onChange = { if seen.last != $0.status { seen.append($0.status) } }
    let s = await u.check()
    XCTAssertEqual(s.status, .ready)
    XCTAssertEqual(s.version, "1.4.0")
    XCTAssertEqual(seen, [.checking, .available, .downloading, .ready])
    XCTAssertEqual(u.downloaded?.lastPathComponent, "Orbit-1.4.0-arm64-mac.zip")
    XCTAssertEqual(try Data(contentsOf: u.downloaded!), gh.zip)
    XCTAssertTrue(gh.server.requests.contains { $0.path.hasSuffix("/releases/latest/download/Orbit-1.4.0-arm64-mac.zip") })
    XCTAssertFalse(gh.server.requests.contains { $0.path.contains("/api/") }, "a stable install never reads the prerelease list")
    // Ready stays ready (no second check), and installing is off without the flag.
    let again = await u.check()
    XCTAssertEqual(again.status, .ready)
    XCTAssertFalse(u.installOnQuit())
  }

  func testUpToDate() async throws {
    let gh = try FakeGitHub()
    defer { gh.server.stop() }
    gh.latestVersion = "1.3.0"
    let u = UpdateChecker(currentVersion: "1.3.0", isPackaged: true, downloadsDir: dir, feed: gh.feed)
    let s = await u.check()
    XCTAssertEqual(s.status, .latest)
    XCTAssertNotNil(s.checkedAt)
    XCTAssertEqual(s.sentence, "Up to date.")
  }

  func testDamagedDownloadIsThrownAway() async throws {
    let gh = try FakeGitHub()
    defer { gh.server.stop() }
    gh.corrupt = true
    let u = UpdateChecker(currentVersion: "1.3.0", isPackaged: true, downloadsDir: dir, feed: gh.feed, arch: "x64")
    let s = await u.check()
    XCTAssertEqual(s.status, .error)
    XCTAssertEqual(s.message, "The download was damaged, so it was thrown away. It will retry.")
    XCTAssertNil(u.downloaded)
    let left = (try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("updates").path)) ?? []
    XCTAssertEqual(left, [])
  }

  func testBetaInstallTakesTheNewestBeta() async throws {
    let gh = try FakeGitHub()
    defer { gh.server.stop() }
    let u = UpdateChecker(currentVersion: "1.4.0-beta.1", isPackaged: true, downloadsDir: dir, feed: gh.feed, arch: "arm64")
    let s = await u.check()
    XCTAssertEqual(s.status, .ready)
    XCTAssertEqual(s.version, "1.5.0-beta.2")
    XCTAssertTrue(gh.server.requests.contains { $0.path == "/o/r/releases/download/v1.5.0-beta.2/Orbit-1.5.0-beta.2-arm64-mac.zip" })
  }

  func testMissingYml() async throws {
    let gh = try FakeGitHub()
    defer { gh.server.stop() }
    let u = UpdateChecker(currentVersion: "1.3.0", isPackaged: true, downloadsDir: dir, feed: UpdateFeed(web: gh.server.base.appendingPathComponent("none"), api: gh.feed.api))
    let s = await u.check()
    XCTAssertEqual(s.status, .error)
    XCTAssertEqual(s.message, "The newest release has no update info yet.")
  }

  func testNoServerSaysConnection() async throws {
    let u = UpdateChecker(currentVersion: "1.3.0", isPackaged: true, downloadsDir: dir, feed: UpdateFeed(web: URL(string: "http://127.0.0.1:9")!, api: URL(string: "http://127.0.0.1:9")!))
    let s = await u.check()
    XCTAssertEqual(s.status, .error)
    XCTAssertEqual(s.message, "Couldn't reach GitHub. Check your connection.")
  }
}
