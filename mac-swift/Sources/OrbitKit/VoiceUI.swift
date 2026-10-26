// What the launcher needs from the voice client and the global hotkey. The voice agent's controller
// and hotkey satisfy these; previews, tests and UIDemo use the fakes below.
//
// The launcher redraws from these through Observation: make the controller an @Observable class
// (or any class whose property reads call ObservationRegistrar.access).
import Foundation
import Observation

/** One line of the conversation (ui/src/useVoice.ts Caption). */
public struct VoiceCaption: Equatable, Sendable, Identifiable {
  public enum Who: String, Sendable { case you, grok, note, error, sent }
  public var id: String
  public var who: Who
  public var text: String
  public var at: Date
  public init(id: String, who: Who, text: String, at: Date = Date()) { self.id = id; self.who = who; self.text = text; self.at = at }
}

// (VoiceDraft, a prompt waiting for your yes, is in Voice/RealtimeEvent.swift.)

/** The voice, as the launcher shows and drives it (the page's useVoice()). */
@MainActor
public protocol VoiceUI: AnyObject, Observable {
  var phase: VoicePhase { get }
  /** Connected but not listening (going to sleep, or "one question" mode answering). */
  var asleep: Bool { get }
  /** The mic hears speech right now. */
  var hearing: Bool { get }
  var muted: Bool { get }
  /** Mic and voice levels, 0...1 (Qubit's eye follows them). */
  var inputLevel: Double { get }
  var outputLevel: Double { get }
  var captions: [VoiceCaption] { get }
  var draft: VoiceDraft? { get }
  /** A prompt is being typed into Claude now. */
  var sending: Bool { get }
  /** The Claude session open in the app (the title bar's switcher shows it). */
  var sessionTitle: String? { get set }

  /** What the global hotkey does: start when off, otherwise sleep / wake (the page's toggleSleep). */
  func hotkey()
  /** Start talking (the big mic button). */
  func start()
  /** Wake from asleep (a click on Qubit while asleep). */
  func wake()
  /** Go to sleep: hangs up. */
  func sleep()
  func toggleMute()
  /** Type a message instead of speaking (the typing box). */
  func type(_ text: String)
  /** Ask about something out loud (the session switcher's "Ask"), starting if needed. */
  func ask(_ text: String)
  /** Why the last try to talk couldn't start (Grok without a key, Claude voice not ready), or nil. */
  var talkNotice: TalkNotice? { get }
  /** The notice's "Use Claude voice": switch to it and start. */
  func useClaudeVoice()
}

public extension VoiceUI {
  var talkNotice: TalkNotice? { nil }
  func useClaudeVoice() {}
}

/** The launcher's caption logic: the last three, notes only when newest (App.tsx `recent`). */
public enum CaptionList {
  public static func recent(_ all: [VoiceCaption]) -> [VoiceCaption] {
    let last = all.last
    return Array(all.filter { $0.who != .note || $0 == last }.suffix(3))
  }
}

/** Phase words under Qubit (App.tsx PHASE_LABEL and `status`). */
public enum LauncherStatus {
  public static func phaseLabel(_ p: VoicePhase) -> String {
    switch p {
    case .off: return "Sleeping"
    case .connecting: return "Connecting…"
    case .listening: return "Listening"
    case .thinking: return "Thinking"
    case .speaking: return "Speaking"
    }
  }

  /** The big line under Qubit. */
  public static func status(phase: VoicePhase, asleep: Bool, muted: Bool, tap: Bool, draft: Bool) -> String {
    let on = phase != .off
    if asleep && on { return tap && draft ? "Waiting for your answer" : tap ? "Answering" : "Going to sleep…" }
    if muted && on && phase == .listening { return "Muted" }
    return phaseLabel(phase)
  }

