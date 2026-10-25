// The macOS accessibility API (AXUIElement), wrapped for Orbit: attributes, actions, the window ID
// behind an AX window, and one element as Orbit's node (the same shape uia.ps1 reports on Windows,
// with UI Automation's control type names, so Orbit's shared code reads both alike).

import AppKit
import ApplicationServices

// The CGWindowID of an AX window. Private but stable since 10.6, and what every window manager uses.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

enum AX {
  static let systemWide = AXUIElementCreateSystemWide()

  static func setup() {
    // A hung app can't hang Orbit for long (the default is 6 s per call).
    AXUIElementSetMessagingTimeout(systemWide, 2.5)
  }

  static var trusted: Bool { AXIsProcessTrusted() }

  static func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    let err = AXUIElementCopyAttributeValue(e, name as CFString, &v)
    return err == .success ? v : nil
  }

  static func str(_ e: AXUIElement, _ name: String) -> String {
    (attr(e, name) as? String) ?? ""
  }

  static func bool(_ e: AXUIElement, _ name: String) -> Bool? {
    if let n = attr(e, name) as? NSNumber { return n.boolValue }
    return nil
  }

  static func children(_ e: AXUIElement) -> [AXUIElement] {
    (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
  }

  /** Several attributes in one round trip (index-aligned; NSNull where missing). */
  static func many(_ e: AXUIElement, _ names: [String]) -> [AnyObject?] {
    var values: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(e, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    guard err == .success, let arr = values as? [AnyObject] else { return names.map { attr(e, $0) } }
    return arr.map { v in
      if v is NSNull { return nil }
      // AXValue errors come back as AXValue of type .axError
      if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
      return v
    }
  }

  static func point(_ v: AnyObject?) -> CGPoint? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
  }

  static func size(_ v: AnyObject?) -> CGSize? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
  }

  static func range(_ v: AnyObject?) -> CFRange? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var r = CFRange(location: 0, length: 0)
    return AXValueGetValue(v as! AXValue, .cfRange, &r) ? r : nil
  }

  static func frame(_ e: AXUIElement) -> CGRect? {
    let v = many(e, [kAXPositionAttribute, kAXSizeAttribute])
    guard let p = point(v[0]), let s = size(v[1]) else { return nil }
    return CGRect(origin: p, size: s)
  }

  static func actions(_ e: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(e, &names) == .success, let a = names as? [String] else { return [] }
    return a
  }

  static func settable(_ e: AXUIElement, _ name: String) -> Bool {
    var b: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(e, name as CFString, &b) == .success && b.boolValue
  }

  @discardableResult
  static func set(_ e: AXUIElement, _ name: String, _ value: AnyObject) -> AXError {
    AXUIElementSetAttributeValue(e, name as CFString, value)
  }

  @discardableResult
  static func perform(_ e: AXUIElement, _ action: String) -> AXError {
    AXUIElementPerformAction(e, action as CFString)
  }

  static func pid(_ e: AXUIElement) -> pid_t {
    var p: pid_t = 0
    AXUIElementGetPid(e, &p)
    return p
  }

  static func windowID(_ e: AXUIElement) -> CGWindowID {
    var id: CGWindowID = 0
    return _AXUIElementGetWindow(e, &id) == .success ? id : 0
  }

  static func app(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

  /** The app's windows (AX), each with its CGWindowID. */
  static func windows(of pid: pid_t) -> [(el: AXUIElement, id: CGWindowID)] {
    let a = app(pid)
    let list = (attr(a, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    return list.map { ($0, windowID($0)) }
  }

  static func window(_ id: CGWindowID, pid: pid_t) -> AXUIElement? {
    windows(of: pid).first { $0.id == id }?.el
  }

  /**
   * Chromium and Electron build their web content's accessibility tree only when someone asks:
   * AXManualAccessibility (Electron) and AXEnhancedUserInterface (Chromium, as VoiceOver does).
   * Changes nothing on screen. Returns true the first time for this pid (the tree needs a moment).
   */
  private static var enabled = Set<pid_t>()
  @discardableResult
  static func enableWebTree(_ pid: pid_t) -> Bool {
    if enabled.contains(pid) { return false }
    enabled.insert(pid)
    let a = app(pid)
    set(a, "AXManualAccessibility", kCFBooleanTrue)
    return true
  }

  // ---- one element as Orbit's node ----

  /** UI Automation's control type for an AX role (and subrole), as uia.ps1 names them. */
  static func controlType(role: String, subrole: String) -> String {
    switch role {
    case "AXButton", "AXPopUpButton", "AXMenuButton", "AXDisclosureTriangle":
      return "Button"
    case "AXCheckBox":
      return subrole == "AXToggle" || subrole == "AXToggleButton" || subrole == "AXSwitch" ? "Button" : "CheckBox"
    case "AXRadioButton":
      return subrole == "AXTabButton" ? "TabItem" : "RadioButton"
    case "AXTextField", "AXTextArea", "AXSearchField":
      return "Edit"
    case "AXSecureTextField":
      return "Edit"
    case "AXComboBox":
      return "ComboBox"
    case "AXWebArea":
      return "Document"
    case "AXStaticText", "AXHeading":
      return "Text"
    case "AXLink":
      return "Hyperlink"
    case "AXImage":
      return "Image"
    case "AXList":
      return "List"
    case "AXOutline":
      return "Tree"
    case "AXRow":
      return subrole == "AXOutlineRow" ? "TreeItem" : "DataItem"
    case "AXCell":
      return "DataItem"
    case "AXTable", "AXGrid":
      return "Table"
    case "AXMenuBar":
      return "MenuBar"
    case "AXMenu":
      return "Menu"
    case "AXMenuItem", "AXMenuBarItem":
      return "MenuItem"
    case "AXTabGroup":
      return "Tab"
    case "AXToolbar":
      return "ToolBar"
    case "AXSlider":
      return "Slider"
    case "AXIncrementor", "AXStepper":
      return "Spinner"
    case "AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator":
      return "ProgressBar"
    case "AXScrollBar":
      return "ScrollBar"
    case "AXScrollArea", "AXSplitGroup", "AXLayoutArea", "AXBrowser":
      return "Pane"
    case "AXSplitter":
      return "Separator"
    case "AXWindow", "AXSheet", "AXDrawer":
      return "Window"
    case "AXDialog":
      return "Window"
    case "AXListItem":
      return "ListItem"
    case "AXGroup", "AXRadioGroup", "AXApplication":
      if subrole == "AXDocumentArticle" || subrole == "AXDocument" { return "Group" }
      if subrole == "AXTabPanel" { return "Pane" }
      return "Group"
    case "AXValueIndicator":
      return "Thumb"
    case "AXColorWell", "AXDateField", "AXTimeField":
      return "Edit"
    default:
      return "Custom"
    }
  }

  /** The node attributes fetched for every element, in one round trip. */
  static let nodeAttrs: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute, "AXDOMClassList",
    kAXIdentifierAttribute, "AXDOMIdentifier", kAXExpandedAttribute, kAXSelectedAttribute, kAXChildrenAttribute,
    kAXPlaceholderValueAttribute, kAXHelpAttribute,
  ]

  struct Raw {
    var role = "", subrole = "", title = "", desc = "", value: AnyObject? = nil
    var rect: CGRect? = nil
    var enabled = true, focused = false
    var classes: [String] = []
    var ident = ""
    var expanded: Bool? = nil, selected: Bool? = nil
    var children: [AXUIElement] = []
    var placeholder = "", help = ""
  }

  static func raw(_ e: AXUIElement) -> Raw {
    let v = many(e, nodeAttrs)
    var r = Raw()
    r.role = (v[0] as? String) ?? ""
    r.subrole = (v[1] as? String) ?? ""
    r.title = (v[2] as? String) ?? ""
    r.desc = (v[3] as? String) ?? ""
    r.value = v[4]
    if let p = point(v[5]), let s = size(v[6]) { r.rect = CGRect(origin: p, size: s) }
    r.enabled = (v[7] as? NSNumber)?.boolValue ?? true
    r.focused = (v[8] as? NSNumber)?.boolValue ?? false
    r.classes = (v[9] as? [String]) ?? []
    r.ident = (v[10] as? String) ?? (v[11] as? String) ?? ""
    r.expanded = (v[12] as? NSNumber)?.boolValue
    r.selected = (v[13] as? NSNumber)?.boolValue
    r.children = (v[14] as? [AXUIElement]) ?? []
    r.placeholder = (v[15] as? String) ?? ""
    r.help = (v[16] as? String) ?? ""
    return r
  }

  /** Its accessible name, as UI Automation would give it: the title, else the description, else (text) its value. */
  static func name(_ r: Raw) -> String {
    if !r.title.isEmpty { return r.title }
    if !r.desc.isEmpty { return r.desc }
    if r.role == "AXStaticText", let s = r.value as? String { return s }
    return ""
  }

  static func isPassword(_ r: Raw) -> Bool { r.role == "AXSecureTextField" || r.subrole == "AXSecureTextField" }

  /** The element's value as text (never a password field's). */
  static func valueText(_ r: Raw) -> String? {
    if isPassword(r) { return nil }
    if let s = r.value as? String { return s }
    if let n = r.value as? NSNumber { return n.stringValue }
    return nil
  }

  /**
   * Orbit's node: { i, p, t, n, a, c, r, en, off, foc, kf, pw, pat, ro, v, rid } as uia.ps1 reports it,
   * plus the Mac's own { role, sr, tog, sel, exp, ph }. `window`: the window's frame, for "off".
   */
  static func node(_ e: AXUIElement, _ r: Raw, index: Int, parent: Int, values: Bool, window: CGRect?) -> [String: Any] {
    var d: [String: Any] = ["i": index, "p": parent]
    let t = controlType(role: r.role, subrole: r.subrole)
    d["t"] = t
    d["role"] = r.role
    if !r.subrole.isEmpty { d["sr"] = r.subrole }
    let n = name(r)
    if !n.isEmpty { d["n"] = cut(n, t == "Text" ? 2000 : 300) }
    if !r.ident.isEmpty { d["a"] = cut(r.ident, 120) }
    if !r.classes.isEmpty { d["c"] = cut(r.classes.joined(separator: " "), 400) }
    if let f = r.rect {
      d["r"] = [Int(f.origin.x.rounded()), Int(f.origin.y.rounded()), Int(f.size.width.rounded()), Int(f.size.height.rounded())]
      if let w = window, f.width <= 0 || f.height <= 0 || !f.intersects(w) { d["off"] = 1 }
    } else {
      d["off"] = 1
    }
    d["en"] = r.enabled ? 1 : 0
    if r.focused { d["foc"] = 1 }
    let pw = isPassword(r)
    if pw { d["pw"] = 1 }
    let acts = actions(e)
    var pat = ""
    let valueSettable = settable(e, kAXValueAttribute)
    let isTextBox = t == "Edit" || r.role == "AXWebArea" && valueSettable
    if isTextBox || (r.value is String && valueSettable) { pat += "V" }
    if acts.contains(kAXPressAction) || acts.contains(kAXPickAction) || acts.contains(kAXConfirmAction) { pat += "I" }
    let toggle = r.role == "AXCheckBox"
    if toggle { pat += "T" }
    // (Chromium answers AXExpanded and AXSelected false for every element: only some can be either.)
    let selectable = r.role == "AXRadioButton" || ["AXRow", "AXCell", "AXListItem", "AXMenuItem", "AXOutlineRow"].contains(r.role) || r.subrole == "AXTabButton" || r.selected == true
    if selectable { pat += "S" }
    let expandable = r.expanded == true || r.role == "AXPopUpButton" || r.role == "AXComboBox" || r.role == "AXDisclosureTriangle" || r.role == "AXMenuButton" || r.subrole == "AXOutlineRow"
    if expandable { pat += "E" }
    if isTextBox || r.role == "AXWebArea" { pat += "X" }
    if r.role == "AXSlider" || r.role == "AXIncrementor" || acts.contains(kAXIncrementAction) { pat += "R" }
    if r.role == "AXScrollArea" { pat += "L" }
    if !pat.isEmpty { d["pat"] = pat }
    if pat.contains("V") && !valueSettable { d["ro"] = 1 }
    if isTextBox || t == "Edit" { d["kf"] = 1 } else if settable(e, kAXFocusedAttribute) { d["kf"] = 1 }
    if toggle || r.role == "AXRadioButton", let n = r.value as? NSNumber { d["tog"] = n.intValue }
    if r.role == "AXRadioButton", let n = r.value as? NSNumber { d["sel"] = n.intValue != 0 ? 1 : 0 } else if selectable, let s = r.selected { d["sel"] = s ? 1 : 0 }
    if expandable, let x = r.expanded { d["exp"] = x ? 1 : 0 }
    if values, !pw, pat.contains("V") || t == "Edit", let v = valueText(r), !v.isEmpty { d["v"] = cut(v, 8000) }
    if !r.placeholder.isEmpty { d["ph"] = cut(r.placeholder, 120) }
    // A rich text editor in web content (contenteditable: ProseMirror, Slate...): an editable web text
    // box with content of its own in the tree (a native input is a leaf). See uia.ps1 IsRich.
    if t == "Edit", !pw, valueSettable, !r.children.isEmpty, r.classes.contains(where: { ["ProseMirror", "tiptap"].contains($0) }) || r.children.count > 0 && r.role == "AXTextArea" {
      d["rich"] = 1
    }
    d["rid"] = "\(CFHash(e))"
    return d
  }
}
