// The website's look, as ui/src/index.css has it: a white page, the system font (the page asks for
// Inter and falls back to it; Inter isn't on a stock Mac), quiet greys, the Orbit wordmark.
import AppKit
import SwiftUI

enum Theme {
  static func rgb(_ hex: UInt32, _ a: Double = 1) -> Color {
    Color(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: a)
  }
  static let fg = rgb(0x0D0D0D)
  static let ink = rgb(0x3D4148)
  static let muted = rgb(0x6B7076)
  static let faint = rgb(0x9A9EA4)
  static let line = Color.black.opacity(0.1)
  static let soft = rgb(0xF4F4F5)
  static let claude = rgb(0xD97757)
  static let disabled = rgb(0xC4C7CB)
  static let floor = rgb(0xE8E8E8)
  static let amber700 = rgb(0xB45309)
  static let amber500 = rgb(0xF59E0B)
  static let emerald700 = rgb(0x047857)
  static let emerald600 = rgb(0x059669)
  static let emerald500 = rgb(0x10B981)
  static let emerald50 = rgb(0xECFDF5)
  static let red600 = rgb(0xDC2626)
  static let darkHover = rgb(0x2B2B2B)

  static func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight) }
  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}

extension View {
  /** The Orbit wordmark: bold, tight (.wordmark: 700, letter-spacing -0.055em, line-height 0.9). */
  func wordmark(_ size: CGFloat) -> some View {
    font(.system(size: size, weight: .bold)).tracking(-0.055 * size).foregroundStyle(Theme.fg)
  }
  /** The eyebrow: small mono capitals, spaced, muted (.eyebrow: 500 10.5px, 0.12em). */
  func eyebrow() -> some View {
    font(Theme.mono(10.5, .medium)).tracking(0.12 * 10.5).textCase(.uppercase).foregroundStyle(Theme.muted)
  }
  /** Tailwind's leading-snug (1.375) on a size. */
  func snug(_ size: CGFloat) -> some View { lineSpacing(size * 0.375 - size * 0.2) }
  /** leading-relaxed (1.625). */
  func relaxed(_ size: CGFloat) -> some View { lineSpacing(size * 0.625 - size * 0.2) }
}

/** The Orbit wordmark text. */
struct Wordmark: View {
  var text = "Orbit"
  var size: CGFloat
  var body: some View { Text(text).wordmark(size).fixedSize() }
}

/** A plain text button that changes colour on hover (the page's many muted links). */
struct HoverText<Label: View>: View {
  var action: () -> Void
  var color = Theme.muted
  var hover = Theme.fg
  @ViewBuilder var label: () -> Label
  @State private var over = false
  var body: some View {
    Button(action: action) { label().foregroundStyle(over ? hover : color).contentShape(Rectangle()) }
      .buttonStyle(.plain)
      .onHover { over = $0 }
  }
}

/** Buttons in the page's two styles: dark (bg-fg text-white) and soft (bg-soft text-ink). */
struct PillButtonStyle: ButtonStyle {
  enum Kind { case dark, soft }
  var kind: Kind = .soft
  var size: CGFloat = 12.5
  var height: CGFloat? = nil
  var hPad: CGFloat = 12
  var vPad: CGFloat = 6
  var radius: CGFloat? = nil // nil: a full pill
  var fullWidth = false
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    PillBody(configuration: configuration, kind: kind, size: size, height: height, hPad: hPad, vPad: vPad, radius: radius, fullWidth: fullWidth, enabled: enabled)
  }

  private struct PillBody: View {
    let configuration: Configuration
    let kind: Kind, size: CGFloat, height: CGFloat?, hPad: CGFloat, vPad: CGFloat, radius: CGFloat?, fullWidth: Bool, enabled: Bool
    @State private var over = false
    var body: some View {
      let bg: Color = kind == .dark ? (over && enabled ? Theme.darkHover : Theme.fg) : (over && enabled ? Color.black.opacity(0.08) : Theme.soft)
      let fgc: Color = kind == .dark ? .white : (over && enabled ? Theme.fg : Theme.ink)
      configuration.label
        .font(Theme.font(size, kind == .dark ? .medium : .regular))
        .foregroundStyle(fgc)
        .padding(.horizontal, hPad)
        .padding(.vertical, height == nil ? vPad : 0)
        .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: height, maxHeight: height)
        .background(RoundedRectangle(cornerRadius: radius ?? 999, style: .continuous).fill(bg))
        .opacity(enabled ? 1 : (kind == .dark ? 0.3 : 0.45))
        .contentShape(Rectangle())
        .onHover { over = $0 }
    }
  }
}

/** A text field in the page's look (rounded, soft fill, a line that darkens on focus). */
struct FieldStyle: ViewModifier {
  var height: CGFloat = 32
  var radius: CGFloat = 8
  var size: CGFloat = 13
  var focused: Bool
  func body(content: Content) -> some View {
    content
      .textFieldStyle(.plain)
      .font(Theme.font(size))
      .foregroundStyle(Theme.fg)
      .padding(.horizontal, 8)
      .frame(height: height)
      .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(focused ? Color.white : Theme.soft))
      .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(focused ? Color.black.opacity(0.4) : Theme.line, lineWidth: 1))
  }
}

/** Opens an https link in the browser (only https, as the Electron shell). */
@MainActor func openExternal(_ url: URL) {
  guard url.scheme == "https" || url.scheme == "x-apple.systempreferences" else { return }
  NSWorkspace.shared.open(url)
}