  /** The mono hint under it (only in the desktop app). */
  public static func hint(phase: VoicePhase, asleep: Bool, tap: Bool, draft: Bool, wakeWordOn: Bool, hotkey: String) -> String? {
    let on = phase != .off
    let waitingForYes = asleep && tap && draft
    let say = wakeWordOn ? "Say “Hey Orbit” or press" : "Press"
    if !on { return wakeWordOn ? "Say “Hey Orbit” or press \(hotkey)" : "Click Qubit or press \(hotkey)" }
    return waitingForYes ? "\(say) \(hotkey) to answer" : nil
  }
}

// MARK: - Hotkey

/** The global hotkey as Settings shows it (Electron's hotkeyInfo). */
public struct HotkeyControlInfo: Equatable, Sendable {
  public var accelerator: String
  public var label: String
  public var registered: Bool
  public var defaultAccelerator: String
  /** Set by `set`: did it take, and if not why. */
  public var ok: Bool?
  public var error: String?
  public init(accelerator: String, label: String? = nil, registered: Bool, defaultAccelerator: String = HotkeyAccelerator.defaultAccelerator, ok: Bool? = nil, error: String? = nil) {
    self.accelerator = accelerator; self.label = label ?? SettingsSchema.hotkeyLabel(accelerator); self.registered = registered
    self.defaultAccelerator = defaultAccelerator; self.ok = ok; self.error = error
  }
}

/** The global hotkey, owned by the voice client (Carbon). Settings' recorder calls this. */
@MainActor
public protocol HotkeyControl: AnyObject {
  func info() -> HotkeyControlInfo
  /** Register and save a new accelerator ("Control+Alt+G"); on failure the old one stays. */
  func set(_ accelerator: String) -> HotkeyControlInfo
  /** While Settings records a shortcut: let key presses reach it. */
  func suspend(_ suspended: Bool)
}

/** Settings' hotkey recorder: a key press as an Electron accelerator (Settings.tsx toAccelerator). */
public enum HotkeyRecorder {
  public struct Result: Equatable, Sendable {
    public var accelerator: String?
    /** The modifiers held so far, as accelerator parts. */
    public var partial: [String]
    public var error: String?
  }

  public struct Modifiers: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let control = Modifiers(rawValue: 1)
    public static let option = Modifiers(rawValue: 2)
    public static let shift = Modifiers(rawValue: 4)
    public static let command = Modifiers(rawValue: 8)
  }

  /** macOS virtual key codes (Carbon kVK_*) to accelerator key names. */
  public static let keyNames: [UInt16: String] = {
    var m: [UInt16: String] = [
      0x00: "A", 0x0B: "B", 0x08: "C", 0x02: "D", 0x0E: "E", 0x03: "F", 0x05: "G", 0x04: "H", 0x22: "I", 0x26: "J", 0x28: "K", 0x25: "L", 0x2E: "M",
      0x2D: "N", 0x1F: "O", 0x23: "P", 0x0C: "Q", 0x0F: "R", 0x01: "S", 0x11: "T", 0x20: "U", 0x09: "V", 0x0D: "W", 0x07: "X", 0x10: "Y", 0x06: "Z",
      0x1D: "0", 0x12: "1", 0x13: "2", 0x14: "3", 0x15: "4", 0x17: "5", 0x16: "6", 0x1A: "7", 0x1C: "8", 0x19: "9",
      0x52: "num0", 0x53: "num1", 0x54: "num2", 0x55: "num3", 0x56: "num4", 0x57: "num5", 0x58: "num6", 0x59: "num7", 0x5B: "num8", 0x5C: "num9",
      0x31: "Space", 0x30: "Tab", 0x33: "Backspace", 0x75: "Delete", 0x72: "Insert", 0x73: "Home", 0x77: "End", 0x74: "PageUp", 0x79: "PageDown",
      0x7E: "Up", 0x7D: "Down", 0x7B: "Left", 0x7C: "Right",
      0x1B: "-", 0x18: "=", 0x21: "[", 0x1E: "]", 0x29: ";", 0x27: "'", 0x2B: ",", 0x2F: ".", 0x2C: "/", 0x2A: "\\", 0x32: "`",
    ]
    let f: [UInt16] = [0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A]
    for (i, code) in f.enumerated() { m[code] = "F\(i + 1)" }
    return m
  }()

  public static let escapeKeyCode: UInt16 = 0x35

  public static func parts(_ mods: Modifiers) -> [String] {
    var p = [String]()
    if mods.contains(.control) { p.append("Control") }
    if mods.contains(.option) { p.append("Alt") }
    if mods.contains(.shift) { p.append("Shift") }
    if mods.contains(.command) { p.append("Command") }
    return p
  }

  /** A key down (keyCode nil: only modifiers changed). */
  public static func accelerator(keyCode: UInt16?, modifiers: Modifiers) -> Result {
    let mods = parts(modifiers)
    guard let keyCode else { return Result(accelerator: nil, partial: mods, error: nil) }
    guard let key = keyNames[keyCode] else { return Result(accelerator: nil, partial: mods, error: "That key can't be used. Try a letter, number or F-key.") }
    let isFKey = key.range(of: "^F\\d+$", options: .regularExpression) != nil
    if !mods.contains(where: { $0 != "Shift" }) && !isFKey { return Result(accelerator: nil, partial: mods, error: "Hold ⌃, ⌥ or ⌘ too, so it doesn't fire while you type.") }
    return Result(accelerator: (mods + [key]).joined(separator: "+"), partial: mods, error: nil)
  }
}

