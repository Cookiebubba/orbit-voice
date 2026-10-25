// The bridge's HTTP server on 127.0.0.1 (Network.framework): keep-alive connections, each request
// routed in order, and four kinds of answer:
//   - a whole response;
//   - a file streamed from disk (the wake-word model is 40 MB);
//   - a stream that stays open (server-sent events, /api/events);
//   - a raw pass-through to another local server (the Node core, while parts of it are still
//     there), bytes both ways until either side closes: HTTP requests and the /voice WebSocket alike.
import Foundation
import Network

public final class BridgeStream: @unchecked Sendable {
  private let conn: NWConnection
  private let queue: DispatchQueue
  private var closed = false
  private var onClose: [@Sendable () -> Void] = []

  init(conn: NWConnection, queue: DispatchQueue) {
    self.conn = conn
    self.queue = queue
  }

  /** Write bytes (in order); dropped once closed. */
  public func write(_ data: Data) {
    queue.async {
      guard !self.closed else { return }
      self.conn.send(content: data, completion: .contentProcessed { [weak self] err in if err != nil { self?.close() } })
    }
  }

  public func write(_ text: String) { write(Data(text.utf8)) }

  public func close() {
    queue.async {
      guard !self.closed else { return }
      self.closed = true
      self.conn.cancel()
      let fns = self.onClose
      self.onClose = []
      for fn in fns { fn() }
    }
  }

  /** Called once when the stream ends (either side). */
  public func whenClosed(_ fn: @escaping @Sendable () -> Void) {
    queue.async {
      if self.closed { fn() } else { self.onClose.append(fn) }
    }
  }

  var isClosed: Bool { closed }
}

public enum BridgeReply: Sendable {
  case response(BridgeResponse)
  /** A file: status 200 with these fields (content-length is added). */
  case file(fields: [(String, String)], url: URL)
  /** The head is written, then `start` gets the stream (it stays open until closed). */
  case stream(head: BridgeResponse, start: @Sendable (BridgeStream) -> Void)
  /** Pass the request on as these bytes to a local port, and its answer back, verbatim. */
  case passThrough(port: UInt16, head: Data, body: Data)
  /**
   * A response that takes a while (a connection test): `work` runs in a task of its own, which is
   * cancelled if the client goes away first (Node's res 'close'); its answer is sent if it's still there.
   */
  case deferred(@Sendable () async -> BridgeResponse)
}

public final class BridgeServer: @unchecked Sendable {
  public typealias Router = @Sendable (BridgeRequest) async -> BridgeReply
  public let port: UInt16
  private let listener: NWListener
  private let router: Router
  private let queue = DispatchQueue(label: "orbit.bridge")
  private var connections: [ObjectIdentifier: Connection] = [:]
  private let maxBody: Int
  public var onError: (@Sendable (String) -> Void)?

