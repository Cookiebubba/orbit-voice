// The host of a web address as `new URL(s).hostname` gives it (the WHATWG URL standard), for
// http: and https: only: what the core shows as a search source's site. Slashes after the scheme
// as the standard skips them, user info and port dropped, the host percent-decoded, lower-cased,
// IDNA (punycode) for non-ASCII names, IPv4 in any of its spellings made dotted, IPv6 compressed.
// nil where `new URL` would throw, or for any other scheme.
import Darwin
import Foundation

public enum WebURL {
  public static func httpHostname(_ input: String) -> String? {
    // Leading and trailing C0 controls and spaces go; tabs and newlines anywhere go.
    var s = Array(input.unicodeScalars)
    while let f = s.first, f.value <= 0x20 { s.removeFirst() }
    while let l = s.last, l.value <= 0x20 { s.removeLast() }
    s.removeAll { $0 == "\t" || $0 == "\n" || $0 == "\r" }
    // The scheme.
    guard let colon = s.firstIndex(of: ":"), colon > 0, isAlpha(s[0]) else { return nil }
    guard s[1..<colon].allSatisfy({ isAlpha($0) || ("0"..."9").contains($0) || $0 == "+" || $0 == "-" || $0 == "." }) else { return nil }
    let scheme = String(String.UnicodeScalarView(s[0..<colon])).lowercased()
    guard scheme == "http" || scheme == "https" else { return nil }
    // Any slashes (either way) before the authority, then the authority up to a path, query or fragment.
    var i = colon + 1
    while i < s.count, s[i] == "/" || s[i] == "\\" { i += 1 }
    var end = i
    while end < s.count, !["/", "\\", "?", "#"].contains(s[end]) { end += 1 }
    var authority = Array(s[i..<end])
    if let at = authority.lastIndex(of: "@") {
      authority = Array(authority[(at + 1)...])
      if authority.isEmpty { return nil }
    }
    // Host and port (a colon inside [...] is the address's own).
    var host = authority
    var inBrackets = false
    for (k, c) in authority.enumerated() {
      if c == "[" { inBrackets = true }
      if c == "]" { inBrackets = false }
      if c == ":" && !inBrackets {
        host = Array(authority[..<k])
        let port = authority[(k + 1)...]
        guard port.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
        if !port.isEmpty, (Int(String(String.UnicodeScalarView(port))) ?? Int.max) > 65535 { return nil }
        break
      }
    }
    guard !host.isEmpty else { return nil }
    return parseHost(String(String.UnicodeScalarView(host)))
  }

  static func isAlpha(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("A"..."Z").contains(c) }

  /** The host parser for a special URL: IPv6, else a domain (percent-decoded, IDNA) that may be IPv4. */
  static func parseHost(_ input: String) -> String? {
    if input.hasPrefix("[") {
      guard input.hasSuffix("]"), input.count >= 2 else { return nil }
      return ipv6(String(input.dropFirst().dropLast())).map { "[\($0)]" }
    }
    guard let decoded = percentDecode(input) else { return nil }
    guard let ascii = domainToASCII(decoded) else { return nil }
    let forbidden: Set<Unicode.Scalar> = ["\0", "\t", "\n", "\r", " ", "#", "/", ":", "<", ">", "?", "@", "[", "\\", "]", "^", "|", "%", "\u{7F}"]
    if ascii.unicodeScalars.contains(where: { forbidden.contains($0) || $0.value < 0x20 }) { return nil }
    if endsInNumber(ascii) { return ipv4(ascii) }
    return ascii
  }

  static func percentDecode(_ s: String) -> String? {
    var out: [UInt8] = []
    let b = Array(s.utf8)
    var i = 0
    while i < b.count {
      if b[i] == UInt8(ascii: "%"), i + 2 < b.count, b[(i + 1)...(i + 2)].allSatisfy({ Character(Unicode.Scalar($0)).isHexDigit }), let v = UInt8(String(decoding: b[(i + 1)...(i + 2)], as: UTF8.self), radix: 16) {
        out.append(v)
        i += 3
      } else {
        out.append(b[i])
        i += 1
      }
    }
    return String(decoding: out, as: UTF8.self) // (invalid UTF-8 becomes U+FFFD, as the standard has it)
  }

  /** UTS #46 ToASCII as URLs use it, for the names that come up: case folded, NFC, punycode labels. */
  static func domainToASCII(_ domain: String) -> String? {
    let mapped = domain.precomposedStringWithCanonicalMapping.lowercased()
    var labels: [String] = []
    for label in mapped.split(separator: ".", omittingEmptySubsequences: false) {
      let l = String(label)
      if l.unicodeScalars.allSatisfy(\.isASCII) {
        if l.hasPrefix("xn--") {
          guard let dec = Punycode.decode(String(l.dropFirst(4))), !dec.isEmpty, !dec.unicodeScalars.allSatisfy(\.isASCII) else { return nil }
        }
        labels.append(l)
      } else {
        guard let enc = Punycode.encode(l) else { return nil }
        labels.append("xn--" + enc)
      }
    }
    let out = labels.joined(separator: ".")
    return out.isEmpty ? nil : out
  }

  static func endsInNumber(_ s: String) -> Bool {
    var parts = s.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    if parts.last == "" {
      if parts.count == 1 { return false }
      parts.removeLast()
    }
    let last = parts.last ?? ""
    if !last.isEmpty && last.allSatisfy({ $0.isASCII && $0.isNumber }) { return true }
    let low = last.lowercased()
    return low.hasPrefix("0x") && low.dropFirst(2).allSatisfy { $0.isHexDigit && $0.isASCII }
  }

