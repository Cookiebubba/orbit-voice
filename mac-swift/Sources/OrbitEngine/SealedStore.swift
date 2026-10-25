// Keys at rest: the xAI key, the optional Anthropic key (and later connector and keeper tokens),
// sealed with AES-256-GCM under the key Orbit keeps in the login Keychain (SealKey). The file format is
// the sidecar's (mac-swift/sidecar/sidecar.mjs makeSealer): "ONS1", a 12-byte nonce, the 16-byte tag,
// then the ciphertext; so both sides read what the other wrote.
import CryptoKit
import Foundation

public struct Sealer: Sendable {
  public static let magic = Data("ONS1".utf8)
  private let key: SymmetricKey

  public init(key: Data) throws {
    guard key.count == 32 else { throw SealError.badKey }
    self.key = SymmetricKey(data: key)
  }

  public enum SealError: Error, Equatable { case badKey, notSealed }

  public func seal(_ text: String) throws -> Data {
    let box = try AES.GCM.seal(Data(text.utf8), using: key)
    return Self.magic + Data(box.nonce) + box.tag + box.ciphertext
  }

  public func open(_ data: Data) throws -> String {
    let d = Data(data)
    guard d.count >= 32, d.prefix(4) == Self.magic else { throw SealError.notSealed }
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: d[4..<16]), ciphertext: d[32...], tag: d[16..<32])
    return String(decoding: try AES.GCM.open(box, using: key), as: UTF8.self)
  }
}

/** One secret in one sealed file (sidecar.mjs sealedKeyStore): "" when missing or unreadable. */
public final class SealedKeyStore: @unchecked Sendable {
  /** What GET /api/config reports as keyStorage: the sealing key lives in the login Keychain. */
  public let kind = "macos-keychain"
  private let sealer: Sealer
  public let file: URL

  public init(sealer: Sealer, file: URL) {
    self.sealer = sealer
    self.file = file
  }

  public func get() -> String {
    guard let data = try? Data(contentsOf: file) else { return "" }
    return (try? sealer.open(data)) ?? ""
  }

  /** Saves it (owner-only), or removes the file for "". */
  public func set(_ value: String) throws {
    if value.isEmpty {
      try? FileManager.default.removeItem(at: file)
      return
    }
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try sealer.seal(value)
    // Created owner-only before anything is written to it.
    FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    try data.write(to: file)
  }
}
