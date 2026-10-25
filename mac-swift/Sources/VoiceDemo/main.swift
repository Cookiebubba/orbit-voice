// VoiceDemo: runs Orbit Native's voice client headless against a running bridge, for checks.
// Prints one JSON line per happening (phases, sounds, hang-ups, counts), never words or keys.
//
//   VoiceDemo --bridge http://127.0.0.1:4551 --auth "http://127.0.0.1:4551/auth?t=..." \
//     --steps "hotkey;until:listening:8000;mic:/tmp/hello.wav:0;wait:6000;report;sleep;until:off:8000;report"
//
// Steps: hotkey | sleep | wake | hangup | announce | mute:on|off | type:<text> | mic:<wav>[:gapMs] |
//        throw | wait:<ms> | until:<phase>[:timeoutMs] | until-asleep[:ms] | report |
//        hotkey-check[:<accelerator>] | wake-word[:ms] | events | post:<url> <json> | get:<url>
// With ORBIT_FAKE_MIC / ORBIT_MUTE_OUTPUT as in parity/PROTOCOL.md.
import AppKit
import Foundation
import OrbitKit
import OrbitVoice

func arg(_ name: String) -> String? {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: "--\(name)"), i + 1 < a.count else { return nil }
  return a[i + 1]
}

let t0 = Date()
func out(_ type: String, _ data: JSONValue = [:]) {
  var o: [String: JSONValue] = ["t": .number((Date().timeIntervalSince(t0) * 1000).rounded()), "ev": .string(type)]
  if case .object(let d) = data { for (k, v) in d { o[k] = v } }
  print(JSONValue.object(o).text)
  fflush(stdout)
}

@MainActor
final class Demo {
  let controller: VoiceController
  var steps: [String]

  init(endpoints: BridgeEndpoints, steps: [String]) {
    controller = VoiceController(endpoints: endpoints)
    self.steps = steps
    controller.onEvent = { name, data in out(name, data) }
    controller.onEmote = { out("emote", ["name": .string($0)]) }
    controller.onAvatarEvent = { out("avatar", ["event": .string($0.rawValue)]) }
  }

  func run() async {
    let io = controller.audio.config
    out("start", ["mutedOutput": .bool(io.muteOutput), "fakeMic": .bool(io.fakeMic)])
    do {
      try await controller.loadConfig()
      let s = controller.settings
      out("config", ["hasKey": .bool(controller.hasKey), "listenMode": .string(s.listenMode.rawValue), "volume": .number(s.voiceVolume)])
    } catch {
      out("config-failed", ["error": .string(String(describing: error))])
    }
    for step in steps { await perform(step) }
    out("done")
    controller.hangup()
    try? await Task.sleep(nanoseconds: 700_000_000)
    exit(0)
  }

  func report() {
    let v = controller.parityVoice()
    let byWho = Dictionary(grouping: controller.captions, by: \.who.rawValue).mapValues { JSONValue.number(Double($0.count)) }
    let st = controller.session.stats
    out("report", [
      "voice": JSONValue.from(v).removingText(),
      "captions": .object(byWho),
      "audio": ["chunks": .number(Double(controller.audio.chunksScheduled)), "scheduledS": .number((controller.audio.secondsScheduled * 100).rounded() / 100),
                "playedBack": .number(Double(controller.audio.chunksPlayedBack)), "lastLateMs": .number((controller.audio.lastPlaybackLateness * 1000).rounded()),
                "engine": .string(controller.audio.stateName), "cut": .number(Double(st.cut)), "kept": .number(Double(st.kept)), "firstLeadMs": .number((st.firstLead * 1000).rounded())],
      "sounds": .array(controller.sounds.map { .string($0.name) }),
    ])
  }

