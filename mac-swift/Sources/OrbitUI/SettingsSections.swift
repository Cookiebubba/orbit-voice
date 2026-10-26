// Settings' sections that talk to the bridge beyond /api/settings (voice lists and previews, speech
// models, the second brain, usage, keys) and to the shell (hotkey, updates, logs).
// Keys typed here go straight to the bridge (POST /api/key, /api/brain/key): never shown, never logged.
import AppKit
import OrbitKit
import SwiftUI

// MARK: - Voice engine

private let brainSpeed: [String: String] = [
  "haiku": "Haiku is the fastest: about 1 second to the first word.",
  "sonnet": "Sonnet: about 2 seconds to the first word on average, sometimes much more.",
  "opus": "Opus: anywhere from under 1 to about 3 seconds to the first word.",
  "fable": "Fable: the slowest, about 3 seconds to the first word.",
]

private let sttOptions: [(value: String, label: String, hint: String)] = [
  ("moonshine", "Fastest", "Moonshine base: about 0.1 s per sentence. Misses the most when you mumble (about 1 word in 5 when quiet)."),
  ("parakeet-110m", "Balanced", "Parakeet 110M: just as fast, about 0.1 s. Fewer misses when you mumble (about 1 in 6). A 100 MB download."),
  ("parakeet-v2", "Accurate", "Parakeet 0.6B: the most accurate, about 1 word in 8 even when mumbling, about 0.3 s slower per sentence. A 460 MB download. Recommended if you mumble."),
]

struct VoiceEngineSection: View {
  @Bindable var ctx: UIContext
  @State private var status: ClaudeVoiceStatus?
  @State private var poll: Task<Void, Never>?

  var body: some View {
    let s = ctx.settings
    let engine = s.string("voiceEngine")
    SettingsSection(title: "Voice engine") {
      Segmented(value: engine, options: [.init(value: "grok", label: "Grok"), .init(value: "claude", label: "Claude (beta)")]) { choose($0) }
      if engine == "grok" {
        Hint(text: "Grok's realtime voice, billed by xAI per minute.").padding(.top, 8)
        XaiKeyField(ctx: ctx)
      } else {
        Hint(text: "Claude through your own Claude Code sign-in, with speech recognized and spoken on \(thisComputer). No xAI cost. Replies take a moment longer than Grok's.").padding(.top, 8)
        FieldLabel(text: "Brain")
        Segmented(value: s.string("claudeVoiceModel"), options: ["haiku", "sonnet", "opus", "fable"].map { .init(value: $0, label: $0.capitalizedFirst) }) { save(s, "claudeVoiceModel", .string($0)) }
        Hint(text: "\(brainSpeed[s.string("claudeVoiceModel")] ?? "") You can also say \"use Opus\" or \"switch to Haiku\". A change takes over between turns, mid-call too.").padding(.top, 8)
        FieldLabel(text: "Effort")
        Segmented(value: s.string("claudeVoiceEffort"), options: [.init(value: "low", label: "Low"), .init(value: "medium", label: "Medium"), .init(value: "high", label: "High")]) { save(s, "claudeVoiceEffort", .string($0)) }
        Hint(text: s.string("claudeVoiceEffort") == "low" ? "Answers right away. Best for talking." : "Thinks longer before it speaks: slower to answer, especially on Opus and Fable.").padding(.top, 8)
        FieldLabel(text: "Speech to text")
        Segmented(value: s.string("claudeVoiceStt"), options: sttOptions.map { .init(value: $0.value, label: $0.label) }) { chooseStt($0) }
        Hint(text: "\(sttOptions.first { $0.value == s.string("claudeVoiceStt") }?.hint ?? "") All on \(thisComputer). (Grok hears you on xAI's side: this is for Claude voice only.)").padding(.top, 8)
        sttStatus
        modelsStatus
      }
    }
    .task(id: engine) { await refresh() }
    .onDisappear { poll?.cancel() }
  }

  @ViewBuilder private var sttStatus: some View {
    let id = ctx.settings.string("claudeVoiceStt")
    if id != "moonshine", let st = status?.stt[id], st.state != "ready" {
      if st.state == "downloading" {
        VStack(alignment: .leading, spacing: 6) {
          Text("Downloading… \(st.percent)% (Moonshine listens until it's ready)").font(Theme.font(12)).foregroundStyle(Theme.ink)
          ProgressBar(percent: st.percent)
        }
        .padding(.top, 6)
      } else {
        HStack(spacing: 12) {
          Hint(text: st.state == "error" ? "Download failed: \(st.error)" : "Needs a \(st.mb) MB download. Moonshine listens until then.", color: st.state == "error" ? Theme.amber700 : Theme.muted)
          Button(st.state == "error" ? "Retry" : "Download") { downloadStt(id) }.buttonStyle(PillButtonStyle(kind: .dark, size: 12, hPad: 10, vPad: 4, radius: 8))
        }
        .padding(.top, 6)
      }
    }
  }

