// How long Orbit is connected to Grok (what xAI bills for), per day (src/usage.js): usage.json next
// to settings.json, { "2026-10-18": seconds, ... } in local dates, about a year kept.
import Foundation
import OrbitKit

public final class Usage: @unchecked Sendable {
  public let file: URL
  private let lock = NSLock()
  private let now: @Sendable () -> Date

  public init(dir: URL, now: @escaping @Sendable () -> Date = { Date() }) {
    file = dir.appendingPathComponent("usage.json")
    self.now = now
  }

  /** Today in local time as YYYY-MM-DD (toLocaleDateString('en-CA')). */
  func today() -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: now())
  }

  func load() -> [String: Double] {
    guard let data = try? Data(contentsOf: file), case .object(let o)? = try? JSONValue.parse(data) else { return [:] }
    return o.compactMapValues(\.doubleValue)
  }

  /** Adds connected seconds to today (a year of days kept). */
  public func add(seconds: Double) {
    guard seconds > 0 else { return }
    lock.withLock {
      var data = load()
      let t = today()
      data[t] = EngineConfig.round((data[t] ?? 0) + seconds)
      let keys = data.keys.sorted()
      for k in keys.prefix(max(0, keys.count - 400)) { data.removeValue(forKey: k) }
      try? JSONValue.object(data.mapValues { .number($0) }).data().write(to: file, options: .atomic)
    }
  }

  /** usageSummary(): today and this month, minutes and cost at the set rate. */
  public func summary(costPerMinute rate: Double) -> JSONValue {
    let data = load()
    let t = today()
    let month = String(t.prefix(7))
    func secs(_ pred: (String) -> Bool) -> Double { data.filter { pred($0.key) }.values.reduce(0, +) }
    func mk(_ s: Double) -> JSONValue {
      ["minutes": .number(EngineConfig.round(s / 60 * 10) / 10), "cost": .number(EngineConfig.round(s / 60 * rate * 100) / 100)]
    }
    return ["today": mk(secs { $0 == t }), "month": mk(secs { $0.hasPrefix(month) }), "costPerMinute": .number(rate)]
  }

  /** startMeter(): call when a Grok connection opens; the returned function when it closes. */
  public func startMeter() -> @Sendable () -> Void {
    let start = Locked(now())
    let timer = DispatchSource.makeTimerSource(queue: .global())
    let flush: @Sendable () -> Void = { [weak self] in
      guard let self else { return }
      let t = self.now()
      let last = start.update { v -> Date in let old = v; v = t; return old }
      self.add(seconds: t.timeIntervalSince(last))
    }
    timer.schedule(deadline: .now() + 30, repeating: 30) // so a crash loses at most 30 s
    timer.setEventHandler(handler: flush)
    timer.resume()
    let stopped = Locked(false)
    return {
      guard stopped.update({ v -> Bool in let was = v; v = true; return !was }) else { return }
      timer.cancel()
      flush()
    }
  }
}
