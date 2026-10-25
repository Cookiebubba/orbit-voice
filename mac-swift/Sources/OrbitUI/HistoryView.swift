// This conversation's history (components/History.tsx), kept in memory only: gone when you quit.
import OrbitKit
import SwiftUI

struct HistoryView: View {
  var items: [VoiceCaption]
  var onClose: () -> Void

  static let time: DateFormatter = {
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = .none
    return f
  }()

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        BackButton(action: onClose)
        Spacer()
        Text("This session only").eyebrow()
      }
      .padding(.horizontal, 16).padding(.bottom, 8)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 8) {
            if items.isEmpty {
              Text("Nothing yet. Start talking and the conversation shows up here.")
                .font(Theme.font(13)).foregroundStyle(Theme.faint).multilineTextAlignment(.center).padding(.top, 40)
            }
            ForEach(items) { c in bubble(c).id(c.id) }
            Color.clear.frame(height: 1).id("end")
          }
          .padding(.horizontal, 16).padding(.bottom, 16)
          .textSelection(.enabled)
        }
        .onAppear { proxy.scrollTo("end", anchor: .bottom) }
        .onChange(of: items.count) { proxy.scrollTo("end", anchor: .bottom) }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder private func bubble(_ c: VoiceCaption) -> some View {
    let t = Self.time.string(from: c.at)
    switch c.who {
    case .note:
      Text("\(c.text) · \(t)").font(Theme.font(11.5)).foregroundStyle(Theme.faint).multilineTextAlignment(.center).frame(maxWidth: .infinity)
    case .sent:
      VStack(alignment: .leading, spacing: 2) {
        Text("Sent to Claude · \(t)").font(Theme.mono(10)).tracking(1.2).textCase(.uppercase).foregroundStyle(Theme.emerald700)
        Text(c.text).font(Theme.font(13)).foregroundStyle(Theme.fg).snug(13)
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.emerald50))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.emerald600.opacity(0.2), lineWidth: 1))
    default:
      HStack {
        if c.who == .you { Spacer(minLength: 0) }
        Text(c.text)
          .font(Theme.font(13)).snug(13)
          .foregroundStyle(c.who == .you ? Color.white : c.who == .error ? Theme.amber700 : Theme.fg)
          .padding(.horizontal, 12).padding(.vertical, 8)
          .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(c.who == .you ? Theme.fg : c.who == .grok ? Theme.soft : Color.clear))
          .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(c.who == .error ? Theme.amber700.opacity(0.3) : .clear, lineWidth: 1))
          .help(t)
          .containerRelativeFrame(.horizontal, alignment: c.who == .you ? .trailing : .leading) { w, _ in w * 0.85 }
        if c.who != .you { Spacer(minLength: 0) }
      }
    }
  }
}
