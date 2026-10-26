// What the Swift parity runner needs around the cases: launching an app under test with `open`, its
// driver, the bridge (raw HTTP so a case can set any header, Host included; WebSocket for /voice),
// the stand-in Claude window and child processes for the test doubles.
import Foundation
import Network

/** One HTTP/1.1 exchange over a fresh loopback connection (`connection: close`), any headers. */
public enum RawHTTP {
  public struct Response: Sendable { public var status: Int; public var headers: [String: String]; public var body: Data }

  public static func send(port: Int, method: String, path: String, headers: [String: String], body: Data?, timeout: Double = 15) async throws -> Response {
    let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!, using: .tcp)
    var head = "\(method) \(path) HTTP/1.1\r\n"
    var h = headers
    h["connection"] = "close"
    if h.keys.first(where: { $0.lowercased() == "host" }) == nil { h["host"] = "127.0.0.1:\(port)" }
    if let body { h["content-length"] = String(body.count) }
    for (k, v) in h { head += "\(k): \(v)\r\n" }
    head += "\r\n"
    var bytes = Data(head.utf8)
    if let body { bytes.append(body) }
    let payload = bytes
    let raw: Data = try await withCheckedThrowingContinuation { cont in
      let done = Locked(false)
      let finish: @Sendable (Result<Data, Error>) -> Void = { r in
        if done.update({ let was = $0; $0 = true; return was }) { return }
        conn.cancel()
        cont.resume(with: r)
      }
      let acc = Locked(Data())
      @Sendable func read() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, complete, err in
          if let data { acc.update { $0.append(data) } }
          if complete || err != nil { finish(.success(acc.get())) } else { read() }
        }
      }
      conn.stateUpdateHandler = { st in
        switch st {
        case .ready:
          conn.send(content: payload, completion: .contentProcessed { e in if let e { finish(.failure(e)) } else { read() } })
        case .failed(let e): finish(.failure(e))
        default: break
        }
      }
      conn.start(queue: .global())
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(.failure(RunnerError("HTTP \(method) \(path) timed out"))) }
    }
    return try parse(raw)
  }

  public static func parse(_ raw: Data) throws -> Response {
    guard let end = raw.range(of: Data("\r\n\r\n".utf8)) else { throw RunnerError("no HTTP response") }
    let head = String(decoding: raw[raw.startIndex..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
    let status = Int(head.first?.split(separator: " ").dropFirst().first ?? "") ?? 0
    var headers: [String: String] = [:]
    for l in head.dropFirst() {
      guard let i = l.firstIndex(of: ":") else { continue }
      let k = l[..<i].lowercased(), v = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
      headers[k] = headers[k].map { "\($0), \(v)" } ?? v
    }
    var body = Data(raw[end.upperBound...])
    if headers["transfer-encoding"]?.lowercased().contains("chunked") == true { body = dechunk(body) }
    return Response(status: status, headers: headers, body: body)
  }

  static func dechunk(_ d: Data) -> Data {
    var out = Data()
    var i = d.startIndex
    while i < d.endIndex, let nl = d[i...].range(of: Data("\r\n".utf8)) {
      let sizeLine = String(decoding: d[i..<nl.lowerBound], as: UTF8.self).split(separator: ";").first ?? ""
      guard let n = Int(sizeLine.trimmingCharacters(in: .whitespaces), radix: 16), n > 0 else { break }
      let start = nl.upperBound
      let stop = min(d.endIndex, start + n)
      out.append(d[start..<stop])
      i = min(d.endIndex, stop + 2)
    }
    return out
  }
}

/** The bridge, signed in with an app's per-launch link. */
public struct BridgeHTTP: Sendable {
  public var base: String
  public var port: Int
  public var cookie: String

  public static func signIn(base: String, authURL: URL) async throws -> BridgeHTTP {
    guard let port = URL(string: base)?.port else { throw RunnerError("bad base \(base)") }
    let r = try await RawHTTP.send(port: port, method: "GET", path: authURL.path + "?" + (authURL.query ?? ""), headers: [:], body: nil)
    guard r.status == 302, let set = r.headers["set-cookie"], let cookie = set.split(separator: ";").first else { throw RunnerError("sign-in failed (HTTP \(r.status))") }
    return BridgeHTTP(base: base, port: port, cookie: String(cookie))
  }

  /** → { status, headers, body } like the Node runner (body: JSON, text, or { bytes }). */
  public func request(method: String, path: String, body: JSONValue? = nil, auth: Bool = true, origin: String? = nil, host: String? = nil, headers: [String: String] = [:], timeout: Double = 15000) async throws -> JSONValue {
    var h = headers
    if auth { h["cookie"] = cookie }
    if method != "GET" && origin == nil { h["origin"] = base }
    if let origin { h["origin"] = origin }
    if let host { h["host"] = host }
    var data: Data?
    if let body { data = body.data(); h["content-type"] = "application/json" }
    let r = try await RawHTTP.send(port: port, method: method, path: path, headers: h, body: data, timeout: timeout / 1000)
    let ct = r.headers["content-type"] ?? ""
    let b: JSONValue
    if ct.contains("json") { b = (try? JSONValue.parse(r.body)) ?? .string(String(decoding: r.body, as: UTF8.self)) }
    else if ct.hasPrefix("text/") || ct.isEmpty && r.body.count < 100_000 { b = .string(String(decoding: r.body, as: UTF8.self)) }
    else { b = ["bytes": .number(Double(r.body.count))] }
    return ["status": .number(Double(r.status)), "headers": .object(r.headers.mapValues { .string($0) }), "body": b]
  }

  /** Opens /voice, sends, collects until `done(messages)` or the timeout → { opened, closed, messages }. */
  public func websocket(query: String, send: [JSONValue], timeout: Double, origin: String?, auth: Bool, done: @escaping @Sendable ([JSONValue]) -> Bool) async -> JSONValue {
    var req = URLRequest(url: URL(string: base.replacingOccurrences(of: "http://", with: "ws://") + "/voice" + (query.isEmpty ? "" : "?\(query)"))!)
    if auth { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
    req.setValue(origin ?? base, forHTTPHeaderField: "Origin")
    let task = URLSession.shared.webSocketTask(with: req)
    task.resume()
    var msgs: [JSONValue] = []
    var opened = false
    var closed = "timeout"
    for m in send { try? await task.send(.string(m.text)) }
    let end = Date().addingTimeInterval(timeout / 1000)
    while Date() < end {
      let left = end.timeIntervalSinceNow
      let got: URLSessionWebSocketTask.Message?? = await withTaskGroup(of: URLSessionWebSocketTask.Message??.self) { g in
        g.addTask { do { return .some(try await task.receive()) } catch { return .some(nil) } }
        g.addTask { try? await Task.sleep(nanoseconds: UInt64(max(0, left) * 1e9)); return nil }
        let r = await g.next() ?? nil
        g.cancelAll()
        return r
      }
      guard let maybe = got else { break } // timed out
      guard let m = maybe else { closed = opened ? "closed" : "refused"; break }
      opened = true
      if case .string(let s) = m, let j = try? JSONValue.parse(s) { msgs.append(j) }
      if done(msgs) { closed = "done"; break }
    }
    task.cancel(with: .goingAway, reason: nil)
    return ["opened": .bool(opened), "closed": .string(closed), "messages": .array(msgs)]
  }
}

/** An app under test, launched with `open -n -g`. */
public final class AppHandle: @unchecked Sendable {
  public let which: String
  public let hello: JSONValue
  let driverPort: Int
  let token: String
  public var pid: Int32 { Int32(hello["pid"]?.intValue ?? 0) }

  /** The run's profile: every process started with it is this app (a relaunch included). */
  let profile: URL?

  init(which: String, hello: JSONValue, driverPort: Int, token: String, profile: URL? = nil) {
    self.which = which; self.hello = hello; self.driverPort = driverPort; self.token = token; self.profile = profile
  }

  public func driver(_ method: String, _ path: String, _ body: JSONValue? = nil, timeout: Double = 15000) async throws -> JSONValue {
    let r = try await RawHTTP.send(port: driverPort, method: method, path: path, headers: ["x-parity-token": token, "content-type": "application/json"], body: body?.data(), timeout: timeout / 1000)
    return ["status": .number(Double(r.status)), "body": (try? JSONValue.parse(r.body)) ?? .string(String(decoding: r.body, as: UTF8.self))]
  }

  static func open(_ bundle: URL, env: [String: String], args: [String] = [], logs: URL, name: String) throws {
    var a = ["-n", "-g"]
    for (k, v) in env.sorted(by: { $0.key < $1.key }) { a += ["--env", "\(k)=\(v)"] }
    a += ["--stdout", logs.appendingPathComponent("\(name).out.log").path, "--stderr", logs.appendingPathComponent("\(name).err.log").path, bundle.path]
    if !args.isEmpty { a += ["--args"] + args }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = a
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw RunnerError("open \(bundle.lastPathComponent) failed (\(p.terminationStatus))") }
  }

  public static func start(_ which: String, paths: ParityRunner.Paths, profile: URL, logs: URL, bridgePort: Int, driverPort: Int, env extra: [String: String]) async throws -> AppHandle {
    var tokBytes = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, 16, &tokBytes)
    let token = tokBytes.map { String(format: "%02x", $0) }.joined()
    var env = ["ORBIT_PARITY_PORT": String(driverPort), "ORBIT_PARITY_TOKEN": token, "ORBIT_PROFILE_DIR": profile.path, "PORT": String(bridgePort), "ORBIT_MUTE_OUTPUT": "1"]
    for (k, v) in extra { env[k] = v }
    guard which == "swift" else { throw RunnerError("unknown app \(which): only swift (Orbit Native) runs the parity suite") }
    guard FileManager.default.fileExists(atPath: paths.swiftApp.path) else { throw RunnerError("no Swift build at \(paths.swiftApp.path)") }
    try open(paths.swiftApp, env: env, logs: logs, name: "swift")
    let probe = AppHandle(which: which, hello: .null, driverPort: driverPort, token: token)
    let end = Date().addingTimeInterval(30)
    while Date() < end {
      if let r = try? await probe.driver("GET", "/parity/hello", timeout: 2000), r["status"]?.intValue == 200, let h = r["body"], h.at(path: "bridge.base")?.stringValue?.isEmpty == false, h["ready"] != .bool(false) {
        return AppHandle(which: which, hello: h, driverPort: driverPort, token: token, profile: profile)
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    // Never leave it running: it would hold the ports for every case after this one.
    for pid in ChildProcess.pids(withEnv: "ORBIT_PROFILE_DIR=\(profile.path)") { await ChildProcess.waitGone(pid, within: 0) }
    let err = (try? String(contentsOf: logs.appendingPathComponent("\(which).err.log"), encoding: .utf8))?.split(separator: "\n").suffix(8).joined(separator: " | ") ?? ""
    throw RunnerError("\(which) did not come up: \(err.isEmpty ? "(no output)" : err)")
  }

  /** Quit through the driver, then make sure (of a copy that relaunched itself too). */
  public func stop() async {
    _ = try? await driver("POST", "/parity/act", ["action": "quit"], timeout: 3000)
    await ChildProcess.waitGone(pid, within: 6)
    if let profile {
      for p in ChildProcess.pids(withEnv: "ORBIT_PROFILE_DIR=\(profile.path)") { await ChildProcess.waitGone(p, within: 3) }
    }
  }
}

/** The stand-in Claude window (parity/fixtures/standin) and its control port. */
public final class StandIn: @unchecked Sendable {
  let port: Int
  let token: String
  public let pid: Int32
  init(port: Int, token: String, pid: Int32) { self.port = port; self.token = token; self.pid = pid }

  public func call(_ method: String, _ path: String, _ body: JSONValue? = nil) async throws -> JSONValue {
    let r = try await RawHTTP.send(port: port, method: method, path: path, headers: ["x-standin-token": token, "content-type": "application/json"], body: body?.data())
    return (try? JSONValue.parse(r.body)) ?? .null
  }

  static func start(paths: ParityRunner.Paths, port: Int, logs: URL, frame: JSONValue?) async throws -> StandIn {
    let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    var env = ["PARITY_STANDIN_PORT": String(port), "PARITY_STANDIN_TOKEN": token]
    if let frame, !frame.isNull { env["PARITY_STANDIN_FRAME"] = frame.text }
    try AppHandle.open(paths.electronRoot.appendingPathComponent("node_modules/electron/dist/Electron.app"), env: env, args: [paths.repo.appendingPathComponent("parity/fixtures/standin").path], logs: logs, name: "standin")
    let probe = StandIn(port: port, token: token, pid: 0)
    let end = Date().addingTimeInterval(30)
    while Date() < end {
      if let s = try? await probe.call("GET", "/state"), let pid = s["pid"]?.intValue { return StandIn(port: port, token: token, pid: Int32(pid)) }
      try await Task.sleep(nanoseconds: 150_000_000)
    }
    throw RunnerError("the stand-in Claude window did not come up")
  }

  public func stop() async {
    _ = try? await call("POST", "/quit")
    await ChildProcess.waitGone(pid, within: 5)
  }
}

/** A test double run as a child process (the stand-in Grok). */
public final class ChildProcess: @unchecked Sendable {
  let process: Process
  let output = Locked("")

  public static func start(_ exe: URL, _ args: [String]) throws -> ChildProcess {
    let p = Process()
    p.executableURL = exe
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    let c = ChildProcess(process: p)
    out.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil } else { c.output.update { $0 += String(decoding: d, as: UTF8.self) } }
    }
    try p.run()
    return c
  }

  init(process: Process) { self.process = process }

  public func waitForOutput(_ s: String, timeout: Double) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if output.get().contains(s) { return true }
      if !process.isRunning { return false }
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return false
  }

  public func stop() {
    if process.isRunning { process.terminate() }
  }

  /** Waits (without blocking a thread) for a process to end; then TERM, then KILL. */
  public static func waitGone(_ pid: Int32, within seconds: Double) async {
    guard pid > 0 else { return }
    let end = Date().addingTimeInterval(seconds)
    while kill(pid, 0) == 0 && Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
    if kill(pid, 0) == 0 { kill(pid, SIGTERM); try? await Task.sleep(nanoseconds: 1_500_000_000) }
    if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
  }

  /** Our own processes whose environment names `needle` (ps shows one's own processes' environment). */
  public static func pids(withEnv needle: String) -> [Int32] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/ps")
    p.arguments = ["-Aeww", "-o", "pid=,command="]
    let out = Pipe()
    p.standardOutput = out
    guard (try? p.run()) != nil else { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self).split(separator: "\n").filter { $0.contains(needle) }
      .compactMap { Int32($0.split(separator: " ", omittingEmptySubsequences: true).first ?? "") }
      .filter { $0 > 0 && $0 != getpid() }
  }

  public static func ensureGone(_ pid: Int32, within seconds: Double) {
    guard pid > 0 else { return }
    let end = Date().addingTimeInterval(seconds)
    while kill(pid, 0) == 0 && Date() < end { usleep(100_000) }
    if kill(pid, 0) == 0 { kill(pid, SIGTERM); usleep(1_500_000) }
    if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
  }
}