  @ViewBuilder private var modelsStatus: some View {
    if let status {
      VStack(alignment: .leading, spacing: 0) {
        if !status.claudeFound {
          Hint(text: Talk.claudeCodeMissing, color: Theme.amber700).padding(.bottom, 8)
          InstallClaudeCodeView(onCheck: { Task { await refresh() } }).padding(.bottom, 12)
        }
        switch status.models.state {
        case "ready": Hint(text: "Speech models ready.")
        case "downloading":
          Text("Downloading speech models… \(status.models.percent)%").font(Theme.font(12)).foregroundStyle(Theme.ink)
          ProgressBar(percent: status.models.percent).padding(.top, 6)
        default:
          HStack(spacing: 12) {
            Hint(text: status.models.state == "error" ? "Download failed: \(status.models.error)" : "Needs about \(status.mb) MB of speech models, kept on \(thisComputer).", color: status.models.state == "error" ? Theme.amber700 : Theme.muted)
            Button(status.models.state == "error" ? "Retry" : "Download") { download() }.buttonStyle(PillButtonStyle(kind: .dark, size: 12, hPad: 10, vPad: 4, radius: 8))
          }
        }
      }
      .padding(.top, 12)
    }
  }

  private func refresh() async {
    status = try? await ctx.bridge.claudeVoice()
    // While models download, check progress every second.
    let downloading = status?.models.state == "downloading" || (status?.stt.values.contains { $0.state == "downloading" } ?? false)
    poll?.cancel()
    if downloading {
      poll = Task {
        try? await Task.sleep(for: .seconds(1))
        if !Task.isCancelled { await refresh() }
      }
    }
  }

  private func choose(_ engine: String) {
    Task {
      await ctx.settings.set("voiceEngine", .string(engine))
      if engine == "claude", let st = status?.models.state, st != "ready", st != "downloading" { download() }
    }
  }

  private func chooseStt(_ id: String) {
    Task {
      await ctx.settings.set("claudeVoiceStt", .string(id))
      if id != "moonshine", let st = status?.stt[id], st.state != "ready", st.state != "downloading" { downloadStt(id) }
    }
  }

  private func download() { Task { _ = try? await ctx.bridge.claudeVoiceDownload(); await refresh() } }
  private func downloadStt(_ id: String) { Task { _ = try? await ctx.bridge.sttDownload(id); await refresh() } }
}

struct ProgressBar: View {
  var percent: Int
  var body: some View {
    GeometryReader { g in
      ZStack(alignment: .leading) {
        Capsule().fill(Color.black.opacity(0.07))
        Capsule().fill(Theme.fg).frame(width: g.size.width * CGFloat(max(0, min(100, percent))) / 100)
      }
    }
    .frame(height: 4)
    .animation(.easeOut(duration: 0.7), value: percent)
  }
}

// MARK: - The engine's voice card (VoiceSettings.tsx)

struct VoiceCard: View {
  @Bindable var ctx: UIContext
  let engine: String
  @State private var list: VoiceList?
  @State private var speed: Double?
  @State private var volume: Double?
  @State private var preview = "idle" // idle | loading | playing
  @State private var error = ""
  @State private var player = PreviewPlayer()
  @State private var saveTask: Task<Void, Never>?
  @State private var volTask: Task<Void, Never>?

