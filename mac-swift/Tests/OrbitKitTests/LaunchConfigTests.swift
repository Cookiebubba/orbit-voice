// How Orbit Native was started: a release build ignores every test switch; a test build honours them.
import Foundation
import XCTest
@testable import OrbitKit

final class LaunchConfigTests: XCTestCase {
  let bundle = URL(fileURLWithPath: "/Applications/Orbit Native.app")
  let home = URL(fileURLWithPath: "/Users/someone")
  let switches = [
    "ORBIT_PROFILE_DIR": "/tmp/p", "PORT": "4521", "ORBIT_FAKE_DESKTOP": "/tmp/fake.mjs", "XAI_REALTIME_URL": "ws://127.0.0.1:1/x",
    "ORBIT_TEST_CLAUDE_PID": "123", "ORBIT_SPEECH": "core", "ORBIT_MCP_HOME": "/tmp/mcp", "SOMETHING_ELSE": "x",
  ]

  func testAReleaseBuildIgnoresTestSwitches() {
    let c = LaunchConfig.resolve(bundle: bundle, info: ["CFBundleIdentifier": "dev.orbit.voice.native"], env: switches, home: home)
    XCTAssertFalse(c.testing)
    XCTAssertEqual(c.profileDir.path, "/Users/someone/Library/Application Support/Orbit Native")
    XCTAssertEqual(c.port, 4317)
    // Nothing of the environment reaches the core, except that the app does the speech.
    XCTAssertEqual(c.sidecarEnv, ["ORBIT_SHELL_SPEECH": "1"])
    XCTAssertTrue(c.speechInApp, "ORBIT_SPEECH=core is a test switch")
  }

  func testATestBuildHonoursThem() {
    let c = LaunchConfig.resolve(bundle: bundle, info: ["OrbitParityAllowed": true], env: switches, home: home)
    XCTAssertTrue(c.testing)
    XCTAssertEqual(c.profileDir.path, "/tmp/p")
    XCTAssertEqual(c.port, 4521)
    XCTAssertFalse(c.speechInApp)
    XCTAssertEqual(c.sidecarEnv["ORBIT_FAKE_DESKTOP"], "/tmp/fake.mjs")
    XCTAssertEqual(c.sidecarEnv["XAI_REALTIME_URL"], "ws://127.0.0.1:1/x")
    XCTAssertEqual(c.sidecarEnv["ORBIT_TEST_CLAUDE_PID"], "123")
    XCTAssertEqual(c.sidecarEnv["ORBIT_PARITY_ALLOWED"], "1")
    XCTAssertNil(c.sidecarEnv["ORBIT_SHELL_SPEECH"], "the core does the speech here")
    XCTAssertNil(c.sidecarEnv["SOMETHING_ELSE"])
  }

  func testATestBuildChecksWhatItIsGiven() {
    var env = switches
    env["PORT"] = "80"
    env["ORBIT_PROFILE_DIR"] = ""
    env.removeValue(forKey: "ORBIT_SPEECH")
    let c = LaunchConfig.resolve(bundle: bundle, info: ["OrbitParityAllowed": "1"], env: env, home: home)
    XCTAssertEqual(c.port, 4317, "a privileged port is refused")
    XCTAssertEqual(c.profileDir.path, "/Users/someone/Library/Application Support/Orbit Native", "an empty profile path is ignored")
    XCTAssertTrue(c.speechInApp)
    XCTAssertEqual(c.sidecarEnv["ORBIT_SHELL_SPEECH"], "1")
  }
}
