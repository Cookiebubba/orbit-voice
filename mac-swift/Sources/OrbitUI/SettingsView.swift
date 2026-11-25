// Settings (ui/src/Settings.tsx, the Mac build's: the orbit-mac branch). Every setting in the page's
// sections, with its labels, ranges and help text. Everything saves as soon as you change it.
import AppKit
import OrbitKit
import SwiftUI

let repoURL = URL(string: "https://github.com/Cookiebubba/orbit-voice")!
let thisComputer = "this Mac"

struct SettingsView: View {
  @Bindable var ctx: UIContext
  var onClose: () -> Void

  var body: some View {
    let s = ctx.settings
    let engine = s.string("voiceEngine")
    let usesLocalVoice = engine == "claude" || engine == "gemini-cli"
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        BackButton(action: onClose).padding(.bottom, 12)
        Wordmark(text: "Settings", size: 38).frame(height: 38 * 0.9).padding(.bottom, 4) // line-height 0.9
        Text("Everything saves as soon as you change it.").font(Theme.font(12.5)).foregroundStyle(Theme.muted).padding(.top, 8).padding(.bottom, 12)
        VStack(alignment: .leading, spacing: 12) {
          VoiceEngineSection(ctx: ctx)
          if engine == "grok" || usesLocalVoice {
            VoiceCard(ctx: ctx, engine: usesLocalVoice ? "claude" : "grok").id(usesLocalVoice ? "claude" : "grok")
          }
          ListeningSection(s: s)
          FinishesSection(s: s)
          SecondBrainSection(ctx: ctx)
          TargetAndRoutingSection(s: s)
          MacPermissionsSection(ctx: ctx)
          AnywhereSection(s: s)
          HotkeySection(ctx: ctx)
          AppSection(ctx: ctx)
          AvatarSection(s: s)
          if engine == "grok" { UsageSection(ctx: ctx) }
          UpdatesSection(ctx: ctx)
          AboutSection(ctx: ctx)
        }
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 32)
    }
    .scrollIndicators(.automatic)
  }
}

/** Save a setting through the Settings model (checked, shown at once, posted). */
@MainActor func save(_ s: SettingsModel, _ key: String, _ value: JSONValue) { Task { await s.set(key, value) } }

// MARK: - Listening

struct ListeningSection: View {
  let s: SettingsModel
  var body: some View {
    let name = s.displayAssistantName, local = s.string("voiceEngine") != "grok", hk = s.hotkeyLabel, wake = s.bool("wakeWord")
    SettingsSection(title: "Listening") {
      Segmented(value: s.string("listenMode"), options: [.init(value: "always", label: "Always on"), .init(value: "tap", label: "One question at a time")]) { save(s, "listenMode", .string($0)) }
      Hint(text: s.string("listenMode") == "always"
        ? "\(name) hears you until you say \"go to sleep\" or press \(hk). Then it hangs up\(local ? "" : ", so nothing is billed,") until you press \(hk)\(wake ? " or say “Hey Orbit”" : "") again."
        : "Press \(hk)\(wake ? " or say “Hey Orbit”" : ""), ask one question, and \(name) hangs up after answering (it waits up to a minute if a prompt needs your yes). Nothing in the background gets picked up.",
        size: 12.5).padding(.top, 8)
      ToggleRow(label: "Don't listen while \(name) is talking", hint: "Turn on if you use speakers instead of headphones, so \(name) doesn't hear itself. You can't interrupt it then.", isOn: s.bool("halfDuplex")) { save(s, "halfDuplex", .bool($0)) }.padding(.top, 16)
      ToggleRow(label: "Wake word: say “Hey Orbit”", hint: "Starts \(name) hands-free after it has gone to sleep. Recognized entirely on \(thisComputer) by a small offline speech model: no audio leaves your computer and it costs nothing. Each wake starts a fresh conversation.", isOn: wake) { save(s, "wakeWord", .bool($0)) }.padding(.top, 16)
    }
  }
}

// MARK: - When a thread / Claude finishes

