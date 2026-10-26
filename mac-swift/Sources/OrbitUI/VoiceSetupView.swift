// The onboarding's voice step: choose Claude voice or Grok voice, and set it up right here with the
// same bridge calls Settings uses: Claude Code (install command, sign-in, the speech models) or the
// xAI key. "Skip this step" moves on to the permissions; "Skip setup" skips the whole onboarding.
import OrbitKit
import SwiftUI

struct VoiceSetupView: View {
  @Bindable var ctx: UIContext
  @State private var claude: ClaudeVoiceStatus?
  @State private var brain: BrainStatus?
  @State private var signingIn: (since: Date, error: String?)?
  @State private var poll: Task<Void, Never>?
  @State private var key = ""
  @State private var keyError: String?
  @State private var replacing = false
  @FocusState private var keyFocused: Bool

  private var engine: String { ctx.settings.string("voiceEngine") == "grok" ? "grok" : "claude" }

  /** Everything the chosen voice needs is in place. */
  private var ready: Bool {
    engine == "grok" ? ctx.settings.hasKey : (brain?.found == true && brain?.signedIn == true)
  }

  var body: some View {
    let m = ctx.onboarding
    VStack(alignment: .leading, spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Text("Step 1 of \(m.stepCount) · Voice").eyebrow().padding(.top, 12)
          Text("How should Orbit talk?").font(.system(size: 24, weight: .bold)).tracking(-0.03 * 24).foregroundStyle(Theme.fg)
            .fixedSize(horizontal: false, vertical: true).padding(.top, 8)
          Text("Pick one and set it up. You can switch any time in Settings.")
            .font(Theme.font(13)).foregroundStyle(Theme.ink).snug(13).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
          HStack(alignment: .top, spacing: 10) {
            EngineCard(symbol: "laptopcomputer", name: "Claude", blurb: "Uses your Claude Code sign-in. Speech stays on \(thisComputer).",
                       tag: "No extra cost", accent: Theme.claude, selected: engine == "claude") { choose("claude") }
            EngineCard(symbol: "bolt.fill", name: "Grok", blurb: "xAI's realtime voice, with the quickest replies.",
                       tag: "Paid per minute", accent: Theme.fg, selected: engine == "grok") { choose("grok") }
          }
          .padding(.top, 14)
          setup.padding(.top, 10)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
      }
      VStack(spacing: 0) {
        Button("Continue") { m.finishVoice() }
          .buttonStyle(PillButtonStyle(kind: .dark, size: 14, height: 44, fullWidth: true))
          .keyboardShortcut(.defaultAction)
          .disabled(!ready)
        HStack {
          HoverText(action: { m.finishVoice() }) { Text("Skip this step").font(Theme.font(12.5)).padding(.vertical, 6) }
            .help("Set the voice up later in Settings → Voice engine.")
          Spacer()
          HoverText(action: { m.skipAll() }, color: Theme.faint) { Text("Skip setup").font(Theme.font(12.5)).padding(.vertical, 6) }
            .help("Skip the whole setup. Settings has all of it any time.")
        }
        .padding(.top, 8).padding(.bottom, 16)
      }
      .padding(.horizontal, 24)
      .padding(.top, 10)
      .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .task(id: engine) { await refresh() }
    .onDisappear { poll?.cancel() }
  }

  // MARK: the chosen voice's setup

