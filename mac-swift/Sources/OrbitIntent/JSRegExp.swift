// JavaScript regular expressions, run by ICU (NSRegularExpression) with JavaScript's meaning, so the
// core's patterns are ported as they are written. The differences that matter, translated:
//   \w \d \s \b \B   ASCII words and digits, and JavaScript's own whitespace (ICU's are Unicode's)
//   .                anything but \n \r \u2028 \u2029 (ICU also stops at \v \f \u0085)
//   $                the end of the input only, without the m flag (ICU also matches before a final \n)
//   [ inside a class a literal "[" (ICU would start a nested set); "&" escaped (ICU's intersection)
//   {                a literal brace where it isn't a quantifier (JavaScript allows that)
//   \u{...}          a code point (with the u flag)
// And the String methods' rules: replace templates ($1, $&, $`, $', $<name>, $$), split (captures
// included), matches at UTF-16 offsets as JavaScript counts them.
import Foundation

public struct JSMatch: Sendable {
  /** UTF-16 offset of the match in the input. */
  public let index: Int
  public let length: Int
  /** [0] is the whole match; nil where a group didn't take part (JavaScript's undefined). */
  public let groups: [String?]
  public let named: [String: String?]
  public var text: String { groups[0] ?? "" }
  public subscript(i: Int) -> String? { i < groups.count ? groups[i] : nil }
}

public struct JSRegExp: @unchecked Sendable {
  public let source: String
  public let global: Bool
  public let ignoreCase: Bool
  public let multiline: Bool
  public let dotAll: Bool
  public let unicode: Bool
  let regex: NSRegularExpression
  let groupNames: [String]

  /** JavaScript's whitespace (\s), for a character class. */
  public static let ws = #"\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"#
  static let word = "A-Za-z0-9_"

  public init(_ source: String, _ flags: String = "") {
    self.source = source
    global = flags.contains("g")
    ignoreCase = flags.contains("i")
    multiline = flags.contains("m")
    dotAll = flags.contains("s")
    unicode = flags.contains("u")
    var opts: NSRegularExpression.Options = []
    if ignoreCase { opts.insert(.caseInsensitive) }
    if multiline { opts.insert(.anchorsMatchLines) }
    // (An empty pattern matches the empty string, as new RegExp('') does; ICU won't compile "".)
    let translated = source.isEmpty ? "(?:)" : Self.translate(source, multiline: multiline, dotAll: dotAll, unicode: unicode)
    do {
      regex = try NSRegularExpression(pattern: translated, options: opts)
    } catch {
      preconditionFailure("JSRegExp: /\(source)/\(flags) does not translate (\(translated)): \(error)")
    }
    groupNames = Self.names(in: source)
  }

  static func names(in source: String) -> [String] {
    var out: [String] = []
    let s = Array(source.unicodeScalars)
    var i = 0
    while i < s.count {
      if s[i] == "\\" { i += 2; continue }
      if s[i] == "(", i + 2 < s.count, s[i + 1] == "?", s[i + 2] == "<", i + 3 < s.count, s[i + 3] != "=", s[i + 3] != "!" {
        var j = i + 3
        var name = ""
        while j < s.count, s[j] != ">" { name.unicodeScalars.append(s[j]); j += 1 }
        out.append(name)
      }
      i += 1
    }
    return out
  }