  var body: some View {
    let claude = engine == "claude"
    let s = ctx.settings
    Group {
      if let list {
        SettingsSection(title: claude ? "Orbit's voice" : "Grok's voice", titleGap: 0) {
          Text(claude ? "Spoken on \(thisComputer). Pick one by ear with Preview. Changes apply right away." : "Changes apply right away, even mid-conversation.")
            .font(Theme.font(12.5)).foregroundStyle(Theme.muted).relaxed(12.5).padding(.top, 12)
          Text("Voice").font(Theme.font(12)).foregroundStyle(Theme.muted).padding(.top, 16).padding(.bottom, 6)
          HStack(spacing: 8) {
            voicePicker(list, current: claude ? String(s.int("claudeVoice")) : s.string("voice"))
            Button(action: playPreview) {
              HStack(spacing: 6) {
                if preview == "loading" { ProgressView().controlSize(.mini).tint(.white) } else { Image(systemName: preview == "playing" ? "stop.fill" : "play.fill").font(.system(size: 10)) }
                Text(preview == "playing" ? "Stop" : "Preview")
              }
            }
            .buttonStyle(PillButtonStyle(kind: .dark, size: 13, height: 40, hPad: 14, radius: 12))
            .help(preview == "playing" ? "Stop preview" : "Preview this voice")
            .accessibilityLabel(preview == "playing" ? "Stop preview" : "Preview voice")
          }
          let sp = speed ?? s.double("speed")
          HStack(alignment: .firstTextBaseline) {
            Text("Talking speed").font(Theme.font(12)).foregroundStyle(Theme.muted)
            Spacer()
            Text(String(format: "%.2f×", sp)).font(Theme.font(13, .medium)).monospacedDigit().foregroundStyle(Theme.fg)
          }
          .padding(.top, 20).padding(.bottom, 6)
          OrbitSlider(value: Binding(get: { speed ?? s.double("speed") }, set: { changeSpeed($0) }), range: list.minSpeed...list.maxSpeed, step: 0.05, label: "Talking speed")
          HStack {
            Text("Slower")
            Spacer()
            HoverText(action: { changeSpeed(1) }, color: Theme.faint) { Text("Reset to 1×") }.opacity(sp == 1 ? 0 : 1).disabled(sp == 1)
            Spacer()
            Text("Faster")
          }
          .font(Theme.font(11.5)).foregroundStyle(Theme.faint).padding(.top, 4)
          let vol = volume ?? s.double("voiceVolume")
          HStack(alignment: .firstTextBaseline) {
            Text("Volume").font(Theme.font(12)).foregroundStyle(Theme.muted)
            Spacer()
            Text("\(Int((vol * 100).rounded()))%").font(Theme.font(13, .medium)).monospacedDigit().foregroundStyle(Theme.fg)
          }
          .padding(.top, 20).padding(.bottom, 6)
          OrbitSlider(value: Binding(get: { volume ?? s.double("voiceVolume") }, set: { changeVolume($0) }), range: 0...1, step: 0.01, label: "Volume")
          HStack { Text("Quiet"); Spacer(); Text("Loud") }.font(Theme.font(11.5)).foregroundStyle(Theme.faint).padding(.top, 4)
          Hint(text: "Applies at once, mid-sentence too. You can also say \"talk quieter\" or \"louder\".", size: 11.5, color: Theme.faint).padding(.top, 6)
          if !error.isEmpty { Text(error).font(Theme.font(12.5)).foregroundStyle(Theme.amber700).padding(.top, 12) }
        }
      } else {
        VStack(alignment: .leading, spacing: 0) {
          Rectangle().fill(Theme.line).frame(height: 1)
          Text(error.isEmpty ? "Loading voices…" : error).font(Theme.font(13)).foregroundStyle(Theme.muted).padding(.top, 20)
        }
      }
    }
    .task {
      do { list = try await ctx.bridge.voices(engine: engine) } catch { self.error = "Couldn't load voice settings." }
    }
    .onDisappear { player.stop(); saveTask?.cancel() }
  }

  private func voicePicker(_ list: VoiceList, current: String) -> some View {
    let groups = [("Female", list.voices.filter { $0.gender == "female" }), ("Male", list.voices.filter { $0.gender == "male" }), ("Other", list.voices.filter { $0.gender != "female" && $0.gender != "male" })].filter { !$0.1.isEmpty }
    let known = list.voices.contains { $0.id == current }
    let name = list.voices.first { $0.id == current }?.name ?? current
    return Menu {
      if !known { Button(current) { pick(current) } }
      ForEach(groups, id: \.0) { g in
        Section(g.0) { ForEach(g.1) { v in Button(v.name) { pick(v.id) } } }
      }
    } label: {
      HStack {
        Text(name).font(Theme.font(13)).foregroundStyle(Theme.fg)
        Spacer()
        Image(systemName: "chevron.down").font(.system(size: 11)).foregroundStyle(Theme.muted)
      }
      .padding(.leading, 12).padding(.trailing, 12)
      .frame(height: 40)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.soft))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
      .contentShape(Rectangle())
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .accessibilityLabel("Voice")
    .accessibilityValue(name)
  }

  private func pick(_ id: String) {
    error = ""
    Task {
      let r = engine == "claude" ? await ctx.settings.set("claudeVoice", .number(Double(id) ?? 0)) : await ctx.settings.set("voice", .string(id))
      if case .saved = r {} else { error = "Couldn't save that setting." }
    }
  }

  private func changeSpeed(_ v: Double) {
    speed = v
    saveTask?.cancel()
    saveTask = Task {
      try? await Task.sleep(for: .milliseconds(350))
      guard !Task.isCancelled else { return }
      let r = await ctx.settings.set("speed", .number(v))
      if case .saved = r { speed = nil } else { error = "Couldn't save that setting." }
    }
  }

  private func changeVolume(_ v: Double) {
    volume = v
    player.setVolume(v)
    volTask?.cancel()
    volTask = Task {
      try? await Task.sleep(for: .milliseconds(150))
      guard !Task.isCancelled else { return }
      await ctx.settings.set("voiceVolume", .number(v))
      volume = nil
    }
  }

  private func playPreview() {
    if preview == "playing" { player.stop(); preview = "idle"; return }
    preview = "loading"
    error = ""
    let s = ctx.settings
    let voice = engine == "claude" ? String(s.int("claudeVoice")) : s.string("voice")
    Task {
      do {
        let data = try await ctx.bridge.voicePreview(engine: engine, voice: voice, speed: speed ?? s.double("speed"))
        player.onEnd = { preview = "idle" }
        try player.play(data, volume: volume ?? s.double("voiceVolume"))
        preview = "playing"
      } catch {
        preview = "idle"
        self.error = (error as? BridgeError)?.message ?? "Preview failed."
      }
    }
  }
}