// MARK: - Fakes (previews, tests, UIDemo)

@MainActor
@Observable
public final class FakeVoiceUI: VoiceUI {
  public var phase: VoicePhase = .off
  public var asleep = false
  public var hearing = false
  public var muted = false
  public var inputLevel = 0.0
  public var outputLevel = 0.0
  public var captions: [VoiceCaption] = []
  public var draft: VoiceDraft?
  public var sending = false
  public var sessionTitle: String?
  public var talkNotice: TalkNotice?
  /** What was asked of it, in order (tests). */
  public private(set) var calls: [String] = []

  public init() {}

  public func hotkey() {
    calls.append("hotkey")
    if phase == .off { start() } else if asleep { wake() } else { sleep() }
  }
  public func start() { calls.append("start"); phase = .listening; asleep = false }
  public func wake() { calls.append("wake"); asleep = false; phase = .listening }
  public func sleep() { calls.append("sleep"); phase = .off; asleep = false }
  public func toggleMute() { calls.append("mute"); muted.toggle() }
  public func type(_ text: String) {
    calls.append("type")
    captions.append(VoiceCaption(id: "typed-\(captions.count)", who: .you, text: text))
  }
  public func ask(_ text: String) {
    calls.append("ask")
    if phase == .off { phase = .listening }
    captions.append(VoiceCaption(id: "ask-\(captions.count)", who: .you, text: text))
  }
  public func useClaudeVoice() {
    calls.append("useClaudeVoice")
    talkNotice = nil
    start()
  }
}

@MainActor
public final class FakeHotkeyControl: HotkeyControl {
  public private(set) var accelerator: String
  public private(set) var suspended = false
  /** Accelerators "taken by another app" (set fails on these). */
  public var taken: Set<String> = []
  public var onSet: ((String) -> Void)?
  public init(accelerator: String = HotkeyAccelerator.defaultAccelerator) { self.accelerator = accelerator }
  public func info() -> HotkeyControlInfo { HotkeyControlInfo(accelerator: accelerator, registered: !suspended) }
  public func set(_ accel: String) -> HotkeyControlInfo {
    guard accel.range(of: "^[A-Za-z0-9_+.-]{1,60}$", options: .regularExpression) != nil else { var i = info(); i.ok = false; i.error = "No shortcut given."; return i }
    if taken.contains(accel) { var i = info(); i.ok = false; i.error = "macOS or another app is already using that shortcut. Try a different one."; return i }
    accelerator = accel
    onSet?(accel)
    var i = info(); i.ok = true; return i
  }
  public func suspend(_ s: Bool) { suspended = s }
}
