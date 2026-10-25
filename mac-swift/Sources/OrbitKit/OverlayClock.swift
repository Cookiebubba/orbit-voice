// Time for the overlays' logic (avatars, the hover poll, Orbit's mouse, the Claude window tracker):
// "now" in milliseconds and one-shot / repeating timers, passed in so the tests run every timeline
// on a hand-driven clock instead of waiting in real time. The app uses MainClock.
import Foundation

@MainActor
public protocol OverlayTimer: AnyObject {
  func cancel()
}

@MainActor
public protocol OverlayClock: AnyObject {
  /** Milliseconds on the shared clock (Date.now's: the mouse page glides on it too). */
  var now: Double { get }
  /** Run `fn` once, `ms` from now. */
  @discardableResult func after(_ ms: Double, _ fn: @escaping @MainActor () -> Void) -> OverlayTimer
  /** Run `fn` every `ms` until cancelled. */
  @discardableResult func every(_ ms: Double, _ fn: @escaping @MainActor () -> Void) -> OverlayTimer
}

/** The real clock: wall-clock milliseconds, timers on the main run loop (they keep firing while a menu tracks). */
@MainActor
public final class MainClock: OverlayClock {
  public static let shared = MainClock()
  public init() {}

  public var now: Double { Date().timeIntervalSince1970 * 1000 }

  private final class Token: OverlayTimer {
    var timer: Timer?
    func cancel() {
      timer?.invalidate()
      timer = nil
    }
  }

  @discardableResult
  public func after(_ ms: Double, _ fn: @escaping @MainActor () -> Void) -> OverlayTimer {
    schedule(ms, repeats: false, fn)
  }

  @discardableResult
  public func every(_ ms: Double, _ fn: @escaping @MainActor () -> Void) -> OverlayTimer {
    schedule(ms, repeats: true, fn)
  }

  private func schedule(_ ms: Double, repeats: Bool, _ fn: @escaping @MainActor () -> Void) -> OverlayTimer {
    let token = Token()
    let t = Timer(timeInterval: max(0.001, ms / 1000), repeats: repeats) { [weak token] _ in
      MainActor.assumeIsolated {
        guard let token, token.timer != nil else { return }
        if !repeats { token.timer = nil }
        fn()
      }
    }
    token.timer = t
    RunLoop.main.add(t, forMode: .common)
    return token
  }
}