  @ViewBuilder private var setup: some View {
    VStack(alignment: .leading, spacing: 0) {
      if engine == "grok" {
        grokSetup
      } else {
        claudeSetup
      }
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.soft))
    .animation(.easeOut(duration: 0.2), value: engine)
  }

  @ViewBuilder private var grokSetup: some View {
    let saved = ctx.settings.hasKey
    SetupRow(done: saved, title: "xAI API key", detail: saved ? "Saved, encrypted on \(thisComputer)" : nil) {
      if saved { HoverText(action: { replacing.toggle() }) { Text(replacing ? "Cancel" : "Replace").font(Theme.font(12)) } }
    }
    if !saved || replacing {
      HStack(spacing: 8) {
        SecureField("", text: $key, prompt: Text("xai-…").foregroundStyle(Theme.faint))
          .focused($keyFocused).modifier(FieldStyle(height: 34, focused: keyFocused))
          .accessibilityLabel("xAI API key")
          .onSubmit(saveKey)
        Button("Save", action: saveKey).buttonStyle(PillButtonStyle(kind: .dark, size: 12.5, height: 34, hPad: 14, radius: 8))
          .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      .padding(.top, 10)
      (Text("Get one at ") + Text("[console.x.ai](https://console.x.ai)").underline() + Text(" → API Keys."))
        .font(Theme.font(11.5)).foregroundStyle(keyError == nil ? Theme.muted : Theme.red600).tint(Theme.ink).padding(.top, 6)
      if let keyError { Text(keyError).font(Theme.font(11.5)).foregroundStyle(Theme.red600).padding(.top, 4) }
    }
  }

  @ViewBuilder private var claudeSetup: some View {
    let found = brain?.found
    let signed = brain?.signedIn == true
    // 1. Claude Code on this Mac.
    SetupRow(done: found == true, title: "Claude Code", detail: found == nil ? "Checking…" : found == true ? "Installed" : "Not installed yet")
    if found == false {
      Text("Copy the install command into Terminal, run it, then press Check again.")
        .font(Theme.font(12)).foregroundStyle(Theme.ink).snug(12).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
      InstallClaudeCodeView(onCheck: { Task { await refresh() } }).padding(.top, 8)
    }
    // 2. Signed in to it.
    SetupRow(done: signed, title: "Sign in", detail: signed ? "Signed in" : found == true ? signInDetail : "After Claude Code is installed",
             detailColor: signingIn?.error != nil ? Theme.red600 : nil) {
      if found == true && !signed {
        let waiting = signingIn != nil && signingIn?.error == nil
        Button(waiting ? "Waiting…" : "Sign in", action: signIn)
          .buttonStyle(PillButtonStyle(kind: .dark, size: 12, height: 28, hPad: 12, radius: 8))
          .disabled(waiting)
      }
    }
    .padding(.top, 10)
    // 3. The speech models (Claude voice hears and speaks on this Mac).
    let models = claude?.models
    SetupRow(done: models?.state == "ready", title: "Speech models", detail: modelsDetail, detailColor: models?.state == "error" ? Theme.amber700 : nil) {
      if models?.state == "error" {
        Button("Retry", action: download).buttonStyle(PillButtonStyle(kind: .soft, size: 12, height: 28, hPad: 12, radius: 8))
      }
    }
    .padding(.top, 10)
    if models?.state == "downloading" { ProgressBar(percent: models?.percent ?? 0).padding(.top, 8).padding(.leading, 28) }
  }

  private var signInDetail: String {
    if let e = signingIn?.error { return e }
    return signingIn != nil ? "Finish in the browser that opened…" : "With your Claude account"
  }

  private var modelsDetail: String {
    guard let c = claude else { return "Checking…" }
    switch c.models.state {
    case "ready": return "Ready"
    case "downloading": return "Downloading… \(c.models.percent)%"
    case "error": return "Download failed: \(c.models.error)"
    default: return "About \(c.mb) MB, kept on \(thisComputer)"
    }
  }

  // MARK: actions

  private func choose(_ e: String) {
    guard e != engine else { return }
    Task { await ctx.settings.set("voiceEngine", .string(e)) }
  }

  private func refresh() async {
    async let c = try? ctx.bridge.claudeVoice()
    async let b = try? ctx.bridge.brain()
    let (cv, br) = await (c, b)
    if let cv { claude = cv }
    if let br { brain = br }
    // Claude voice chosen: its speech models download right away (as choosing it in Settings does).
    if engine == "claude", let st = claude?.models.state, st != "ready", st != "downloading", st != "error" { download() }
    poll?.cancel()
    if engine == "claude" && claude?.models.state == "downloading" {
      poll = Task {
        try? await Task.sleep(for: .seconds(1))
        if !Task.isCancelled { await refresh() }
      }
    }
  }

  /** POST /api/key, as Settings' key field. The key is never shown or logged. */
  private func saveKey() {
    let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !k.isEmpty else { return }
    keyError = nil
    Task {
      do {
        try await ctx.bridge.setXaiKey(k)
        key = ""
        replacing = false
        ctx.settings.markHasKey()
      } catch {
        keyError = (error as? BridgeError)?.message ?? "Couldn't save it."
      }
    }
  }

  private func download() { Task { _ = try? await ctx.bridge.claudeVoiceDownload(); await refresh() } }

  /** Claude Code's own sign-in (POST /api/brain/login), then a check every 3 s until it reports signed in. */
  private func signIn() {
    signingIn = (Date(), nil)
    Task {
      do {
        let r = try await ctx.bridge.brainLogin()
        if !r.ok { signingIn = (Date(), r.error ?? "Couldn't open the sign-in."); return }
      } catch { signingIn = (Date(), "Couldn't reach Orbit."); return }
      let since = Date()
      while signingIn != nil, signingIn?.error == nil, Date().timeIntervalSince(since) < 180 {
        try? await Task.sleep(for: .seconds(3))
        if let b = try? await ctx.bridge.brain() { brain = b }
        if brain?.signedIn == true { signingIn = nil; return }
      }
      signingIn = nil
    }
  }
}