struct FinishesSection: View {
  let s: SettingsModel
  var body: some View {
    let name = s.displayAssistantName, eng = s.string("voiceEngine"), t3 = s.isT3Target, mode = s.string("announce")
    let wakeCost = eng == "gemini-cli"
      ? " Each wake uses your Gemini subscription."
      : eng == "gemini-live"
        ? " Each wake uses a few seconds of Gemini Live API time."
        : eng == "claude"
          ? " Each wake uses a little of your Claude plan."
          : " Each wake bills a few seconds of xAI time."
    SettingsSection(title: t3 ? "When a thread finishes" : "When Claude finishes") {
      Segmented(value: mode, options: [.init(value: "speak", label: "\(name) tells me"), .init(value: "chime", label: "Chime only"), .init(value: "off", label: "Off")]) { save(s, "announce", .string($0)) }
      Hint(text: mode == "off"
        ? "Orbit won't tell you when \(t3 ? "a T3 thread" : "Claude") finishes."
        : t3
          ? "Orbit watches your T3 Code threads across local and SSH projects. When a thread finishes you get a chime and a notification\(mode == "speak" ? ", and if \(name) is on, it summarizes what finished." : ".")"
          : "Orbit watches your recent Claude sessions. When Claude finishes a task you get a chime and a notification\(mode == "speak" ? ", and if \(name) is on, it says what Claude did." : ".")",
        size: 12.5).padding(.top, 8)
      if mode == "speak" {
        ToggleRow(label: "Wake \(name) to say it", hint: "While \(name) is asleep, it connects just long enough to tell you, then listens for 3 seconds in case you want something. The mic opens only after it has spoken; press the hotkey to stop it.\(wakeCost)", isOn: s.bool("announceWake")) { save(s, "announceWake", .bool($0)) }.padding(.top, 16)
        ToggleRow(label: "Wake \(name) when something you asked for is ready", hint: "When \(t3 ? "a thread" : "Claude") finishes a prompt \(name) sent for you, or the second brain answers after you hung up (a question still running then keeps going), \(name) wakes to tell you. At most 6 wakes an hour.", isOn: s.bool("wakeOnResults")) { save(s, "wakeOnResults", .bool($0)) }.padding(.top, 16)
      }
    }
  }
}

// MARK: - Target & routing

struct TargetAndRoutingSection: View {
  let s: SettingsModel
  @State private var endpointDraft: String?
  @State private var endpointError = ""
  @FocusState private var endpointFocused: Bool

  var body: some View {
    SettingsSection(title: "Target & routing") {
      FieldLabel(text: "Target backend")
      Segmented(value: s.string("targetBackend"), options: [
        .init(value: "auto", label: "Auto"),
        .init(value: "claude-desktop", label: "Claude Desktop"),
        .init(value: "t3-code", label: "T3 Code"),
      ]) { save(s, "targetBackend", .string($0)) }
      Hint(text: "Auto uses T3 Code when a local endpoint is configured below, otherwise Claude Desktop.").padding(.top, 8)
      FieldLabel(text: "T3 Code endpoint")
      TextField(
        "",
        text: Binding(get: { endpointDraft ?? s.string("t3Endpoint") }, set: { endpointDraft = $0; endpointError = "" }),
        prompt: Text("http://127.0.0.1:3773").foregroundStyle(Theme.faint)
      )
      .focused($endpointFocused)
      .modifier(FieldStyle(size: 12.5, focused: endpointFocused))
      .onSubmit(saveEndpoint)
      .onChange(of: endpointFocused) { if !endpointFocused { saveEndpoint() } }
      .accessibilityLabel("T3 Code endpoint")
      if !endpointError.isEmpty {
        Hint(text: endpointError, size: 11.5, color: Theme.amber700).padding(.top, 4)
      }
      Hint(text: "Local loopback URL for T3 Code (127.0.0.1 or localhost). Leave empty when using Claude Desktop.", size: 11.5, color: Theme.faint).padding(.top, 4)
      ToggleRow(
        label: "Topic drift heads-up",
        hint: "Speaks an advisory heads-up when a prompt looks meant for another session or a brand-new topic. Never auto-switches.",
        isOn: s.bool("routingDriftGuard")
      ) { save(s, "routingDriftGuard", .bool($0)) }.padding(.top, 16)
      ToggleRow(
        label: "Queue prompts while busy",
        hint: "Holds confirmed prompts while a session is working and sends them once it is idle. Always blocked while waiting on a permission or question.",
        isOn: s.bool("routingQueueBusy")
      ) { save(s, "routingQueueBusy", .bool($0)) }.padding(.top, 16)
    }
  }

