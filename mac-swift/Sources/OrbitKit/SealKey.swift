// The key that seals Orbit's secrets on disk (the sidecar's AES-GCM key): 32 random bytes kept in
// the login Keychain as a generic password, like Electron's "Orbit Safe Storage". A test build with a
// throwaway profile keeps it in that profile instead, so tests never touch the Keychain.
import Foundation
import Security

public enum SealKey {
  public static let service = "Orbit Native Safe Storage"
  public static let account = "Orbit Native"

  public enum Failure: Error, Equatable { case keychain(OSStatus), random }

  /** The key from the Keychain, made (and stored) on first use. */
  public static func fromKeychain() throws -> Data {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    if st == errSecSuccess, let d = out as? Data, d.count == 32 { return d }
    if st != errSecItemNotFound && st != errSecSuccess { throw Failure.keychain(st) }
    let key = try random()
    let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecValueData as String: key, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let a = SecItemAdd(add as CFDictionary, nil)
    if a == errSecDuplicateItem {
      SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
      let again = SecItemAdd(add as CFDictionary, nil)
      guard again == errSecSuccess else { throw Failure.keychain(again) }
    } else if a != errSecSuccess { throw Failure.keychain(a) }
    return key
  }

  /** A test profile's key: a file in that profile (owner-only), made on first use. */
  public static func fromProfile(_ dir: URL) throws -> Data {
    let f = dir.appendingPathComponent("test-seal.key")
    if let d = try? Data(contentsOf: f), d.count == 32 { return d }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let key = try random()
    try key.write(to: f, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: f.path)
    return key
  }

  public static func random() throws -> Data {
    var d = Data(count: 32)
    let st = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    guard st == errSecSuccess else { throw Failure.random }
    return d
  }
}