  func perform(_ step: String) async {
    let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
    let name = parts[0], rest = parts.count > 1 ? parts[1] : ""
    out("step", ["name": .string(name)])
    switch name {
    case "hotkey": controller.hotkey()
    case "sleep": controller.sleep()
    case "wake": controller.wake()
    case "hangup": controller.hangup()
    case "announce": controller.announce()
    case "mute": controller.mute(rest != "off")
    case "type": controller.type(rest)
    case "throw": controller.playSound("throw")
    case "events": controller.followBridgeEvents()
    case "mic":
      let p = rest.split(separator: ":").map(String.init)
      let ok = controller.playIntoMic(wav: URL(fileURLWithPath: p[0]), gapMs: p.count > 1 ? Double(p[1]) ?? 0 : 0)
      out("mic", ["ok": .bool(ok)])
    case "wait": try? await Task.sleep(nanoseconds: UInt64((Double(rest) ?? 1000) * 1e6))
    case "until", "until-asleep":
      let p = rest.split(separator: ":").map(String.init)
      let want = name == "until" ? VoicePhase(rawValue: p.first ?? "") : nil
      let timeout = Double(name == "until" ? (p.count > 1 ? p[1] : "10000") : (p.first ?? "10000")) ?? 10000
      let start = Date()
      while Date().timeIntervalSince(start) * 1000 < timeout {
        let s = controller.state
        if let want, s.phase == want { break }
        if want == nil, s.asleep { break }
        try? await Task.sleep(nanoseconds: 20_000_000)
      }
      let s = controller.state
      let ok = want.map { s.phase == $0 } ?? s.asleep
      out("until", ["ok": .bool(ok), "phase": .string(s.phase.rawValue), "ms": .number((Date().timeIntervalSince(start) * 1000).rounded())])
    case "report": report()
    case "post", "get":
      // A test double's control endpoint (voice-check-bridge.mjs): "post:<url> <json>" / "get:<url>".
      let p = rest.split(separator: " ", maxSplits: 1).map(String.init)
      guard let url = URL(string: p[0]) else { break }
      var req = URLRequest(url: url)
      if name == "post" {
        req.httpMethod = "POST"
        req.httpBody = Data((p.count > 1 ? p[1] : "{}").utf8)
        req.setValue("application/json", forHTTPHeaderField: "content-type")
      }
      let r = try? await URLSession.shared.data(for: req)
      out(name, ["status": .number(Double((r?.1 as? HTTPURLResponse)?.statusCode ?? 0)), "body": r.flatMap { try? JSONValue.parse($0.0) } ?? .null])
    case "hotkey-check":
      let hk = GlobalHotkey(accelerator: rest.isEmpty ? HotkeyAccelerator.defaultAccelerator : rest)
      let started = hk.start()
      let other = GlobalHotkey(accelerator: "Control+Alt+Shift+F19")
      _ = other.start()
      // Taking what another holds fails and leaves the old one registered.
      let clash = hk.set("Control+Alt+Shift+F19")
      let bad = hk.set("Control+Alt+!")
      let moved = hk.set("Control+Alt+Shift+F18")
      out("hotkey", ["registered": .bool(started), "label": .string(hk.info.label), "clashOk": .bool(clash.ok ?? false), "clashError": .string(clash.error ?? ""),
                     "afterClash": .string(clash.accelerator), "stillRegistered": .bool(clash.registered), "badError": .string(bad.error ?? ""),
                     "movedTo": .string(moved.accelerator), "movedOk": .bool(moved.ok ?? false)])
      hk.suspend(true)
      out("hotkey-suspended", ["registeredFlag": .bool(hk.info.registered)])
      hk.suspend(false)
      hk.invalidate()
      other.invalidate()
    case "wake-word":
      let w = WakeWord(link: controller.link)
      // The system's microphone prompt would show on the owner's screen: refuse it here (the page's
      // request still reaches the delegate, which is what this checks).
      w.grantsMicrophone = false
      w.onMicrophoneRequest = { out("wake-word-mic", ["granted": .bool($0)]) }
      w.onStatus = { s, detail in out("wake-word", ["status": .string(s.rawValue), "detail": .string(detail.map { String($0.prefix(120)) } ?? "")]) }
      w.setActive(true)
      let total = Double(rest) ?? 8000
      var waited = 0.0
      while waited < total {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        waited += 3000
        let js = """
        const r = { ready: document.readyState, hidden: document.hidden, wasm: typeof WebAssembly };
        try { const h = await fetch('/models/vosk-model-small-en-us-0.15.tar.gz', { method: 'HEAD' }); r.model = h.status; } catch (e) { r.model = String(e); }
        try {
          const src = 'try { const q = indexedDB.open("orbit-probe"); q.onsuccess = () => postMessage("idb ok"); q.onerror = () => postMessage("idb error " + q.error); setTimeout(() => postMessage("idb timeout"), 1000); } catch (e) { postMessage("idb throws " + e); }';
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
          r.worker = await new Promise((ok) => { w.onmessage = (e) => ok('ok ' + e.data); w.onerror = (e) => ok('error ' + e.message); setTimeout(() => ok('timeout'), 1500); });
        } catch (e) { r.worker = 'throws ' + e; }
        return JSON.stringify(r);
        """
        out("wake-word-probe", ["page": .string(await w.probe(js) ?? "(none)")])
      }
      w.setActive(false)
    default: out("unknown-step", ["name": .string(name)])
    }
  }
}

extension JSONValue {
  /** A draft's words are the user's: counts only in this output. */
  func removingText() -> JSONValue {
    guard case .object(var o) = self else { return self }
    if case .object(var d)? = o["draft"] { d["text"] = .number(Double(d["text"]?.stringValue?.count ?? 0)); o["draft"] = .object(d) }
    if o["lastError"]?.stringValue != nil { o["lastError"] = "(set)" }
    return .object(o)
  }
}

guard let bridge = arg("bridge").flatMap(URL.init(string:)), let auth = arg("auth").flatMap(URL.init(string:)) else {
  FileHandle.standardError.write(Data("usage: VoiceDemo --bridge <base url> --auth <sign-in url> --steps \"hotkey;until:listening;...\"\n".utf8))
  exit(2)
}
let steps = (arg("steps") ?? "hotkey;until:listening:8000;wait:3000;report;hangup").split(separator: ";").map(String.init)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let demo = Demo(endpoints: BridgeEndpoints(base: bridge, auth: ["main": auth]), steps: steps)
Task { @MainActor in await demo.run() }
app.run()
