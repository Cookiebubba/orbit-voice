// A JSON value of any shape, for the bridge's free-form events, the parity driver and its cases.
import Foundation

public enum JSONValue: Codable, Equatable, Sendable, CustomStringConvertible {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
    else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "not JSON") }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n): try c.encode(n)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  // MARK: conversions

  /** From Foundation's JSONSerialization output (NSNumber booleans are told apart from numbers). */
  public init(any: Any?) {
    switch any {
    case nil, is NSNull: self = .null
    case let n as NSNumber:
      if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
    case let s as String: self = .string(s)
    case let a as [Any]: self = .array(a.map { JSONValue(any: $0) })
    case let o as [String: Any]: self = .object(o.mapValues { JSONValue(any: $0) })
    case let b as Bool: self = .bool(b)
    case let i as Int: self = .number(Double(i))
    case let d as Double: self = .number(d)
    default: self = .string(String(describing: any!))
    }
  }

  public var any: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let b): return b
    case .number(let n): return n
    case .string(let s): return s
    case .array(let a): return a.map { $0.any }
    case .object(let o): return o.mapValues { $0.any }
    }
  }

  public static func parse(_ data: Data) throws -> JSONValue {
    JSONValue(any: try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
  }

  public static func parse(_ text: String) throws -> JSONValue { try parse(Data(text.utf8)) }

  public func data(pretty: Bool = false) -> Data {
    (try? JSONSerialization.data(withJSONObject: any, options: pretty ? [.fragmentsAllowed, .prettyPrinted, .sortedKeys] : [.fragmentsAllowed, .sortedKeys])) ?? Data("null".utf8)
  }

  public var text: String { String(decoding: data(), as: UTF8.self) }
  public var description: String { text }

  // MARK: access

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  public subscript(index: Int) -> JSONValue? {
    if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
    return nil
  }

  /** A dotted path: "avatars.0.frame.w". */
  public func at(path: String) -> JSONValue? {
    if path.isEmpty { return self }
    var cur: JSONValue? = self
    for part in path.split(separator: ".", omittingEmptySubsequences: false).map(String.init) {
      guard let c = cur else { return nil }
      if case .array = c, let i = Int(part) { cur = c[i] } else { cur = c[part] }
    }
    return cur
  }

  public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
  public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
  public var intValue: Int? { doubleValue.map { Int($0) } }
  public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
  public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
  public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
  public var isNull: Bool { if case .null = self { return true }; return false }

  /** Any Encodable value as JSON. */
  public static func from<T: Encodable>(_ value: T) -> JSONValue {
    guard let d = try? JSONEncoder().encode(value), let v = try? JSONValue.parse(d) else { return .null }
    return v
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByFloatLiteral, ExpressibleByIntegerLiteral, ExpressibleByNilLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
  public init(stringLiteral v: String) { self = .string(v) }
  public init(booleanLiteral v: Bool) { self = .bool(v) }
  public init(floatLiteral v: Double) { self = .number(v) }
  public init(integerLiteral v: Int) { self = .number(Double(v)) }
  public init(nilLiteral: ()) { self = .null }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(uniqueKeysWithValues: elements)) }
}
