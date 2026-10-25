// A hand-driven clock for the overlay tests: time moves only when a test says so, and timers fire in
// order as it does (the Electron tests used real time and sleeps for the same timelines).
import Foundation
@testable import OrbitKit

@MainActor
final class ManualClock: OverlayClock {
  final class Timer: OverlayTimer {
    weak var clock: ManualClock?
    let id: Int
    init(clock: ManualClock, id: Int) { (self.clock, self.id) = (clock, id) }
    func cancel() { clock?.tasks.removeAll { $0.id == id } }
  }

  struct Task {
    var id: Int
    var at: Double
    var every: Double?
    var fn: @MainActor () -> Void
  }

  var now: Double
  fileprivate var tasks: [Task] = []
  private var nextId = 0

  init(now: Double = 1_000_000) { self.now = now }

  @discardableResult
  func after(_ ms: Double, _ fn: @escaping @MainActor () -> Void) -> OverlayTimer { add(ms, nil, fn) }

  @discardableResult
  func every(_ ms: Double, _ fn: @escaping @MainActor () -> Void) -> OverlayTimer { add(ms, ms, fn) }

  private func add(_ ms: Double, _ every: Double?, _ fn: @escaping @MainActor () -> Void) -> OverlayTimer {
    nextId += 1
    tasks.append(Task(id: nextId, at: now + max(0, ms), every: every, fn: fn))
    return Timer(clock: self, id: nextId)
  }

  /** Move time on by `ms`, firing every timer that falls due (in order), then `each` after every step of `step` ms. */
  func advance(_ ms: Double, step: Double? = nil, each: (() -> Void)? = nil) {
    let end = now + ms
    if let step {
      while now < end {
        run(until: min(end, now + step))
        each?()
      }
    } else {
      run(until: end)
    }
  }

  private func run(until end: Double) {
    while true {
      guard let i = tasks.indices.filter({ tasks[$0].at <= end }).min(by: { (tasks[$0].at, tasks[$0].id) < (tasks[$1].at, tasks[$1].id) }) else { break }
      let t = tasks[i]
      now = max(now, t.at)
      if let e = t.every { tasks[i].at = t.at + max(1, e) } else { tasks.remove(at: i) }
      t.fn()
    }
    now = max(now, end)
  }

  /** Move "now" without firing anything (as the Electron tests moved their fake now between real timers). */
  func jump(_ ms: Double) { now += ms }

  var pending: Int { tasks.count }
}
