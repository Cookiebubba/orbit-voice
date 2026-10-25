// The /voice WebSocket (URLSessionWebSocketTask): open, text frames in and out, close. Callbacks
// come on the main queue. A close waits (briefly) for frames still being sent, so the goodbye
// (ui.bye, sent just before hanging up) reaches the bridge's log.
import Foundation

final class VoiceSocket: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  var onOpen: @MainActor () -> Void = {}
  var onText: @MainActor (String) -> Void = { _ in }
  var onClose: @MainActor () -> Void = {}

  private var task: URLSessionWebSocketTask?
  private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
  private let lock = NSLock()
  private var inFlight = 0
  private var closing = false
  private var closed = false

  func open(_ req: URLRequest) {
    let t = session.webSocketTask(with: req)
    t.maximumMessageSize = 4 * 1024 * 1024
    task = t
    t.resume()
    receive()
  }

  private func receive() {
    task?.receive { [weak self] r in
      guard let self else { return }
      switch r {
      case .success(.string(let s)):
        DispatchQueue.main.async { MainActor.assumeIsolated { self.onText(s) } }
        self.receive()
      case .success(.data(let d)):
        if let s = String(data: d, encoding: .utf8) { DispatchQueue.main.async { MainActor.assumeIsolated { self.onText(s) } } }
        self.receive()
      case .success:
        self.receive()
      case .failure:
        self.finish()
      }
    }
  }

  func send(_ text: String) {
    guard let task else { return }
    lock.withLock { inFlight += 1 }
    task.send(.string(text)) { [weak self] _ in
      guard let self else { return }
      let go = self.lock.withLock { () -> Bool in
        self.inFlight -= 1
        return self.closing && self.inFlight == 0
      }
      if go { self.task?.cancel(with: .normalClosure, reason: nil) }
    }
  }

  /** Close once what's being sent has gone (at most half a second). */
  func close() {
    let now = lock.withLock { () -> Bool in
      closing = true
      return inFlight == 0
    }
    if now { task?.cancel(with: .normalClosure, reason: nil) }
    else { DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.task?.cancel(with: .normalClosure, reason: nil) } }
    session.finishTasksAndInvalidate()
  }

  private func finish() {
    let first = lock.withLock { () -> Bool in
      defer { closed = true }
      return !closed
    }
    if first { DispatchQueue.main.async { MainActor.assumeIsolated { self.onClose() } } }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    DispatchQueue.main.async { MainActor.assumeIsolated { self.onOpen() } }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    finish()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    finish()
  }
}
