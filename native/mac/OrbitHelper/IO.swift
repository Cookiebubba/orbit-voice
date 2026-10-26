// Line-based JSON in and out, shared by every mode. One JSON object per line on stdout (never
// interleaved: one lock), requests read on a background thread and handled on the main thread (the
// accessibility API and NSWorkspace both want the main run loop).

import Foundation

enum IO {
  private static let lock = NSLock()
  private static let out = FileHandle.standardOutput

  /** One JSON line on stdout. Non-ASCII is fine: Node reads UTF-8. */
  static func emit(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          var data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else {
      return
    }
    data.append(0x0A)
    lock.lock()
    defer { lock.unlock() }
    out.write(data)
  }

  /** A plain line (the focus protocol's answers are built as objects too; this is for tests). */
  static func emitRaw(_ line: String) {
    lock.lock()
    defer { lock.unlock() }
    out.write((line + "\n").data(using: .utf8)!)
  }

  /**
   * Read stdin line by line on a background thread; each line goes to `handle` on the main queue.
   * When stdin closes (Orbit quit or crashed) the process exits.
   */
  static func readLines(_ handle: @escaping (String) -> Void) {
    let t = Thread {
      while let line = readLine(strippingNewline: true) {
        let l = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if l.isEmpty { continue }
        DispatchQueue.main.async { handle(l) }
      }
      DispatchQueue.main.async { exit(0) }
    }
    t.stackSize = 1 << 20
    t.start()
  }

  /** Exit once the parent process (Orbit) is gone, checked every two seconds. */
  static func watchParent(_ pid: Int32) {
    guard pid > 0 else { return }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler {
      if kill(pid, 0) != 0 && errno == ESRCH { exit(0) }
      if getppid() == 1 { exit(0) } // re-parented to launchd: Orbit is gone
    }
    timer.resume()
    keep.append(timer)
  }
  static var keep: [AnyObject] = []

  static func parseJSON(_ line: String) -> [String: Any]? {
    guard let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
    return obj as? [String: Any]
  }
}

// Small typed readers for request dictionaries.
extension Dictionary where Key == String, Value == Any {
  func str(_ k: String, _ def: String = "") -> String {
    if let s = self[k] as? String { return s }
    if let n = self[k] as? NSNumber { return n.stringValue }
    return def
  }
  func int(_ k: String, _ def: Int = 0) -> Int {
    if let n = self[k] as? NSNumber { return n.intValue }
    if let s = self[k] as? String, let n = Int(s) { return n }
    return def
  }
  func bool(_ k: String) -> Bool {
    if let b = self[k] as? Bool { return b }
    if let n = self[k] as? NSNumber { return n.boolValue }
    return false
  }
}

/** Command-line flags: --name value, or --flag. */
struct Flags {
  var values: [String: String] = [:]
  var switches: Set<String> = []
  init(_ args: [String]) {
    var i = 0
    while i < args.count {
      let a = args[i]
      if a.hasPrefix("--") {
        let k = String(a.dropFirst(2))
        if i + 1 < args.count, !args[i + 1].hasPrefix("--") {
          values[k] = args[i + 1]
          i += 2
          continue
        }
        switches.insert(k)
      }
      i += 1
    }
  }
  func int(_ k: String, _ def: Int = 0) -> Int { values[k].flatMap { Int($0) } ?? def }
  func str(_ k: String, _ def: String = "") -> String { values[k] ?? def }
  func has(_ k: String) -> Bool { switches.contains(k) || values[k] != nil }
}

func cut(_ s: String, _ max: Int) -> String { s.count <= max ? s : String(s.prefix(max)) }
func ms(since t: DispatchTime) -> Int { Int((DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1_000_000) }
