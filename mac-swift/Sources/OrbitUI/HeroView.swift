// The launcher's hero: Qubit, drawn by his own engine, unchanged. A WKWebView loads a tiny page that
// runs the very files the Electron page bundles: ui/src/vendor/avatars/orbit-nav.js and
// qubit-engine.js (plain scripts), and ui/src/hero/hero.js (his show, which imports
// ui/src/qubit/director.js), served from `heroRoot` through an orbit-hero: URL scheme so the ES
// modules load as they do in the page. heroRoot is the repo's ui/src while developing; the app
// bundle carries those four files in the same layout (Resources/hero-src).
import AppKit
import OrbitKit
import SwiftUI
import WebKit

/** AvatarHero.tsx's measures. */
enum HeroMetrics {
  static let side: CGFloat = 64 // his body, px
  static let floor: CGFloat = 18 // the hairline floor, px above the stage's bottom
  static let stageHeight: CGFloat = (18 + 64 * 3.3).rounded() // 229: room for his jumps and flips
}

/** Orbit's state as the hero gets it (OrbSync's keys: phase, asleep, hearing, levels...). */
struct HeroVoice: Equatable {
  var phase: VoicePhase
  var asleep: Bool
  var hearing: Bool
  var input: Double
  var output: Double
  var muted: Bool
  var draft: Bool
  var sending: Bool
  var claudeWorking: Bool
  var json: String {
    func n(_ d: Double) -> String { String(format: "%.3f", d) }
    return "{\"phase\":\"\(phase.rawValue)\",\"asleep\":\(asleep),\"hearing\":\(hearing),\"input\":\(n(input)),\"output\":\(n(output)),\"muted\":\(muted),\"draft\":\(draft),\"sending\":\(sending),\"claudeWorking\":\(claudeWorking)}"
  }
}

/** Serves the hero page and the engine files under orbit-hero://app/. Only those paths, nothing else. */
final class HeroSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "orbit-hero"
  static let allowed: Set<String> = ["/vendor/avatars/orbit-nav.js", "/vendor/avatars/qubit-engine.js", "/hero/hero.js", "/qubit/director.js"]
  let root: URL
  init(root: URL) { self.root = root }

  static let page = """
  <!doctype html><html><head><meta charset="utf-8">
  <style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}#m{position:absolute;inset:0}</style>
  <script src="/vendor/avatars/orbit-nav.js"></script>
  <script src="/vendor/avatars/qubit-engine.js"></script>
  </head><body><div id="m"></div>
  <script type="module">
  import { createHero } from '/hero/hero.js';
  const SIDE = 64, FLOOR = 18, H = Math.round(FLOOR + SIDE * 3.3);
  const el = document.getElementById('m');
  const E = window.QubitEngine;
  const W = Math.max(120, el.clientWidth);
  const q = E.create({ mount: el, width: W, height: H, size: SIDE, floor: FLOOR, x: W / 2, mode: 'idle' });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seed = Number(new URLSearchParams(location.search).get('seed')) || Math.floor(Math.random() * 0xffffff) + 1;
  const h = createHero(q, { seed, home: W / 2, timing: reduce ? { firstS: Infinity } : {} });
  E.ticker.hooks.add((dt) => h.tick(dt));
  window.__hero = { q, hero: h };
  window.heroVoice = (v) => h.setVoice(v);
  window.heroPoke = () => h.poke();
  window.heroPointer = (p) => q.setPointer(p);
  new ResizeObserver(() => {
    const w = Math.max(120, el.clientWidth);
    if (w === q.W) return;
    const off = q.cx - h.home;
    q.resize(w, H, FLOOR);
    h.home = w / 2;
    q.cx = w / 2 + off;
  }).observe(el);
  window.webkit?.messageHandlers?.hero?.postMessage('ready');
  </script></body></html>
  """

  func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
    guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
    let path = url.path
    let data: Data
    let type: String
    if path == "/hero.html" || path == "/" {
      data = Data(Self.page.utf8); type = "text/html"
    } else if Self.allowed.contains(path), let d = try? Data(contentsOf: root.appendingPathComponent(String(path.dropFirst()))) {
      data = d; type = "text/javascript"
    } else {
      task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
      task.didFinish()
      return
    }
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "\(type); charset=utf-8", "Content-Length": String(data.count), "Cache-Control": "no-store"])!)
    task.didReceive(data)
    task.didFinish()
  }
  func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