// MARK: - Second brain

struct SecondBrainSection: View {
  @Bindable var ctx: UIContext
  @State private var status: BrainStatus?
  @State private var test: (state: String, text: String) = ("idle", "")
  @State private var key = ""
  @State private var keyError = ""
  @State private var path: String?
  @State private var advanced: Bool?
  @State private var signingIn: (since: Date, error: String?)?
  @FocusState private var keyFocused: Bool
  @FocusState private var pathFocused: Bool

  var body: some View {
    let s = ctx.settings, name = s.assistantName
    let showAdvanced = advanced ?? !s.string("brainClaudePath").isEmpty
    SettingsSection(title: "Second brain") {
      ToggleRow(label: "Let \(name) ask Claude when a question is hard", hint: "For deep questions, or questions about the code in your current project, \(name) quietly asks Claude and tells you the answer. Only a short note appears when Claude reads your project.", isOn: s.bool("brainEnabled")) { save(s, "brainEnabled", .bool($0)) }
      ToggleRow(label: "Let \(name) search the web", hint: s.string("voiceEngine") == "claude"
        ? "For current facts (the latest versions, news, docs), \(name) looks them up instead of guessing: a quick search through your Claude Code that can only search and read web pages. What pages say is never taken as an instruction."
        : "For current facts (the latest versions, news, docs), \(name) looks them up instead of guessing, with xAI's own web and X search. What pages say is never taken as an instruction.", isOn: s.bool("webSearch")) { save(s, "webSearch", .bool($0)) }.padding(.top, 16)
      if s.bool("brainEnabled") {
        FieldLabel(text: "Model")
        Segmented(value: s.string("brainModel"), options: [.init(value: "auto", label: "\(name) picks"), .init(value: "haiku", label: "Haiku"), .init(value: "sonnet", label: "Sonnet"), .init(value: "opus", label: "Opus")]) { save(s, "brainModel", .string($0)) }
        Hint(text: s.string("brainModel") == "auto" ? "\(name) chooses per question: Haiku for quick lookups, Sonnet for most code questions, Opus only for hard problems." : "Every question goes to \(s.string("brainModel").capitalizedFirst).").padding(.top, 8)
        ToggleRow(label: "Read the current project", hint: "Claude may read the files of the project open in your Claude session to answer: read-only, only inside that project folder, with common secret files (.env, keys, credentials) blocked. It can't run commands or change anything.", isOn: s.bool("brainExplore")) { save(s, "brainExplore", .bool($0)) }.padding(.top, 16)
        FieldLabel(text: "Connection")
        Segmented(value: s.string("brainConnection"), options: [.init(value: "claude-code", label: "My Claude login"), .init(value: "api-key", label: "Anthropic API key")]) { v in
          test = ("idle", "")
          Task { await s.set("brainConnection", .string(v)); await refresh() }
        }
        Hint(text: s.string("brainConnection") == "claude-code" ? "Uses your Claude Code sign-in, so questions count toward your Claude plan. No setup if you use Claude Code." : "Questions are billed to your Anthropic API account. The key is encrypted on \(thisComputer).").padding(.top, 8)
        if s.string("brainConnection") == "claude-code", let st = status, !st.found {
          VStack(alignment: .leading, spacing: 8) {
            Text("Claude Code isn't on \(thisComputer) yet. Copy the install command into Terminal, run it, then press Check again.")
              .font(Theme.font(12.5)).foregroundStyle(Theme.amber700).snug(12.5).fixedSize(horizontal: false, vertical: true)
            InstallClaudeCodeView(onCheck: { Task { await refresh() } })
          }
          .padding(.top, 8)
        }
        if s.string("brainConnection") == "claude-code", let st = status, st.found, let signed = st.signedIn {
          HStack(spacing: 12) {
            Text(signed ? "Signed in to Claude Code ✓" : signingIn?.error ?? (signingIn != nil ? "Finish signing in in the window and browser that opened…" : "Claude Code isn't signed in (or its sign-in expired)."))
              .font(Theme.font(12.5)).foregroundStyle(signed ? Theme.ink : signingIn?.error != nil ? Theme.red600 : Theme.amber700).snug(12.5)
              .frame(maxWidth: .infinity, alignment: .leading)
            if !signed {
              Button(signingIn != nil && signingIn?.error == nil ? "Waiting…" : "Sign in", action: signIn)
                .buttonStyle(PillButtonStyle(kind: .dark, size: 12.5, height: 32, radius: 8))
                .disabled(signingIn != nil && signingIn?.error == nil)
            }
          }
          .padding(.top, 8)
        }
        if s.string("brainConnection") == "api-key" {
          VStack(alignment: .leading, spacing: 4) {
            if status?.hasKey == true && key.isEmpty {
              HStack {
                Text("API key saved ✓").font(Theme.font(12.5)).foregroundStyle(Theme.ink)
                Spacer()
                HoverText(action: { saveKey("") }) { Text("Remove").font(Theme.font(12.5)).padding(.horizontal, 8).padding(.vertical, 4) }
              }
            } else {
              HStack(spacing: 8) {
                SecureField("", text: $key, prompt: Text("sk-ant-…").foregroundStyle(Theme.faint))
                  .focused($keyFocused).modifier(FieldStyle(focused: keyFocused))
                  .onSubmit { if !key.trimmingCharacters(in: .whitespaces).isEmpty { saveKey(key.trimmingCharacters(in: .whitespaces)) } }
                Button("Save") { saveKey(key.trimmingCharacters(in: .whitespaces)) }
                  .buttonStyle(PillButtonStyle(kind: .dark, size: 12.5, height: 32, radius: 8))
                  .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
              }
            }
            if !keyError.isEmpty { Text(keyError).font(Theme.font(12)).foregroundStyle(Theme.red600) }
          }
          .padding(.top, 8)
        }
        HStack(spacing: 12) {
          Button(test.state == "testing" ? "Testing…" : "Test connection", action: runTest)
            .buttonStyle(PillButtonStyle(kind: .soft, size: 12.5, height: 32, radius: 8))
            .disabled(test.state == "testing")
          Text(test.state == "idle" ? (status.map { $0.found ? "Using \(where_($0))." : "Claude Code not found." } ?? "") : test.text)
            .font(Theme.font(12)).foregroundStyle(test.state == "failed" ? Theme.red600 : test.state == "ok" ? Theme.emerald700 : Theme.muted).snug(12)
        }
        .padding(.top, 12)
        HoverText(action: { advanced = !showAdvanced }) { Text(showAdvanced ? "Hide location" : "Claude Code location…").font(Theme.font(12)) }.padding(.top, 12)
        if showAdvanced {
          VStack(alignment: .leading, spacing: 4) {
            TextField("", text: Binding(get: { path ?? s.string("brainClaudePath") }, set: { path = $0 }),
                      prompt: Text(status.flatMap { $0.path != nil && $0.source != "settings" ? "Automatic: \($0.path!)" : nil } ?? "Automatic").foregroundStyle(Theme.faint))
              .focused($pathFocused).modifier(FieldStyle(size: 12, focused: pathFocused))
              .onSubmit(savePath)
              .onChange(of: pathFocused) { if !pathFocused { savePath() } }
            Hint(text: "Leave empty to find it automatically. Otherwise, the full path to claude.", size: 11.5, color: Theme.faint)
          }
          .padding(.top, 8)
        }
      }
    }
    .task(id: "\(s.string("brainClaudePath"))|\(s.string("brainConnection"))") { await refresh() }
  }

