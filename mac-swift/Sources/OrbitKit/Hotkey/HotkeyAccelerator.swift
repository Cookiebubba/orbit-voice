// The global hotkey's settings value is an Electron accelerator ("Control+Alt+G"), shared with the
// Electron build through settings.json. Here: parsing it into a Carbon key code + modifier mask
// (RegisterEventHotKey), the reverse for the Settings recorder (as ui/src/Settings.tsx
// toAccelerator builds it), the label people read ("⌃⌥G", src/platform/system.js hotkeyLabel),
// and the checks electron/main.js's hotkey:set makes. No Carbon import: the constants are fixed.
import Foundation

/** What the Settings screen shows about the hotkey (ui/src/desktop.ts HotkeyInfo). */
public struct HotkeyInfo: Codable, Equatable, Sendable {
  public var accelerator: String
  public var label: String
  public var registered: Bool
  public var defaultAccelerator: String
  public var ok: Bool?
  public var error: String?
  public init(accelerator: String, label: String, registered: Bool, defaultAccelerator: String = HotkeyAccelerator.defaultAccelerator, ok: Bool? = nil, error: String? = nil) {
    self.accelerator = accelerator; self.label = label; self.registered = registered; self.defaultAccelerator = defaultAccelerator; self.ok = ok; self.error = error
  }
  public var parity: ParityHotkey { ParityHotkey(accelerator: accelerator, label: label, registered: registered) }
}

public struct HotkeyAccelerator: Equatable, Sendable {
  /** src/config.js DEFAULTS.wakeHotkey on macOS (⌘⌥G; Ctrl+Alt+G is the Windows one). */
  public static let defaultAccelerator = "Command+Alt+G"

  // Carbon's modifier masks (Events.h: cmdKey, shiftKey, optionKey, controlKey).
  public static let cmdKey: UInt32 = 1 << 8
  public static let shiftKey: UInt32 = 1 << 9
  public static let optionKey: UInt32 = 1 << 11
  public static let controlKey: UInt32 = 1 << 12

  /** Carbon virtual key code (kVK_*). */
  public var keyCode: UInt32
  /** Carbon modifier mask. */
  public var modifiers: UInt32

  public init(keyCode: UInt32, modifiers: UInt32) { self.keyCode = keyCode; self.modifiers = modifiers }

  // MARK: parsing (Electron's rules: case-insensitive, any modifiers, exactly one key)

  static let modifierNames: [String: UInt32] = [
    "command": cmdKey, "cmd": cmdKey, "commandorcontrol": cmdKey, "cmdorctrl": cmdKey, "super": cmdKey, "meta": cmdKey,
    "control": controlKey, "ctrl": controlKey,
    "alt": optionKey, "option": optionKey, "altgr": optionKey,
    "shift": shiftKey,
  ]

  /** Key names to kVK codes. */
  static let keyCodes: [String: UInt32] = {
    var m: [String: UInt32] = [
      "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
      "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "o": 0x1F, "u": 0x20, "i": 0x22,
      "p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,
      "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D,
      "=": 0x18, "-": 0x1B, "]": 0x1E, "[": 0x21, "'": 0x27, ";": 0x29, "\\": 0x2A, ",": 0x2B, "/": 0x2C, ".": 0x2F, "`": 0x32,
      "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
      "delete": 0x75, "insert": 0x72, "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
      "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
      "capslock": 0x39, "volumeup": 0x48, "volumedown": 0x49, "volumemute": 0x4A,
      "numdec": 0x41, "nummult": 0x43, "numadd": 0x45, "numdiv": 0x4B, "numsub": 0x4E,
      "num0": 0x52, "num1": 0x53, "num2": 0x54, "num3": 0x55, "num4": 0x56, "num5": 0x57, "num6": 0x58, "num7": 0x59, "num8": 0x5B, "num9": 0x5C,
    ]
    let f: [UInt32] = [0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A]
    for (i, c) in f.enumerated() { m["f\(i + 1)"] = c }
    return m
  }()

  /** Characters Electron types with Shift on a US layout: the key underneath. */
  static let shifted: [String: String] = [
    "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "plus": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/",
  ]

  /** Parses an accelerator; nil if it isn't one this Mac can register (no key, two keys, unknown name). */
  public static func parse(_ accel: String) -> HotkeyAccelerator? {
    let s = accel.trimmingCharacters(in: .whitespaces)
    guard !s.isEmpty else { return nil }
    // "Control+Alt++" means the + key: split on "+" but keep a trailing (or lone) "+".
    var parts = s.components(separatedBy: "+")
    if s.hasSuffix("+") {
      while parts.last == "" { parts.removeLast() }
      parts.append("+")
    }
    var mods: UInt32 = 0
    var key: UInt32?
    for raw in parts {
      let p = raw.lowercased()
      if p.isEmpty { return nil }
      if let m = modifierNames[p] { mods |= m; continue }
      guard key == nil else { return nil } // two keys
      if let c = keyCodes[p] { key = c }
      else if let base = shifted[p], let c = keyCodes[base] { key = c; mods |= shiftKey }
      else { return nil }
    }
    guard let key else { return nil }
    return HotkeyAccelerator(keyCode: key, modifiers: mods)
  }

