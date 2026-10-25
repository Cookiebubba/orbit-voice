// The shell's recent happenings (avatar clicks, lifts, sounds, voice state changes...), kept as a
// ring for the parity driver's `events` and `sounds`. Names and small data only, never user words.
import Foundation

public final class EventLog: @unchecked Sendable {
  private var events: [ParityEvent] = []
  private var sounds: [ParitySound] = []
  private let lock = NSLock()
  private let max: Int
  public init(max: Int = 200) { self.max = max }

  public static func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

  public func add(_ type: String, _ data: JSONValue? = nil) {
    lock.withLock {
      events.append(ParityEvent(at: Self.now(), type: type, data: data))
      if events.count > max { events.removeFirst(events.count - max) }
    }
  }

  public func sound(_ name: String) {
    lock.withLock {
      sounds.append(ParitySound(name: name, at: Self.now()))
      if sounds.count > max { sounds.removeFirst(sounds.count - max) }
    }
    add("sound", ["name": .string(name)])
  }

  public var recentEvents: [ParityEvent] { lock.withLock { events } }
  public var recentSounds: [ParitySound] { lock.withLock { sounds } }
}
