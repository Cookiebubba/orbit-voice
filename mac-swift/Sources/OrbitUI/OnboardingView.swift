// The permissions onboarding (OnboardingModel), in the launcher: one step at a time, with the
// three permissions listed underneath as the Electron Mac build's Settings rows show them.
import OrbitKit
import SwiftUI

struct OnboardingView: View {
  @Bindable var model: OnboardingModel
  var onDone: () -> Void

  var body: some View {
    let s = model.screen
    VStack(alignment: .leading, spacing: 0) {
      Spacer(minLength: 0)
      Text(s.eyebrow).eyebrow()
      Text(s.title).font(.system(size: 26, weight: .bold)).tracking(-0.03 * 26).foregroundStyle(Theme.fg)
        .fixedSize(horizontal: false, vertical: true).padding(.top, 10)
      Text(s.body).font(Theme.font(13)).foregroundStyle(Theme.ink).relaxed(13)
        .fixedSize(horizontal: false, vertical: true).padding(.top, 10)
      if let note = model.note {
        Text(note).font(Theme.font(12)).foregroundStyle(Theme.amber700).padding(.top, 8)
      }
      VStack(spacing: 0) {
        ForEach(OnboardingModel.items) { item in
          let on = model.isOn(item.step)
          HStack(alignment: .top, spacing: 12) {
            Circle().fill(on ? Theme.emerald500 : item.needed ? Theme.amber500 : Theme.line).frame(width: 8, height: 8).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
              (Text(item.label).font(Theme.font(13, .medium)).foregroundStyle(Theme.fg)
                + Text("  " + (on ? "On" : item.needed ? "Off: needed" : "Off")).font(Theme.font(11.5)).foregroundStyle(Theme.muted))
            }
            Spacer(minLength: 0)
            if item.step == s.step { Image(systemName: "arrow.left").font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.top, 3) }
          }
          .padding(.vertical, 6)
          .accessibilityElement(children: .combine)
        }
      }
      .padding(.top, 18)
      Spacer(minLength: 0)
      Button(s.primary) {
        Task {
          if s.step == .done { onDone() } else { await model.primary() }
        }
      }
      .buttonStyle(PillButtonStyle(kind: .dark, size: 14, height: 44, fullWidth: true))
      .keyboardShortcut(.defaultAction)
      HStack {
        if let secondary = s.secondary {
          HoverText(action: { model.skip() }) { Text(secondary).font(Theme.font(12.5)).padding(.vertical, 6) }
        }
        Spacer()
        if let url = s.settingsURL, s.action != .openSettings(url) {
          HoverText(action: { model.probe.open(url) }) { Text("Open System Settings").font(Theme.font(12.5)).padding(.vertical, 6) }
        }
        if s.step != .done {
          HoverText(action: { model.skipAll() }, color: Theme.faint) { Text("Skip setup").font(Theme.font(12.5)).padding(.vertical, 6).padding(.leading, 10) }
            .help("Skip the rest of the setup. Settings → Mac permissions has it any time.")
        }
      }
      .padding(.top, 8).padding(.bottom, 16)
    }
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
