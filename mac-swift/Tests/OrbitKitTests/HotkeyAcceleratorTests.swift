// The hotkey: Electron accelerators to Carbon codes and back, the label, hotkey:set's checks.
import XCTest
@testable import OrbitKit

final class HotkeyAcceleratorTests: XCTestCase {
  typealias A = HotkeyAccelerator

  func testParsesTheDefaultAndCommonOnes() {
    XCTAssertEqual(A.parse("Control+Alt+G"), A(keyCode: 0x05, modifiers: A.controlKey | A.optionKey))
    XCTAssertEqual(A.parse("CommandOrControl+Shift+Space"), A(keyCode: 0x31, modifiers: A.cmdKey | A.shiftKey))
    XCTAssertEqual(A.parse("Super+F5"), A(keyCode: 0x60, modifiers: A.cmdKey))
    XCTAssertEqual(A.parse("F12"), A(keyCode: 0x6F, modifiers: 0))
    XCTAssertEqual(A.parse("cmd+option+k"), A(keyCode: 0x28, modifiers: A.cmdKey | A.optionKey), "case doesn't matter")
    XCTAssertEqual(A.parse("Control+Alt+num5"), A(keyCode: 0x57, modifiers: A.controlKey | A.optionKey))
    XCTAssertEqual(A.parse("Control+Alt+-"), A(keyCode: 0x1B, modifiers: A.controlKey | A.optionKey))
    XCTAssertEqual(A.parse("Control+Alt+Up"), A(keyCode: 0x7E, modifiers: A.controlKey | A.optionKey))
    XCTAssertEqual(A.parse("Control+Plus"), A(keyCode: 0x18, modifiers: A.controlKey | A.shiftKey), "Plus is Shift+=")
    XCTAssertEqual(A.parse("Control++"), A(keyCode: 0x18, modifiers: A.controlKey | A.shiftKey))
    XCTAssertEqual(A.parse("Control+Alt+1"), A(keyCode: 0x12, modifiers: A.controlKey | A.optionKey))
  }

  func testRejectsWhatCantBeRegistered() {
    for bad in ["", "Control+Alt", "Control+G+H", "Control+Alt+Bogus", "Control++Alt", "F25"] { XCTAssertNil(A.parse(bad), bad) }
  }

  func testHotkeySetsFirstCheck() {
    XCTAssertTrue(A.isAcceptable("Control+Alt+G"))
    XCTAssertTrue(A.isAcceptable("Control+Alt+num_5.-"))
    XCTAssertFalse(A.isAcceptable(""))
    XCTAssertFalse(A.isAcceptable("Control+Alt+!"))
    XCTAssertFalse(A.isAcceptable("Control Alt G"))
    XCTAssertFalse(A.isAcceptable(String(repeating: "A", count: 61)))
    XCTAssertFalse(A.isAcceptable("Control+Alt+é"))
  }

  // test/mac-platform.test.js: hotkeyLabel
  func testLabelsAsSystemJsWritesThem() {
    XCTAssertEqual(A.label("Control+Alt+G"), "⌃⌥G")
    XCTAssertEqual(A.label("Shift+Control+Alt+Command+k"), "⌃⌥⇧⌘K", "Apple's order")
    XCTAssertEqual(A.label("CommandOrControl+Shift+Space"), "⇧⌘Space")
    XCTAssertEqual(A.label("Super+F5"), "⌘F5")
    XCTAssertEqual(A.label("AltGr+X"), "⌥X")
    XCTAssertEqual(A.label("Control+Alt+G", mac: false), "Ctrl+Alt+G")
    XCTAssertEqual(A.label("Super+Alt+G", mac: false), "Win+Alt+G")
    XCTAssertEqual(A.label(""), "")
  }

  // ui/src/Settings.tsx toAccelerator
  func testRecordingAShortcutAsSettingsDoes() {
    XCTAssertEqual(A.record(keyCode: 0x05, control: true, option: true, shift: false, command: false), .accelerator("Control+Alt+G"))
    XCTAssertEqual(A.record(keyCode: 0x31, control: false, option: false, shift: true, command: true), .accelerator("Shift+Command+Space"))
    XCTAssertEqual(A.record(keyCode: 0x60, control: false, option: false, shift: false, command: false), .accelerator("F5"), "an F-key alone is fine")
    XCTAssertEqual(A.record(keyCode: 0x57, control: true, option: false, shift: false, command: false), .accelerator("Control+num5"))
    XCTAssertEqual(A.record(keyCode: 0x2A, control: true, option: false, shift: false, command: false), .accelerator("Control+\\"))
    XCTAssertEqual(A.record(keyCode: nil, control: true, option: false, shift: false, command: false), .partial(modifiers: ["Control"], error: nil))
    XCTAssertEqual(A.record(keyCode: 0x05, control: false, option: false, shift: true, command: false),
                   .partial(modifiers: ["Shift"], error: "Hold ⌃, ⌥ or ⌘ too, so it doesn't fire while you type."))
    XCTAssertEqual(A.record(keyCode: 0x35, control: true, option: false, shift: false, command: false),
                   .partial(modifiers: ["Control"], error: "That key can't be used. Try a letter, number or F-key."))
    XCTAssertEqual(A.record(keyCode: 0x05, control: false, option: false, shift: false, command: true, mac: false), .accelerator("Super+G"))
  }

  func testEveryRecordedShortcutParsesBackToTheSameKey() {
    for code in A.recordNames.keys {
      guard case .accelerator(let s) = A.record(keyCode: code, control: true, option: true, shift: false, command: false) else { XCTFail("\(code)"); continue }
      XCTAssertEqual(A.parse(s), A(keyCode: code, modifiers: A.controlKey | A.optionKey), s)
    }
  }

  func testHotkeyInfoCarriesTheLabel() {
    let i = HotkeyInfo(accelerator: "Control+Alt+G", label: A.label("Control+Alt+G"), registered: true)
    XCTAssertEqual(i.defaultAccelerator, "Command+Alt+G")
    XCTAssertEqual(i.parity, ParityHotkey(accelerator: "Control+Alt+G", label: "⌃⌥G", registered: true))
  }
}
