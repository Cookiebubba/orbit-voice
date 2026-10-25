// The parity suite's matchers in Swift: the same rules as parity/lib/match.mjs (see
// parity/PROTOCOL.md "Matchers"); parity/test/match-cases.json keeps the two in step.
import Foundation

public enum ParityMatch {
  /** Replaces "${name}" (a whole string: the saved value itself) and "…${a.b}…" (its text). */
  public static func interpolate(_ x: JSONValue, _ vars: JSONValue) -> JSONValue {
    switch x {
    case .string(let s):
      if s.hasPrefix("${"), s.hasSuffix("}"), s.dropFirst(2).dropLast().allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }) {
        return vars.at(path: String(s.dropFirst(2).dropLast())) ?? .null
      }
      guard s.contains("${") else { return x }
      var out = ""
      var rest = Substring(s)
      while let r = rest.range(of: "${") {
        out += rest[rest.startIndex..<r.lowerBound]
        guard let end = rest[r.upperBound...].firstIndex(of: "}") else { out += rest[r.lowerBound...]; rest = ""; break }
        let key = String(rest[r.upperBound..<end])
        if let v = vars.at(path: key) { out += v.stringValue ?? v.text }
        rest = rest[rest.index(after: end)...]
      }
      return .string(out + rest)
    case .array(let a): return .array(a.map { interpolate($0, vars) })
    case .object(let o): return .object(o.mapValues { interpolate($0, vars) })
    default: return x
    }
  }

  /** nil when `actual` matches `expected`, else a short reason. A missing value is passed as nil. */
  public static func match(_ actual: JSONValue?, _ expected: JSONValue, vars: JSONValue = .object([:]), at where_: String = "") -> String? {
    value(actual, interpolate(expected, vars), where_)
  }

  static func isOp(_ e: JSONValue) -> Bool {
    guard case .object(let o) = e, !o.isEmpty else { return false }
    return o.keys.allSatisfy { $0.hasPrefix("$") }
  }

  static func typeOf(_ v: JSONValue?) -> String {
    switch v {
    case nil: return "undefined"
    case .null?: return "null"
    case .array?: return "array"
    case .object?: return "object"
    case .string?: return "string"
    case .bool?: return "boolean"
    case .number(let n)?: return n.rounded() == n && abs(n) < 9e15 ? "integer" : "number"
    }
  }

  static func show(_ v: JSONValue?) -> String {
    guard let v else { return "undefined" }
    let s = v.text
    return s.count > 160 ? String(s.prefix(157)) + "..." : s
  }

  static func value(_ a: JSONValue?, _ exp: JSONValue, _ w: String) -> String? {
    if isOp(exp) { return ops(a, exp.objectValue!, w) }
    if case .object(let o) = exp {
      guard let a, case .object = a else {
        let allAbsent = o.values.allSatisfy { isOp($0) && $0["$absent"] == .bool(true) }
        if allAbsent { return nil } // (an empty object matches anything, as in match.mjs)
        return "\(w.isEmpty ? "(value)" : w): expected an object, got \(show(a))"
      }
      for (path, e) in o.sorted(by: { $0.key < $1.key }) {
        if let r = value(a.at(path: path), e, w.isEmpty ? path : "\(w).\(path)") { return r }
      }
      return nil
    }
    return a == exp ? nil : "\(w.isEmpty ? "(value)" : w): expected \(show(exp)), got \(show(a))"
  }

  static func isRect(_ v: JSONValue?) -> Bool { ["x", "y", "w", "h"].allSatisfy { v?[$0]?.doubleValue != nil } }

  static func ops(_ a: JSONValue?, _ o: [String: JSONValue], _ where_: String) -> String? {
    let w = where_.isEmpty ? "(value)" : where_
    let n = a?.doubleValue
    for (op, arg) in o.sorted(by: { $0.key < $1.key }) {
      switch op {
      case "$type":
        let t = typeOf(a)
        let want = arg.stringValue ?? ""
        if !(t == want || (want == "number" && t == "integer")) { return "\(w): expected a \(want), got \(show(a))" }
      case "$gt": if !(n != nil && arg.doubleValue != nil && n! > arg.doubleValue!) { return "\(w): expected > \(show(arg)), got \(show(a))" }
      case "$gte": if !(n != nil && arg.doubleValue != nil && n! >= arg.doubleValue!) { return "\(w): expected >= \(show(arg)), got \(show(a))" }
      case "$lt": if !(n != nil && arg.doubleValue != nil && n! < arg.doubleValue!) { return "\(w): expected < \(show(arg)), got \(show(a))" }
      case "$lte": if !(n != nil && arg.doubleValue != nil && n! <= arg.doubleValue!) { return "\(w): expected <= \(show(arg)), got \(show(a))" }
      case "$near":
        let tol = o["$tol"]?.doubleValue ?? 0.5
        if !(n != nil && arg.doubleValue != nil && abs(n! - arg.doubleValue!) <= tol) { return "\(w): expected \(show(arg)) ± \(tol), got \(show(a))" }
      case "$tol", "$slack": break
      case "$in":
        if !(arg.arrayValue ?? []).contains(where: { $0 == a }) { return "\(w): expected one of \(show(arg)), got \(show(a))" }
      case "$match":
        guard let s = a?.stringValue, let re = try? NSRegularExpression(pattern: arg.stringValue ?? ""), re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil else { return "\(w): expected to match /\(arg.stringValue ?? "")/, got \(show(a))" }
      case "$contains":
        if let s = a?.stringValue {
          if !(arg.stringValue.map { s.contains($0) } ?? false) { return "\(w): expected to contain \(show(arg)), got \(show(a))" }
        } else if let arr = a?.arrayValue {
          let partial: Bool = { if case .object = arg { return true }; return false }()
          if !arr.contains(where: { $0 == arg || (partial && value($0, arg, "") == nil) }) { return "\(w): expected to contain \(show(arg)), got \(show(a))" }
        } else { return "\(w): expected to contain \(show(arg)), got \(show(a))" }
      case "$len":
        let len: Int? = a?.stringValue?.count ?? a?.arrayValue?.count ?? a?.objectValue?.count
        guard let len else { return "\(w): expected something with a length, got \(show(a))" }
        if case .number(let want) = arg { if Double(len) != want { return "\(w): expected length \(Int(want)), got \(len)" } }
        else if let r = value(.number(Double(len)), arg, "\(w).length") { return r }
      case "$every":
        guard let arr = a?.arrayValue else { return "\(w): expected an array, got \(show(a))" }
        for (i, x) in arr.enumerated() { if let r = value(x, arg, "\(w).\(i)") { return r } }
      case "$some":
        guard let arr = a?.arrayValue, arr.contains(where: { value($0, arg, "") == nil }) else { return "\(w): expected some element to match \(show(arg)), got \(show(a))" }
      case "$count":
        guard let arr = a?.arrayValue else { return "\(w): expected an array, got \(show(a))" }
        let c = arr.filter { value($0, arg["where"] ?? .object([:]), "") == nil }.count
        if case .number(let want)? = arg["is"] { if Double(c) != want { return "\(w): expected \(Int(want)) matching, got \(c)" } }
        else if let r = value(.number(Double(c)), arg["is"] ?? .null, "\(w).count") { return r }
      case "$inside":
        guard isRect(a) else { return "\(w): expected a rect, got \(show(a))" }
        guard isRect(arg) else { return "\(w): $inside needs a rect, got \(show(arg))" }
        let s = o["$slack"]?.doubleValue ?? 1
        let (x, y, ww, h) = (a!["x"]!.doubleValue!, a!["y"]!.doubleValue!, a!["w"]!.doubleValue!, a!["h"]!.doubleValue!)
        let (X, Y, W, H) = (arg["x"]!.doubleValue!, arg["y"]!.doubleValue!, arg["w"]!.doubleValue!, arg["h"]!.doubleValue!)
        if !(x >= X - s && y >= Y - s && x + ww <= X + W + s && y + h <= Y + H + s) { return "\(w): \(show(a)) is not inside \(show(arg))" }
      case "$not":
        if value(a, arg, w) == nil { return "\(w): expected not \(show(arg)), got \(show(a))" }
      case "$absent":
        let missing = a == nil || a == .null
        if arg == .bool(true) ? !missing : a == nil { return "\(w): expected \(arg == .bool(true) ? "absent" : "present"), got \(show(a))" }
      case "$eq":
        if a != arg { return "\(w): expected \(show(arg)), got \(show(a))" }
      default:
        return "\(w): unknown matcher \(op)"
      }
    }
    return nil
  }
}
