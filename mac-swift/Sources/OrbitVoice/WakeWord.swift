// "Hey Orbit" / "Hey Grok" (phase 1): the bridge's own wake-word page (wake.html, Vosk in
// WebAssembly, fully offline) in a hidden WKWebView. In Electron that page runs in an iframe and
// posts {source: "orbit-wake", type: "status" | "wake"} to window.parent; here it's the top-level
// page, so a script injected before it runs gives it a `parent` whose postMessage forwards to Swift.
// The page's microphone request is granted only for the bridge's own origin. Removing the web view
// stops the microphone. VoiceController decides when it runs (off or asleep, setting on, a key).
import AppKit
import Foundation
import OrbitKit
import WebKit

@MainActor
public final class WakeWord: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
  public enum Status: String, Sendable { case off, loading, listening, error }

  public var onWake: () -> Void = {}
  /** Status changes (an error's detail is the page's message, at most 200 characters). */
  public var onStatus: (Status, String?) -> Void = { _, _ in }
  public private(set) var status: Status = .off
  /** Grant the page's microphone request (false: checks that must not trigger the system's mic prompt). */
  public var grantsMicrophone = true
  /** The page asked for the microphone (and whether it was granted). */
  public var onMicrophoneRequest: (Bool) -> Void = { _ in }

  private let link: BridgeLink
  private var webView: WKWebView?
  private var window: NSWindow?
  private var active = false

  public init(link: BridgeLink) { self.link = link }

  /** Start or stop listening. */
  public func setActive(_ on: Bool) {
    guard on != active else { return }
    active = on
    if on { start() } else { stop() }
  }

  public var isActive: Bool { active }

  /** Makes the top-level wake page talk to Swift as it would to Orbit's window. */
  static let bridgeScript = """
  (() => {
    const forward = { postMessage(msg) { try { window.webkit.messageHandlers.orbitWake.postMessage(msg); } catch (e) {} } };
    try { Object.defineProperty(window, 'parent', { get: () => forward, configurable: true }); } catch (e) { try { window.parent = forward; } catch (e2) {} }
    // A failure the page doesn't catch itself (its recognizer's worker, say) is an error status too.
    const fail = (m) => forward.postMessage({ source: 'orbit-wake', type: 'status', status: 'error', detail: String(m || 'error').slice(0, 200) });
    window.addEventListener('error', (e) => fail(e.message));
    window.addEventListener('unhandledrejection', (e) => fail(e.reason && (e.reason.message || e.reason)));
  })();
  """

  private func start() {
    set(.loading, nil)
    Task { [weak self] in
      guard let self else { return }
      let cookie = try? await self.link.cookie()
      guard self.active, self.webView == nil else { return }
      let cfg = WKWebViewConfiguration()
      // The recognizer keeps its model in IndexedDB (Emscripten's IDBFS), as it does in Electron's
      // profile; a non-persistent store leaves its first sync waiting forever.
      cfg.websiteDataStore = .default()
      cfg.mediaTypesRequiringUserActionForPlayback = []
      // It's never on screen, but it must keep running at full speed (WebKit throttles, then
      // suspends, web views it considers inactive).
      cfg.preferences.inactiveSchedulingPolicy = .none
      let uc = WKUserContentController()
      uc.addUserScript(WKUserScript(source: WakeWord.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
      uc.add(WeakHandler(self), name: "orbitWake")
      cfg.userContentController = uc
      let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 4, height: 4), configuration: cfg)
      wv.uiDelegate = self
      wv.navigationDelegate = self
      // A web view not in a window may be throttled; this one is in an invisible window off screen.
      let w = NSWindow(contentRect: NSRect(x: -10_000, y: -10_000, width: 4, height: 4), styleMask: .borderless, backing: .buffered, defer: false)
      w.isReleasedWhenClosed = false
      w.alphaValue = 0
      w.ignoresMouseEvents = true
      w.contentView = wv
      w.orderBack(nil)
      self.window = w
      self.webView = wv
      let base = self.link.endpoints.base
      if let cookie, let value = cookie.split(separator: "=", maxSplits: 1).last,
         let c = HTTPCookie(properties: [.name: "orbit_session", .value: String(value), .domain: base.host ?? "127.0.0.1", .path: "/"]) {
        await cfg.websiteDataStore.httpCookieStore.setCookie(c)
      }
      wv.load(URLRequest(url: base.appendingPathComponent("wake.html")))
    }
  }

  private func stop() {
    webView?.stopLoading()
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "orbitWake")
    webView?.removeFromSuperview()
    webView = nil
    window?.close()
    window = nil
    set(.off, nil)
  }

  /** For checks: what the page reports (its load state, what it fetched). */
  public func probe(_ js: String = "return JSON.stringify({ready: document.readyState, hidden: document.hidden})") async -> String? {
    guard let webView else { return nil }
    do { return try await webView.callAsyncJavaScript(js, contentWorld: .page).map { "\($0)" } } catch { return "probe failed: \(error.localizedDescription.prefix(120))" }
  }

  private func set(_ s: Status, _ detail: String?) {
    status = s
    onStatus(s, detail)
  }

  private func isBridge(_ origin: WKSecurityOrigin) -> Bool {
    let b = link.endpoints.base
    return origin.protocol == (b.scheme ?? "http") && origin.host == (b.host ?? "") && origin.port == (b.port ?? 80)
  }

  // MARK: the page's messages

  public func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard active, message.frameInfo.isMainFrame, isBridge(message.frameInfo.securityOrigin),
          let m = message.body as? [String: Any], m["source"] as? String == "orbit-wake" else { return }
    switch m["type"] as? String {
    case "wake": onWake()
    case "status":
      if let s = (m["status"] as? String).flatMap(Status.init(rawValue:)) { set(s, (m["detail"] as? String).map { String($0.prefix(200)) }) }
    default: break
    }
  }

  // MARK: the microphone, for the bridge's page only

  public func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
    let ok = active && grantsMicrophone && type == .microphone && isBridge(origin)
    onMicrophoneRequest(ok)
    decisionHandler(ok ? .grant : .deny)
  }

  public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    // Only the bridge's wake page; nothing else loads here.
    let ok = action.request.url.map { $0.host == link.endpoints.base.host && $0.port == link.endpoints.base.port } ?? false
    decisionHandler(ok ? .allow : .cancel)
  }

  public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { set(.error, String(error.localizedDescription.prefix(200))) }
  public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { set(.error, String(error.localizedDescription.prefix(200))) }
}

/** WKUserContentController keeps its handlers strongly; this breaks the cycle. */
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: WakeWord?
  init(_ t: WakeWord) { target = t }
  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated { target?.userContentController(uc, didReceive: message) }
  }
}