  private func where_(_ st: BrainStatus) -> String {
    st.source == "claude-desktop" ? "the copy inside the Claude app" : st.source == "settings" ? "the path below" : "Claude Code on \(thisComputer)"
  }

  private func refresh() async { if let st = try? await ctx.bridge.brain() { status = st } }

  private func savePath() {
    guard let p = path?.trimmingCharacters(in: .whitespaces), p != ctx.settings.string("brainClaudePath") else { return }
    Task {
      let r = await ctx.settings.set("brainClaudePath", .string(p))
      if case .saved = r { path = nil }
    }
  }

  private func saveKey(_ value: String) {
    keyError = ""
    Task {
      do {
        _ = try await ctx.bridge.setBrainKey(value)
        key = ""
        await refresh()
      } catch {
        keyError = (error as? BridgeError)?.message ?? "Couldn't save the key."
      }
    }
  }

  private func runTest() {
    test = ("testing", "")
    Task {
      do {
        let r = try await ctx.bridge.brainTest()
        test = r.ok ? ("ok", "Connected (\(r.seconds.map { String(format: "%g", $0) } ?? "?") s)") : ("failed", r.error ?? "Failed.")
        if r.needsSignIn { await refresh() }
      } catch { test = ("failed", "Couldn't reach Orbit.") }
    }
  }

