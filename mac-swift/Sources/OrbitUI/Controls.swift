// The page's building blocks (Settings.tsx Section / Segmented / Toggle, App.tsx IconButton /
// TitleButton, the sliders and the Claude-is-working dot), drawn the same way.
import AppKit
import SwiftUI

/** A Settings section: a hairline on top, the eyebrow title, then its rows. */
struct SettingsSection<Content: View>: View {
  var title: String
  var titleGap: CGFloat = 16
  @ViewBuilder var content: () -> Content
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Rectangle().fill(Theme.line).frame(height: 1)
      Text(title).eyebrow().padding(.top, 20).padding(.bottom, titleGap).accessibilityAddTraits(.isHeader)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/** Grey help text under a control (12px muted, snug). */
struct Hint: View {
  var text: String
  var size: CGFloat = 12
  var color = Theme.muted
  var body: some View {
    Text(text).font(Theme.font(size)).foregroundStyle(color).snug(size).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
  }
}

/** A small label above a control ("Brain", "Effort"...). */
struct FieldLabel: View {
  var text: String
  var body: some View { Text(text).font(Theme.font(12.5)).foregroundStyle(Theme.ink).padding(.top, 16).padding(.bottom, 6) }
}

/** The page's segmented control: a soft pill with the chosen option filled black. */
struct Segmented: View {
  struct Option: Identifiable { var value: String; var label: String; var id: String { value } }
  var value: String
  var options: [Option]
  var onChange: (String) -> Void
  var body: some View {
    HStack(spacing: 0) {
      ForEach(options) { o in
        SegmentButton(label: o.label, selected: o.value == value) { onChange(o.value) }
      }
    }
    .padding(3)
    .background(Capsule().fill(Theme.soft))
    .accessibilityElement(children: .contain)
  }

  private struct SegmentButton: View {
    var label: String
    var selected: Bool
    var action: () -> Void
    @State private var over = false
    var body: some View {
      Button(action: action) {
        Text(label)
          .font(Theme.font(12.5, .medium))
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .foregroundStyle(selected ? Color.white : (over ? Theme.fg : Theme.ink))
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
          .frame(maxWidth: .infinity)
          .background(Capsule().fill(selected ? Theme.fg : Color.clear))
          .contentShape(Capsule())
      }
      .buttonStyle(.plain)
      .onHover { over = $0 }
      .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
  }
}

/** A labelled switch with a hint (Settings.tsx Toggle). */
struct ToggleRow: View {
  var label: String
  var hint: String?
  var isOn: Bool
  var onChange: (Bool) -> Void
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(label).font(Theme.font(13, .medium)).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
        if let hint { Text(hint).font(Theme.font(12)).foregroundStyle(Theme.muted).snug(12).fixedSize(horizontal: false, vertical: true) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      OrbitSwitch(isOn: isOn, label: label) { onChange(!isOn) }.padding(.top, 2)
    }
  }
}

/** The switch itself: 36x20, black when on, a white knob. */
struct OrbitSwitch: View {
  var isOn: Bool
  var label: String
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      ZStack(alignment: .leading) {
        Capsule().fill(isOn ? Theme.fg : Color.black.opacity(0.15)).frame(width: 36, height: 20)
        Circle().fill(Color.white).frame(width: 16, height: 16).shadow(color: .black.opacity(0.2), radius: 1, y: 1)
          .offset(x: isOn ? 18 : 2)
      }
      .frame(width: 36, height: 20)
      .animation(.easeOut(duration: 0.15), value: isOn)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityValue(isOn ? "on" : "off")
    .accessibilityAddTraits(.isToggle)
  }
}

/** The page's slider (.speed-slider): a 4 px track filled black up to a 16 px black thumb. */
struct OrbitSlider: View {
  @Binding var value: Double
  var range: ClosedRange<Double>
  var step: Double
  var label: String
  /** Let go (pointer up / key up): the page saves then. */
  var onCommit: (Double) -> Void = { _ in }
  @State private var dragging = false

  private func snapped(_ v: Double) -> Double {
    let s = (((v - range.lowerBound) / step).rounded() * step) + range.lowerBound
    return min(range.upperBound, max(range.lowerBound, (s * 1000).rounded() / 1000))
  }

