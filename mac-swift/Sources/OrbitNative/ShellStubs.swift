// Stand-ins the shell uses until the voice client is wired in: a voice that is always off and a
// hotkey that isn't registered. They say so (the parity driver doesn't list "voice" or "hotkey"
// while these are in use), rather than pretending.
import Foundation
import Observation
import OrbitKit

@Observable
final class IdleVoice: VoiceUI {
  var phase: VoicePhase = .off
  var asleep = false
  var hearing = false
  var muted = false
  var inputLevel = 0.0
  var outputLevel = 0.0
  var captions: [VoiceCaption] = []
  var draft: VoiceDraft?
  var sending = false
  var sessionTitle: String?
  func hotkey() {}
  func start() {}
  func wake() {}
  func sleep() {}
  func toggleMute() {}
  func type(_ text: String) {}
  func ask(_ text: String) {}
}

final class UnregisteredHotkey: HotkeyControl {
  var accelerator = "Control+Alt+G"
  func info() -> HotkeyControlInfo { HotkeyControlInfo(accelerator: accelerator, registered: false) }
  func set(_ accelerator: String) -> HotkeyControlInfo {
    var i = info()
    i.ok = false
    i.error = "The hotkey isn't available in this build yet."
    return i
  }
  func suspend(_ suspended: Bool) {}
}