/** Holds the hero's web view, so the launcher can pass him the cursor, poke him and snapshot him. */
@MainActor
final class HeroBridge: NSObject, WKScriptMessageHandler {
  let root: URL
  let seed: Int?
  private(set) var webView: WKWebView?
  private(set) var ready = false
  private var lastVoice: String?
  private var pendingVoice: String?

  init(root: URL, seed: Int? = nil) { self.root = root; self.seed = seed }

  /** Snapshot runs only: keep Qubit animating while the display sleeps (WebKit pauses hidden pages). */
  static var ignoreOcclusion = false


  func makeWebView() -> WKWebView {
    if let webView { return webView }
    let cfg = WKWebViewConfiguration()
    cfg.setURLSchemeHandler(HeroSchemeHandler(root: root), forURLScheme: HeroSchemeHandler.scheme)
    cfg.userContentController.add(WeakMessageHandler(self), name: "hero")
    cfg.suppressesIncrementalRendering = false
    let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: HeroMetrics.stageHeight), configuration: cfg)
    wv.setValue(false, forKey: "drawsBackground") // the page is transparent over the white launcher
    wv.allowsMagnification = false
    wv.setAccessibilityElement(false) // decorative: the button over him carries his name
    if Self.ignoreOcclusion { keepAnimating(wv) }
    var url = "\(HeroSchemeHandler.scheme)://app/hero.html"
    if let seed { url += "?seed=\(seed)" }
    wv.load(URLRequest(url: URL(string: url)!))
    webView = wv
    return wv
  }

  nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated {
      ready = true
      if let v = pendingVoice { pendingVoice = nil; send(v) }
    }
  }

  func setVoice(_ v: HeroVoice) {
    let j = v.json
    guard j != lastVoice else { return }
    lastVoice = j
    if ready { send(j) } else { pendingVoice = j }
  }

  private func send(_ json: String) { webView?.evaluateJavaScript("window.heroVoice && window.heroVoice(\(json))") }

  func poke() { webView?.evaluateJavaScript("window.heroPoke && window.heroPoke()") }

  /** The cursor (window coordinates, AppKit: bottom-left origin) or nil when it left the window. */
  func pointer(_ windowPoint: NSPoint?) {
    guard let wv = webView, ready else { return }
    guard let p = windowPoint else { wv.evaluateJavaScript("window.heroPointer && window.heroPointer(null)"); return }
    let local = wv.convert(p, from: nil)
    let y = wv.isFlipped ? local.y : wv.bounds.height - local.y
    wv.evaluateJavaScript(String(format: "window.heroPointer && window.heroPointer({x:%.1f,y:%.1f})", local.x, y))
  }

  func snapshot() async -> NSImage? {
    guard let wv = webView else { return nil }
    let cfg = WKSnapshotConfiguration()
    cfg.afterScreenUpdates = true
    return try? await wv.takeSnapshot(configuration: cfg)
  }
}

/**
 * Turn off WebKit's window-occlusion detection for one web view (its SPI, when present), so its page
 * keeps running requestAnimationFrame with the display asleep. For snapshot runs, never the app.
 */
@MainActor public func keepAnimating(_ wv: WKWebView) {
  if wv.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
    wv.setValue(false, forKey: "windowOcclusionDetectionEnabled")
  }
}

/** WKUserContentController holds its handlers strongly; this breaks the cycle. */
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: (any WKScriptMessageHandler)?
  init(_ t: any WKScriptMessageHandler) { target = t }
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}

struct HeroWebView: NSViewRepresentable {
  let bridge: HeroBridge
  let voice: HeroVoice
  func makeNSView(context: Context) -> WKWebView { bridge.makeWebView() }
  func updateNSView(_ nsView: WKWebView, context: Context) { bridge.setVoice(voice) }
}