  /** The pattern in ICU's terms, meaning what it means in JavaScript. */
  public static func translate(_ src: String, multiline: Bool, dotAll: Bool, unicode: Bool) -> String {
    let s = Array(src.unicodeScalars)
    var out = ""
    var inClass = false
    var i = 0
    let notWord = "[^\(word)]"
    let boundary = "(?:(?<=[\(word)])(?![\(word)])|(?<![\(word)])(?=[\(word)]))"
    let notBoundary = "(?:(?<=[\(word)])(?=[\(word)])|(?<![\(word)])(?![\(word)]))"
    func hex(_ from: Int, _ count: Int) -> String? {
      guard from + count <= s.count else { return nil }
      let h = String(String.UnicodeScalarView(s[from..<(from + count)]))
      return h.allSatisfy(\.isHexDigit) ? h : nil
    }
    while i < s.count {
      let c = s[i]
      if c == "\\" {
        guard i + 1 < s.count else { out += "\\\\"; i += 1; continue }
        let n = s[i + 1]
        switch n {
        case "d": out += inClass ? "0-9" : "[0-9]"
        case "D": out += inClass ? "[^0-9]" : "[^0-9]"
        case "w": out += inClass ? word : "[\(word)]"
        case "W": out += notWord
        case "s": out += inClass ? ws : "[\(ws)]"
        case "S": out += "[^\(ws)]"
        case "b": out += inClass ? "\\x08" : boundary
        case "B": out += inClass ? "B" : notBoundary
        case "u":
          if unicode, i + 2 < s.count, s[i + 2] == "{", let close = s[(i + 3)...].firstIndex(of: "}") {
            let h = String(String.UnicodeScalarView(s[(i + 3)..<close]))
            out += "\\x{\(h)}"
            i = close + 1
            continue
          }
          if let h = hex(i + 2, 4) {
            out += "\\u\(h)"
            i += 6
            continue
          }
          out += "u"
        case "x":
          if let h = hex(i + 2, 2) {
            out += "\\x\(h)"
            i += 4
            continue
          }
          out += "x"
        case "/": out += "/"
        case "p", "P":
          // \p{L}, \P{Lu}: the whole property as it is (its braces aren't literals).
          if i + 2 < s.count, s[i + 2] == "{", let close = s[(i + 3)...].firstIndex(of: "}") {
            out += "\\" + String(n) + String(String.UnicodeScalarView(s[(i + 2)...close]))
            i = close + 1
            continue
          }
          out += "\\" + String(n)
        default:
          out += "\\" + String(n)
        }
        i += 2
        continue
      }
      if inClass {
        if c == "]" {
          inClass = false
          out += "]"
        } else if c == "[" || c == "&" || c == "~" || c == "{" || c == "}" {
          out += "\\" + String(c)
        } else {
          out.unicodeScalars.append(c)
        }
        i += 1
        continue
      }
      switch c {
      case "[":
        // [^] is anything at all; [] is nothing.
        if i + 2 < s.count, s[i + 1] == "^", s[i + 2] == "]" {
          out += "[\\s\\S]"
          i += 3
          continue
        }
        if i + 1 < s.count, s[i + 1] == "]" {
          out += "(?!)"
          i += 2
          continue
        }
        inClass = true
        out += "["
        if i + 1 < s.count, s[i + 1] == "^" {
          out += "^"
          i += 1
        }
      case "$":
        out += multiline ? "$" : "\\z"
      case ".":
        out += dotAll ? "[\\s\\S]" : "[^\\n\\r\\u2028\\u2029]"
      case "{":
        // A quantifier ({2}, {1,}, {0,20}) stays; anything else is a literal brace.
        var j = i + 1
        var body = ""
        while j < s.count, s[j] != "}", body.count < 12 { body.unicodeScalars.append(s[j]); j += 1 }
        if j < s.count, s[j] == "}", body.range(of: #"^[0-9]+(,[0-9]*)?$"#, options: .regularExpression) != nil {
          out += "{" + body + "}"
          i = j + 1
          continue
        }
        out += "\\{"
      case "}":
        out += "\\}"
      default:
        out.unicodeScalars.append(c)
      }
      i += 1
    }
    return out
  }

  // MARK: matching

  func match(_ m: NSTextCheckingResult, in ns: NSString) -> JSMatch {
    var groups: [String?] = []
    for g in 0..<m.numberOfRanges {
      let r = m.range(at: g)
      groups.append(r.location == NSNotFound ? nil : ns.substring(with: r))
    }
    var named: [String: String?] = [:]
    for name in groupNames {
      let r = m.range(withName: name)
      named[name] = r.location == NSNotFound ? .some(nil) : ns.substring(with: r)
    }
    return JSMatch(index: m.range.location, length: m.range.length, groups: groups, named: named)
  }

  /** RegExp.prototype.test, statelessly (as for a regex without the g flag). */
  public func test(_ s: String) -> Bool {
    regex.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
  }

  /** The first match (String.prototype.match without g), or nil. */
  public func firstMatch(_ s: String, from: Int = 0) -> JSMatch? {
    let ns = s as NSString
    guard from <= ns.length, let m = regex.firstMatch(in: s, range: NSRange(location: from, length: ns.length - from)) else { return nil }
    return match(m, in: ns)
  }

  /** Every match (String.prototype.matchAll), empty matches stepping on as JavaScript does. */
  public func allMatches(_ s: String) -> [JSMatch] {
    let ns = s as NSString
    return regex.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { match($0, in: ns) }
  }

  /** String.prototype.match with g: the matched texts, or nil if none. */
  public func matchTexts(_ s: String) -> [String]? {
    let all = allMatches(s).map(\.text)
    return all.isEmpty ? nil : all
  }

  /** String.prototype.replace / replaceAll with a JavaScript replacement template. */
  public func replace(_ s: String, _ template: String) -> String {
    replace(s) { m in Self.expand(template, m, input: s) }
  }

  /** String.prototype.replace with a function: (match) -> replacement. All matches with g, else the first. */
  public func replace(_ s: String, _ fn: (JSMatch) -> String) -> String {
    let ns = s as NSString
    let list: [JSMatch] = global ? allMatches(s) : (firstMatch(s).map { [$0] } ?? [])
    guard !list.isEmpty else { return s }
    var out = ""
    var at = 0
    for m in list {
      out += ns.substring(with: NSRange(location: at, length: m.index - at))
      out += fn(m)
      at = m.index + m.length
    }
    out += ns.substring(from: at)
    return out
  }

