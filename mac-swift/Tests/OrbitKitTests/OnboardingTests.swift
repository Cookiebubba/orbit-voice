import Foundation
import XCTest
@testable import OrbitKit

@MainActor
final class OnboardingTests: XCTestCase {
  func model(_ s: PermissionState, completed: Bool = false) -> (OnboardingModel, FakePermissionProbe, MemoryOnboardingStore) {
    let probe = FakePermissionProbe(s)
    let store = MemoryOnboardingStore(completed: completed)
    return (OnboardingModel(probe: probe, store: store), probe, store)
  }

  func testFakePermsJSON() {
    XCTAssertEqual(PermissionState(fakeJSON: #"{"mic":"restricted","ax":true,"screen":false}"#), PermissionState(mic: .restricted, ax: true, screen: false))
    XCTAssertEqual(PermissionState(fakeJSON: #"{"mic":"not-determined"}"#), PermissionState(mic: .notDetermined, ax: false, screen: false))
    XCTAssertNil(PermissionState(fakeJSON: "nope"))
    let p = OnboardingModel.probe(environment: ["ORBIT_FAKE_PERMS": #"{"mic":"granted","ax":true,"screen":true}"#], real: FakePermissionProbe(PermissionState(mic: .denied, ax: false, screen: false)))
    XCTAssertEqual(p.current(), .allGranted)
  }

  func testAllGrantedIsDoneAndHidden() {
    let (m, _, store) = model(.allGranted)
    XCTAssertEqual(m.step, .done)
    XCTAssertFalse(m.needed)
    m.recheck()
    XCTAssertTrue(store.completed)
    XCTAssertEqual(m.parity(shown: false), ParityOnboarding(mic: "granted", ax: true, screen: true, step: "done", shown: false))
  }

  func testWalksMicThenAxThenScreen() async {
    let (m, probe, store) = model(PermissionState(mic: .notDetermined, ax: false, screen: false))
    var shows: [Bool] = []
    m.onNeededChange = { shows.append($0) }
    XCTAssertEqual(m.step, .mic)
    XCTAssertTrue(m.needed)
    XCTAssertEqual(m.screen.action, .requestMic)
    XCTAssertTrue(m.screen.step.required)

    // Pressing the button asks macOS; the user says yes (the fake turns granted).
    probe.state.mic = .granted
    await m.primary()
    XCTAssertEqual(probe.requests, ["mic"])
    XCTAssertEqual(m.step, .ax)

    // Accessibility: macOS's prompt the first time, the pane after that.
    XCTAssertEqual(m.screen.action, .promptAccessibility)
    await m.primary()
    XCTAssertEqual(m.screen.action, .openSettings(PrivacyPane.accessibility))
    await m.primary()
    XCTAssertEqual(probe.requests, ["mic", "ax", PrivacyPane.accessibility.absoluteString])
    XCTAssertEqual(m.step, .ax, "nothing changes until the user turns it on")

    // Back from System Settings with it on.
    m.setFake(PermissionState(mic: .granted, ax: true, screen: false))
    XCTAssertEqual(m.step, .screen)
    XCTAssertFalse(m.screen.step.required)
    XCTAssertEqual(m.screen.secondary, "Skip")
    m.skip()
    XCTAssertEqual(m.step, .done)
    XCTAssertFalse(m.needed)
    XCTAssertTrue(store.completed)
    XCTAssertEqual(shows, [false])
  }

  func testDeniedMicOpensItsPane() async {
    let (m, probe, _) = model(PermissionState(mic: .denied, ax: true, screen: true))
    XCTAssertEqual(m.screen.action, .openSettings(PrivacyPane.microphone))
    XCTAssertEqual(m.screen.settingsURL?.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    await m.primary()
    XCTAssertEqual(probe.requests, [PrivacyPane.microphone.absoluteString])
  }

  func testRestrictedMicCarriesOn() async {
    let (m, _, _) = model(PermissionState(mic: .restricted, ax: true, screen: true))
    XCTAssertEqual(m.step, .mic)
    XCTAssertFalse(m.requiredMissing)
    await m.primary()
    XCTAssertEqual(m.step, .done)
  }

  func testShowsAgainWhileARequiredOneIsMissing() {
    // Once through, with Accessibility still off: shown again (a required one is missing).
    let (m, _, _) = model(PermissionState(mic: .granted, ax: false, screen: true), completed: true)
    XCTAssertTrue(m.needed)
    // Once through, only the optional one off: not shown.
    let (m2, _, _) = model(PermissionState(mic: .granted, ax: true, screen: false), completed: true)
    XCTAssertEqual(m2.step, .screen)
    XCTAssertFalse(m2.needed)
    // First launch, only the optional one off: shown.
    let (m3, _, _) = model(PermissionState(mic: .granted, ax: true, screen: false))
    XCTAssertTrue(m3.needed)
  }

  func testPanesAndItemsMatchTheElectronBuild() {
    XCTAssertEqual(PrivacyPane.accessibility.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    XCTAssertEqual(PrivacyPane.screenCapture.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    XCTAssertEqual(OnboardingModel.items.map(\.label), ["Accessibility", "Microphone", "Screen Recording"])
    XCTAssertEqual(OnboardingModel.items.map(\.needed), [true, true, false])
    let (m, _, _) = model(PermissionState(mic: .denied, ax: false, screen: false))
    XCTAssertEqual(m.bannerText?.text, "Orbit needs Accessibility and Microphone to use the Claude app for you.")
    let (m2, _, _) = model(PermissionState(mic: .denied, ax: true, screen: false))
    XCTAssertEqual(m2.bannerText?.text, "Orbit needs Microphone to hear you.")
  }

  func testFileStore() {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("orbit-ob-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let s = FileOnboardingStore(directory: dir)
    XCTAssertFalse(s.completed)
    s.completed = true
    XCTAssertTrue(FileOnboardingStore(directory: dir).completed)
  }
}
