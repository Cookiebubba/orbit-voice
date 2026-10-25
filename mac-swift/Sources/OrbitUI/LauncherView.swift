// The launcher (ui/src/App.tsx): white, the website's look. A title bar with the wordmark, the
// session switcher, History and Settings; Qubit as the hero in the middle with the avatar carousel;
// what Orbit is doing; the last captions; the typing box; and icon-only controls at the bottom.
import AppKit
import OrbitKit
import SwiftUI

/** Which screen the launcher shows (parity: windows.main.view). */
public enum LauncherScreen: String, Sendable { case main, settings, history, onboarding }

/** Everything the windows share: the bridge, the models, the voice and hotkey, the shell's hooks. */
@MainActor
@Observable
public final class UIContext {
  public let bridge: BridgeClient
  public let settings: SettingsModel
  public let app: AppStateModel
  public let onboarding: OnboardingModel
  public let updates: UpdateChecker
  @ObservationIgnored public let voice: any VoiceUI
  @ObservationIgnored public let hotkey: any HotkeyControl
  @ObservationIgnored public let login: any LoginItemControl
  public var screen: LauncherScreen = .main
  public var typing = false
  /** The orbit-helper (the Claude app's driver) is present; false shows Settings' note. nil: unknown. */
  public var helperPresent: Bool?
  /** Bumped whenever the shell changes the login item or hotkey elsewhere (the menu), so views re-read. */
  public var shellRevision = 0
  /** Settings saved a new hotkey (the shell tells the core and refreshes its menu). */
  @ObservationIgnored public var hotkeyChanged: (String) -> Void = { _ in }
  @ObservationIgnored let hero: HeroBridge

  init(bridge: BridgeClient, settings: SettingsModel, app: AppStateModel, onboarding: OnboardingModel, updates: UpdateChecker,
       voice: any VoiceUI, hotkey: any HotkeyControl, login: any LoginItemControl, heroRoot: URL, heroSeed: Int?) {
    self.bridge = bridge; self.settings = settings; self.app = app; self.onboarding = onboarding; self.updates = updates
    self.voice = voice; self.hotkey = hotkey; self.login = login
    hero = HeroBridge(root: heroRoot, seed: heroSeed)
  }
}

struct LauncherView: View {
  @Bindable var ctx: UIContext

  var body: some View {
    VStack(spacing: 0) {
      TitleBar(ctx: ctx)
      if ctx.screen == .main, ctx.settings.loaded, let banner = ctx.onboarding.bannerText {
        PermissionsBanner(text: banner.text) { Task { await ctx.onboarding.request(banner.missing[0].step) } }
      }
      switch ctx.screen {
      case .settings: SettingsView(ctx: ctx) { ctx.screen = .main }
      case .history: HistoryView(items: ctx.voice.captions) { ctx.screen = .main }
      case .onboarding: OnboardingView(model: ctx.onboarding) { ctx.screen = .main }
      case .main:
        if ctx.settings.failed {
          Centered("Orbit isn't signed in to its local bridge. Close this and open Orbit again.")
        } else if !ctx.settings.loaded {
          Centered("Loading…")
        } else if !ctx.settings.hasKey {
          KeySetupView(ctx: ctx)
        } else {
          MainContent(ctx: ctx)
        }
      }
    }
    .frame(minWidth: 320, minHeight: 480)
    .background(Color.white)
    .ignoresSafeArea(.container, edges: .top) // the page's own 44 pt bar is the title bar
    .environment(\.colorScheme, .light) // the page is white in dark mode too
  }
}