  private func signIn() {
    signingIn = (Date(), nil)
    Task {
      do {
        let r = try await ctx.bridge.brainLogin()
        if !r.ok { signingIn = (Date(), r.error ?? "Couldn't open the sign-in."); return }
      } catch { signingIn = (Date(), "Couldn't reach Orbit."); return }
      // Re-check every 3 s (for up to 3 minutes) until Claude Code reports signed in.
      let since = Date()
      while signingIn != nil, signingIn?.error == nil, Date().timeIntervalSince(since) < 180 {
        try? await Task.sleep(for: .seconds(3))
        await refresh()
        if status?.signedIn == true { signingIn = nil; test = ("idle", ""); return }
      }
      signingIn = nil
    }
  }
}

// MARK: - Wake hotkey

struct HotkeySection: View {
  @Bindable var ctx: UIContext
  @State private var info: HotkeyControlInfo?
  @State private var recording = false
  @State private var partial: [String] = []
  @State private var message: (text: String, bad: Bool)?
  @State private var monitor: Any?

  var body: some View {
    let _ = ctx.shellRevision
    SettingsSection(title: "Wake hotkey") {
      Text("Works from any app: starts Grok when it's off, and puts it to sleep or wakes it when it's on.")
        .font(Theme.font(12.5)).foregroundStyle(Theme.muted).relaxed(12.5).padding(.top, -4)
      Button(action: { message = nil; recording ? stop() : record() }) {
        Group {
          if recording {
            if partial.isEmpty { Text("Press your new shortcut…").font(Theme.font(13)).foregroundStyle(Theme.ink) } else { KeyCaps(parts: SettingsSchema.keyCaps(partial.joined(separator: "+")), dim: true) }
          } else if let info {
            KeyCaps(parts: SettingsSchema.keyCaps(info.accelerator))
          }
        }
        .frame(maxWidth: .infinity, minHeight: 48)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.soft))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(recording ? Color.black.opacity(0.4) : Theme.line, lineWidth: 1))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .padding(.top, 16)
      .accessibilityLabel(recording ? "Press your new shortcut" : "Wake hotkey \(info?.label ?? ""), click to change")
      HStack {
        Text(recording ? "Esc to cancel" : "Click to change").foregroundStyle(Theme.faint)
        Spacer()
        if let info, info.accelerator != info.defaultAccelerator, !recording {
          HoverText(action: { apply(info.defaultAccelerator) }) { Text("Reset to \(SettingsSchema.keyCaps(info.defaultAccelerator).joined(separator: "+"))") }
        }
      }
      .font(Theme.font(12)).padding(.top, 8)
      if let message {
        Hint(text: message.text, size: 12.5, color: message.bad ? Theme.amber700 : Theme.emerald700).padding(.top, 12)
      } else if let info, !info.registered, !recording {
        Hint(text: "This shortcut isn't active. Another app is probably using it. Pick a different one.", size: 12.5, color: Theme.amber700).padding(.top, 12)
      }
    }
    .onAppear { info = ctx.hotkey.info() }
    .onDisappear { stop() }
  }

  private func apply(_ accel: String) {
    let r = ctx.hotkey.set(accel)
    info = r
    if r.ok == true { ctx.settings.showHotkey(r.accelerator); ctx.hotkeyChanged(r.accelerator) }
    message = r.ok == true ? ("Saved. \(r.label) now starts, sleeps and wakes Grok.", false) : (r.error ?? "Could not use that shortcut.", true)
    ctx.shellRevision += 1
  }

  /** Record the next shortcut; the current global hotkey is paused meanwhile so it can be re-picked. */
  private func record() {
    recording = true
    ctx.hotkey.suspend(true)
    monitor = NSEvent.addLocalMonitorForEventsMatchingMask([.keyDown, .flagsChanged]) { e in
      MainActor.assumeIsolated {
        let f = e.modifierFlags
        var mods: HotkeyRecorder.Modifiers = []
        if f.contains(.control) { mods.insert(.control) }
        if f.contains(.option) { mods.insert(.option) }
        if f.contains(.shift) { mods.insert(.shift) }
        if f.contains(.command) { mods.insert(.command) }
        if e.type == .flagsChanged {
          partial = HotkeyRecorder.parts(mods)
          return
        }
        if e.keyCode == HotkeyRecorder.escapeKeyCode && !f.contains(.control) && !f.contains(.option) && !f.contains(.command) { stop(); return }
        let r = HotkeyRecorder.accelerator(keyCode: e.keyCode, modifiers: mods)
        partial = r.partial
        if let err = r.error { message = (err, true) }
        if let a = r.accelerator { stop(); apply(a) }
      }
      return nil // swallow it: a recorded key must not type anywhere
    }
  }

  private func stop() {
    guard recording else { return }
    recording = false
    partial = []
    if let m = monitor { NSEvent.removeMonitor(m) }
    monitor = nil
    ctx.hotkey.suspend(false)
  }
}

