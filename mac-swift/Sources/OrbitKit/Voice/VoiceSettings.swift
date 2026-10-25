// The settings the voice client follows, read from the bridge's settings object (/api/config's
// `settings`, and the `settings` of each settings.changed event, which carry only what changed).
import Foundation

public struct VoiceSettings: Equatable, Sendable {
  public var listenMode: ListenMode = .always
  public var halfDuplex = false
  public var voiceVolume = VoiceAudio.defaultVolume
  public var wakeWord = false
  public var announce = "speak" // speak | chime | off
  public var avatarThrow = true
  public var avatarThrowSound = true
  public var voiceEngine = "grok" // grok | claude
  public var wakeHotkey = HotkeyAccelerator.defaultAccelerator
  public init() {}

  /** Take what's in `s`; missing or mistyped keys keep their value. */
  public mutating func merge(_ s: JSONValue) {
    if let v = s["listenMode"]?.stringValue, let m = ListenMode(rawValue: v) { listenMode = m }
    if let v = s["halfDuplex"]?.boolValue { halfDuplex = v }
    if let v = s["voiceVolume"]?.doubleValue, v.isFinite { voiceVolume = v }
    if let v = s["wakeWord"]?.boolValue { wakeWord = v }
    if let v = s["announce"]?.stringValue, ["speak", "chime", "off"].contains(v) { announce = v }
    if let v = s["avatarThrow"]?.boolValue { avatarThrow = v }
    if let v = s["avatarThrowSound"]?.boolValue { avatarThrowSound = v }
    if let v = s["voiceEngine"]?.stringValue, ["grok", "claude"].contains(v) { voiceEngine = v }
    if let v = s["wakeHotkey"]?.stringValue, HotkeyAccelerator.isAcceptable(v) { wakeHotkey = v }
  }

  public var options: VoiceOptions { VoiceOptions(listenMode: listenMode, halfDuplex: halfDuplex, volume: voiceVolume) }
}
