// The Settings screen's model: the bridge's settings, kept in sync live (ui/src/useAppState.ts).
// A change is checked here first (SettingsSchema.sanitize, the bridge's own rules), shown at once,
// posted to the bridge, and replaced by what the bridge saved. Changes made anywhere else (the
// voice saying "talk quieter", another window) arrive as settings.changed events.
import Foundation
import Observation

/** What the Settings model needs from the bridge (BridgeClient; a fake in tests). */
public protocol SettingsTransport: Sendable {
  func config() async throws -> BridgeConfig
  func updateSettings(_ patch: [String: JSONValue]) async throws -> [String: JSONValue]
}

extension BridgeClient: SettingsTransport {}

public enum SettingChange: Equatable, Sendable {
  /** Saved: the value the bridge kept. */
  case saved(JSONValue)
  /** Refused here (the bridge would ignore it), with why. Nothing was sent. */
  case refused(String)
  /** The bridge couldn't be reached or said no; the screen shows the bridge's value again. */
  case failed(String)
}

@MainActor
@Observable
public final class SettingsModel {
  public private(set) var values: [String: JSONValue] = SettingsSchema.defaults
  public private(set) var version = "dev"
  public private(set) var hasKey = false
  public private(set) var keyStorage = "none"
  public private(set) var loaded = false
  /** The bridge couldn't be read (the launcher says so, as the page does). */
  public private(set) var failed = false

  @ObservationIgnored private let transport: any SettingsTransport

  public init(transport: any SettingsTransport) {
    self.transport = transport
    values["hotkeyLabel"] = .string(SettingsSchema.hotkeyLabel("Control+Alt+G"))
  }

  public func load() async {
    do {
      let c = try await transport.config()
      version = c.version
      hasKey = c.hasKey
      keyStorage = c.keyStorage
      replace(with: c.settings)
      loaded = true
      failed = false
    } catch {
      failed = !loaded
    }
  }

  private func replace(with settings: [String: JSONValue]) {
    var next = values
    for (k, v) in settings { next[k] = v }
    if let accel = next["wakeHotkey"]?.stringValue { next["hotkeyLabel"] = .string(SettingsSchema.hotkeyLabel(accel)) }
    if next != values { values = next }
  }

  /** A settings.changed event from the bridge (or any `{type, settings}`). */
  public func apply(event: JSONValue) {
    guard event["type"]?.stringValue == "settings.changed", let s = event["settings"]?.objectValue else { return }
    replace(with: s)
  }

  /** The key was saved (POST /api/key went through). */
  public func markHasKey() { hasKey = true }

  // MARK: reading

  public subscript(key: String) -> JSONValue? { values[key] }
  public func bool(_ key: String) -> Bool { values[key]?.boolValue ?? SettingsSchema.byKey[key]?.defaultValue.boolValue ?? false }
  public func double(_ key: String) -> Double { values[key]?.doubleValue ?? SettingsSchema.byKey[key]?.defaultValue.doubleValue ?? 0 }
  public func int(_ key: String) -> Int { Int(double(key)) }
  public func string(_ key: String) -> String { values[key]?.stringValue ?? SettingsSchema.byKey[key]?.defaultValue.stringValue ?? "" }
  public var hotkeyLabel: String { string("hotkeyLabel") }
  /** The assistant's name in the text: Grok, or Orbit when Claude is the voice. */
  public var assistantName: String { string("voiceEngine") == "claude" ? "Orbit" : "Grok" }

  // MARK: changing

  /**
   * Change one setting as the Settings screen does: checked, shown at once, posted, then shown as
   * the bridge saved it.
   */
  @discardableResult
  public func set(_ key: String, _ value: JSONValue) async -> SettingChange {
    guard let spec = SettingsSchema.byKey[key] else { return .refused("Unknown setting.") }
    guard spec.postable else { return .refused(key == "wakeHotkey" ? "The hotkey is changed through the hotkey recorder." : "Kept by the app itself.") }
    guard let clean = SettingsSchema.sanitize(key, value) else { return .refused("Not a valid value for \(spec.label).") }
    let before = values
    values[key] = clean // optimistic, as the page
    do {
      let saved = try await transport.updateSettings([key: clean])
      replace(with: saved)
      return .saved(values[key] ?? clean)
    } catch {
      if values[key] == clean { values[key] = before[key] }
      return .failed((error as? BridgeError)?.message ?? "Couldn't reach Orbit.")
    }
  }

  /** Several at once (one POST), e.g. the voice card's voice + speed. */
  @discardableResult
  public func set(_ patch: [String: JSONValue]) async -> SettingChange {
    var clean = [String: JSONValue]()
    for (k, v) in patch {
      guard let spec = SettingsSchema.byKey[k], spec.postable, let c = SettingsSchema.sanitize(k, v) else { return .refused("Not a valid value for \(k).") }
      clean[k] = c
    }
    for (k, v) in clean { values[k] = v }
    do {
      replace(with: try await transport.updateSettings(clean))
      return .saved(.object(clean))
    } catch {
      return .failed((error as? BridgeError)?.message ?? "Couldn't reach Orbit.")
    }
  }

  /** The shell saved the hotkey itself (HotkeyControl.set): show it until the bridge's event lands. */
  public func showHotkey(_ accel: String) {
    values["wakeHotkey"] = .string(accel)
    values["hotkeyLabel"] = .string(SettingsSchema.hotkeyLabel(accel))
  }
}