  public init(port: UInt16, maxBody: Int = 1 << 20, router: @escaping Router) throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(BridgePolicy.host), port: NWEndpoint.Port(rawValue: port)!)
    params.allowLocalEndpointReuse = true
    listener = try NWListener(using: params)
    self.port = port
    self.router = router
    self.maxBody = maxBody
  }

  /** Starts listening; throws if the port is taken. */
  public func start() async throws {
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
      let once = OnceFlag()
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready: if once.take() { cont.resume() }
        case .failed(let e): if once.take() { cont.resume(throwing: e) }
        case .cancelled: if once.take() { cont.resume(throwing: CancellationError()) }
        default: break
        }
      }
      listener.newConnectionHandler = { [weak self] nw in self?.accept(nw) }
      listener.start(queue: queue)
    }
  }

  public func stop() {
    listener.cancel()
    queue.async {
      for c in self.connections.values { c.conn.cancel() }
      self.connections.removeAll()
    }
  }

  private func accept(_ nw: NWConnection) {
    let c = Connection(conn: nw, server: self, maxBody: maxBody)
    connections[ObjectIdentifier(c)] = c
    c.start()
  }

  fileprivate func done(_ c: Connection) {
    queue.async { self.connections.removeValue(forKey: ObjectIdentifier(c)) }
  }

  fileprivate func route(_ r: BridgeRequest) async -> BridgeReply { await router(r) }
  fileprivate var serverQueue: DispatchQueue { queue }

  /** One client connection: requests read and answered one at a time. */
  final class Connection: @unchecked Sendable {
    let conn: NWConnection
    unowned let server: BridgeServer
    var parser: HTTPRequestParser
    var busy = false
    var finished = false
    var passThrough: PassThrough?
    /** A deferred answer being worked on, and whether a read is waiting on the client meanwhile. */
    var work: Task<Void, Never>?
    var watching = false
    var clientGone = false

    init(conn: NWConnection, server: BridgeServer, maxBody: Int) {
      self.conn = conn
      self.server = server
      parser = HTTPRequestParser(maxBody: maxBody)
    }

    var queue: DispatchQueue { server.serverQueue }

    func start() {
      conn.stateUpdateHandler = { [weak self] st in
        switch st {
        case .failed, .cancelled: self?.finish()
        default: break
        }
      }
      conn.start(queue: queue)
      receive()
    }

    func finish() {
      guard !finished else { return }
      finished = true
      work?.cancel()
      conn.cancel()
      server.done(self)
    }

    func receive() {
      guard !watching else { return }
      watching = true
      conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, err in
        guard let self else { return }
        self.watching = false
        if let data, !data.isEmpty { self.parser.feed(data) }
        if err != nil { return self.finish() }
        if self.busy {
          // Read while a deferred answer is worked on: the client closing ends it; anything else waits.
          if complete {
            self.clientGone = true
            self.finish()
          } else {
            self.receive()
          }
          return
        }
        self.pump(eof: complete || self.clientGone)
      }
    }

    /** Answers the next whole request, if there is one and nothing else is being answered. */
    func pump(eof: Bool) {
      guard !busy, !finished else { return }
      let req: BridgeRequest?
      do {
        req = try parser.next()
      } catch let e as HTTPParseError {
        let status = e == .bodyTooLarge ? 413 : e == .headTooLarge ? 431 : 400
        send(BridgePolicy.plain(status).serialize(keepAlive: false)) { self.finish() }
        return
      } catch {
        return finish()
      }
      guard let req else {
        if eof { finish() } else { receive() }
        return
      }
      busy = true
      Task {
        let reply = await self.server.route(req)
        self.queue.async { self.answer(req, reply, eof: eof) }
      }
    }

    func answer(_ req: BridgeRequest, _ reply: BridgeReply, eof: Bool) {
      guard !finished else { return }
      switch reply {
      case .response(let r):
        let keep = req.keepAlive && !eof
        send(r.serialize(headOnly: req.method == "HEAD", keepAlive: keep)) {
          if keep {
            self.busy = false
            self.pump(eof: false)
          } else {
            self.finish()
          }
        }
      case .file(let fields, let url):
        let keep = req.keepAlive && !eof
        guard let fh = try? FileHandle(forReadingFrom: url) else {
          return send(BridgePolicy.plain(404, "not found").serialize(keepAlive: false)) { self.finish() }
        }
        let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue ?? 0
        let head = BridgeResponse(status: 200, fields: fields + [("content-length", String(size))])
        send(head.serialize(headOnly: true, keepAlive: keep)) {
          let next = {
            try? fh.close()
            if keep {
              self.busy = false
              self.pump(eof: false)
            } else {
              self.finish()
            }
          }
          if req.method == "HEAD" { return next() }
          self.sendFile(fh, then: next)
        }
      case .stream(let head, let start):
        var h = head
        h.fields.removeAll { $0.name.lowercased() == "content-length" }
        var text = "HTTP/1.1 \(h.status) \(BridgeResponse.reasons[h.status] ?? "Status")\r\n"
        for f in h.fields where f.name.lowercased() != "connection" { text += "\(f.name): \(f.value)\r\n" }
        text += "connection: keep-alive\r\n\r\n"
        let stream = BridgeStream(conn: conn, queue: queue)
        // Reading on: the client going away ends the stream.
        watchForClose(stream)
        send(Data(text.utf8)) { start(stream) }
      case .deferred(let work):
        // Watch the client while it works (no pass-through can follow on this connection's reads now).
        receive()
        self.work = Task {
          let r = await work()
          if Task.isCancelled { return }
          self.queue.async {
            self.work = nil
            self.answer(req, .response(r), eof: eof)
          }
        }
      case .passThrough(let port, let head, let body):
        let rest = parser.takeRest()
        // Held here until it ends (its own callbacks only hold it weakly).
        let p = PassThrough(client: conn, port: port, queue: queue) { [weak self] in
          self?.passThrough = nil
          self?.finish()
        }
        passThrough = p
        p.start(first: head + body + rest)
      }
    }

    func watchForClose(_ stream: BridgeStream) {
      conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] _, _, complete, err in
        guard let self else { return stream.close() }
        if complete || err != nil {
          stream.close() // (cancels the connection: its state handler finishes it here)
        } else {
          self.watchForClose(stream)
        }
      }
    }

    func sendFile(_ fh: FileHandle, then: @escaping () -> Void) {
      let chunk = (try? fh.read(upToCount: 256 * 1024)) ?? nil
      guard let chunk, !chunk.isEmpty else { return then() }
      send(chunk) { self.sendFile(fh, then: then) }
    }

    func send(_ data: Data, then: @escaping () -> Void) {
      conn.send(content: data, completion: .contentProcessed { [weak self] err in
        guard let self else { return }
        if err != nil { return self.finish() }
        self.queue.async(execute: then)
      })
    }
  }
}

