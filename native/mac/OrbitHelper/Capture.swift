// "Orbit anywhere": look at one window (the same answer as src/platform/win/capture.ps1). Captures
// just that window with ScreenCaptureKit (works while it's covered by other windows), saves it as a
// PNG (at most --max-width wide), and reads its text with Apple's on-device Vision OCR (nothing
// leaves this Mac). One JSON line on stdout:
//   {"ok":true,"path":"...png","w":..,"h":..,"lit":0.93,"ocr":"text...","lang":"en-US"}
//   {"ok":false,"error":"no_window|minimized|screen_denied|capture_failed","message":"..."}
// Needs Screen Recording permission (System Settings > Privacy & Security > Screen & System Audio Recording).

import AppKit
import ScreenCaptureKit
import Vision

enum Capture {
  static func run(_ flags: Flags) -> Never {
    let id = CGWindowID(flags.int("window"))
    let out = flags.str("out")
    let maxWidth = max(200, flags.int("max-width", 1600))
    let ocr = !flags.has("no-ocr")
    guard id > 0, !out.isEmpty else { finish(["ok": false, "error": "bad_request", "message": "--window and --out are needed."]) }
    guard let c = Wins.cg().first(where: { $0.id == id }) else { finish(["ok": false, "error": "no_window", "message": "That window is gone."]) }
    if let el = AX.window(id, pid: c.pid), AX.bool(el, kAXMinimizedAttribute) == true {
      finish(["ok": false, "error": "minimized", "message": "That window is minimized, so there's nothing to see."])
    }
    if !CGPreflightScreenCaptureAccess() {
      finish(["ok": false, "error": "screen_denied", "message": "Orbit needs Screen Recording permission to look at windows (System Settings > Privacy & Security > Screen & System Audio Recording)."])
    }
    guard let image = grab(id) else { finish(["ok": false, "error": "capture_failed", "message": "Orbit could not take a picture of that window."]) }
    // Downscale to maxWidth, write the PNG, and measure how much of it is lit.
    let scale = min(1.0, Double(maxWidth) / Double(image.width))
    let w = max(1, Int(Double(image.width) * scale)), h = max(1, Int(Double(image.height) * scale))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
      finish(["ok": false, "error": "capture_failed", "message": "Orbit could not take a picture of that window."])
    }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let small = ctx.makeImage() else { finish(["ok": false, "error": "capture_failed", "message": "Orbit could not take a picture of that window."]) }
    var lit = 0, n = 0
    if let data = ctx.data {
      let px = data.bindMemory(to: UInt8.self, capacity: w * h * 4)
      let step = max(1, (w * h) / 40000)
      var i = 0
      while i < w * h {
        let o = i * 4
        if Int(px[o]) + Int(px[o + 1]) + Int(px[o + 2]) > 24 { lit += 1 }
        n += 1
        i += step
      }
    }
    let rep = NSBitmapImageRep(cgImage: small)
    guard let png = rep.representation(using: .png, properties: [:]), (try? png.write(to: URL(fileURLWithPath: out))) != nil else {
      finish(["ok": false, "error": "capture_failed", "message": "Orbit could not save the picture."])
    }
    var res: [String: Any] = ["ok": true, "path": out, "w": w, "h": h, "lit": n == 0 ? 0 : (Double(lit) / Double(n) * 1000).rounded() / 1000, "ocr": "", "lang": ""]
    if ocr {
      let (text, lang) = recognize(image)
      res["ocr"] = cut(text, 20000)
      res["lang"] = lang
    }
    finish(res)
  }

  static func finish(_ obj: [String: Any]) -> Never {
    IO.emit(obj)
    exit(0)
  }

  /** The window's own pixels, full resolution. */
  static func grab(_ id: CGWindowID) -> CGImage? {
    if #available(macOS 14.0, *) {
      let sem = DispatchSemaphore(value: 0)
      var result: CGImage? = nil
      SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, _ in
        guard let win = content?.windows.first(where: { $0.windowID == id }) else { sem.signal(); return }
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let cfg = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        cfg.width = max(1, Int(filter.contentRect.width * scale))
        cfg.height = max(1, Int(filter.contentRect.height * scale))
        cfg.showsCursor = false
        cfg.ignoreShadowsSingleWindow = true
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { image, _ in
          result = image
          sem.signal()
        }
      }
      _ = sem.wait(timeout: .now() + 10)
      return result
    }
    return nil
  }

  /** On-device OCR: the text, top to bottom, and the language Vision used. */
  static func recognize(_ image: CGImage) -> (String, String) {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    let lang = Locale.preferredLanguages.first ?? "en-US"
    if let langs = try? req.supportedRecognitionLanguages(), langs.contains(lang) { req.recognitionLanguages = [lang] }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([req]) } catch { return ("", "") }
    let obs = (req.results ?? []).sorted { a, b in
      let ay = a.boundingBox.maxY, by = b.boundingBox.maxY
      if abs(ay - by) > 0.01 { return ay > by }
      return a.boundingBox.minX < b.boundingBox.minX
    }
    let lines = obs.compactMap { $0.topCandidates(1).first?.string }
    return (lines.joined(separator: "\n"), req.recognitionLanguages.first ?? lang)
  }
}