private extension NSEvent {
  static func addLocalMonitorForEventsMatchingMask(_ mask: NSEvent.EventTypeMask, handler: @escaping (NSEvent) -> NSEvent?) -> Any? {
    addLocalMonitorForEvents(matching: mask, handler: handler)
  }
}

// MARK: - Usage

struct UsageSection: View {
  @Bindable var ctx: UIContext
  @State private var usage: UsageSummary?
  @State private var rate: String?
  @FocusState private var focused: Bool
  var body: some View {
    let s = ctx.settings
    SettingsSection(title: "Usage") {
      HStack(spacing: 8) {
        card("Today", usage?.today)
        card("This month", usage?.month)
      }
      Hint(text: "An estimate from time connected to Grok. Your xAI console has the real bill. Orbit hangs up when you say \"go to sleep\", so sleeping costs nothing.").padding(.top, 8)
      HStack(spacing: 12) {
        Text("Price per minute (USD)").font(Theme.font(12.5)).foregroundStyle(Theme.ink)
        Spacer()
        TextField("", text: Binding(get: { rate ?? fmt(s.double("costPerMinute")) }, set: { rate = $0 }))
          .multilineTextAlignment(.trailing).monospacedDigit()
          .focused($focused).modifier(FieldStyle(focused: focused))
          .frame(width: 80)
          .onSubmit(commit)
          .onChange(of: focused) { if !focused { commit() } }
          .accessibilityLabel("Price per minute (USD)")
      }
      .padding(.top, 12)
    }
    .task(id: s.double("costPerMinute")) { usage = try? await ctx.bridge.usage() }
  }

  private func fmt(_ d: Double) -> String { String(format: "%g", d) }

  private func commit() {
    guard let r = rate else { return }
    // As the page: a number from 0 up to (not including) 10, else back to the saved one.
    if let n = Double(r.trimmingCharacters(in: .whitespaces)), n.isFinite, n >= 0, n < 10 {
      Task { await ctx.settings.set("costPerMinute", .number(n)); rate = nil }
    } else { rate = nil }
  }

  private func card(_ title: String, _ p: UsageSummary.Period?) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).font(Theme.font(11.5)).foregroundStyle(Theme.muted)
      Text(p.map { String(format: "$%.2f", $0.cost) } ?? "…").font(Theme.font(18, .semibold)).tracking(-0.36).monospacedDigit().foregroundStyle(Theme.fg)
      Text(p.map { "\(fmt($0.minutes)) min connected" } ?? " ").font(Theme.font(11.5)).monospacedDigit().foregroundStyle(Theme.muted)
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.soft))
  }
}

// MARK: - Updates

struct UpdatesSection: View {
  @Bindable var ctx: UIContext
  var body: some View {
    let u = ctx.updates.state
    SettingsSection(title: "Updates") {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Orbit \(ctx.settings.version)").foregroundStyle(Theme.ink)
          if let t = u.sentence { Text(t).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
        }
        .font(Theme.font(12.5)).snug(12.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        if u.status == .ready {
          Button("Restart to update") { if ctx.updates.installOnQuit(relaunch: true) { NSApp.terminate(nil) } }
            .buttonStyle(PillButtonStyle(kind: .dark))
        } else if u.status != .dev {
          Button("Check now") { Task { await ctx.updates.check() } }
            .buttonStyle(PillButtonStyle(kind: .soft))
            .disabled(u.status == .checking || u.status == .downloading)
        }
      }
      if u.status != .dev {
        ToggleRow(label: "Update automatically", hint: "Orbit checks GitHub for a new release when it starts and every few hours, downloads it in the background, and installs it the next time you quit. Nothing about you is sent.", isOn: ctx.settings.bool("autoUpdate")) { save(ctx.settings, "autoUpdate", .bool($0)) }.padding(.top, 16)
      }
    }
  }
}

