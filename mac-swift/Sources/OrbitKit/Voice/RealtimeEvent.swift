// The bridge's /voice WebSocket protocol (src/server.js "voice relay"), both directions.
// The bridge passes Grok's (or Claude voice's) realtime events through as they come and adds its
// own `bridge.*` events; the page (ui/src/useVoice.ts) sends mic audio and a few `ui.*` messages.
// Anything we don't know is kept as `.unknown`, never an error: Grok adds events over time.
import Foundation

/** A draft prompt waiting for the user's yes (bridge.draft). */
public struct VoiceDraft: Codable, Equatable, Sendable {
  public var id: Int
  public var text: String
  public var targetTitle: String?
  public init(id: Int, text: String, targetTitle: String?) { self.id = id; self.text = text; self.targetTitle = targetTitle }
}

/** Bridge (and Grok) → client. */
public enum ServerEvent: Equatable, Sendable {
  case bridgeReady(model: String?, voice: String?)
  case bridgeError(message: JSONValue?)
  case bridgeClosed(code: Int?, reason: JSONValue?)
  case bridgeSleep
  case bridgeAnnounce(ok: Bool, reason: String?)
  case bridgeAnnounceReady(spoke: Bool)
  case bridgeSession(title: String?)
  case bridgeDraft(VoiceDraft?)
  case bridgeCopied(chars: Double, preview: String)
  case bridgeAvatar(action: String?, fast: Bool)
  case bridgeBrain(project: JSONValue?)
  case bridgeSent(text: JSONValue?)
  case bridgeTool(name: JSONValue?)
  case bridgeToolResult(name: JSONValue?, result: JSONValue?)
  /** A cue in a reply's transcript: `at` is a character offset (UTF-16) into the clean transcript. */
  case bridgeEmote(itemId: String?, responseId: String?, cue: String, at: Double)
  /** Grok's own error event. */
  case error(message: JSONValue?)
  /** response.output_audio.delta / response.audio.delta: base64 PCM16 at 24 kHz. `emote`: Claude voice's cue on this chunk. */
  case audioDelta(delta: String, responseId: String?, emote: String?)
  case audioDone(responseId: String?)
  case responseCreated(id: String?)
  case responseDone(id: String?, status: String?)
  case speechStarted
  /** input_audio_buffer.speech_stopped or .committed (the page treats them the same). */
  case speechStopped
  /** conversation.item.input_audio_transcription.* (your words). */
  case inputTranscription(type: String, itemId: String?, transcript: String?, delta: JSONValue?)
  /** response.*transcript* / *output_text* / response.text.delta (Grok's words). */
  case outputText(type: String, itemId: String?, responseId: String?, delta: JSONValue?, transcript: JSONValue?)
  case unknown(type: String, raw: JSONValue)

  /** Parse one message from the bridge; nil if it isn't a JSON object with a string `type`. */
  public static func parse(_ text: String) -> ServerEvent? {
    guard let v = try? JSONValue.parse(text) else { return nil }
    return parse(v)
  }

  public static func parse(_ v: JSONValue) -> ServerEvent? {
    guard case .object = v else { return nil }
    let t = v["type"]?.stringValue ?? ""
    let s = { (k: String) in v[k]?.stringValue }
    // JS truthiness of an id: a number id still names the reply (String(evt.response_id)).
    let id = { (k: JSONValue?) -> String? in
      switch k {
      case .string(let x)?: return x.isEmpty ? nil : x
      case .number(let n)?: return n == 0 ? nil : jsNumber(n)
      default: return nil
      }
    }
    switch t {
    case "bridge.ready": return .bridgeReady(model: s("model"), voice: s("voice"))
    case "bridge.error": return .bridgeError(message: v["message"])
    case "bridge.closed": return .bridgeClosed(code: v["code"]?.intValue, reason: v["reason"])
    case "bridge.sleep": return .bridgeSleep
    case "bridge.announce": return .bridgeAnnounce(ok: v["ok"]?.truthy ?? false, reason: s("reason"))
    case "bridge.announce_ready": return .bridgeAnnounceReady(spoke: v["spoke"]?.truthy ?? false)
    case "bridge.session": return .bridgeSession(title: s("title"))
    case "bridge.draft":
      guard let d = v["draft"], d.truthy else { return .bridgeDraft(nil) }
      return .bridgeDraft(VoiceDraft(id: d["id"]?.intValue ?? 0, text: jsString(d["text"]), targetTitle: d["targetTitle"]?.stringValue))
    case "bridge.copied": return .bridgeCopied(chars: v["chars"]?.doubleValue ?? 0, preview: jsString(v["preview"]))
    case "bridge.avatar": return .bridgeAvatar(action: s("action"), fast: v["fast"]?.truthy ?? false)
    case "bridge.brain": return .bridgeBrain(project: v["project"])
    case "bridge.sent": return .bridgeSent(text: v["text"])
    case "bridge.tool": return .bridgeTool(name: v["name"])
    case "bridge.tool_result": return .bridgeToolResult(name: v["name"], result: v["result"])
    case "bridge.emote":
      guard let cue = s("cue") else { return .unknown(type: t, raw: v) }
      return .bridgeEmote(itemId: id(v["item_id"]), responseId: id(v["response_id"]), cue: cue, at: v["at"]?.doubleValue ?? 0)
    case "error": return .error(message: v["error"]?["message"])
    case "response.output_audio.delta", "response.audio.delta":
      return .audioDelta(delta: s("delta") ?? "", responseId: id(v["response_id"]), emote: v["emote"]?["name"]?.stringValue)
    case "response.output_audio.done", "response.audio.done": return .audioDone(responseId: id(v["response_id"]))
    case "response.created": return .responseCreated(id: id(v["response"]?["id"]))
    case "response.done": return .responseDone(id: id(v["response"]?["id"]), status: v["response"]?["status"]?.stringValue)
    case "input_audio_buffer.speech_started": return .speechStarted
    case "input_audio_buffer.speech_stopped", "input_audio_buffer.committed": return .speechStopped
    default: break
    }
    if t.hasPrefix("conversation.item.input_audio_transcription") {
      return .inputTranscription(type: t, itemId: v["item_id"].map { jsString($0) }, transcript: v["transcript"]?.stringValue, delta: v["delta"])
    }
    if t.hasPrefix("response.") && (t.contains("transcript") || t.contains("output_text") || t == "response.text.delta") {
      return .outputText(type: t, itemId: id(v["item_id"]), responseId: id(v["response_id"]), delta: v["delta"], transcript: v["transcript"])
    }
    return .unknown(type: t, raw: v)
  }
}