/** The carousel with Qubit in the middle (AvatarHero.tsx), wired to the `avatar` setting. */
struct AvatarHeroView: View {
  let bridge: HeroBridge
  let avatar: String
  let voice: HeroVoice
  let label: String
  let onChoose: (String) -> Void
  let onActivate: () -> Void

  /** carousel.js: only Qubit for now; the controls already work for more. */
  static let carousel: [(id: String, name: String)] = [("qubit", "Qubit")]
  var index: Int { Self.carousel.firstIndex { $0.id == avatar } ?? 0 }

  var body: some View {
    let item = Self.carousel[index]
    let chosen = item.id == avatar
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text(item.name).eyebrow()
        if !chosen {
          Text("·").eyebrow().accessibilityHidden(true)
          Button(action: { onChoose(item.id) }) {
            Text("Use as my avatar").font(Theme.mono(10.5, .medium)).tracking(0.12 * 10.5).textCase(.uppercase).foregroundStyle(Theme.fg)
              .overlay(alignment: .bottom) { Rectangle().fill(Color.black.opacity(0.25)).frame(height: 1).offset(y: 4) } // underline-offset 3px
          }
          .buttonStyle(.plain)
        }
      }
      .frame(height: 11)
      ZStack {
        // The floor he stands on: a hairline, as on the website.
        VStack { Spacer(); Rectangle().fill(Theme.floor).frame(height: 1).padding(.horizontal, 40).padding(.bottom, HeroMetrics.floor) }
          .accessibilityHidden(true)
        if item.id == "qubit" {
          HeroWebView(bridge: bridge, voice: voice)
          // His button: a click pokes him and does what the label says.
          VStack {
            Spacer()
            Button(action: { bridge.poke(); onActivate() }) { Color.clear.frame(width: HeroMetrics.side * 1.3, height: HeroMetrics.side * 1.3).contentShape(Rectangle()) }
              .buttonStyle(.plain)
              .help(label)
              .accessibilityLabel(label)
              .padding(.bottom, HeroMetrics.floor - 4)
          }
        }
        HStack {
          arrow(left: true, disabled: index == 0) { step(-1) }
          Spacer()
          arrow(left: false, disabled: index >= Self.carousel.count - 1) { step(1) }
        }
      }
      .frame(height: HeroMetrics.stageHeight)
      .padding(.top, 4)
      HStack(spacing: 6) {
        ForEach(Array(Self.carousel.enumerated()), id: \.offset) { i, a in
          Button(action: { if i != index { onChoose(a.id) } }) {
            Capsule().fill(i == index ? Theme.fg : Color.black.opacity(0.2)).frame(width: i == index ? 16 : 6, height: 6)
          }
          .buttonStyle(.plain)
          .help(a.name)
          .accessibilityLabel(a.name)
          .accessibilityAddTraits(i == index ? .isSelected : [])
        }
      }
      .padding(.top, 12)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Your avatar")
  }

  private func step(_ dir: Int) {
    let next = max(0, min(Self.carousel.count - 1, index + dir))
    if next != index { onChoose(Self.carousel[next].id) }
  }

  private func arrow(left: Bool, disabled: Bool, action: @escaping () -> Void) -> some View {
    let label = left ? "Previous avatar" : "Next avatar"
    return IconButtonPlain(symbol: left ? "chevron.left" : "chevron.right", size: 15, frame: 32, disabled: disabled, action: action)
      .help(disabled ? "\(label) (only one for now)" : label)
      .accessibilityLabel(label)
  }
}

/** An icon-only button that can be disabled (the carousel's arrows). */
struct IconButtonPlain: View {
  var symbol: String
  var size: CGFloat
  var frame: CGFloat
  var disabled = false
  var action: () -> Void
  @State private var over = false
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: size, weight: .medium))
        .foregroundStyle(disabled ? Theme.disabled : (over ? Theme.fg : Theme.muted))
        .frame(width: frame, height: frame).contentShape(Circle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .onHover { over = $0 }
  }
}