  private func saveEndpoint() {
    guard let draft = endpointDraft else { return }
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed == s.string("t3Endpoint") {
      endpointDraft = nil
      return
    }
    Task {
      let result = await s.set("t3Endpoint", .string(trimmed))
      switch result {
      case .saved:
        endpointDraft = nil
        endpointError = ""
      case .refused:
        endpointError = "Enter a local http(s) URL on 127.0.0.1 or localhost (or leave empty)."
      case .failed(let msg):
        endpointError = msg
      }
    }
  }
}

// MARK: - Mac permissions (the orbit-mac branch's MacPermissionsSection)

struct MacPermissionsSection: View {
  @Bindable var ctx: UIContext
  var body: some View {
    let m = ctx.onboarding
    SettingsSection(title: "Mac permissions", titleGap: 12) {
      ForEach(m.displayItems) { item in
        let on = m.isOn(item.step)
        HStack(alignment: .top, spacing: 12) {
          Circle().fill(on ? Theme.emerald500 : item.needed ? Theme.amber500 : Theme.line).frame(width: 8, height: 8).padding(.top, 5).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 2) {
            (Text(item.label).font(Theme.font(13, .medium)).foregroundStyle(Theme.fg)
              + Text("  " + (on ? "On" : item.needed ? "Off: needed" : "Optional")).font(Theme.font(11.5)).foregroundStyle(Theme.muted))
            Text(item.why).font(Theme.font(11.5)).foregroundStyle(Theme.muted).snug(11.5).fixedSize(horizontal: false, vertical: true)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          if !on {
            Button("Turn on") { Task { await m.request(item.step) } }.buttonStyle(PillButtonStyle(kind: .dark, size: 12, hPad: 12, vPad: 4))
          }
        }
        .padding(.vertical, 8)
      }
      if ctx.helperPresent == false && !ctx.settings.isT3Target {
        Hint(text: "Orbit's helper for the Claude app is missing from this copy of Orbit. Reinstall Orbit to use the Claude app by voice.", size: 11.5, color: Theme.amber700).padding(.top, 8)
      }
      Hint(text: "“Turn on” shows macOS's own question, or opens System Settings → Privacy & Security at the right place: switch Orbit on there. Screen Recording takes effect after Orbit restarts.", size: 11.5, color: Theme.faint).padding(.top, 8)
    }
  }
}

// MARK: - Orbit anywhere

