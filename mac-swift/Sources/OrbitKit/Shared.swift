// Types shared across Orbit Native: rects, the bridge's address, Orbit's voice state as the avatars
// and the orb get it, and the parity driver's state snapshot (see ../../parity/PROTOCOL.md).
import Foundation

/** A rectangle in screen points, top-left origin (as Electron and the pages use). */
public struct Rect: Codable, Equatable, Sendable, CustomStringConvertible {
  public var x: Double, y: Double, w: Double, h: Double
  public init(x: Double, y: Double, w: Double, h: Double) { (self.x, self.y, self.w, self.h) = (x, y, w, h) }
  public var maxX: Double { x + w }
  public var maxY: Double { y + h }
  public var midX: Double { x + w / 2 }
  public var midY: Double { y + h / 2 }
  public var isEmpty: Bool { w <= 0 || h <= 0 }
  public func contains(_ px: Double, _ py: Double) -> Bool { px >= x && py >= y && px < maxX && py < maxY }
  /** Is `r` inside this rect (with `slack` points of tolerance)? */
  public func contains(_ r: Rect, slack: Double = 1) -> Bool {
    r.x >= x - slack && r.y >= y - slack && r.maxX <= maxX + slack && r.maxY <= maxY + slack
  }
  public func intersection(_ r: Rect) -> Rect? {
    let x0 = max(x, r.x), y0 = max(y, r.y), x1 = min(maxX, r.maxX), y1 = min(maxY, r.maxY)
    return x1 > x0 && y1 > y0 ? Rect(x: x0, y: y0, w: x1 - x0, h: y1 - y0) : nil
  }
  public var description: String { "{\(Int(x)),\(Int(y)) \(Int(w))x\(Int(h))}" }
}

/** Where the bridge is, and its per-view sign-in links (from the sidecar's `ready` line). */
public struct BridgeEndpoints: Codable, Equatable, Sendable {
  public var base: URL
  /** view -> sign-in URL: main, orb, qubit, buddy, mouse */
  public var auth: [String: URL]
  public init(base: URL, auth: [String: URL]) { self.base = base; self.auth = auth }
}

/** Orbit's voice phase (ui/src/useVoice.ts Phase). */
public enum VoicePhase: String, Codable, Sendable { case off, connecting, listening, thinking, speaking }

/**
 * Orbit's state as the orb and the avatars get it (ui/src/desktop.ts OrbSync): the same keys, so the
 * pages read it unchanged.
 */
public struct OrbSync: Codable, Equatable, Sendable {
  public var phase: VoicePhase = .off
  public var input: Double = 0
  public var output: Double = 0
  public var asleep = false
  public var hearing = false
  public var claudeWorking = false
  public var pulseMe = false
  public var pulseGrok = false
  public var pulseAmount = 0.05
  public var muted: Bool? = false
  public var draft: Bool? = false
  public var sending: Bool? = false
  public init() {}
}

// MARK: - Parity driver state (parity/PROTOCOL.md "GET /parity/state")

public struct ParityWindow: Codable, Equatable, Sendable {
  public var visible: Bool
  public var frame: Rect?
  public var view: String?
  /** The main page's notice (a try to talk that couldn't start), with its buttons. */
  public var notice: ParityNotice?
  /** Settings was opened from that notice with the xAI key field focused. */
  public var focusKey: Bool?
  public init(visible: Bool, frame: Rect?, view: String? = nil, notice: ParityNotice? = nil, focusKey: Bool? = nil) {
    self.visible = visible; self.frame = frame; self.view = view; self.notice = notice; self.focusKey = focusKey
  }
}

public struct ParityNotice: Codable, Equatable, Sendable {
  public var kind: String
  public var text: String
  public var buttons: [String]
  public init(kind: String, text: String, buttons: [String]) { self.kind = kind; self.text = text; self.buttons = buttons }

  /** The buttons the main page shows for it (App.tsx's notice; Copy sits in the install command's box). */
  public static func buttons(for kind: String) -> [String] {
    if kind == "claude-models" { return [] }
    let missing = kind == "claude-missing", setup = missing || kind == "claude-signed-out"
    return (missing ? ["Copy"] : []) + (setup ? ["Check again"] : []) + (missing ? ["Setup guide"] : []) + ["Open Settings"]
      + (kind == "grok-key" ? ["Use Claude voice"] : []) + (kind == "claude-models-error" ? ["Try again"] : [])
  }
}

public struct ParityClaude: Codable, Equatable, Sendable {
  public var found: Bool
  public var pid: Int?
  public var frame: Rect?
  public var box: Rect?
  public var send: Rect?
  public init(found: Bool, pid: Int? = nil, frame: Rect? = nil, box: Rect? = nil, send: Rect? = nil) {
    self.found = found; self.pid = pid; self.frame = frame; self.box = box; self.send = send
  }
}

