// One Orbit Native per profile: an exclusive lock on a file in the profile folder (released by the
// OS if the app dies). A second launch tells the first to show itself, then quits.
import Foundation

public final class SingleInstance: @unchecked Sendable {
  public static let showNotification = Notification.Name("dev.orbit.voice.native.show")
  private let fd: Int32
  public let path: String

  /** nil if another instance holds the lock. */
  public init?(profileDir: URL) {
    try? FileManager.default.createDirectory(at: profileDir, withIntermediateDirectories: true)
    path = profileDir.appendingPathComponent("instance.lock").path
    let f = open(path, O_RDWR | O_CREAT, 0o600)
    guard f >= 0 else { return nil }
    if flock(f, LOCK_EX | LOCK_NB) != 0 {
      close(f)
      return nil
    }
    fd = f
    let pid = "\(getpid())\n"
    ftruncate(f, 0)
    _ = pid.withCString { write(f, $0, strlen($0)) }
  }

  deinit {
    flock(fd, LOCK_UN)
    close(fd)
  }

  /** Ask the running instance (same profile) to show its window. */
  public static func signalRunning(profileDir: URL) {
    DistributedNotificationCenter.default().postNotificationName(showNotification, object: profileDir.path, userInfo: nil, deliverImmediately: true)
  }
}