  var body: some View {
    GeometryReader { g in
      let w = g.size.width
      let frac = range.upperBound > range.lowerBound ? (value - range.lowerBound) / (range.upperBound - range.lowerBound) : 0
      ZStack(alignment: .leading) {
        Capsule().fill(Color.black.opacity(0.1)).frame(height: 4)
        Capsule().fill(Theme.fg).frame(width: max(0, w * frac), height: 4)
        Circle().fill(Theme.fg).frame(width: 16, height: 16)
          .overlay(Circle().stroke(Color.black.opacity(dragging ? 0.18 : 0.06), lineWidth: 4).padding(-2))
          .offset(x: max(0, min(w - 16, w * frac - 8)))
      }
      .frame(height: 20)
      .contentShape(Rectangle())
      .gesture(DragGesture(minimumDistance: 0).onChanged { d in
        dragging = true
        value = snapped(range.lowerBound + Double(min(max(0, d.location.x / max(1, w)), 1)) * (range.upperBound - range.lowerBound))
      }.onEnded { _ in
        dragging = false
        onCommit(value)
      })
    }
    .frame(height: 20)
    .accessibilityElement()
    .accessibilityLabel(label)
    .accessibilityValue(String(format: "%.2f", value))
    .accessibilityAdjustableAction { dir in
      value = snapped(value + (dir == .increment ? step : -step))
      onCommit(value)
    }
  }
}

/** A bottom-bar control: only its icon, a quiet grey that darkens; its name is the tooltip. */
struct IconButton: View {
  var label: String
  var symbol: String
  var big = false
  var active = false
  var danger = false
  var iconSize: CGFloat
  var action: () -> Void
  @State private var over = false
  @State private var down = false
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: iconSize, weight: .medium))
        .foregroundStyle(danger ? Theme.red600 : (active || over ? Theme.fg : Theme.muted))
        .frame(width: big ? 48 : 40, height: big ? 48 : 40)
        .contentShape(Circle())
    }
    .buttonStyle(PressScale())
    .onHover { over = $0 }
    .help(label)
    .accessibilityLabel(label)
  }
}

struct PressScale: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.scaleEffect(configuration.isPressed ? 0.94 : 1).animation(.easeOut(duration: 0.15), value: configuration.isPressed)
  }
}

/** A title-bar button (32x32, rounded; soft when active or hovered). */
struct TitleButton: View {
  var label: String
  var symbol: String
  var active = false
  var action: () -> Void
  @State private var over = false
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(active || over ? Theme.fg : Theme.muted)
        .frame(width: 32, height: 32)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(active || over ? Theme.soft : .clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { over = $0 }
    .help(label)
    .accessibilityLabel(label)
  }
}

/** "← Back" (Settings and History). */
struct BackButton: View {
  var action: () -> Void
  var body: some View {
    HoverText(action: action) {
      HStack(spacing: 6) {
        Image(systemName: "arrow.left").font(.system(size: 13))
        Text("Back").font(Theme.font(13))
      }
      .padding(.vertical, 4).padding(.trailing, 8)
    }
    .accessibilityLabel("Back")
  }
}

/** Claude is working: a small orange dot that breathes (.working-dot). */
struct WorkingDot: View {
  @State private var on = false
  @Environment(\.accessibilityReduceMotion) private var reduce
  var body: some View {
    Circle().fill(Theme.claude).frame(width: 7, height: 7)
      .opacity(reduce ? 1 : (on ? 1 : 0.35))
      .scaleEffect(reduce ? 1 : (on ? 1 : 0.85))
      .onAppear { if !reduce { withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { on = true } } }
      .accessibilityHidden(true)
  }
}

/** Key caps for the hotkey (Settings.tsx Keys). */
struct KeyCaps: View {
  var parts: [String]
  var dim = false
  var body: some View {
    HStack(spacing: 4) {
      ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
        Text(p)
          .font(Theme.font(13, .medium))
          .foregroundStyle(dim ? Theme.faint : Theme.fg)
          .padding(.horizontal, 8).padding(.vertical, 4)
          .frame(minWidth: 28)
          .background(RoundedRectangle(cornerRadius: 6).fill(Color.white))
          .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.black.opacity(dim ? 0.1 : 0.15), lineWidth: 1))
          .shadow(color: dim ? .clear : .black.opacity(0.08), radius: 0, y: 1)
      }
    }
  }
}

/** A drag area for the window (the page's title bar is -webkit-app-region: drag). */
struct WindowDragArea: NSViewRepresentable {
  final class DragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
      if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
    }
  }
  func makeNSView(context: Context) -> NSView { DragView() }
  func updateNSView(_ nsView: NSView, context: Context) {}
}

/** OKLCH (the engine's colour space) to sRGB, for the mouse preview's swatches. */
func oklch(_ l: Double, _ c: Double, _ hDeg: Double) -> Color {
  let h = hDeg * .pi / 180
  let a = c * cos(h), b = c * sin(h)
  let l_ = l + 0.3963377774 * a + 0.2158037573 * b
  let m_ = l - 0.1055613458 * a - 0.0638541728 * b
  let s_ = l - 0.0894841775 * a - 1.2914855480 * b
  let L = l_ * l_ * l_, M = m_ * m_ * m_, S = s_ * s_ * s_
  let r = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S
  let g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S
  let bl = -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S
  func enc(_ x: Double) -> Double {
    let v = max(0, min(1, x))
    return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055
  }
  return Color(.sRGB, red: enc(r), green: enc(g), blue: enc(bl), opacity: 1)
}