public struct ParityHost: Codable, Equatable, Sendable {
  public var pid: Int?
  public var frame: Rect?
  public init(pid: Int?, frame: Rect?) { self.pid = pid; self.frame = frame }
}

public struct ParityAvatar: Codable, Equatable, Sendable {
  public var id: String
  public var kind: String
  public var role: String // home | guest
  public var visible: Bool
  public var frame: Rect?
  public var host: ParityHost?
  public var figure: Rect?
  public var standingOn: String? // box | floor | air
  public var lifted: Bool
  public var asleep: Bool
  public var takesMouse: Bool
  public var leaving: Bool
  public init(id: String, kind: String, role: String, visible: Bool, frame: Rect?, host: ParityHost?, figure: Rect?, standingOn: String?, lifted: Bool, asleep: Bool, takesMouse: Bool, leaving: Bool) {
    self.id = id; self.kind = kind; self.role = role; self.visible = visible; self.frame = frame; self.host = host
    self.figure = figure; self.standingOn = standingOn; self.lifted = lifted; self.asleep = asleep; self.takesMouse = takesMouse; self.leaving = leaving
  }
}

public struct ParityMouse: Codable, Equatable, Sendable {
  public var visible: Bool
  public var pos: [String: Double]?
  public var windows: Int
  public init(visible: Bool, pos: [String: Double]?, windows: Int) { self.visible = visible; self.pos = pos; self.windows = windows }
}

public struct ParityDraft: Codable, Equatable, Sendable {
  public var id: Int
  public var text: String
  public var targetTitle: String?
  public init(id: Int, text: String, targetTitle: String?) { self.id = id; self.text = text; self.targetTitle = targetTitle }
}

public struct ParityVoice: Codable, Equatable, Sendable {
  public var phase: VoicePhase
  public var asleep: Bool
  public var connected: Bool
  public var muted: Bool
  public var playedMs: Double
  public var scheduledMs: Double
  public var chunks: Int
  public var lastError: String?
  public var draft: ParityDraft?
  public var sentCount: Int
  /** "Hey Orbit": off, loading, listening (ready to hear it) or error. */
  public var wakeWord: String
  public init(phase: VoicePhase = .off, asleep: Bool = false, connected: Bool = false, muted: Bool = false, playedMs: Double = 0, scheduledMs: Double = 0, chunks: Int = 0, lastError: String? = nil, draft: ParityDraft? = nil, sentCount: Int = 0, wakeWord: String = "off") {
    self.phase = phase; self.asleep = asleep; self.connected = connected; self.muted = muted; self.playedMs = playedMs
    self.scheduledMs = scheduledMs; self.chunks = chunks; self.lastError = lastError; self.draft = draft; self.sentCount = sentCount
    self.wakeWord = wakeWord
  }
}

public struct ParityOnboarding: Codable, Equatable, Sendable {
  public var mic: String
  public var ax: Bool
  public var screen: Bool
  public var step: String
  public var shown: Bool
  public init(mic: String, ax: Bool, screen: Bool, step: String, shown: Bool) { self.mic = mic; self.ax = ax; self.screen = screen; self.step = step; self.shown = shown }
}

public struct ParityHotkey: Codable, Equatable, Sendable {
  public var accelerator: String
  public var label: String
  public var registered: Bool
  public init(accelerator: String, label: String, registered: Bool) { self.accelerator = accelerator; self.label = label; self.registered = registered }
}

public struct ParityEvent: Codable, Equatable, Sendable {
  public var at: Double
  public var type: String
  public var data: JSONValue?
  public init(at: Double, type: String, data: JSONValue? = nil) { self.at = at; self.type = type; self.data = data }
}

public struct ParitySound: Codable, Equatable, Sendable {
  public var name: String
  public var at: Double
  public init(name: String, at: Double) { self.name = name; self.at = at }
}

public struct ParityState: Codable, Equatable, Sendable {
  public var windows: [String: ParityWindow] = [:]
  public var claude = ParityClaude(found: false)
  public var avatars: [ParityAvatar] = []
  public var mouse = ParityMouse(visible: false, pos: nil, windows: 0)
  public var voice = ParityVoice()
  public var onboarding = ParityOnboarding(mic: "not-determined", ax: false, screen: false, step: "mic", shown: false)
  public var hotkey = ParityHotkey(accelerator: "", label: "", registered: false)
  public var login: [String: Bool] = ["enabled": false]
  public var sounds: [ParitySound] = []
  public var events: [ParityEvent] = []
  public init() {}
}

/** A value behind a lock, for state shared with callbacks on other threads. */
public final class Locked<T>: @unchecked Sendable {
  private var value: T
  private let lock = NSLock()
  public init(_ value: T) { self.value = value }
  public func get() -> T { lock.withLock { value } }
  public func set(_ v: T) { lock.withLock { value = v } }
  @discardableResult public func update<R>(_ f: (inout T) -> R) -> R { lock.withLock { f(&value) } }
}