struct Centered: View {
  var text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(Theme.font(13)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

// MARK: - Title bar

struct TitleBar: View {
  @Bindable var ctx: UIContext
  @State private var switcherOpen = false
  var body: some View {
    ZStack(alignment: .leading) {
      WindowDragArea()
      HStack(spacing: 6) {
        Wordmark(size: 19).padding(.trailing, 4).allowsHitTesting(false)
        SessionSwitcherButton(ctx: ctx, open: $switcherOpen)
        Spacer(minLength: 0)
        HStack(spacing: 0) {
          TitleButton(label: "History", symbol: "clock.arrow.circlepath", active: ctx.screen == .history) { ctx.screen = ctx.screen == .history ? .main : .history }
          TitleButton(label: "Settings", symbol: "gearshape", active: ctx.screen == .settings) { ctx.screen = ctx.screen == .settings ? .main : .settings }
        }
      }
      .padding(.leading, 78) // the traffic lights sit at the left
      .padding(.trailing, 6)
    }
    .frame(height: 44)
    .overlay(alignment: .topLeading) {
      if switcherOpen {
        SessionSwitcherPanel(ctx: ctx) { switcherOpen = false }
          .offset(x: 16, y: 40)
      }
    }
    .zIndex(10)
  }
}

// MARK: - Main screen

struct MainContent: View {
  @Bindable var ctx: UIContext
  @State private var text = ""
  @FocusState private var focused: Bool

  var body: some View {
    let v = ctx.voice
    let s = ctx.settings
    let on = v.phase != .off
    let tap = s.string("listenMode") == "tap"
    let hotkey = s.hotkeyLabel
    let waitingForYes = v.asleep && tap && v.draft != nil
    let working = ctx.app.claudeWorking
    let status = LauncherStatus.status(phase: v.phase, asleep: v.asleep, muted: v.muted, tap: tap, draft: v.draft != nil)
    let hint = LauncherStatus.hint(phase: v.phase, asleep: v.asleep, tap: tap, draft: v.draft != nil, wakeWordOn: s.bool("wakeWord") && (v.phase == .off || v.asleep), hotkey: hotkey)
    let heroVoice = HeroVoice(phase: v.phase, asleep: v.asleep, hearing: v.hearing, input: v.inputLevel, output: v.outputLevel, muted: v.muted,
                              draft: v.draft != nil, sending: v.sending, claudeWorking: !working.isEmpty)
    let heroLabel = !on ? "Start talking" : v.asleep ? "Wake up" : "Voice is on"

    VStack(spacing: 0) {
      VStack(spacing: 0) {
        Spacer(minLength: 0)
        AvatarHeroView(bridge: ctx.hero, avatar: s.string("avatar"), voice: heroVoice, label: heroLabel,
                       onChoose: { id in Task { await s.set("avatar", .string(id)) } },
                       onActivate: { if !on { v.start() } else if v.asleep { v.wake() } })
        // CSS line boxes: 16px text in a 24px line, 11px mono "snug" in ~15px.
        Text(status).font(Theme.font(16, .semibold)).tracking(-0.32).foregroundStyle(Theme.fg).frame(minHeight: 24).padding(.top, 20)
        if let hint {
          Text(hint).font(Theme.mono(11)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(minHeight: 15).padding(.top, 6)
        }
        if !working.isEmpty {
          HStack(spacing: 6) {
            WorkingDot()
            Text(working.count == 1 ? "Claude is working in \(working[0].title)" : "Claude is working in \(working.count) sessions")
              .font(Theme.font(12)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
          }
          .padding(.top, 8)
        }
        VStack(spacing: 4) {
          let recent = CaptionList.recent(v.captions)
          ForEach(Array(recent.enumerated()), id: \.element.id) { i, c in
            Text(c.who == .sent ? "Sent to Claude ✓ \(c.text)" : c.text)
              .font(Theme.font(13))
              .foregroundStyle(captionColor(c, last: i == recent.count - 1))
              .multilineTextAlignment(.center)
              .lineLimit(2)
              .snug(13)
          }
        }
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .top)
        .padding(.top, 12)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 20)
      .padding(.top, 4) // centres as the page's column does (its line boxes are a little taller)

      if ctx.typing && on {
        HStack(spacing: 0) {
          TextField("", text: $text, prompt: Text("Type to Grok…").foregroundStyle(Theme.faint))
            .textFieldStyle(.plain).font(Theme.font(13)).foregroundStyle(Theme.fg)
            .focused($focused)
            .onSubmit(send)
            .frame(height: 40)
          Button(action: send) {
            Image(systemName: "paperplane.fill").font(.system(size: 12)).foregroundStyle(.white)
              .frame(width: 32, height: 32).background(Circle().fill(Theme.fg))
          }
          .buttonStyle(.plain)
          .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
          .opacity(text.trimmingCharacters(in: .whitespaces).isEmpty ? 0.25 : 1)
          .help("Send").accessibilityLabel("Send")
        }
        .padding(.leading, 16).padding(.trailing, 4)
        .background(Capsule().fill(Theme.soft))
        .padding(.horizontal, 16).padding(.bottom, 8)
        .onAppear { focused = true }
      }

      // Only their icons. Sleep in the middle (big), typing on its left, mute on its right.
      HStack(spacing: 28) {
        if on {
          IconButton(label: "Type instead", symbol: "keyboard", active: ctx.typing, iconSize: 19) { ctx.typing.toggle() }
          IconButton(label: waitingForYes ? "Answer (\(hotkey))" : "Go to sleep: hangs up (\(hotkey))", symbol: waitingForYes ? "mic" : "moon",
                     big: true, active: waitingForYes, iconSize: 23) { v.hotkey() }
          IconButton(label: v.muted ? "Unmute microphone" : "Mute microphone", symbol: v.muted ? "mic.slash" : "mic", danger: v.muted, iconSize: 19) { v.toggleMute() }
        } else {
          IconButton(label: "Start talking", symbol: "mic", big: true, active: true, iconSize: 24) { v.start() }
        }
      }
      .frame(height: 72)
      .padding(.bottom, 4)
      .frame(maxWidth: .infinity)
    }
  }

  private func send() {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return }
    ctx.voice.type(t)
    text = ""
  }

  private func captionColor(_ c: VoiceCaption, last: Bool) -> Color {
    switch c.who {
    case .error: return Theme.amber700
    case .you: return Theme.faint
    case .sent: return Theme.emerald700
    case .grok: return last ? Theme.fg : Theme.muted
    case .note: return Theme.muted
    }
  }
}

/** On the main screen while something Orbit needs is off (MacPermissionsBanner). */
struct PermissionsBanner: View {
  var text: String
  var onTurnOn: () -> Void
  @State private var hidden = false
  var body: some View {
    if !hidden {
      HStack(spacing: 8) {
        Circle().fill(Theme.amber500).frame(width: 8, height: 8).accessibilityHidden(true)
        Text(text).font(Theme.font(12)).foregroundStyle(Theme.ink).snug(12).frame(maxWidth: .infinity, alignment: .leading)
        Button("Turn on", action: onTurnOn).buttonStyle(PillButtonStyle(kind: .dark, size: 11.5, hPad: 10, vPad: 4))
        HoverText(action: { hidden = true }) { Text("×").font(Theme.font(13)).padding(.horizontal, 4) }.accessibilityLabel("Not now")
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.soft))
      .padding(.horizontal, 16).padding(.bottom, 8)
      .accessibilityElement(children: .contain)
    }
  }
}

// MARK: - Key setup (no xAI key yet)

struct KeySetupView: View {
  let ctx: UIContext
  @State private var key = ""
  @State private var error = ""
  @FocusState private var focused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Wordmark(size: 40)
      Text("Welcome").eyebrow()
      (Text("Orbit uses Grok Voice from xAI. Paste your xAI API key to start. Get one at ")
        + Text("[console.x.ai](https://console.x.ai)").underline()
        + Text(" → API Keys. It's stored encrypted, only on this computer."))
        .font(Theme.font(13)).foregroundStyle(Theme.ink).relaxed(13).tint(Theme.fg)
        .fixedSize(horizontal: false, vertical: true)
      SecureField("", text: $key, prompt: Text("xai-…").foregroundStyle(Theme.faint))
        .focused($focused)
        .modifier(FieldStyle(height: 40, radius: 12, focused: focused))
        .onSubmit(save)
      if !error.isEmpty { Text(error).font(Theme.font(12)).foregroundStyle(Theme.amber700) }
      Button("Save key", action: save)
        .buttonStyle(PillButtonStyle(kind: .dark, size: 14, height: 44, fullWidth: true))
        .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
    }
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func save() {
    let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !k.isEmpty else { return }
    error = ""
    Task {
      do {
        try await ctx.bridge.setXaiKey(k)
        key = ""
        ctx.settings.markHasKey()
      } catch {
        self.error = (error as? BridgeError)?.message ?? "Could not save the key."
      }
    }
  }
}
