// A free TCP port on 127.0.0.1, for a server only this app talks to (the Node core behind the
// engine, while it's still there): the system picks one, and it's let go at once for that server.
import Darwin

public enum FreePort {
  public static func pick() -> UInt16? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    guard bound == 0 else { return nil }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let got = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
    guard got == 0 else { return nil }
    let port = UInt16(bigEndian: addr.sin_port)
    return port > 0 ? port : nil
  }
}
