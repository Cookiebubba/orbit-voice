// AXObserver wrapper: per app (pid), notifications on the app or its windows, delivered on the main
// run loop to one Swift closure. Observers for apps that quit are dropped.

import AppKit
import ApplicationServices

final class AppObserver {
  let pid: pid_t
  private var observer: AXObserver?
  private let onEvent: (String, AXUIElement) -> Void
  private var registered: [(AXUIElement, String)] = []

  init?(pid: pid_t, onEvent: @escaping (String, AXUIElement) -> Void) {
    self.pid = pid
    self.onEvent = onEvent
    var obs: AXObserver?
    let cb: AXObserverCallback = { _, element, name, refcon in
      guard let refcon = refcon else { return }
      let me = Unmanaged<AppObserver>.fromOpaque(refcon).takeUnretainedValue()
      me.onEvent(name as String, element)
    }
    guard AXObserverCreate(pid, cb, &obs) == .success, let o = obs else { return nil }
    observer = o
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
  }

  /** Listen for `names` on `element` (the app element when nil). */
  @discardableResult
  func add(_ names: [String], on element: AXUIElement? = nil) -> Bool {
    guard let o = observer else { return false }
    let el = element ?? AX.app(pid)
    var any = false
    let ref = Unmanaged.passUnretained(self).toOpaque()
    for n in names {
      let err = AXObserverAddNotification(o, el, n as CFString, ref)
      if err == .success || err == .notificationAlreadyRegistered {
        any = true
        registered.append((el, n))
      }
    }
    return any
  }

  func removeAll() {
    guard let o = observer else { return }
    for (el, n) in registered { AXObserverRemoveNotification(o, el, n as CFString) }
    registered.removeAll()
  }

  deinit {
    removeAll()
    if let o = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode) }
  }
}

/** Calls `fn` on the main queue every `seconds` until cancelled. */
@discardableResult
func every(_ seconds: Double, _ fn: @escaping () -> Void) -> DispatchSourceTimer {
  let t = DispatchSource.makeTimerSource(queue: .main)
  t.schedule(deadline: .now() + seconds, repeating: seconds, leeway: .milliseconds(10))
  t.setEventHandler(handler: fn)
  t.resume()
  return t
}