  /** GetSubstitution: $$, $&, $`, $', $n / $nn, $<name>. */
  static func expand(_ t: String, _ m: JSMatch, input: String) -> String {
    let ns = input as NSString
    let s = Array(t.utf16)
    var out: [UInt16] = []
    var i = 0
    let captures = m.groups.count - 1
    func put(_ str: String?) { out.append(contentsOf: Array((str ?? "").utf16)) }
    while i < s.count {
      guard s[i] == 36, i + 1 < s.count else { out.append(s[i]); i += 1; continue } // "$"
      let n = s[i + 1]
      switch n {
      case 36: out.append(36); i += 2
      case 38: put(m.text); i += 2 // $&
      case 96: put(ns.substring(to: m.index)); i += 2 // $`
      case 39: put(ns.substring(from: m.index + m.length)); i += 2 // $'
      case 48...57:
        let d1 = Int(n - 48)
        if i + 2 < s.count, (48...57).contains(s[i + 2]), d1 * 10 + Int(s[i + 2] - 48) <= captures, d1 * 10 + Int(s[i + 2] - 48) >= 1 {
          put(m[d1 * 10 + Int(s[i + 2] - 48)])
          i += 3
        } else if d1 >= 1, d1 <= captures {
          put(m[d1])
          i += 2
        } else {
          out.append(36)
          i += 1
        }
      case 60 where !m.named.isEmpty: // $<name>
        if let close = s[(i + 2)...].firstIndex(of: 62) {
          let name = String(utf16CodeUnits: Array(s[(i + 2)..<close]), count: close - i - 2)
          put(m.named[name] ?? nil)
          i = close + 1
        } else {
          out.append(36)
          i += 1
        }
      default:
        out.append(36)
        i += 1
      }
    }
    return String(utf16CodeUnits: out, count: out.count)
  }

  /** String.prototype.split(regex): captures included, empty matches handled as JavaScript does. */
  public func split(_ s: String) -> [String] {
    let ns = s as NSString
    let size = ns.length
    if size == 0 {
      return regex.firstMatch(in: s, options: [.anchored], range: NSRange(location: 0, length: 0)) != nil ? [] : [s]
    }
    var out: [String] = []
    var p = 0
    var q = 0
    while q < size {
      guard let m = regex.firstMatch(in: s, options: [.anchored], range: NSRange(location: q, length: size - q)) else {
        q += 1
        continue
      }
      let e = min(m.range.location + m.range.length, size)
      if e == p {
        q += 1
        continue
      }
      out.append(ns.substring(with: NSRange(location: p, length: q - p)))
      for g in 1..<max(1, m.numberOfRanges) {
        let r = m.range(at: g)
        // (undefined in JavaScript; the callers here never split with optional groups)
        out.append(r.location == NSNotFound ? "" : ns.substring(with: r))
      }
      p = e
      q = p
    }
    out.append(ns.substring(from: p))
    return out
  }
}

/** JavaScript's String methods, where Swift's differ. */
public enum JS {
  static let wsSet: CharacterSet = {
    var c = CharacterSet(charactersIn: "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    c.insert(charactersIn: "\u{2000}"..."\u{200A}")
    return c
  }()

  /** String.prototype.trim (JavaScript's whitespace and line terminators). */
  public static func trim(_ s: String) -> String {
    let u = Array(s.unicodeScalars)
    var a = 0
    var b = u.count
    while a < b, wsSet.contains(u[a]) { a += 1 }
    while b > a, wsSet.contains(u[b - 1]) { b -= 1 }
    return String(String.UnicodeScalarView(u[a..<b]))
  }

  /** The length JavaScript sees (UTF-16 code units). */
  public static func length(_ s: String) -> Int { s.utf16.count }

  /** String.prototype.slice(from, to) on UTF-16 offsets (negative from the end). */
  public static func slice(_ s: String, _ from: Int, _ to: Int? = nil) -> String {
    let u = Array(s.utf16)
    let n = u.count
    var a = from < 0 ? max(0, n + from) : min(from, n)
    var b = to.map { $0 < 0 ? max(0, n + $0) : min($0, n) } ?? n
    if b < a { b = a }
    a = min(a, n)
    return String(utf16CodeUnits: Array(u[a..<b]), count: b - a)
  }

  /** toLowerCase (Unicode default case mapping, no locale). */
  public static func lower(_ s: String) -> String { s.lowercased() }

  /** normalize('NFKC'). */
  public static func nfkc(_ s: String) -> String { s.precomposedStringWithCompatibilityMapping }
}
