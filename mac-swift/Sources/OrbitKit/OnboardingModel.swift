// The permissions onboarding: a small state machine over what macOS has granted Orbit.
//
//   mic    (required) the microphone, to hear you. Asked once by macOS; if refused, System Settings.
//   ax     (required) Accessibility, so Orbit can type prompts into Claude, press Send and read the
//          Claude window (the orbit-helper's Accessibility driver).
//   screen (optional) Screen Recording, only for "look at this window" (a picture of that window).
// Which are needed, their reasons and "Turn on" (macOS's prompt once, then the pane) are the Electron
// Mac build's (ui/src/MacPermissions.tsx, electron/main.js "macOS permissions"). One difference: the
// Electron build shows a banner and Settings rows only; this one also walks through them in order.
//
// The steps run in that order; a granted one is passed by itself. The onboarding shows on the first
// launch and again whenever a required permission is missing, and the shell re-checks each time Orbit
// becomes active again (the user comes back from System Settings). "Not now" on a required step
// passes it for this launch only. With ORBIT_FAKE_PERMS set (parity/PROTOCOL.md), a fake answers the
// checks and requests only record what was asked: the real privacy settings are never touched.
import Foundation
import Observation

public enum MicPermission: String, Codable, Sendable, CaseIterable {
  case granted, denied, restricted
  case notDetermined = "not-determined"
}

public struct PermissionState: Codable, Equatable, Sendable {
  public var mic: MicPermission
  public var ax: Bool
  public var screen: Bool
  public init(mic: MicPermission, ax: Bool, screen: Bool) { self.mic = mic; self.ax = ax; self.screen = screen }
  public static let allGranted = PermissionState(mic: .granted, ax: true, screen: true)

  /** ORBIT_FAKE_PERMS: `{"mic":"granted|denied|not-determined|restricted","ax":bool,"screen":bool}` (missing keys: not granted). */
  public init?(fakeJSON text: String) {
    guard let v = try? JSONValue.parse(text) else { return nil }
    self.init(fake: v)
  }

  public init?(fake v: JSONValue) {
    guard case .object = v else { return nil }
    mic = v["mic"]?.stringValue.flatMap(MicPermission.init(rawValue:)) ?? .notDetermined
    ax = v["ax"]?.boolValue ?? false
    screen = v["screen"]?.boolValue ?? false
  }
}

public enum OnboardingStep: String, Codable, Sendable, CaseIterable {
  case mic, ax, screen, done
  public var required: Bool { self == .mic || self == .ax }
}

/** What a step's primary button does. */
public enum OnboardingAction: Equatable, Sendable {
  /** AVCaptureDevice.requestAccess(for: .audio): macOS's own question. */
  case requestMic
  /** AXIsProcessTrustedWithOptions with the prompt: macOS's dialog leading to System Settings. */
  case promptAccessibility
  /** CGRequestScreenCaptureAccess(): macOS's question (the first time), then System Settings. */
  case requestScreen
  /** Open a System Settings pane. */
  case openSettings(URL)
  /** Nothing to grant here (restricted by a device policy): carry on. */
  case carryOn
}

/** One screen of the onboarding: its words and buttons. */
public struct OnboardingScreen: Equatable, Sendable {
  public var step: OnboardingStep
  public var eyebrow: String
  public var title: String
  public var body: String
  public var primary: String
  public var action: OnboardingAction
  /** "Not now" / "Skip" (nil: none). */
  public var secondary: String?
  /** The System Settings pane for this permission. */
  public var settingsURL: URL?
}

public enum PrivacyPane {
  public static let microphone = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!
  public static let accessibility = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
  public static let screenCapture = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
}

/** The real checks and requests (OrbitUI's SystemPermissionProbe) or a fake. */
@MainActor
public protocol PermissionProbe: AnyObject {
  func current() -> PermissionState
  /** macOS's microphone question; answers whether it was granted. */
  func requestMic() async -> Bool
  func promptAccessibility()
  /** Answers whether it's granted now (false the first time: macOS asks and needs a relaunch). */
  func requestScreenCapture() -> Bool
  func open(_ url: URL)
}

@MainActor
public final class FakePermissionProbe: PermissionProbe {
  public var state: PermissionState
  /** What the onboarding asked for, in order: "mic", "ax", "screen", or a pane URL (tests, parity). */
  public private(set) var requests: [String] = []
  public init(_ state: PermissionState) { self.state = state }
  public func current() -> PermissionState { state }
  public func requestMic() async -> Bool { requests.append("mic"); return state.mic == .granted }
  public func promptAccessibility() { requests.append("ax") }
  public func requestScreenCapture() -> Bool { requests.append("screen"); return state.screen }
  public func open(_ url: URL) { requests.append(url.absoluteString) }
}

/** Whether the onboarding has been through once (a file in the profile folder; memory in tests). */
public protocol OnboardingStore: AnyObject {
  var completed: Bool { get set }
}