// MARK: - About

func keyStorageLabel(_ kind: String) -> String {
  ["windows-dpapi": "encrypted with your Windows account", "macos-keychain": "encrypted with a key in your macOS Keychain", "env-file": "in the .env file (developer mode)"][kind] ?? "not available"
}

/** Grok voice's xAI key: add one (or replace it). Only Grok needs it; Claude voice never does. */
struct XaiKeyField: View {
  @Bindable var ctx: UIContext
  @State private var open = false
  @State private var key = ""
  @State private var msg = ""
  @FocusState private var focused: Bool
  var body: some View {
    let s = ctx.settings
    VStack(alignment: .leading, spacing: 0) {
      if s.hasKey {
        HStack(spacing: 12) {
          Text("xAI key saved, \(keyStorageLabel(s.keyStorage)).").font(Theme.font(12)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
          Button("Replace") { open.toggle() }.buttonStyle(PillButtonStyle(kind: .soft, size: 12, hPad: 10, vPad: 4, radius: 8))
        }
      } else {
        (Text("Grok voice needs an xAI API key. Get one at ") + Text("[console.x.ai](https://console.x.ai)").underline()
          + Text(" → API Keys. It's stored encrypted, only on \(thisComputer)."))
          .font(Theme.font(12)).foregroundStyle(Theme.ink).snug(12).tint(Theme.fg).fixedSize(horizontal: false, vertical: true)
      }
      if open || !s.hasKey {
        HStack(spacing: 8) {
          SecureField("", text: $key, prompt: Text("xai-…").foregroundStyle(Theme.faint))
            .focused($focused).modifier(FieldStyle(height: 36, focused: focused))
            .accessibilityLabel("xAI API key")
            .onSubmit(save)
          Button("Save", action: save).buttonStyle(PillButtonStyle(kind: .dark, size: 13, height: 36, radius: 8)).disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.top, 8)
      }
      if !msg.isEmpty { Text(msg).font(Theme.font(12)).foregroundStyle(Theme.muted).padding(.top, 8) }
    }
    .padding(.top, 12)
    // Opened from the main page's "needs an xAI key" notice: the field takes the focus.
    .onAppear { if ctx.focusKey { focused = true } }
  }

  private func save() {
    let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !k.isEmpty else { return }
    Task {
      do {
        try await ctx.bridge.setXaiKey(k)
        msg = "Saved. New conversations use this key."
        key = ""
        open = false
        ctx.focusKey = false
        ctx.settings.markHasKey()
      } catch {
        msg = (error as? BridgeError)?.message ?? "Couldn't save it."
      }
    }
  }
}

struct AboutSection: View {
  @Bindable var ctx: UIContext
  var body: some View {
    let s = ctx.settings
    SettingsSection(title: "About") {
      VStack(alignment: .leading, spacing: 4) {
        Text("Orbit \(s.version) · open source (MIT)")
        Text("xAI key (Grok voice only): \(s.hasKey ? "saved, \(keyStorageLabel(s.keyStorage))" : "not set")")
        Text("Not affiliated with xAI or Anthropic. Grok is a trademark of xAI; Claude is a trademark of Anthropic.")
          .font(Theme.font(11.5)).foregroundStyle(Theme.faint).snug(11.5).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
      }
      .font(Theme.font(12.5)).foregroundStyle(Theme.muted)
      HStack(spacing: 8) {
        Button("Source & help") { openExternal(repoURL) }.buttonStyle(PillButtonStyle(kind: .soft))
        Button("Open log folder") { openLogs() }.buttonStyle(PillButtonStyle(kind: .soft))
      }
      .padding(.top, 12)
      Hint(text: "Errors are logged (without keys or prompt text) so you can attach them to a bug report. Grok can read recent ones too. Just ask \"what went wrong?\"", size: 11.5, color: Theme.faint).padding(.top, 8)
    }
  }

  private func openLogs() {
    Task {
      if let dir = try? await ctx.bridge.logs().dir { NSWorkspace.shared.open(URL(fileURLWithPath: dir, isDirectory: true)) }
    }
  }
}
