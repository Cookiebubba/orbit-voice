// Live events from the bridge (GET /api/events), as ui/src/useAppState.ts handles them: what Claude
// is working on, "Claude finished", the bridge asking the voice to wake, and settings changes.
import Foundation
import Observation

public struct ClaudeWork: Equatable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public init(id: String, title: String) { self.id = id; self.title = title }
}

public struct ClaudeFinished: Equatable, Sendable {
  public var id: String
  public var title: String
  public var summary: String
  public var at: Date
}

@MainActor
@Observable
public final class AppStateModel {
  public private(set) var claudeWorking: [ClaudeWork] = []
  /** Claude finished a turn somewhere (the shell chimes / notifies / lets the voice say it). */
  @ObservationIgnored public var onFinished: ((ClaudeFinished) -> Void)?
  /** The bridge wants the voice to wake by itself (orbit.wake). */
  @ObservationIgnored public var onWake: (() -> Void)?
  /** Every event, for anyone else who listens (the integrator's shell). */
  @ObservationIgnored public var onEvent: ((JSONValue) -> Void)?
  /** A session opened in Claude (claude.open). */
  @ObservationIgnored public var onOpen: ((String) -> Void)?

  @ObservationIgnored private let settings: SettingsModel
  @ObservationIgnored private var task: Task<Void, Never>?

  public init(settings: SettingsModel) { self.settings = settings }

  public func handle(_ evt: JSONValue) {
    switch evt["type"]?.stringValue {
    case "claude.status":
      claudeWorking = (evt["working"]?.arrayValue ?? []).map { ClaudeWork(id: $0["id"]?.stringValue ?? "", title: $0["title"]?.stringValue ?? "") }
    case "claude.finished":
      onFinished?(ClaudeFinished(id: evt["id"]?.stringValue ?? "", title: evt["title"]?.stringValue ?? "", summary: evt["summary"]?.stringValue ?? "", at: Date()))
    case "orbit.wake":
      onWake?()
    case "settings.changed":
      settings.apply(event: evt)
    case "claude.open":
      if let t = evt["title"]?.stringValue { onOpen?(t) }
    default: break
    }
    onEvent?(evt)
  }

  /** Follow a stream of events (BridgeClient.events()) until stop(). */
  public func follow(_ events: AsyncStream<JSONValue>) {
    task?.cancel()
    task = Task { [weak self] in
      for await e in events {
        guard let self else { return }
        self.handle(e)
      }
    }
  }

  public func stop() { task?.cancel(); task = nil }
}