  static func ipv4Number(_ part: String) -> UInt64? {
    if part.isEmpty { return nil }
    var p = Substring(part)
    var radix = 10
    if p.count >= 2, p.lowercased().hasPrefix("0x") {
      p = p.dropFirst(2)
      radix = 16
    } else if p.count >= 2, p.hasPrefix("0") {
      p = p.dropFirst()
      radix = 8
    }
    if p.isEmpty { return 0 }
    return UInt64(p, radix: radix)
  }

  static func ipv4(_ s: String) -> String? {
    var parts = s.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    if parts.last == "", parts.count > 1 { parts.removeLast() }
    guard parts.count <= 4 else { return nil }
    var nums: [UInt64] = []
    for p in parts {
      guard let n = ipv4Number(p) else { return nil }
      nums.append(n)
    }
    for n in nums.dropLast() where n > 255 { return nil }
    let lastLimit = UInt64(1) << (8 * UInt64(5 - nums.count))
    guard let last = nums.last, last < lastLimit else { return nil }
    var ip = last
    for (k, n) in nums.dropLast().enumerated() { ip += n << (8 * UInt64(3 - k)) }
    return [24, 16, 8, 0].map { String((ip >> UInt64($0)) & 0xff) }.joined(separator: ".")
  }

  static func ipv6(_ s: String) -> String? {
    var addr = in6_addr()
    guard inet_pton(AF_INET6, s, &addr) == 1 else { return nil }
    let bytes = withUnsafeBytes(of: &addr) { Array($0) }
    let pieces = (0..<8).map { UInt16(bytes[2 * $0]) << 8 | UInt16(bytes[2 * $0 + 1]) }
    // The longest run of two or more zero pieces (the first of equals) becomes "::".
    var best = (start: -1, len: 0)
    var k = 0
    while k < 8 {
      if pieces[k] == 0 {
        var e = k
        while e < 8, pieces[e] == 0 { e += 1 }
        if e - k > best.len && e - k > 1 { best = (k, e - k) }
        k = e
      } else {
        k += 1
      }
    }
    var out = ""
    var i = 0
    while i < 8 {
      if i == best.start {
        out += i == 0 ? "::" : ":"
        i += best.len
        continue
      }
      out += String(pieces[i], radix: 16)
      if i < 7 { out += ":" }
      i += 1
    }
    return out
  }
}

/** RFC 3492 punycode for one label. */
enum Punycode {
  static let base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128

  static func adapt(_ delta: Int, _ numPoints: Int, _ first: Bool) -> Int {
    var d = first ? delta / damp : delta / 2
    d += d / numPoints
    var k = 0
    while d > ((base - tMin) * tMax) / 2 {
      d /= base - tMin
      k += base
    }
    return k + (base - tMin + 1) * d / (d + skew)
  }

  static func digit(_ d: Int) -> Character { Character(Unicode.Scalar(UInt8(d < 26 ? d + 97 : d + 22))) }

  static func encode(_ s: String) -> String? {
    let input = s.unicodeScalars.map { Int($0.value) }
    var out = String(String.UnicodeScalarView(s.unicodeScalars.filter(\.isASCII)))
    let b = out.count
    var h = b
    if b > 0 { out.append("-") }
    var n = initialN, delta = 0, bias = initialBias
    while h < input.count {
      guard let m = input.filter({ $0 >= n }).min() else { return nil }
      delta += (m - n) * (h + 1)
      n = m
      for c in input {
        if c < n { delta += 1 }
        if c == n {
          var q = delta
          var k = base
          while true {
            let t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias)
            if q < t { break }
            out.append(digit(t + (q - t) % (base - t)))
            q = (q - t) / (base - t)
            k += base
          }
          out.append(digit(q))
          bias = adapt(delta, h + 1, h == b)
          delta = 0
          h += 1
        }
      }
      delta += 1
      n += 1
    }
    return out
  }

  static func decode(_ s: String) -> String? {
    var output: [Int] = []
    let chars = Array(s.unicodeScalars)
    var start = 0
    if let dash = chars.lastIndex(of: "-") {
      output = chars[..<dash].map { Int($0.value) }
      guard output.allSatisfy({ $0 < 0x80 }) else { return nil }
      start = dash + 1
    }
    var n = initialN, i = 0, bias = initialBias
    var pos = start
    while pos < chars.count {
      let oldi = i
      var w = 1
      var k = base
      while true {
        guard pos < chars.count else { return nil }
        let c = chars[pos].value
        pos += 1
        let d: Int
        switch c {
        case 0x30...0x39: d = Int(c) - 22
        case 0x41...0x5A: d = Int(c) - 65
        case 0x61...0x7A: d = Int(c) - 97
        default: return nil
        }
        i += d * w
        let t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias)
        if d < t { break }
        w *= base - t
        k += base
        if w > 1 << 40 { return nil }
      }
      bias = adapt(i - oldi, output.count + 1, oldi == 0)
      n += i / (output.count + 1)
      i %= output.count + 1
      guard n < 0x110000 else { return nil }
      output.insert(n, at: i)
      i += 1
    }
    var str = ""
    for v in output {
      guard let u = Unicode.Scalar(v) else { return nil }
      str.unicodeScalars.append(u)
    }
    return str
  }
}
