// The title bar's session switcher (components/SessionSwitcher.tsx): the sessions in Claude's
// sidebar. Click one to open it in Claude, or "Ask" to have the voice tell you about it.
import OrbitKit
import SwiftUI

struct SessionSwitcherButton: View {
  @Bindable var ctx: UIContext
  @Binding var open: Bool
  @State private var over = false
  var body: some View {
    Button(action: { open.toggle() }) {
      HStack(spacing: 4) {
        if !ctx.app.claudeWorking.isEmpty { WorkingDot() }
        Text(ctx.voice.sessionTitle ?? "Sessions").font(Theme.font(12)).lineLimit(1).truncationMode(.tail)
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
      }
      .foregroundStyle(over || open ? Theme.fg : Theme.muted)
      .padding(.horizontal, 6).padding(.vertical, 4)
      .background(RoundedRectangle(cornerRadius: 6).fill(over ? Theme.soft : .clear))
      .frame(maxWidth: 150, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { over = $0 }
    .help("Switch Claude session")
    .accessibilityLabel("Switch Claude session")
    .accessibilityValue(ctx.voice.sessionTitle ?? "")
  }
}

struct SessionSwitcherPanel: View {
  @Bindable var ctx: UIContext
  var close: () -> Void
  @State private var rows: [SessionRow]?
  @State private var canSwitch = true
  @State private var busy: String?
  @State private var error = ""
  @State private var filter = ""
  @FocusState private var focused: Bool

  var shown: [SessionRow] { (rows ?? []).filter { filter.isEmpty || $0.title.localizedCaseInsensitiveContains(filter) } }

  var body: some View {
    VStack(spacing: 0) {
      TextField("", text: $filter, prompt: Text("Find a session…").foregroundStyle(Theme.faint))
        .textFieldStyle(.plain).font(Theme.font(12.5)).foregroundStyle(Theme.fg)
        .focused($focused)
        .padding(.horizontal, 10).frame(height: 32)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.soft))
        .padding(6)
        .onExitCommand(perform: close)
      if rows != nil || !filter.isEmpty {
        Rectangle().fill(Theme.line).frame(height: 1)
        ScrollView {
          VStack(spacing: 0) {
            if rows == nil { Text("Loading…").font(Theme.font(12.5)).foregroundStyle(Theme.faint).frame(maxWidth: .infinity, alignment: .leading).padding(10) }
            if rows != nil && shown.isEmpty { Text("No sessions found.").font(Theme.font(12.5)).foregroundStyle(Theme.faint).frame(maxWidth: .infinity, alignment: .leading).padding(10) }
            ForEach(shown) { s in row(s) }
          }
          .padding(4)
        }
        .frame(maxHeight: 300)
      }
      if !error.isEmpty {
        Rectangle().fill(Theme.line).frame(height: 1)
        Text(error).font(Theme.font(12)).foregroundStyle(Theme.amber700).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 8)
      }
      if !canSwitch && rows != nil {
        Rectangle().fill(Theme.line).frame(height: 1)
        Text("Open the Claude app to switch sessions from here.").font(Theme.font(11.5)).foregroundStyle(Theme.faint).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 8)
      }
    }
    .frame(width: 310)
    .fixedSize(horizontal: false, vertical: true)
    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    .shadow(color: .black.opacity(0.28), radius: 20, y: 12)
    .onAppear {
      focused = true
      Task {
        do {
          let list = try await ctx.bridge.sessions()
          rows = list.sessions
          canSwitch = list.canSwitch
        } catch { rows = [] }
      }
    }
  }

  private func row(_ s: SessionRow) -> some View {
    let working = s.working || ctx.app.claudeWorking.contains { $0.title == s.title }
    return HStack(spacing: 0) {
      Button(action: { switchTo(s.title) }) {
        HStack(spacing: 10) {
          Group {
            if working { WorkingDot() } else { Circle().fill(s.open ? Theme.fg : Color.black.opacity(0.15)).frame(width: 8, height: 8) }
          }
          .accessibilityLabel(working ? "Claude is working" : s.open ? "Open" : "Idle")
          VStack(alignment: .leading, spacing: 1) {
            Text(busy == s.title ? "Opening…" : s.title).font(Theme.font(13)).foregroundStyle(Theme.fg).lineLimit(1)
            let sub = [s.project, working ? "working" : s.lastActive].filter { !$0.isEmpty }.joined(separator: " · ")
            if !sub.isEmpty { Text(sub).font(Theme.font(11.5)).foregroundStyle(Theme.faint).lineLimit(1) }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          if s.open {
            Text("open").font(Theme.font(10.5)).foregroundStyle(Theme.muted).padding(.horizontal, 6)
              .overlay(Capsule().strokeBorder(Color.black.opacity(0.15), lineWidth: 1))
          }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(busy != nil)
      .help(canSwitch ? "Open in Claude" : "Ask Grok about it")
      IconButtonPlain(symbol: "questionmark.bubble", size: 12, frame: 28) {
        close()
        ask(s.title)
      }
      .help("Ask Grok about this session")
      .accessibilityLabel("Ask Grok about \(s.title)")
      .padding(.trailing, 4)
    }
    .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.0001)))
  }

  private func ask(_ title: String) {
    ctx.screen = .main
    ctx.voice.ask("What's happening in my Claude session called \"\(title)\"?")
  }

  private func switchTo(_ title: String) {
    guard canSwitch else { close(); ask(title); return }
    busy = title
    error = ""
    Task {
      let r = try? await ctx.bridge.switchSession(title: title)
      busy = nil
      if let r, r.ok {
        ctx.voice.sessionTitle = r.sessionTitle ?? title
        close()
      } else {
        error = r?.message ?? "Couldn't open that session."
      }
    }
  }
}