struct AnywhereSection: View {
  let s: SettingsModel
  var body: some View {
    let name = s.displayAssistantName, on = s.bool("anywhere"), t3 = s.isT3Target, gem = s.isGeminiBrain
    let preview: [(label: String, lch: (Double, Double, Double))] = [
      ("Listening", (0.78, 0.13, 205)), ("Thinking", (0.62, 0.22, 300)), ("Speaking", (0.8, 0.15, 78)), (t3 ? "Watching threads" : "Watching Claude", (0.7, 0.14, 42)), ("Resting", (0.63, 0.2, 272)),
    ]
    let apps = (s["anywhereUnderOrbit"]?.arrayValue ?? []).compactMap(\.stringValue)
    SettingsSection(title: "Orbit anywhere") {
      ToggleRow(label: "Let \(name) work in the window you're in", hint: "In any app\(t3 ? "" : ", not just Claude"): ask \"what does this say?\" and \(name) reads that window; ask it to type something or press a button and it does, without touching your mouse or keyboard. Sending, posting, deleting and buying always ask first. Only when you ask, never in password managers, banking, private browsing or sign-in windows, and what a window says is never taken as an instruction.", isOn: on) { save(s, "anywhere", .bool($0)) }
      if on {
        ToggleRow(
          label: "Let \(gem ? "Gemini" : "Claude") see windows",
          hint: gem
            ? "When you ask \(name) to look at a window (a picture, a chart), a picture of that one window goes to Gemini through your Gemini / Antigravity CLI. Off: looking stays on \(thisComputer), reading only the text in it."
            : "When you ask \(name) to look at a window (a picture, a chart), a picture of that one window goes to Claude through your Claude Code. Off: looking stays on \(thisComputer), reading only the text in it.",
          isOn: s.bool("anywhereVision")
        ) { save(s, "anywhereVision", .bool($0)) }.padding(.top, 16)
        ToggleRow(label: "Also use apps' own debugging ports", hint: "Only for an app you started yourself with --remote-debugging-port. Usually not needed: for apps that only notice real typing (Discord, OpenCode), \(name) asks (every time) to restart them under its own control instead.", isOn: s.bool("anywhereCdp")) { save(s, "anywhereCdp", .bool($0)) }.padding(.top, 16)
        ToggleRow(label: "Show Orbit's mouse", hint: "A second cursor of \(name)'s own, in its colours: it shows you where to click when you ask how to do something, and moves to whatever \(name) works on in a window. It never moves or clicks with your mouse.", isOn: s.bool("anywhereMouse")) { save(s, "anywhereMouse", .bool($0)) }.padding(.top, 16)
        if s.bool("anywhereMouse") {
          FlowRow(spacing: 16, lineSpacing: 6) {
            ForEach(preview, id: \.label) { p in
              HStack(spacing: 6) {
                ArrowShape().fill(oklch(p.lch.0, p.lch.1, p.lch.2)).frame(width: 13, height: 20)
                Text(p.label).font(Theme.font(11.5)).foregroundStyle(Theme.muted)
              }
            }
          }
          .padding(.top, 8)
          .accessibilityHidden(true)
        }
        if !apps.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text("Apps under \(name)").font(Theme.font(13, .medium)).foregroundStyle(Theme.fg)
            Hint(text: "\(name) may restart these under its own control so it can type, click and look without your mouse; it still asks you out loud every time first. Only \(name) can connect; no port is open. Stop restarts the app the normal way.")
            ForEach(apps, id: \.self) { a in
              HStack {
                Text(a.replacingOccurrences(of: ".exe", with: "", options: [.caseInsensitive, .anchored, .backwards]).capitalizedFirst).font(Theme.font(13)).foregroundStyle(Theme.fg)
                Spacer()
                HoverText(action: { save(s, "anywhereUnderOrbit", .array(apps.filter { $0 != a }.map { .string($0) })) }, color: Theme.ink) { Text("Stop").font(Theme.font(12)).padding(.horizontal, 8).padding(.vertical, 2) }
              }
              .padding(.horizontal, 12).padding(.vertical, 6)
              .background(RoundedRectangle(cornerRadius: 8).fill(Theme.soft))
            }
          }
          .padding(.top, 16)
        }
      }
    }
  }
}

extension String {
  var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/** Orbit's mouse arrow (ui/src/mouse/shape.js ARROW_PATH, 12.2 x 19.2). */
struct ArrowShape: Shape {
  func path(in r: CGRect) -> Path {
    let sx = r.width / 12.2, sy = r.height / 19.2
    var p = Path()
    let pts: [(Double, Double)] = [(0, 0), (0, 16.6), (4.1, 12.9), (6.9, 19.2), (9.5, 18.1), (6.8, 11.9), (12.2, 11.9)]
    p.move(to: CGPoint(x: r.minX, y: r.minY))
    for (x, y) in pts.dropFirst() { p.addLine(to: CGPoint(x: r.minX + x * sx, y: r.minY + y * sy)) }
    p.closeSubpath()
    return p
  }
}

/** Items left to right, wrapping (flex-wrap). */
struct FlowRow: Layout {
  var spacing: CGFloat = 8
  var lineSpacing: CGFloat = 4
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let maxW = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, w: CGFloat = 0
    for v in subviews {
      let s = v.sizeThatFits(.unspecified)
      if x > 0 && x + s.width > maxW { y += line + lineSpacing; x = 0; line = 0 }
      x += s.width + spacing; line = max(line, s.height); w = max(w, x - spacing)
    }
    return CGSize(width: proposal.width ?? w, height: y + line)
  }
  func placeSubviews(in b: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = b.minX, y = b.minY, line: CGFloat = 0
    for v in subviews {
      let s = v.sizeThatFits(.unspecified)
      if x > b.minX && x + s.width > b.maxX { y += line + lineSpacing; x = b.minX; line = 0 }
      v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
      x += s.width + spacing; line = max(line, s.height)
    }
  }
}