public final class MemoryOnboardingStore: OnboardingStore {
  public var completed: Bool
  public init(completed: Bool = false) { self.completed = completed }
}

public final class FileOnboardingStore: OnboardingStore {
  private let file: URL
  public init(directory: URL) { file = directory.appendingPathComponent("onboarding.json") }
  public var completed: Bool {
    get { ((try? Data(contentsOf: file)).flatMap { try? JSONValue.parse($0) })?["completed"]?.boolValue ?? false }
    set {
      try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? JSONValue.object(["completed": .bool(newValue)]).data().write(to: file, options: .atomic)
    }
  }
}

@MainActor
@Observable
public final class OnboardingModel {
  public private(set) var state: PermissionState
  /** Steps passed with "Not now" / "Skip" this launch. */
  public private(set) var skipped: Set<OnboardingStep> = []
  /** Permissions asked for once already: macOS shows each prompt once; after that, the pane. */
  public private(set) var askedOnce: Set<OnboardingStep> = []
  /** Something to tell the user on the current screen (e.g. after a refusal). */
  public private(set) var note: String?
  public private(set) var completedOnce: Bool

  @ObservationIgnored public private(set) var probe: PermissionProbe
  @ObservationIgnored private let store: OnboardingStore
  /** Called when the onboarding should show or hide (the launcher switches its view). */
  @ObservationIgnored public var onNeededChange: ((Bool) -> Void)?

  public init(probe: PermissionProbe, store: OnboardingStore) {
    self.probe = probe
    self.store = store
    state = probe.current()
    completedOnce = store.completed
  }

  /** The probe ORBIT_FAKE_PERMS asks for, else `real`. */
  public static func probe(environment: [String: String] = ProcessInfo.processInfo.environment, real: @autoclosure () -> PermissionProbe) -> PermissionProbe {
    if let s = environment["ORBIT_FAKE_PERMS"], let st = PermissionState(fakeJSON: s) { return FakePermissionProbe(st) }
    return real()
  }

  /** The first step still to do. */
  public var step: OnboardingStep {
    if state.mic != .granted && !skipped.contains(.mic) { return .mic }
    if !state.ax && !skipped.contains(.ax) { return .ax }
    if !state.screen && !skipped.contains(.screen) { return .screen }
    return .done
  }

  /** A required permission is missing (restricted mic can't be fixed here, so it doesn't count). */
  public var requiredMissing: Bool { (state.mic != .granted && state.mic != .restricted) || !state.ax }

  /** Should the onboarding be on screen? First launch, or a required permission missing, and a step left. */
  public var needed: Bool { step != .done && (!completedOnce || requiredMissing) }

  public var screen: OnboardingScreen { Self.screen(for: step, state: state, asked: askedOnce) }

  /**
   * The permissions as the Electron Mac build lists them (ui/src/MacPermissions.tsx ITEMS): the same
   * labels, reasons, and which are needed. Settings' "Mac permissions" rows and the main screen's
   * banner use these.
   */
  public struct Item: Equatable, Sendable, Identifiable {
    public var step: OnboardingStep
    public var label: String
    public var why: String
    public var needed: Bool
    public var id: String { step.rawValue }
  }

  public static let items: [Item] = [
    Item(step: .ax, label: "Accessibility", why: "To type your prompts into Claude, press Send and Stop, answer Claude's questions, follow its window, and work in the windows you ask about.", needed: true),
    Item(step: .mic, label: "Microphone", why: "To hear you (and for the offline “Hey Orbit”).", needed: true),
    Item(step: .screen, label: "Screen Recording", why: "Only to look at a window when you ask (“what's on this chart?”). Everything else works without it.", needed: false),
  ]

  public static func item(_ step: OnboardingStep) -> Item { items.first { $0.step == step }! }

  public func isOn(_ step: OnboardingStep) -> Bool {
    switch step {
    case .mic: return state.mic == .granted
    case .ax: return state.ax
    case .screen: return state.screen
    case .done: return true
    }
  }

  /** The main screen's banner while a needed permission is off (MacPermissionsBanner), else nil. */
  public var bannerText: (missing: [Item], text: String)? {
    let missing = Self.items.filter { $0.needed && !isOn($0.step) }
    guard let first = missing.first else { return nil }
    return (missing, "Orbit needs \(missing.map(\.label).joined(separator: " and ")) \(first.step == .ax ? "to use the Claude app for you." : "to hear you.")")
  }

