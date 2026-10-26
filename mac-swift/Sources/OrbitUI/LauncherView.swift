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
  /** Settings was opened from the "needs an xAI key" notice: its key field takes the focus. */
  public var focusKey = false
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
      case .settings: SettingsView(ctx: ctx) {
          ctx.focusKey = false
          ctx.screen = .main
        }
      case .history: HistoryView(items: ctx.voice.captions) { ctx.screen = .main }
      case .onboarding:
        if ctx.onboarding.voicePending { VoiceSetupView(ctx: ctx) } else { OnboardingView(model: ctx.onboarding) { ctx.screen = .main } }
      case .main:
        if ctx.settings.failed {
          Centered("Orbit isn't signed in to its local bridge. Close this and open Orbit again.")
        } else if !ctx.settings.loaded {
          Centered("Loading…")
        } else {
          // (Never a key screen: the main page shows with or without an xAI key; see Talk.)
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
        let notice = on ? nil : v.talkNotice
        // Claude voice's speech models loading and warming up (a call started now waits for them).
        let warming = v.voiceWarming && notice == nil && (!on || v.phase == .connecting)
        if warming {
          Text("Getting Orbit's voice ready…").font(Theme.mono(11)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(minHeight: 15).padding(.top, 6)
        } else if let hint, notice == nil {
          Text(hint).font(Theme.mono(11)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(minHeight: 15).padding(.top, 6)
        }
        if let notice {
          TalkNoticeView(notice: notice, openSettings: { ctx.openSettings(focusKey: notice.kind == "grok-key") },
                         useClaude: { v.useClaudeVoice() }, tryAgain: { v.start() })
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
          TextField("", text: $text, prompt: Text(s.string("voiceEngine") == "claude" ? "Type to Orbit…" : "Type to Grok…").foregroundStyle(Theme.faint))
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

// MARK: - The notice after a try to talk that couldn't start (no key screen)

extension UIContext {
  /** Settings, with its xAI key field focused when the notice was about the key. */
  public func openSettings(focusKey: Bool = false) {
    self.focusKey = focusKey
    screen = .settings
  }
}

/** Grok without a key, or Claude voice not ready: what to do, in a line, with a way out (App.tsx). */
struct TalkNoticeView: View {
  let notice: TalkNotice
  var openSettings: () -> Void
  var useClaude: () -> Void
  var tryAgain: () -> Void
  var body: some View {
    let missing = notice.kind == "claude-missing", setup = missing || notice.kind == "claude-signed-out"
    VStack(spacing: 8) {
      Text(notice.text).font(Theme.font(12.5)).foregroundStyle(notice.kind == "claude-models" ? Theme.ink : Theme.amber700)
        .multilineTextAlignment(.center).snug(12.5).fixedSize(horizontal: false, vertical: true)
      if missing {
        InstallCommandBox()
        SignInStepText().frame(maxWidth: .infinity, alignment: .leading)
      }
      if notice.kind != "claude-models" {
        HStack(spacing: 8) {
          if setup { Button("Check again", action: tryAgain).buttonStyle(PillButtonStyle(kind: .soft)) }
          if missing { Button("Setup guide") { openExternal(Talk.claudeCodeGuide) }.buttonStyle(PillButtonStyle(kind: .soft)) }
          Button("Open Settings", action: openSettings).buttonStyle(PillButtonStyle(kind: .soft))
          if notice.kind == "grok-key" { Button("Use Claude voice", action: useClaude).buttonStyle(PillButtonStyle(kind: .soft)) }
          if notice.kind == "claude-models-error" { Button("Try again", action: tryAgain).buttonStyle(PillButtonStyle(kind: .soft)) }
        }
      }
    }
    .frame(maxWidth: 320)
    .padding(.top, 8)
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.updatesFrequently)
  }
}

/** Claude Code's install command for this Mac in a code box, with Copy (ui/src/components/ClaudeSetup.tsx InstallCommand). */
struct InstallCommandBox: View {
  @State private var copied = false

  /** Puts the install command on the clipboard. */
  @MainActor static func copyCommand() -> String {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(Talk.claudeInstallCommand, forType: .string)
    return Talk.claudeInstallCommand
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("In Terminal:").font(Theme.font(11.5)).foregroundStyle(Theme.muted)
      HStack(spacing: 4) {
        Text(Talk.claudeInstallCommand).font(Theme.mono(11.5)).foregroundStyle(Theme.fg).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
        Button {
          _ = Self.copyCommand()
          copied = true
          Task {
            try? await Task.sleep(for: .seconds(1.8))
            copied = false
          }
        } label: {
          Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(Theme.font(12)).labelStyle(.titleAndIcon)
        }
        .buttonStyle(PillButtonStyle(kind: .soft, size: 12, height: 28, hPad: 8, radius: 6))
        .accessibilityLabel("Copy the install command")
      }
      .padding(.leading, 10).padding(.trailing, 4).padding(.vertical, 4)
      .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.soft))
      .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/** "Then run claude once…" (ClaudeSetup.tsx SignInStep). */
struct SignInStepText: View {
  var body: some View {
    (Text("Then run ") + Text("claude").font(Theme.mono(11.5)).foregroundColor(Theme.ink) + Text(" once in a terminal and sign in with your Claude account."))
      .font(Theme.font(12)).foregroundStyle(Theme.muted).snug(12).fixedSize(horizontal: false, vertical: true)
  }
}

/**
 * Claude Code isn't on this Mac: Anthropic's install command to copy (Orbit never runs it itself),
 * the sign-in step, Check again and Anthropic's setup guide. Settings and the voice setup use it.
 */
struct InstallClaudeCodeView: View {
  var onCheck: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      InstallCommandBox()
      SignInStepText()
      HStack(spacing: 8) {
        Button("Check again", action: onCheck).buttonStyle(PillButtonStyle(kind: .soft))
        Button("Setup guide") { openExternal(Talk.claudeCodeGuide) }.buttonStyle(PillButtonStyle(kind: .soft))
      }
    }
  }
}