// MARK: - App

struct AppSection: View {
  @Bindable var ctx: UIContext
  var body: some View {
    let _ = ctx.shellRevision
    // (Orbit Native has no floating orb, so none of its settings: the window minimizes to the Dock.)
    SettingsSection(title: "App") {
      VStack(alignment: .leading, spacing: 4) {
        ToggleRow(label: "Open at login", hint: "Orbit starts quietly in the menu bar when you sign in.", isOn: ctx.login.enabled) { on in
          ctx.login.set(on)
          ctx.shellRevision += 1
        }
        if let e = ctx.login.lastError { Hint(text: e, color: Theme.amber700) }
      }
    }
  }
}

// MARK: - Avatar

struct AvatarSection: View {
  let s: SettingsModel
  var body: some View {
    let name = s.displayAssistantName, avatar = s.string("avatar"), t3 = s.isT3Target
    let targetWin = t3 ? "your screen" : "your Claude window"
    SettingsSection(title: "Avatar") {
      Segmented(value: avatar, options: [.init(value: "buddy", label: "Pixel buddy"), .init(value: "qubit", label: "Qubit"), .init(value: "none", label: "None")]) { save(s, "avatar", .string($0)) }
      Hint(text: avatar == "buddy"
        ? "A little pixel character lives along the bottom of \(targetWin). It naps while \(name) sleeps, listens and talks with it, and celebrates when work wraps up. Click it, or pick it up and drop it."
        : avatar == "qubit"
          ? "A square with one eye lives on \(targetWin). He sleeps while \(name) sleeps, wakes when you call, his eye stretches as you talk and opens with \(name)'s voice. His colour shows what's going on."
          : "No avatar overlay shown.").padding(.top, 8)
      if avatar != "none" {
        let who = avatar == "qubit" ? "Qubit" : "the pixel buddy"
        Text("Size").font(Theme.font(12)).foregroundStyle(Theme.muted).padding(.top, 12).padding(.bottom, 6)
        Segmented(value: String(s.int("buddySize")), options: [.init(value: "1", label: "Tiny"), .init(value: "2", label: "Small"), .init(value: "3", label: "Big")]) { save(s, "buddySize", .number(Double($0) ?? 2)) }
        ToggleRow(label: "Click your avatar to talk", hint: "A quick click on \(who) starts talking to \(name), the same as saying “Hey Orbit” with that window in front. Off: a click is only a little poke.", isOn: s.bool("avatarClickTalk")) { save(s, "avatarClickTalk", .bool($0)) }.padding(.top, 16)
        ToggleRow(label: "Throw your avatar", hint: avatar == "qubit" ? "Press and hold Qubit to pick him up, drag him about inside his window and let go to throw him. He bounces off its edges, lands, shakes it off and carries on from where he landed." : "Press and hold the pixel buddy to pick it up, then drop it somewhere along the strip.", isOn: s.bool("avatarThrow")) { save(s, "avatarThrow", .bool($0)) }.padding(.top, 16)
        if s.bool("avatarThrow") && avatar == "qubit" {
          ToggleRow(label: "Sound when thrown", hint: "A quick “Wheee!” when you really throw him (not when you set him down), at the voice volume above.", isOn: s.bool("avatarThrowSound")) { save(s, "avatarThrowSound", .bool($0)) }.padding(.top, 16)
        }
      }
    }
  }
}
