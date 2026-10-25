// The global hotkey (electron/main.js "global hotkey"): works from any app, through Carbon's
// RegisterEventHotKey (no Accessibility permission needed). set() is hotkey:set: on failure the
// old shortcut is put back; suspend() is hotkey:suspend (while Settings records a new one).
import Carbon
import Foundation
import OrbitKit

@MainActor
public final class GlobalHotkey {
  /** The hotkey was pressed (wire it to VoiceController.hotkey). */
  public var onPress: () -> Void = {}
  /** A new shortcut was taken: save it as the wakeHotkey setting (POST /api/settings). */
  public var onSaved: (String) -> Void = { _ in }
  /** How many times it fired (the self-test's count). */
  public private(set) var hits = 0

  /** The setting's value (what Settings shows), registered or not. */
  public private(set) var accelerator: String
  /** The shortcut held right now, or nil. */
  private var active: String?
  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private static let signature: OSType = 0x4F52_4254 // 'ORBT'

  public init(accelerator: String = HotkeyAccelerator.defaultAccelerator) {
    self.accelerator = accelerator
    installHandler()
  }

  /** Register the setting's shortcut at startup. False if it couldn't be (logged by the caller). */
  @discardableResult public func start() -> Bool {
    if register(accelerator) { active = accelerator; return true }
    return false
  }

  public var info: HotkeyInfo { info() }

  private func info(ok: Bool? = nil, error: String? = nil) -> HotkeyInfo {
    HotkeyInfo(accelerator: accelerator, label: HotkeyAccelerator.label(accelerator), registered: active != nil, ok: ok, error: error)
  }

  /** hotkey:set — take a new shortcut, or keep the old one and say why not. */
  public func set(_ accel: String) -> HotkeyInfo {
    guard HotkeyAccelerator.isAcceptable(accel) else { return info(ok: false, error: HotkeyAccelerator.noShortcutError) }
    if active != accel {
      let old = active
      unregister()
      active = nil
      guard register(accel) else {
        if let old, register(old) { active = old } // put the old one back
        return info(ok: false, error: HotkeyAccelerator.takenError)
      }
    }
    active = accel
    accelerator = accel
    onSaved(accel)
    return info(ok: true)
  }

  /** hotkey:suspend — let key presses reach Settings while it records a new shortcut. */
  public func suspend(_ suspended: Bool) {
    guard let a = active else { return }
    if suspended { unregister() } else { _ = register(a) }
  }

  // MARK: Carbon

  private func register(_ accel: String) -> Bool {
    guard let k = HotkeyAccelerator.parse(accel) else { return false }
    unregister()
    var r: EventHotKeyRef?
    let id = EventHotKeyID(signature: GlobalHotkey.signature, id: 1)
    let status = RegisterEventHotKey(k.keyCode, k.modifiers, id, GetApplicationEventTarget(), 0, &r)
    guard status == noErr, let r else { return false }
    ref = r
    return true
  }

  private func unregister() {
    if let ref { UnregisterEventHotKey(ref) }
    ref = nil
  }

  private func installHandler() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let me = Unmanaged.passUnretained(self).toOpaque()
    InstallEventHandler(GetApplicationEventTarget(), { _, event, user -> OSStatus in
      guard let event, let user else { return OSStatus(eventNotHandledErr) }
      var id = EventHotKeyID()
      GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
      guard id.signature == GlobalHotkey.signature else { return OSStatus(eventNotHandledErr) }
      let hk = Unmanaged<GlobalHotkey>.fromOpaque(user).takeUnretainedValue()
      // Carbon calls this on the main thread (the app's event loop).
      MainActor.assumeIsolated {
        hk.hits += 1
        hk.onPress()
      }
      return noErr
    }, 1, &spec, me, &handler)
  }

  /** Let go of the shortcut and the handler (quitting). */
  public func invalidate() {
    unregister()
    active = nil
    if let handler { RemoveEventHandler(handler) }
    handler = nil
  }
}