/** One of the two voices, as a card to pick. */
private struct EngineCard: View {
  let symbol: String
  let name: String
  let blurb: String
  let tag: String
  let accent: Color
  let selected: Bool
  let action: () -> Void
  @State private var over = false

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 6) {
          Image(systemName: symbol).font(.system(size: 11, weight: .semibold)).foregroundStyle(selected ? accent : Theme.muted)
            .frame(width: 24, height: 24)
            .background(Circle().fill(selected ? accent.opacity(0.12) : Color.black.opacity(0.05)))
          Text(name).font(Theme.font(15, .semibold)).foregroundStyle(Theme.fg).lineLimit(1).fixedSize().layoutPriority(1)
          Spacer(minLength: 0)
          Image(systemName: selected ? "checkmark.circle.fill" : "circle").font(.system(size: 15))
            .foregroundStyle(selected ? Theme.fg : Theme.disabled)
        }
        Text(blurb).font(Theme.font(11.5)).foregroundStyle(Theme.muted).snug(11.5)
          .fixedSize(horizontal: false, vertical: true).padding(.top, 8)
        Spacer(minLength: 6)
        Text(tag).font(Theme.mono(9.5, .medium)).tracking(0.6).textCase(.uppercase).foregroundStyle(selected ? Theme.ink : Theme.faint)
      }
      .padding(.horizontal, 11).padding(.vertical, 12)
      .frame(maxWidth: .infinity, minHeight: 118, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(selected ? Color.white : over ? Color.black.opacity(0.06) : Theme.soft))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(selected ? Theme.fg : Theme.line, lineWidth: selected ? 1.5 : 1))
      .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
    .buttonStyle(.plain)
    .onHover { over = $0 }
    .accessibilityLabel("\(name) voice")
    .accessibilityHint(blurb)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/** A setup item: a tick when done, its name, how it stands, and an optional button. */
private struct SetupRow<Trailing: View>: View {
  let done: Bool
  let title: String
  let detail: String?
  var detailColor: Color? = nil
  @ViewBuilder var trailing: () -> Trailing

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      ZStack {
        Circle().fill(done ? Theme.emerald500 : Color.white).frame(width: 18, height: 18)
        if done { Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white) } else {
          Circle().strokeBorder(Theme.disabled, lineWidth: 1.5).frame(width: 18, height: 18)
        }
      }
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(Theme.font(13, .medium)).foregroundStyle(Theme.fg)
        if let detail {
          Text(detail).font(Theme.font(11.5)).foregroundStyle(detailColor ?? (done ? Theme.emerald700 : Theme.muted)).snug(11.5)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 8)
      trailing()
    }
    .accessibilityElement(children: .combine)
  }
}

extension SetupRow where Trailing == EmptyView {
  init(done: Bool, title: String, detail: String?, detailColor: Color? = nil) {
    self.init(done: done, title: title, detail: detail, detailColor: detailColor, trailing: { EmptyView() })
  }
}