  /** The step's screen. Its primary button asks with macOS's own prompt once, then opens the pane (as electron/main.js requestMacPermission). */
  public static func screen(for step: OnboardingStep, state: PermissionState, asked: Set<OnboardingStep> = []) -> OnboardingScreen {
    let turnOn = "Turn Orbit on in System Settings → Privacy & Security"
    switch step {
    case .mic:
      let why = item(.mic).why
      switch state.mic {
      case .denied:
        return OnboardingScreen(step: .mic, eyebrow: "Step 1 of 3 · Microphone", title: "Orbit can't use the microphone",
                                body: "\(why) \(turnOn) → Microphone, then come back here.",
                                primary: "Open System Settings", action: .openSettings(PrivacyPane.microphone), secondary: "Not now", settingsURL: PrivacyPane.microphone)
      case .restricted:
        return OnboardingScreen(step: .mic, eyebrow: "Step 1 of 3 · Microphone", title: "The microphone is restricted",
                                body: "Microphone access is restricted on this Mac (for example by a device policy), so Orbit can't hear you. You can still type to it.",
                                primary: "Continue", action: .carryOn, secondary: nil, settingsURL: PrivacyPane.microphone)
      default:
        return OnboardingScreen(step: .mic, eyebrow: "Step 1 of 3 · Microphone", title: "Let Orbit hear you",
                                body: "\(why) macOS asks once: choose Allow.",
                                primary: "Turn on", action: .requestMic, secondary: "Not now", settingsURL: PrivacyPane.microphone)
      }
    case .ax:
      let again = asked.contains(.ax)
      return OnboardingScreen(step: .ax, eyebrow: "Step 2 of 3 · Accessibility", title: "Let Orbit use the Claude app",
                              body: "\(item(.ax).why) \(turnOn) → Accessibility, then come back here.",
                              primary: again ? "Open System Settings" : "Turn on", action: again ? .openSettings(PrivacyPane.accessibility) : .promptAccessibility,
                              secondary: "Not now", settingsURL: PrivacyPane.accessibility)
    case .screen:
      let again = asked.contains(.screen)
      return OnboardingScreen(step: .screen, eyebrow: "Step 3 of 3 · Optional", title: "Let Orbit look at a window",
                              body: "\(item(.screen).why) \(turnOn) → Screen Recording. It takes effect after Orbit restarts.",
                              primary: again ? "Open System Settings" : "Turn on", action: again ? .openSettings(PrivacyPane.screenCapture) : .requestScreen,
                              secondary: "Skip", settingsURL: PrivacyPane.screenCapture)
    case .done:
      return OnboardingScreen(step: .done, eyebrow: "All set", title: "Orbit is ready",
                              body: "Press the hotkey or click Qubit to start talking.", primary: "Start", action: .carryOn, secondary: nil, settingsURL: nil)
    }
  }

  /** Read the permissions again (the app became active, or the fake changed). */
  public func recheck() {
    let was = needed
    let next = probe.current()
    if next != state {
      // Granted while away: whatever was said on that step no longer applies.
      note = nil
      state = next
    }
    finishIfDone()
    if needed != was { onNeededChange?(needed) }
  }

  /**
   * "Turn on" for one permission (the onboarding's button, Settings' rows, the banner): macOS's own
   * prompt the first time, the right System Settings pane after that (electron/main.js
   * requestMacPermission).
   */
  public func request(_ step: OnboardingStep) async {
    let was = needed
    switch step {
    case .mic where state.mic != .granted:
      if state.mic == .notDetermined {
        let ok = await probe.requestMic()
        state = probe.current()
        if !ok && state.mic != .granted { note = "macOS said no. You can turn it on in System Settings." }
      } else if state.mic == .denied {
        probe.open(PrivacyPane.microphone)
      }
    case .ax where !state.ax:
      if askedOnce.contains(.ax) { probe.open(PrivacyPane.accessibility) } else { probe.promptAccessibility() }
    case .screen where !state.screen:
      if askedOnce.contains(.screen) { probe.open(PrivacyPane.screenCapture) } else { _ = probe.requestScreenCapture() }
      state = probe.current()
    default: break
    }
    if step != .done { askedOnce.insert(step) }
    finishIfDone()
    if needed != was { onNeededChange?(needed) }
  }

  /** The onboarding's primary button. */
  public func primary() async {
    let s = screen
    if s.action == .carryOn {
      let was = needed
      skipped.insert(s.step)
      finishIfDone()
      if needed != was { onNeededChange?(needed) }
      return
    }
    await request(s.step)
  }

  /** "Not now" / "Skip": pass this step for this launch. */
  public func skip() {
    let was = needed
    guard step != .done else { return }
    skipped.insert(step)
    note = nil
    finishIfDone()
    if needed != was { onNeededChange?(needed) }
  }

  /** Replace the fake permission state (parity perms.set) and re-check as on returning to Orbit. */
  public func setFake(_ st: PermissionState) {
    if let fake = probe as? FakePermissionProbe { fake.state = st } else { probe = FakePermissionProbe(st) }
    recheck()
  }

  private func finishIfDone() {
    if step == .done && !completedOnce {
      completedOnce = true
      store.completed = true
    }
  }

  public func parity(shown: Bool) -> ParityOnboarding {
    ParityOnboarding(mic: state.mic.rawValue, ax: state.ax, screen: state.screen, step: step.rawValue, shown: shown)
  }
}