/**
 * Bytes both ways between the client's connection and a local server, until either closes (then
 * both are). The first bytes to send upstream are given: the request as passed on.
 */
final class PassThrough: @unchecked Sendable {
  let client: NWConnection
  let upstream: NWConnection
  let queue: DispatchQueue
  let onEnd: () -> Void
  var ended = false

  init(client: NWConnection, port: UInt16, queue: DispatchQueue, onEnd: @escaping () -> Void) {
    self.client = client
    self.queue = queue
    self.onEnd = onEnd
    upstream = NWConnection(host: NWEndpoint.Host(BridgePolicy.host), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
  }

  func start(first: Data) {
    upstream.stateUpdateHandler = { [weak self] st in
      guard let self else { return }
      switch st {
      case .ready:
        self.upstream.send(content: first, completion: .contentProcessed { err in if err != nil { self.end() } })
        self.copy(from: self.upstream, to: self.client)
        self.copy(from: self.client, to: self.upstream)
      case .failed, .cancelled, .waiting:
        // Nothing listening upstream (the core is gone; refused is "waiting" to Network.framework):
        // a plain 502 if nothing was answered yet.
        guard !self.ended else { return }
        if self.answered { return self.end() }
        self.client.send(content: BridgePolicy.plain(502, "Orbit's core is not answering.").serialize(keepAlive: false), completion: .contentProcessed { _ in self.end() })
      default: break
      }
    }
    upstream.start(queue: queue)
  }

  private var answered = false

  func copy(from a: NWConnection, to b: NWConnection) {
    a.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, err in
      guard let self, !self.ended else { return }
      if let data, !data.isEmpty {
        if a === self.upstream { self.answered = true }
        b.send(content: data, completion: .contentProcessed { e in
          if e != nil { return self.end() }
          if complete { self.end() } else { self.copy(from: a, to: b) }
        })
      } else if complete || err != nil {
        self.end()
      } else {
        self.copy(from: a, to: b)
      }
    }
  }

  func end() {
    guard !ended else { return }
    ended = true
    upstream.stateUpdateHandler = nil
    upstream.cancel()
    // Let what was sent go out before closing the client.
    client.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [client] _ in client.cancel() })
    onEnd()
  }
}

/** A flag that can be taken once (a continuation resumed once). */
final class OnceFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var taken = false
  func take() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if taken { return false }
    taken = true
    return true
  }
}
