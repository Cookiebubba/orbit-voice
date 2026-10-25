// JSON text to OJSON with each object's keys in the order they were written (JSON.parse keeps them,
// and what Claude voice puts in its system prompt depends on it). RFC 8259, as JSON.parse reads it.
import Foundation
import OrbitKit

extension OJSON {
  public struct ParseError: Error {}

  public static func parse(_ text: String) throws -> OJSON {
    var p = Parser(Array(text.utf16))
    p.space()
    let v = try p.value()
    p.space()
    guard p.i == p.s.count else { throw ParseError() }
    return v
  }

  /** The same value as an unordered JSONValue. */
  public var value: JSONValue {
    switch self {
    case .str(let s): return .string(s)
    case .num(let n): return .number(n)
    case .bool(let b): return .bool(b)
    case .null: return .null
    case .arr(let a): return .array(a.map(\.value))
    case .obj(let o):
      var d: [String: JSONValue] = [:]
      for (k, v) in o { d[k] = v.value } // (a repeated key: the last one, as JSON.parse)
      return .object(d)
    }
  }

  /** A member of an object (the last one with this key), or nil. */
  public subscript(key: String) -> OJSON? {
    if case .obj(let o) = self { return o.last { $0.0 == key }?.1 }
    return nil
  }

  struct Parser {
    let s: [UInt16]
    var i = 0
    init(_ s: [UInt16]) { self.s = s }

    mutating func space() { while i < s.count, [0x20, 0x09, 0x0A, 0x0D].contains(s[i]) { i += 1 } }

    mutating func value() throws -> OJSON {
      guard i < s.count else { throw ParseError() }
      switch s[i] {
      case 0x7B: // {
        i += 1
        var o: [(String, OJSON)] = []
        space()
        if i < s.count, s[i] == 0x7D { i += 1; return .obj(o) }
        while true {
          space()
          guard i < s.count, s[i] == 0x22 else { throw ParseError() }
          let k = try string()
          space()
          guard i < s.count, s[i] == 0x3A else { throw ParseError() }
          i += 1
          space()
          let v = try value()
          // A repeated key keeps its first place with the last value (as a JS object does).
          if let at = o.firstIndex(where: { $0.0 == k }) { o[at].1 = v } else { o.append((k, v)) }
          space()
          guard i < s.count else { throw ParseError() }
          if s[i] == 0x2C { i += 1; continue }
          if s[i] == 0x7D { i += 1; return .obj(o) }
          throw ParseError()
        }
      case 0x5B: // [
        i += 1
        var a: [OJSON] = []
        space()
        if i < s.count, s[i] == 0x5D { i += 1; return .arr(a) }
        while true {
          space()
          a.append(try value())
          space()
          guard i < s.count else { throw ParseError() }
          if s[i] == 0x2C { i += 1; continue }
          if s[i] == 0x5D { i += 1; return .arr(a) }
          throw ParseError()
        }
      case 0x22: return .str(try string())
      case 0x74: try word("true"); return .bool(true)
      case 0x66: try word("false"); return .bool(false)
      case 0x6E: try word("null"); return .null
      default: return .num(try number())
      }
    }

    mutating func word(_ w: String) throws {
      let u = Array(w.utf16)
      guard i + u.count <= s.count, Array(s[i..<(i + u.count)]) == u else { throw ParseError() }
      i += u.count
    }

    mutating func number() throws -> Double {
      let start = i
      if i < s.count, s[i] == 0x2D { i += 1 }
      guard i < s.count, (0x30...0x39).contains(s[i]) else { throw ParseError() }
      if s[i] == 0x30 { i += 1 } else { while i < s.count, (0x30...0x39).contains(s[i]) { i += 1 } }
      if i < s.count, s[i] == 0x2E {
        i += 1
        guard i < s.count, (0x30...0x39).contains(s[i]) else { throw ParseError() }
        while i < s.count, (0x30...0x39).contains(s[i]) { i += 1 }
      }
      if i < s.count, s[i] == 0x65 || s[i] == 0x45 {
        i += 1
        if i < s.count, s[i] == 0x2B || s[i] == 0x2D { i += 1 }
        guard i < s.count, (0x30...0x39).contains(s[i]) else { throw ParseError() }
        while i < s.count, (0x30...0x39).contains(s[i]) { i += 1 }
      }
      return Double(String(utf16CodeUnits: Array(s[start..<i]), count: i - start)) ?? 0
    }

    mutating func string() throws -> String {
      i += 1 // "
      var out: [UInt16] = []
      while true {
        guard i < s.count else { throw ParseError() }
        let c = s[i]
        i += 1
        if c == 0x22 { break }
        if c < 0x20 { throw ParseError() }
        if c != 0x5C { out.append(c); continue }
        guard i < s.count else { throw ParseError() }
        let e = s[i]
        i += 1
        switch e {
        case 0x22: out.append(0x22)
        case 0x5C: out.append(0x5C)
        case 0x2F: out.append(0x2F)
        case 0x62: out.append(0x08)
        case 0x66: out.append(0x0C)
        case 0x6E: out.append(0x0A)
        case 0x72: out.append(0x0D)
        case 0x74: out.append(0x09)
        case 0x75:
          guard i + 4 <= s.count, let v = UInt16(String(utf16CodeUnits: Array(s[i..<(i + 4)]), count: 4), radix: 16) else { throw ParseError() }
          out.append(v)
          i += 4
        default: throw ParseError()
        }
      }
      return String(utf16CodeUnits: out, count: out.count)
    }
  }
}
