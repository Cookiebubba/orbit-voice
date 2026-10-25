// Time for the voice logic, injected so it runs the same against the real clock and in tests
// (instantly, in virtual time). Two clocks, as in the page: the wall clock with its timers
// (Date.now / setTimeout / setInterval) and the audio clock playback is scheduled on
// (AudioContext.currentTime, here the audio engine's host time).
import Foundation

/** Wall-clock time in milliseconds and timers. */
public protocol VoiceClock: AnyObject {
  var nowMs: Double { get }
  /** Runs `fn` once after `ms` (negative = 0). Returns an id for cancel. */
  @discardableResult func after(_ ms: Double, _ fn: @escaping () -> Void) -> Int
  /** Runs `fn` every `ms` (first after `ms`) until cancelled. */
  @discardableResult func every(_ ms: Double, _ fn: @escaping () -> Void) -> Int
  func cancel(_ id: Int?)
}

/** The clock playback is scheduled on (seconds), and how long after that audio is heard. */
public protocol AudioClock: AnyObject {
  var audioTime: Double { get }
  /** Seconds between scheduling a sample and hearing it (Bluetooth earbuds: 0.1–0.3 s). */
  var outputLatency: Double { get }
}

/**
 * Virtual time for tests (and the parity runner): nothing happens until `advance`, which runs every
 * timer due on the way, in order. The audio clock moves with it (plus `audioOffset`).
 */
public final class ManualClock: VoiceClock, AudioClock {
  public private(set) var nowMs: Double
  public var audioOffset: Double = 0
  public var outputLatency: Double = 0
  private var timers: [(id: Int, due: Double, every: Double?, seq: Int, fn: () -> Void)] = []
  private var nextId = 0
  private var seq = 0

  public init(startMs: Double = 1_000_000) { nowMs = startMs }

  public var audioTime: Double { nowMs / 1000 + audioOffset }

  @discardableResult public func after(_ ms: Double, _ fn: @escaping () -> Void) -> Int { add(ms, nil, fn) }
  @discardableResult public func every(_ ms: Double, _ fn: @escaping () -> Void) -> Int { add(ms, ms, fn) }
  public func cancel(_ id: Int?) { if let id { timers.removeAll { $0.id == id } } }

  private func add(_ ms: Double, _ every: Double?, _ fn: @escaping () -> Void) -> Int {
    nextId += 1
    seq += 1
    // setTimeout/setInterval take at least ~1 ms; never 0, so a repeating timer can't spin.
    let d = max(every == nil ? 0 : 1, ms.isFinite ? ms : 0)
    timers.append((nextId, nowMs + max(0, d), every.map { max(1, $0) }, seq, fn))
    return nextId
  }

  /** Move time forward by `ms`, running timers as they come due. */
  public func advance(_ ms: Double) { advance(to: nowMs + ms) }

  public func advance(to t: Double) {
    while true {
      guard let i = timers.indices.filter({ timers[$0].due <= t }).min(by: { (timers[$0].due, timers[$0].seq) < (timers[$1].due, timers[$1].seq) }) else { break }
      let x = timers[i]
      nowMs = max(nowMs, x.due)
      if let e = x.every {
        seq += 1
        timers[i].due = x.due + e
        timers[i].seq = seq
      } else {
        timers.remove(at: i)
      }
      x.fn()
    }
    nowMs = max(nowMs, t)
  }

  /** Timers still waiting. */
  public var pendingTimers: Int { timers.count }
}

/** The real wall clock and timers on the main run loop (DispatchQueue.main), for the app. */
public final class MainQueueClock: VoiceClock, @unchecked Sendable {
  private var items: [Int: DispatchWorkItem] = [:]
  private var repeating: [Int: DispatchSourceTimer] = [:]
  private var nextId = 0
  public init() {}
  public var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

  @discardableResult public func after(_ ms: Double, _ fn: @escaping () -> Void) -> Int {
    nextId += 1
    let id = nextId
    let box = UncheckedBox(fn)
    let item = DispatchWorkItem { [weak self] in
      self?.items[id] = nil
      box.value()
    }
    items[id] = item
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, ms) / 1000, execute: item)
    return id
  }

  @discardableResult public func every(_ ms: Double, _ fn: @escaping () -> Void) -> Int {
    nextId += 1
    let id = nextId
    let box = UncheckedBox(fn)
    let t = DispatchSource.makeTimerSource(queue: .main)
    let ivl = max(1, ms) / 1000
    t.schedule(deadline: .now() + ivl, repeating: ivl, leeway: .milliseconds(2))
    t.setEventHandler { box.value() }
    repeating[id] = t
    t.resume()
    return id
  }

  public func cancel(_ id: Int?) {
    guard let id else { return }
    items.removeValue(forKey: id)?.cancel()
    repeating.removeValue(forKey: id)?.cancel()
  }
}

/** Carries a non-Sendable value to the main queue (everything here runs on it). */
struct UncheckedBox<T>: @unchecked Sendable {
  let value: T
  init(_ v: T) { value = v }
}
