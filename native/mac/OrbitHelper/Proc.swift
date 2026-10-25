// `orbit-helper proc --pid N`: one process's program and arguments, read-only (what Orbit needs to
// restart an app the user approved under its keeper; Windows reads the same from WMI).
//   {"ok":true,"pid":N,"exe":"/Applications/Discord.app/Contents/MacOS/Discord","args":["--flag"],"parent":1,"bundle":"/Applications/Discord.app"}
//   {"ok":false,"error":"no_process|access_denied"}

import AppKit
import Darwin

enum Proc {
  static func run(_ flags: Flags) -> Never {
    let pid = pid_t(flags.int("pid"))
    IO.emit(info(pid))
    exit(0)
  }

  static func info(_ pid: pid_t) -> [String: Any] {
    guard pid > 0, kill(pid, 0) == 0 || errno == EPERM else { return ["ok": false, "error": "no_process"] }
    var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let n = proc_pidpath(pid, &buf, UInt32(buf.count))
    guard n > 0 else { return ["ok": false, "error": "access_denied"] }
    let exe = String(cString: buf)
    var res: [String: Any] = ["ok": true, "pid": Int(pid), "exe": exe, "args": arguments(pid) ?? []]
    var bsd = proc_bsdinfo()
    if proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 { res["parent"] = Int(bsd.pbi_ppid) }
    if let r = exe.range(of: ".app/Contents/MacOS/") { res["bundle"] = String(exe[..<r.lowerBound]) + ".app" }
    return res
  }

  /** argv[1...] from KERN_PROCARGS2 (argc, the exec path, padding, then argv strings). */
  static func arguments(_ pid: pid_t) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_ARGMAX]
    var argmax: Int32 = 0
    var size = MemoryLayout<Int32>.size
    guard sysctl(&mib, 2, &argmax, &size, nil, 0) == 0 else { return nil }
    var buf = [UInt8](repeating: 0, count: Int(argmax))
    mib = [CTL_KERN, KERN_PROCARGS2, pid]
    size = buf.count
    guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return nil }
    let argc = buf.withUnsafeBytes { $0.load(as: Int32.self) }
    var i = 4
    while i < size && buf[i] != 0 { i += 1 } // the exec path
    while i < size && buf[i] == 0 { i += 1 } // padding
    var args: [String] = []
    while i < size && args.count < Int(argc) {
      let start = i
      while i < size && buf[i] != 0 { i += 1 }
      args.append(String(decoding: buf[start..<i], as: UTF8.self))
      i += 1
    }
    return Array(args.dropFirst()).filter { !$0.hasPrefix("-psn_") }
  }
}
