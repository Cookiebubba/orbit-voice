// The overlay pages (qubit.html, buddy.html, mouse.html, index.html#orb) run unchanged in a WKWebView.
// They talk to the shell through `window.desktop` (electron/preload.cjs); this injects the same API at
// document start, with exactly the methods and channels these pages use. Calls post to
// webkit.messageHandlers.orbit as { ch, args }; Swift answers with window.__orbit.emit(channel,
// payload), which runs the page's listeners. The channels and payloads are Electron's.
//
// Locked down like Electron's lockDown(): the web view never leaves the bridge's origin (the sign-in
// link redirects within it), opens no new windows, shows no context menu, and only the main frame of
// the bridge's own page may post messages. Its background is transparent.
import AppKit
import OrbitKit
import WebKit

enum PageShim {
  /** The user script (document start, main frame only). */
  static let source = #"""
  (() => {
    if (window.desktop) return;
    const post = (ch, ...args) => {
      try { window.webkit.messageHandlers.orbit.postMessage({ ch, args }); } catch (e) {}
    };
    const listeners = new Map();
    const on = (ch) => (cb) => {
      let set = listeners.get(ch);
      if (!set) listeners.set(ch, (set = new Set()));
      const fn = (payload) => cb(payload);
      set.add(fn);
      // The shell may have spoken before the page's script got here: it says the last state again.
      post('shim:listen', ch);
      return () => set.delete(fn);
    };
    Object.defineProperty(window, '__orbit', {
      value: Object.freeze({
        emit(ch, payload) {
          for (const fn of [...(listeners.get(ch) || [])]) {
            try { fn(payload); } catch (e) { console.error(e); }
          }
        },
      }),
    });
    const rect = (r) => (r && typeof r === 'object' ? { x: +r.x, y: +r.y, w: +r.w, h: +r.h } : null);
    Object.defineProperty(window, 'desktop', {
      value: Object.freeze({
        platform: 'darwin',
        // The avatar (the pixel buddy or Qubit).
        buddyHover: (over, held) => post('buddy:hover', !!over, !!held),
        buddyHit: (r) => post('buddy:hit', rect(r)),
        // A press on the avatar and what came of it ('click' | 'pickup' | 'ignored', and why), for the log.
        buddyPress: (outcome, why) => post('buddy:press', String(outcome), String(why || '')),
        onBuddyCursor: on('buddy:cursor'),
        buddyTalk: () => post('buddy:talk'),
        buddyLift: (v) => post('buddy:lift', !!v),
        buddySound: (name) => post('buddy:sound', String(name)),
        onBuddyEmote: on('buddy:emote'),
        onBuddyState: on('buddy:state'),
        onBuddyEvent: on('buddy:event'),
        onBuddyCommand: on('buddy:command'),
        // Orbit's mouse.
        onMouseState: on('mouse:state'),
        // The orb.
        onOrbState: on('orb:state'),
        onOrbAction: on('orb:action'),
        orbRestore: () => post('orb:restore'),
        orbAction: (a) => post('orb:action', String(a)),
        orbDragStart: () => post('orb:drag-start'),
        orbDragMove: () => post('orb:drag-move'),
        orbDragEnd: () => post('orb:drag-end'),
      }),
    });
    // No context menu (the orb's own right-click handler still runs: this only stops the menu).
    addEventListener('contextmenu', (e) => e.preventDefault(), true);
    // Errors on the page (their message only: the code's own words), so a stuck avatar explains itself.
    const err = (m) => post('page:error', String(m || '').replace(/\s+/g, ' ').slice(0, 160));
    addEventListener('error', (e) => err(e && e.message));
    addEventListener('unhandledrejection', (e) => err(e && e.reason && (e.reason.message || e.reason)));
  })();
  """#
}

/** A web view that takes the first click (its window is never key) and shows no context menu. */
final class OverlayWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) { menu.removeAllItems() }
  override var mouseDownCanMoveWindow: Bool { false }
}

/** One overlay page: its web view, its sign-in link, and the channel to and from it. */
@MainActor
public final class OverlayPage: NSObject, WKNavigationDelegate, WKUIDelegate {
  /** One cookie jar for every overlay, in memory only (nothing of the session lands on disk). */
  private static let store = WKWebsiteDataStore.nonPersistent()

  let webView: OverlayWebView
  private let url: URL
  private let origin: (scheme: String, host: String, port: Int)
  /** A message from the page: channel and arguments. */
  var onMessage: (String, [JSONValue]) -> Void = { _, _ in }
  /** The page finished loading (each time). */
  var onLoad: () -> Void = {}
  /** The page started loading again, or its process went (`why`: nil, or what WebKit says): what it said about itself no longer holds. */
  var onReset: (_ stopped: String?) -> Void = { _ in }
  /** Where the page's plumbing reports trouble (a refused message, a failed emit); no page content. */
  static var log: (String) -> Void = { _ in }
  private var refusedLogged = 0
  private var emitErrors = 0
  private var lastState: [String: JSONValue] = [:] // the latest buddy:state / mouse:state / orb:state
  private(set) var loaded = false
  private var destroyed = false

  private final class Handler: NSObject, WKScriptMessageHandler {
    weak var page: OverlayPage?
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
      MainActor.assumeIsolated { page?.receive(message) }
    }
  }
  private let handler = Handler()

  init(url: URL, base: URL) {
    self.url = url
    origin = (base.scheme ?? "http", base.host ?? "127.0.0.1", base.port ?? 80)
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = Self.store
    cfg.suppressesIncrementalRendering = false
    cfg.mediaTypesRequiringUserActionForPlayback = .all
    let ucc = WKUserContentController()
    ucc.addUserScript(WKUserScript(source: PageShim.source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    ucc.add(handler, name: "orbit")
    cfg.userContentController = ucc
    cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
    Self.keepRunningWhenHidden(cfg.preferences)
    webView = OverlayWebView(frame: NSRect(x: 0, y: 0, width: 100, height: 100), configuration: cfg)
    super.init()
    handler.page = self
    webView.setValue(false, forKey: "drawsBackground") // transparent: the desktop shows through
    webView.underPageBackgroundColor = .clear
    webView.allowsBackForwardNavigationGestures = false
    webView.allowsMagnification = false
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.autoresizingMask = [.width, .height]
    keepRunningWhenOccluded(webView)
  }

  /**
   * Electron's backgroundThrottling: false. WebKit marks a page hidden (no animation frames, timers
   * throttled) when macOS says its window is occluded, which a transparent overlay often is to the
   * window server (nothing opaque in it), and always is while the screen is locked. The pages stop
   * their own frame loop when the shell says they're hidden (buddy:state visible false), so this
   * only keeps them from being frozen while they show. (WebKit SPI, looked up at run time; without
   * it nothing changes.)
   */
  private func keepRunningWhenOccluded(_ wv: WKWebView) {
    typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
    let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
    if wv.responds(to: sel) { unsafeBitCast(wv.method(for: sel), to: SetBool.self)(wv, sel, false) }
  }

  private static func keepRunningWhenHidden(_ prefs: WKPreferences) {
    typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
    for name in ["_setHiddenPageDOMTimerThrottlingEnabled:", "_setPageVisibilityBasedProcessSuppressionEnabled:"] {
      let s = NSSelectorFromString(name)
      if prefs.responds(to: s) { unsafeBitCast(prefs.method(for: s), to: SetBool.self)(prefs, s, false) }
    }
  }

  func load() { webView.load(URLRequest(url: url)) }

  /** Is this URL the bridge's own origin (an exact match, no user or password)? */
  private func isOurs(_ u: URL?) -> Bool {
    guard let u, u.user == nil, u.password == nil else { return false }
    return u.scheme == origin.scheme && u.host == origin.host && (u.port ?? 80) == origin.port
  }

  private func receive(_ message: WKScriptMessage) {
    let o = message.frameInfo.securityOrigin
    guard !destroyed, message.frameInfo.isMainFrame, o.protocol == origin.scheme, o.host == origin.host, o.port == origin.port else {
      if refusedLogged < 3 {
        refusedLogged += 1
        Self.log("page: a message refused (main frame \(message.frameInfo.isMainFrame), origin \(o.protocol)://\(o.host):\(o.port))")
      }
      return
    }
    let body = JSONValue(any: message.body)
    guard let ch = body["ch"]?.stringValue, ch.count < 40 else { return }
    if ch == "shim:listen" {
      // A listener just registered: the last state on that channel again (it may have come first).
      if let c = body["args"]?[0]?.stringValue, let p = lastState[c] { send(c, p) }
      return
    }
    onMessage(ch, body["args"]?.arrayValue ?? [])
  }

  /** window.__orbit.emit(channel, payload) in the page. */
  func emit(_ channel: String, _ payload: JSONValue) {
    if channel.hasSuffix(":state") { lastState[channel] = payload }
    guard !destroyed, loaded else { return }
    send(channel, payload)
  }

  private func send(_ channel: String, _ payload: JSONValue) {
    guard !destroyed else { return }
    // The payload goes as an argument (WebKit hands it over as a JS value), never pasted into code.
    // It answers whether the page had the channel's shim, so a lost message shows up in the log.
    webView.callAsyncJavaScript("if (!window.__orbit) return false; window.__orbit.emit(ch, p); return true;", arguments: ["ch": channel, "p": payload.any], in: nil, in: .page) { [weak self] result in
      MainActor.assumeIsolated {
        guard let self else { return }
        var problem: String?
        switch result {
        case .failure(let e): problem = String(describing: e).prefix(200).description
        case .success(let v): if (v as? Bool) != true { problem = "no shim in the page" }
        }
        if let problem, self.emitErrors < 3 {
          self.emitErrors += 1
          Self.log("page: \(channel) didn't reach the page: \(problem)")
        }
      }
    }
  }

  /** Run a script in the page (the parity driver's probes): an expression, or a function body. */
  func eval(_ script: String) async -> JSONValue {
    guard !destroyed else { return .null }
    do {
      let v = try await webView.callAsyncJavaScript("return await (\n\(script)\n);", arguments: [:], in: nil, contentWorld: .page)
      return JSONValue(any: v)
    } catch {
      do {
        let v = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
        return JSONValue(any: v)
      } catch {
        return ["error": .string(String(describing: error).prefix(300).description)]
      }
    }
  }

  func destroy() {
    destroyed = true
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "orbit")
    webView.removeFromSuperview()
  }

  // MARK: WKNavigationDelegate / WKUIDelegate

  public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    decisionHandler(isOurs(navigationAction.request.url) && navigationAction.targetFrame?.isMainFrame != false ? .allow : .cancel)
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard !destroyed else { return }
    loaded = true
    Self.log("page: loaded \(webView.url?.path ?? "?")")
    onLoad()
  }

  public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    guard !destroyed else { return }
    onReset(nil)
  }

  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // The page's process went (memory pressure, a crash): load it again.
    guard !destroyed else { return }
    loaded = false
    onReset("process ended")
    load()
  }

  public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    nil // no new windows
  }
}