  /** hotkey:set's first check (electron/main.js): a short string of word characters, "+", "." and "-". */
  public static func isAcceptable(_ accel: String) -> Bool {
    guard (1...60).contains(accel.count) else { return false }
    return accel.unicodeScalars.allSatisfy { c in
      CharacterSet.alphanumerics.contains(c) && c.isASCII || c == "_" || c == "+" || c == "." || c == "-"
    }
  }

  // MARK: the label

  static let macMods: [String: String] = [
    "Control": "⌃", "Ctrl": "⌃", "Alt": "⌥", "Option": "⌥", "AltGr": "⌥", "Shift": "⇧",
    "Command": "⌘", "Cmd": "⌘", "CommandOrControl": "⌘", "CmdOrCtrl": "⌘", "Super": "⌘", "Meta": "⌘",
  ]

  /**
   * The accelerator as people read it: "⌃⌥G" on a Mac (modifiers in Apple's order: Control, Option,
   * Shift, Command), "Ctrl+Alt+G" elsewhere. Same as src/platform/system.js hotkeyLabel.
   */
  public static func label(_ accel: String, mac: Bool = true) -> String {
    if !mac {
      var s = accel
      for w in ["CommandOrControl", "CmdOrCtrl", "Control"] { s = s.replacingOccurrences(of: w, with: "Ctrl") }
      for w in ["Super", "Meta"] { s = s.replacingOccurrences(of: w, with: "Win") }
      return s
    }
    var mods = Set<String>()
    var keys: [String] = []
    for part in accel.split(separator: "+").map(String.init) where !part.isEmpty {
      if let m = macMods[part] { mods.insert(m) } else { keys.append(part.count == 1 ? part.uppercased() : part) }
    }
    return ["⌃", "⌥", "⇧", "⌘"].filter { mods.contains($0) }.joined() + keys.joined(separator: "+")
  }

  // MARK: recording a new one (Settings)

  /** kVK codes back to the key names Settings writes. */
  static let recordNames: [UInt32: String] = {
    var m: [UInt32: String] = [0x31: "Space", 0x30: "Tab", 0x33: "Backspace", 0x75: "Delete", 0x72: "Insert",
                               0x73: "Home", 0x77: "End", 0x74: "PageUp", 0x79: "PageDown",
                               0x7E: "Up", 0x7D: "Down", 0x7B: "Left", 0x7C: "Right",
                               0x1B: "-", 0x18: "=", 0x21: "[", 0x1E: "]", 0x29: ";", 0x27: "'", 0x2B: ",", 0x2F: ".", 0x2C: "/", 0x2A: "\\", 0x32: "`"]
    for (name, code) in keyCodes {
      if name.count == 1, let c = name.first, c.isLetter { m[code] = name.uppercased() }
      else if name.count == 1, let c = name.first, c.isNumber { m[code] = name }
      else if name.hasPrefix("num"), name.count == 4, name.last!.isNumber { m[code] = name }
      else if name.hasPrefix("f"), Int(name.dropFirst()) != nil { m[code] = name.uppercased() }
    }
    return m
  }()

  public enum Recorded: Equatable, Sendable {
    case accelerator(String)
    /** Not a usable shortcut; `error` says why (nil: only modifiers so far). */
    case partial(modifiers: [String], error: String?)
  }

  /**
   * A key press as Settings records it (ui/src/Settings.tsx toAccelerator): modifiers in the order
   * Control, Alt, Shift, Command, then the key. Needs ⌃, ⌥ or ⌘ unless it's an F-key.
   */
  public static func record(keyCode: UInt32?, control: Bool, option: Bool, shift: Bool, command: Bool, mac: Bool = true) -> Recorded {
    var mods: [String] = []
    if control { mods.append("Control") }
    if option { mods.append("Alt") }
    if shift { mods.append("Shift") }
    if command { mods.append(mac ? "Command" : "Super") }
    guard let keyCode else { return .partial(modifiers: mods, error: nil) } // a modifier on its own
    guard let key = recordNames[keyCode] else { return .partial(modifiers: mods, error: "That key can't be used. Try a letter, number or F-key.") }
    let isFKey = key.hasPrefix("F") && Int(key.dropFirst()) != nil
    if !mods.contains(where: { $0 != "Shift" }) && !isFKey {
      return .partial(modifiers: mods, error: mac ? "Hold ⌃, ⌥ or ⌘ too, so it doesn't fire while you type." : "Hold Ctrl, Alt or Win too, so it doesn't fire while you type.")
    }
    return .accelerator((mods + [key]).joined(separator: "+"))
  }

  /** hotkey:set's error when the system or another app holds the shortcut. */
  public static let takenError = "macOS or another app is already using that shortcut. Try a different one."
  public static let noShortcutError = "No shortcut given."
}
