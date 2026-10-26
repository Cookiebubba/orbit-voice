// `orbit-helper selftest`: the helper's pure pieces, checked without any window or permission
// (test/mac-helper.test.js runs it on macOS). One JSON line: {"ok":bool,"checks":n,"failures":[..]}.

import Foundation

enum SelfTest {
  static func run() -> Never {
    var failures: [String] = []
    var checks = 0
    func expect(_ cond: Bool, _ what: String) {
      checks += 1
      if !cond { failures.append(what) }
    }
    // Roles as UI Automation's control types (what Orbit's shared code matches on).
    let roles: [(String, String, String)] = [
      ("AXButton", "", "Button"), ("AXPopUpButton", "", "Button"), ("AXCheckBox", "AXToggle", "Button"),
      ("AXCheckBox", "", "CheckBox"), ("AXRadioButton", "", "RadioButton"), ("AXRadioButton", "AXTabButton", "TabItem"),
      ("AXTextArea", "", "Edit"), ("AXTextField", "", "Edit"), ("AXSecureTextField", "", "Edit"),
      ("AXWebArea", "", "Document"), ("AXStaticText", "", "Text"), ("AXHeading", "", "Text"),
      ("AXGroup", "AXLandmarkComplementary", "Group"), ("AXLink", "", "Hyperlink"), ("AXMenuItem", "", "MenuItem"),
      ("AXWindow", "AXStandardWindow", "Window"), ("AXRow", "AXOutlineRow", "TreeItem"), ("AXSomethingNew", "", "Custom"),
    ]
    for (role, sub, want) in roles {
      expect(AX.controlType(role: role, subrole: sub) == want, "controlType(\(role),\(sub)) == \(want)")
    }
    // Names as UI Automation gives them.
    var r = AX.Raw()
    r.role = "AXButton"; r.desc = "Send"
    expect(AX.name(r) == "Send", "a button's aria-label is its name")
    r.title = "New"
    expect(AX.name(r) == "New", "its title wins over the description")
    var t = AX.Raw()
    t.role = "AXStaticText"; t.value = "hello" as NSString
    expect(AX.name(t) == "hello", "a text's value is its name")
    var p = AX.Raw()
    p.role = "AXSecureTextField"; p.value = "secret" as NSString
    expect(AX.isPassword(p) && AX.valueText(p) == nil, "a password field's value is never read")
    // Command-line flags.
    let f = Flags(["--window", "42", "--no-ocr", "--out", "/tmp/x.png"])
    expect(f.int("window") == 42 && f.has("no-ocr") && f.str("out") == "/tmp/x.png", "flags parse")
    expect(cut("abcdef", 3) == "abc" && cut("ab", 3) == "ab", "cut")
    // JSON requests.
    let req = IO.parseJSON("{\"op\":\"scan\",\"hwnd\":12,\"values\":true,\"skip\":[\"Chat messages\"]}") ?? [:]
    expect(req.str("op") == "scan" && req.int("hwnd") == 12 && req.bool("values"), "request fields")
    expect(IO.parseJSON("not json") == nil, "a broken line is ignored")
    IO.emit(["ok": failures.isEmpty, "checks": checks, "failures": failures, "version": helperVersion])
    exit(failures.isEmpty ? 0 : 1)
  }
}