/** Why the client hung up, told to the bridge for its log (src/server.js PAGE_REASONS). */
public enum ByeReason: String, Codable, Sendable, CaseIterable {
  case user, sleep, idle
  case tapTimeout = "tap_timeout"
  case draftHold = "draft_hold"
  case listenExpired = "listen_expired"
  case heardNoWords = "heard_no_words"
  case announceMax = "announce_max"
  case bridge
  case micError = "mic_error"
  case closed, other
}

/** ui.bye's numbers: Grok audio scheduled and played (s), lead of the first chunk, talk-overs. */
public struct ByeReport: Equatable, Sendable {
  public var reason: ByeReason
  public var audio: String // running | suspended | closed | interrupted | none
  public var scheduled: Double
  public var played: Double
  public var lead: Double
  public var maxLead: Double
  public var cut: Int
  public var kept: Int
  public init(reason: ByeReason, audio: String, scheduled: Double, played: Double, lead: Double, maxLead: Double, cut: Int, kept: Int) {
    self.reason = reason; self.audio = audio; self.scheduled = scheduled; self.played = played; self.lead = lead; self.maxLead = maxLead; self.cut = cut; self.kept = kept
  }
}

/** Client → bridge. */
public enum ClientMessage: Equatable, Sendable {
  case audioAppend(base64: String)
  case audioClear
  case audioCommit
  case responseCancel
  case uiState(asleep: Bool)
  case uiText(String)
  case uiListenWindow
  case uiBye(ByeReport)

  public var type: String {
    switch self {
    case .audioAppend: return "input_audio_buffer.append"
    case .audioClear: return "input_audio_buffer.clear"
    case .audioCommit: return "input_audio_buffer.commit"
    case .responseCancel: return "response.cancel"
    case .uiState: return "ui.state"
    case .uiText: return "ui.text"
    case .uiListenWindow: return "ui.listen_window"
    case .uiBye: return "ui.bye"
    }
  }

  public var json: JSONValue {
    switch self {
    case .audioAppend(let b): return ["type": .string(type), "audio": .string(b)]
    case .uiState(let a): return ["type": .string(type), "asleep": .bool(a)]
    case .uiText(let t): return ["type": .string(type), "text": .string(t)]
    case .uiBye(let r):
      let r1 = { (n: Double) in JSONValue.number((n * 10).rounded() / 10) }
      return ["type": .string(type), "reason": .string(r.reason.rawValue), "audio": .string(r.audio), "scheduled": r1(r.scheduled), "played": r1(r.played),
              "lead": r1(r.lead), "maxLead": r1(r.maxLead), "cut": .number(Double(r.cut)), "kept": .number(Double(r.kept))]
    default: return ["type": .string(type)]
    }
  }

  /** The text frame to send. Audio is built by hand: ten of these a second, and base64 needs no escaping. */
  public var text: String {
    if case .audioAppend(let b) = self { return "{\"type\":\"input_audio_buffer.append\",\"audio\":\"\(b)\"}" }
    return json.text
  }
}

// MARK: - JS-like conversions (the page passes Grok's values through String(...))

extension JSONValue {
  /** JavaScript truthiness. */
  public var truthy: Bool {
    switch self {
    case .null: return false
    case .bool(let b): return b
    case .number(let n): return n != 0 && !n.isNaN
    case .string(let s): return !s.isEmpty
    case .array, .object: return true
    }
  }
}

/** A number as JavaScript's String(n) writes it (integers without ".0"). */
func jsNumber(_ n: Double) -> String {
  if n.isNaN { return "NaN" }
  if n.isInfinite { return n > 0 ? "Infinity" : "-Infinity" }
  if n == n.rounded(), abs(n) < 1e21 { return String(Int64(n)) }
  return String(n)
}

/** String(value ?? "") as the page writes it for captions. */
public func jsString(_ v: JSONValue?) -> String {
  switch v {
  case nil, .null?: return ""
  case .string(let s)?: return s
  case .bool(let b)?: return b ? "true" : "false"
  case .number(let n)?: return jsNumber(n)
  case .array(let a)?: return a.map { $0.isNull ? "" : jsString($0) }.joined(separator: ",")
  case .object?: return "[object Object]"
  }
}
