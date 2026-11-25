// T3 Code Lead target backend HTTP client (Swift port of src/targets/t3-code.js).
// Speaks to T3 Code's local MCP HTTP bridge (`POST <endpoint>/mcp/call` with Bearer token).
//
// Security:
//   - Endpoints are restricted to loopback hosts (127.0.0.1, localhost, ::1, [::1]) unless
//     `allowRemote: true` is explicitly passed.
//   - Bearer tokens, user prompts, and session text are never logged.
import Foundation
import OrbitKit

public enum T3EndpointError: Error, Equatable, Sendable {
  case notConfigured
  case invalidEndpoint(String)
  case remoteEndpointDisallowed(String)

  public var code: String {
    switch self {
    case .notConfigured: return "not_configured"
    case .invalidEndpoint: return "invalid_endpoint"
    case .remoteEndpointDisallowed: return "remote_endpoint_disallowed"
    }
  }

  public var message: String {
    switch self {
    case .notConfigured: return "No T3 endpoint configured."
    case .invalidEndpoint(let m): return m
    case .remoteEndpointDisallowed(let m): return m
    }
  }
}

public struct T3Session: Sendable, Equatable {
  public let id: String
  public let title: String
  public let project: String
  public let cwd: String
  public let branch: String?
  public let status: String
  public let working: Bool
  public let waiting: Bool
  public let lastActivityAt: Double
  public let lastFocusedAt: Double
  public let createdAt: Double
  public let recentFiles: [String]
  public let backend: String
}

public struct T3PendingChoice: Sendable, Equatable {
  public let n: Int
  public let id: String?
  public let label: String
  public let description: String
  public let selected: Bool
}

public struct T3PendingRequest: Sendable, Equatable {
  public let id: String
  public let kind: String
  public let question: String
  public let title: String
  public let detail: String
  public let choices: [T3PendingChoice]
  public let multiSelect: Bool
  public let canSkip: Bool
  public let threadId: String?
}

public struct T3ListResult: Sendable, Equatable {
  public let ok: Bool
  public let sessions: [T3Session]
  public let nextCursor: JSONValue?
  public let error: String?
  public let message: String?
}

public struct T3SwitchResult: Sendable, Equatable {
  public let ok: Bool
  public let session: T3Session?
  public let threadId: String?
  public let sessionTitle: String?
  public let error: String?
  public let message: String?
}

public struct T3NewSessionResult: Sendable, Equatable {
  public let ok: Bool
  public let session: T3Session?
  public let threadId: String?
  public let title: String?
  public let projectId: String?
  public let branch: String?
  public let worktreePath: String?
  public let link: String?
  public let error: String?
  public let message: String?
}

public struct T3SendResult: Sendable, Equatable {
  public let ok: Bool
  public let sent: Bool
  public let threadId: String?
  public let mode: String?
  public let runId: String?
  public let queuedRunId: String?
  public let queued: Bool
  public let link: String?
  public let error: String?
  public let message: String?
}

public struct T3InterruptResult: Sendable, Equatable {
  public let ok: Bool
  public let stopped: Bool
  public let threadId: String?
  public let error: String?
  public let message: String?
}

public struct T3PendingResult: Sendable, Equatable {
  public let ok: Bool
  public let threadId: String?
  public let pending: T3PendingRequest?
  public let error: String?
  public let message: String?
}

public struct T3AnswerResult: Sendable, Equatable {
  public let ok: Bool
  public let answered: Bool
  public let requestId: String?
  public let threadId: String?
  public let error: String?
  public let message: String?
}

public final class T3Target: @unchecked Sendable {
  public static let backendId = "t3-code"
  public static let maxPromptChars = 8000
  private static let sendModes: Set<String> = ["auto", "queue", "steer", "restart"]
  private static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1", "[::1]"]
  private static let workingStatuses: Set<String> = ["working", "running", "starting", "preparing", "queued"]
  private static let maxRecentIds = 30

  public typealias HTTPTransport = @Sendable (URLRequest) async throws -> (Data, Int)

  private let endpointResult: Result<URL, T3EndpointError>
  private let token: String
  private let timeoutSeconds: TimeInterval
  private let transport: HTTPTransport

  private let lock = NSLock()
  private var _activeThreadId: String?
  private var _recentInteractedIds: [String] = []
  private var sessionCache: [String: T3Session] = [:]

  public var activeThreadId: String? { lock.withLock { _activeThreadId } }
  public var recentInteractedIds: [String] { lock.withLock { _recentInteractedIds } }
  public var callURL: URL? { try? endpointResult.get() }

  public init(
    endpoint: String,
    token: String = "",
    allowRemote: Bool = false,
    timeoutSeconds: TimeInterval = 15,
    transport: HTTPTransport? = nil
  ) {
    self.endpointResult = Self.parseEndpoint(endpoint, allowRemote: allowRemote)
    self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
    self.timeoutSeconds = max(0.5, min(60, timeoutSeconds))
    if let transport {
      self.transport = transport
    } else {
      self.transport = { req in
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return (data, status)
      }
    }
  }

  /**
   * Validates and normalizes a T3 Code HTTP endpoint URL.
   * Rejects non-http(s) protocols and non-loopback hosts unless `allowRemote` is true.
   */
  public static func parseEndpoint(_ rawEndpoint: String, allowRemote: Bool = false) -> Result<URL, T3EndpointError> {
    let trimmed = rawEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return .failure(.notConfigured) }
    guard var comps = URLComponents(string: trimmed),
          let scheme = comps.scheme?.lowercased() else {
      return .failure(.invalidEndpoint("Invalid T3 endpoint URL."))
    }
    guard scheme == "http" || scheme == "https" else {
      return .failure(.invalidEndpoint("T3 endpoint must use http or https."))
    }
    guard let host = comps.host?.lowercased(), !host.isEmpty else {
      return .failure(.invalidEndpoint("Invalid T3 endpoint URL."))
    }
    if !allowRemote && !loopbackHosts.contains(host) {
      return .failure(.remoteEndpointDisallowed("T3 endpoint must be loopback unless allowRemote is true."))
    }
    var basePath = comps.percentEncodedPath
    while basePath.hasSuffix("/") { basePath.removeLast() }
    comps.percentEncodedPath = basePath.hasSuffix("/mcp/call") ? basePath : "\(basePath)/mcp/call"
    comps.query = nil
    comps.fragment = nil
    guard let finalURL = comps.url else {
      return .failure(.invalidEndpoint("Invalid T3 endpoint URL."))
    }
    return .success(finalURL)
  }

  // MARK: - Internal helpers

  private func touchRecent(_ threadId: String) {
    let id = String(threadId.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
    guard !id.isEmpty else { return }
    lock.withLock {
      if let idx = _recentInteractedIds.firstIndex(of: id) {
        _recentInteractedIds.remove(at: idx)
      }
      _recentInteractedIds.insert(id, at: 0)
      if _recentInteractedIds.count > Self.maxRecentIds {
        _recentInteractedIds = Array(_recentInteractedIds.prefix(Self.maxRecentIds))
      }
    }
  }

  private func rememberSession(_ raw: JSONValue) -> T3Session {
    let s = Self.normalizeSession(raw)
    if !s.id.isEmpty {
      lock.withLock { sessionCache[s.id] = s }
    }
    return s
  }

  private static func clampStr(_ v: JSONValue?, max: Int) -> String {
    guard let s = v?.stringValue else { return "" }
    return String(s.trimmingCharacters(in: .whitespacesAndNewlines).prefix(max))
  }

  private static func toMs(_ v: JSONValue?) -> Double {
    if let n = v?.doubleValue, n.isFinite, n >= 0 { return floor(n) }
    if let s = v?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
      let iso = ISO8601DateFormatter()
      iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let d = iso.date(from: s) ?? ISO8601DateFormatter().date(from: s) {
        return floor(d.timeIntervalSince1970 * 1000)
      }
    }
    return 0
  }

  private static func basename(_ path: String) -> String {
    var clean = path.replacingOccurrences(of: "\\", with: "/")
    while clean.hasSuffix("/") { clean.removeLast() }
    if let idx = clean.lastIndex(of: "/") { return String(clean[clean.index(after: idx)...]) }
    return clean
  }

  static func normalizeSession(_ raw: JSONValue) -> T3Session {
    let id = clampStr(raw["id"] ?? raw["threadId"] ?? raw["sessionId"], max: 200)
    let cwd = clampStr(raw["cwd"] ?? raw["worktreePath"] ?? raw["workspacePath"] ?? raw["workspaceRoot"], max: 1000)
    let rawTitle = clampStr(raw["title"] ?? raw["name"], max: 300)
    let title = rawTitle.isEmpty ? "(untitled)" : rawTitle
    let fallbackProject = cwd.isEmpty ? "" : basename(cwd)
    let rawProj = clampStr(raw["project"] ?? raw["projectName"], max: 200)
    let project = rawProj.isEmpty ? String(fallbackProject.prefix(200)) : rawProj
    let branchStr = clampStr(raw["branch"] ?? raw["gitBranch"], max: 200)
    let branch: String? = branchStr.isEmpty ? nil : branchStr

    let rawStatus = clampStr(raw["status"], max: 40).lowercased()
    let waiting: Bool
    if let w = raw["waiting"]?.boolValue {
      waiting = w
    } else {
      let hasPending = (raw["pendingRequest"] != nil && raw["pendingRequest"] != .null && raw["pendingRequest"] != .bool(false))
        || raw["hasPendingRequest"] == .bool(true)
      waiting = rawStatus == "waiting" || hasPending
    }
    let working: Bool
    if let w = raw["working"]?.boolValue {
      working = w
    } else {
      working = workingStatuses.contains(rawStatus)
    }
    let status = rawStatus.isEmpty ? (waiting ? "waiting" : (working ? "running" : "idle")) : rawStatus

    let createdAt = toMs(raw["createdAt"])
    let lastActivity = toMs(raw["lastActivityAt"] ?? raw["updatedAt"] ?? raw["lastTurnAt"])
    let lastActivityAt = lastActivity > 0 ? lastActivity : createdAt
    let lastFocused = toMs(raw["lastFocusedAt"] ?? raw["focusedAt"])
    let lastFocusedAt = lastFocused > 0 ? lastFocused : lastActivityAt

    var recentFiles: [String] = []
    if let arr = raw["recentFiles"]?.arrayValue {
      for item in arr.prefix(50) {
        if let s = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
          recentFiles.append(String(s.prefix(500)))
        } else if let s = item["path"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
          recentFiles.append(String(s.prefix(500)))
        }
      }
    }

    let backend = clampStr(raw["backend"], max: 60)
    return T3Session(
      id: id,
      title: title,
      project: project,
      cwd: cwd,
      branch: branch,
      status: status,
      working: working,
      waiting: waiting,
      lastActivityAt: lastActivityAt,
      lastFocusedAt: lastFocusedAt,
      createdAt: createdAt,
      recentFiles: recentFiles,
      backend: backend.isEmpty ? backendId : backend
    )
  }

  static func unwrapToolPayload(_ raw: JSONValue?) -> JSONValue {
    guard let raw, raw != .null else { return .object([:]) }
    guard case .object(let obj) = raw else { return .object(["value": raw]) }
    if let res = obj["result"], case .object = res {
      return unwrapToolPayload(res)
    }
    if let content = obj["content"]?.arrayValue {
      if let textPart = content.first(where: { $0["type"]?.stringValue == "text" && $0["text"]?.stringValue != nil }),
         let text = textPart["text"]?.stringValue {
        if let parsed = try? JSONValue.parse(text), case .object = parsed {
          return parsed
        }
        return .object(["text": .string(text)])
      }
    }
    return raw
  }

  private static func normText(_ s: String) -> String {
    let lower = s.lowercased()
    var out = ""
    var lastWasSpace = true
    for sc in lower.unicodeScalars {
      if CharacterSet.alphanumerics.contains(sc) && sc.isASCII {
        out.unicodeScalars.append(sc)
        lastWasSpace = false
      } else if !lastWasSpace {
        out.append(" ")
        lastWasSpace = true
      }
    }
    return out.trimmingCharacters(in: .whitespaces)
  }

  private static func matchBestByQuery(_ sessions: [T3Session], query: String) -> T3Session? {
    let raw = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let q = normText(raw)
    guard !raw.isEmpty, !q.isEmpty else { return nil }

    if let exact = sessions.first(where: { $0.id == raw || $0.id.lowercased() == raw.lowercased() }) {
      return exact
    }
    let fields: (T3Session) -> [String] = { [$0.title, $0.project, $0.branch ?? ""] }
    if let exactName = sessions.first(where: { fields($0).contains { normText($0) == q } }) {
      return exactName
    }
    let words = q.split(separator: " ").map(String.init).filter { $0.count > 1 }
    var best: T3Session? = nil
    var bestScore = 0
    for s in sessions {
      let hay = fields(s).map(normText).joined(separator: " ")
      if hay.contains(q) {
        let score = words.count + 2
        if score > bestScore { best = s; bestScore = score }
        continue
      }
      let score = words.filter { hay.contains($0) }.count
      if score > bestScore { best = s; bestScore = score }
    }
    return best
  }

  private func invoke(_ name: String, arguments: [String: JSONValue]) async -> (ok: Bool, data: JSONValue?, error: String?, message: String?) {
    let callUrl: URL
    switch endpointResult {
    case .success(let u): callUrl = u
    case .failure(let e): return (false, nil, e.code, e.message)
    }

    var req = URLRequest(url: callUrl)
    req.httpMethod = "POST"
    req.timeoutInterval = timeoutSeconds
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    req.httpBody = JSONValue.object(["name": .string(name), "arguments": .object(arguments)]).data()

    do {
      let (data, status) = try await transport(req)
      let body = try? JSONValue.parse(data)

      if status == 401 || status == 403 {
        return (false, nil, "unauthorized", "T3 endpoint rejected authorization.")
      }
      if !(200..<300).contains(status) {
        let err = body?["error"]?.stringValue.map { String($0.prefix(120)) } ?? "http_error"
        let msg = body?["message"]?.stringValue.map { String($0.prefix(200)) } ?? "T3 HTTP \(status)"
        return (false, nil, err, msg)
      }
      if let body, body["ok"] == .bool(false) {
        let err = body["error"]?.stringValue.map { String($0.prefix(120)) } ?? "tool_error"
        let msg = body["message"]?.stringValue.map { String($0.prefix(200)) }
        return (false, nil, err, msg)
      }
      return (true, Self.unwrapToolPayload(body), nil, nil)
    } catch {
      let nsErr = error as NSError
      let timedOut = nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorTimedOut
      return (
        false,
        nil,
        timedOut ? "timeout" : "network_error",
        timedOut ? "T3 request timed out." : String(error.localizedDescription.prefix(200))
      )
    }
  }

  private func resolveThread(_ idOrQuery: String) async -> (ok: Bool, session: T3Session?, error: String?, message: String?) {
    let query = String(idOrQuery.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
    if query.isEmpty {
      if let aid = activeThreadId {
        let listed = await listSessions(limit: 50)
        if listed.ok, let hit = listed.sessions.first(where: { $0.id == aid }) {
          return (true, hit, nil, nil)
        }
        if let cached = lock.withLock({ sessionCache[aid] }) {
          return (true, cached, nil, nil)
        }
        return (true, Self.normalizeSession(.object(["id": .string(aid)])), nil, nil)
      }
      let listed = await listSessions(limit: 10)
      guard listed.ok else { return (false, nil, listed.error, listed.message) }
      guard let first = listed.sessions.first else { return (false, nil, "session_not_found", nil) }
      return (true, first, nil, nil)
    }

    let listed = await listSessions(limit: 50)
    if listed.ok, let hit = Self.matchBestByQuery(listed.sessions, query: query) {
      return (true, hit, nil, nil)
    }
    let searched = await searchSessions(query, limit: 5)
    if searched.ok, !searched.sessions.isEmpty {
      let hit = Self.matchBestByQuery(searched.sessions, query: query) ?? searched.sessions[0]
      return (true, hit, nil, nil)
    }
    if let cached = lock.withLock({ sessionCache[query] }) {
      return (true, cached, nil, nil)
    }
    return (false, nil, "session_not_found", nil)
  }

  // MARK: - Target API

  public func listSessions(
    limit: Int = 20,
    projectId: String? = nil,
    statuses: [String]? = nil,
    allProjects: Bool = true,
    includeSubagents: Bool = false
  ) async -> T3ListResult {
    var args: [String: JSONValue] = [
      "limit": .number(Double(max(1, min(100, limit)))),
      "allProjects": .bool(allProjects),
      "includeSubagents": .bool(includeSubagents),
    ]
    if let projectId, !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      args["projectId"] = .string(String(projectId.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)))
    }
    if let statuses, !statuses.isEmpty {
      args["statuses"] = .array(statuses.prefix(20).map { .string($0) })
    }

    let res = await invoke("t3_thread_list", arguments: args)
    guard res.ok, let data = res.data else {
      return T3ListResult(ok: false, sessions: [], nextCursor: nil, error: res.error, message: res.message)
    }
    let rawThreads = data["threads"]?.arrayValue ?? data["items"]?.arrayValue ?? []
    let sessions = rawThreads.map(rememberSession)
    return T3ListResult(ok: true, sessions: sessions, nextCursor: data["nextCursor"], error: nil, message: nil)
  }

  public func searchSessions(_ query: String, limit: Int = 10, projectId: String? = nil) async -> T3ListResult {
    let clean = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
    let maxN = max(1, min(50, limit))
    if clean.isEmpty {
      return await listSessions(limit: maxN, projectId: projectId)
    }
    var args: [String: JSONValue] = ["query": .string(clean), "limit": .number(Double(maxN))]
    if let projectId, !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      args["projectId"] = .string(String(projectId.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)))
    }
    let res = await invoke("t3_thread_search", arguments: args)
    guard res.ok, let data = res.data else {
      return T3ListResult(ok: false, sessions: [], nextCursor: nil, error: res.error, message: res.message)
    }
    let rawThreads = data["threads"]?.arrayValue ?? data["results"]?.arrayValue ?? []
    let sessions = rawThreads.map(rememberSession)
    return T3ListResult(ok: true, sessions: sessions, nextCursor: nil, error: nil, message: nil)
  }

  public func switchSession(_ idOrQuery: String) async -> T3SwitchResult {
    let query = String(idOrQuery.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
    guard !query.isEmpty else {
      return T3SwitchResult(ok: false, session: nil, threadId: nil, sessionTitle: nil, error: "empty_query", message: nil)
    }
    let resolved = await resolveThread(query)
    guard resolved.ok, let session = resolved.session else {
      return T3SwitchResult(ok: false, session: nil, threadId: nil, sessionTitle: nil, error: resolved.error, message: resolved.message)
    }
    lock.withLock { _activeThreadId = session.id }
    touchRecent(session.id)
    return T3SwitchResult(ok: true, session: session, threadId: session.id, sessionTitle: session.title, error: nil, message: nil)
  }

  public func newSession(
    title: String = "",
    message: String = "",
    projectId: String? = nil,
    worktree: Bool = false,
    branch: String? = nil,
    baseRef: String? = nil,
    startFromOrigin: Bool? = nil,
    worktreePath: String? = nil,
    scratch: Bool = false
  ) async -> T3NewSessionResult {
    let cleanTitleRaw = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
    let cleanTitle = cleanTitleRaw.isEmpty ? "New thread" : cleanTitleRaw
    let cleanMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
    if cleanMessage.count > Self.maxPromptChars {
      return T3NewSessionResult(ok: false, session: nil, threadId: nil, title: nil, projectId: nil, branch: nil, worktreePath: nil, link: nil, error: "too_long", message: "Prompt is over \(Self.maxPromptChars) characters.")
    }

    var args: [String: JSONValue] = ["title": .string(cleanTitle)]
    if !cleanMessage.isEmpty { args["message"] = .string(cleanMessage) }
    let resolvedProjectId = String((projectId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
    if !resolvedProjectId.isEmpty {
      args["projectId"] = .string(resolvedProjectId)
    } else if scratch {
      args["scratch"] = .bool(true)
    }

    let cleanWorktreePath = String((worktreePath ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(1000))
    let cleanBranch = String((branch ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
    let cleanBaseRef = String((baseRef ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))

    if args["scratch"] != .bool(true) {
      if !cleanWorktreePath.isEmpty {
        args["workspaceStrategy"] = .object(["type": "existing_worktree", "worktreePath": .string(cleanWorktreePath)])
      } else if worktree || !cleanBranch.isEmpty || !cleanBaseRef.isEmpty {
        var strategy: [String: JSONValue] = ["type": "worktree"]
        if !cleanBranch.isEmpty { strategy["branch"] = .string(cleanBranch) }
        if !cleanBaseRef.isEmpty { strategy["baseRef"] = .string(cleanBaseRef) }
        if let startFromOrigin {
          strategy["startFromOrigin"] = .bool(startFromOrigin)
        } else if cleanBaseRef.contains("/") {
          strategy["startFromOrigin"] = .bool(true)
        }
        args["workspaceStrategy"] = .object(strategy)
      } else if !resolvedProjectId.isEmpty {
        args["workspaceStrategy"] = .object(["type": "root"])
      }
    }

    let res = await invoke("t3_thread_launch", arguments: args)
    guard res.ok, let data = res.data else {
      return T3NewSessionResult(ok: false, session: nil, threadId: nil, title: nil, projectId: nil, branch: nil, worktreePath: nil, link: nil, error: res.error, message: res.message)
    }

    var merged = data.objectValue ?? [:]
    merged["id"] = data["threadId"] ?? data["id"] ?? ""
    if merged["title"] == nil { merged["title"] = .string(cleanTitle) }
    if merged["branch"] == nil && !cleanBranch.isEmpty { merged["branch"] = .string(cleanBranch) }
    let session = rememberSession(.object(merged))
    if !session.id.isEmpty {
      lock.withLock { _activeThreadId = session.id }
      touchRecent(session.id)
    }
    return T3NewSessionResult(
      ok: true,
      session: session,
      threadId: session.id,
      title: session.title,
      projectId: resolvedProjectId.isEmpty ? data["projectId"]?.stringValue : resolvedProjectId,
      branch: session.branch,
      worktreePath: data["worktreePath"]?.stringValue ?? (session.cwd.isEmpty ? nil : session.cwd),
      link: data["link"]?.stringValue,
      error: nil,
      message: nil
    )
  }

  public func sendPrompt(
    _ text: String = "",
    threadId: String? = nil,
    mode: String = "auto",
    freshContext: Bool = false,
    clientRequestId: String? = nil
  ) async -> T3SendResult {
    let cleanMode = mode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard Self.sendModes.contains(cleanMode) else {
      return T3SendResult(ok: false, sent: false, threadId: nil, mode: nil, runId: nil, queuedRunId: nil, queued: false, link: nil, error: "invalid_mode", message: "Unsupported send mode \"\(cleanMode)\".")
    }

    var targetId = (threadId ?? activeThreadId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if targetId.isEmpty {
      let listed = await listSessions(limit: 10)
      guard listed.ok else {
        return T3SendResult(ok: false, sent: false, threadId: nil, mode: nil, runId: nil, queuedRunId: nil, queued: false, link: nil, error: listed.error, message: listed.message)
      }
      targetId = listed.sessions.first?.id ?? ""
    }
    guard !targetId.isEmpty else {
      return T3SendResult(ok: false, sent: false, threadId: nil, mode: nil, runId: nil, queuedRunId: nil, queued: false, link: nil, error: "no_active_thread", message: nil)
    }

    let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty else {
      return T3SendResult(ok: false, sent: false, threadId: targetId, mode: nil, runId: nil, queuedRunId: nil, queued: false, link: nil, error: "empty_text", message: nil)
    }
    guard clean.count <= Self.maxPromptChars else {
      return T3SendResult(ok: false, sent: false, threadId: targetId, mode: nil, runId: nil, queuedRunId: nil, queued: false, link: nil, error: "too_long", message: "Prompt is over \(Self.maxPromptChars) characters.")
    }

    var args: [String: JSONValue] = [
      "threadId": .string(targetId),
      "message": .string(clean),
      "mode": .string(cleanMode),
    ]
    if freshContext { args["freshContext"] = .bool(true) }
    if let cid = clientRequestId, !cid.isEmpty { args["clientRequestId"] = .string(String(cid.prefix(120))) }

    let res = await invoke("t3_thread_send", arguments: args)
    guard res.ok, let data = res.data else {
      return T3SendResult(ok: false, sent: false, threadId: targetId, mode: nil, runId: nil, queuedRunId: nil, queued: false, link: nil, error: res.error, message: res.message)
    }
    lock.withLock { _activeThreadId = targetId }
    touchRecent(targetId)
    return T3SendResult(
      ok: true,
      sent: true,
      threadId: targetId,
      mode: data["mode"]?.stringValue ?? cleanMode,
      runId: data["runId"]?.stringValue,
      queuedRunId: data["queuedRunId"]?.stringValue,
      queued: data["queued"] == .bool(true) || cleanMode == "queue",
      link: data["link"]?.stringValue,
      error: nil,
      message: nil
    )
  }

  public func interruptSession(
    threadId: String? = nil,
    runId: String? = nil,
    reason: String? = nil,
    stop: Bool? = nil
  ) async -> T3InterruptResult {
    let targetId = (threadId ?? activeThreadId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !targetId.isEmpty else {
      return T3InterruptResult(ok: false, stopped: false, threadId: nil, error: "no_active_thread", message: nil)
    }
    var args: [String: JSONValue] = ["threadId": .string(targetId)]
    if let runId, !runId.isEmpty { args["runId"] = .string(String(runId.prefix(120))) }
    if let reason, !reason.isEmpty { args["reason"] = .string(String(reason.prefix(200))) }
    if let stop { args["stop"] = .bool(stop) }

    let res = await invoke("t3_thread_interrupt", arguments: args)
    guard res.ok, let data = res.data else {
      return T3InterruptResult(ok: false, stopped: false, threadId: targetId, error: res.error, message: res.message)
    }
    touchRecent(targetId)
    return T3InterruptResult(ok: true, stopped: data["interrupted"] != .bool(false), threadId: targetId, error: nil, message: nil)
  }

  private static func normalizePendingRequest(_ raw: JSONValue, fallbackThreadId: String?) -> T3PendingRequest? {
    guard case .object = raw else { return nil }
    let id = clampStr(raw["requestId"] ?? raw["id"] ?? raw["key"], max: 200)
    guard !id.isEmpty else { return nil }

    let rawChoices: [JSONValue]
    if let c = raw["choices"]?.arrayValue {
      rawChoices = c
    } else if let o = raw["options"]?.arrayValue {
      rawChoices = o
    } else if let q0 = raw["questions"]?.arrayValue?.first, let o = q0["options"]?.arrayValue {
      rawChoices = o
    } else {
      rawChoices = []
    }

    let choices: [T3PendingChoice] = rawChoices.prefix(20).enumerated().map { idx, c in
      if let s = c.stringValue {
        return T3PendingChoice(n: idx + 1, id: nil, label: String(s.prefix(200)), description: "", selected: false)
      }
      let nVal = c["n"]?.doubleValue.flatMap { $0.rounded() == $0 ? Int($0) : nil } ?? (idx + 1)
      let cid = c["id"]?.stringValue.map { String($0.prefix(100)) }
      let label = clampStr(c["label"] ?? c["text"] ?? c["value"], max: 200)
      let desc = clampStr(c["description"], max: 300)
      return T3PendingChoice(n: nVal, id: cid, label: label, description: desc, selected: c["selected"] == .bool(true))
    }

    let q0 = raw["questions"]?.arrayValue?.first
    let question = clampStr(raw["question"] ?? q0?["question"] ?? raw["title"], max: 1000)
    let rawKind = clampStr(raw["kind"], max: 40).lowercased()
    let title = clampStr(raw["title"], max: 300)
    let tid = clampStr(raw["threadId"], max: 200)

    return T3PendingRequest(
      id: id,
      kind: rawKind.isEmpty ? "question" : rawKind,
      question: question,
      title: title.isEmpty ? String(question.prefix(300)) : title,
      detail: clampStr(raw["detail"], max: 1000),
      choices: choices,
      multiSelect: raw["multiSelect"] == .bool(true) || q0?["is_multi_select"] == .bool(true),
      canSkip: raw["canSkip"] == .bool(true),
      threadId: tid.isEmpty ? fallbackThreadId : tid
    )
  }

  public func getPendingRequest(threadId: String? = nil, requestId: String? = nil) async -> T3PendingResult {
    let targetId = (threadId ?? activeThreadId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    var listArgs: [String: JSONValue] = ["action": "list"]
    if !targetId.isEmpty { listArgs["threadId"] = .string(targetId) }

    let listRes = await invoke("t3_pending_request", arguments: listArgs)
    guard listRes.ok, let listData = listRes.data else {
      return T3PendingResult(ok: false, threadId: targetId.isEmpty ? nil : targetId, pending: nil, error: listRes.error, message: listRes.message)
    }

    let rawList: [JSONValue]
    if let reqs = listData["requests"]?.arrayValue {
      rawList = reqs
    } else if let ids = listData["requestIds"]?.arrayValue {
      rawList = ids.map { .object(["requestId": $0]) }
    } else {
      rawList = []
    }

    guard !rawList.isEmpty else {
      return T3PendingResult(ok: true, threadId: targetId.isEmpty ? nil : targetId, pending: nil, error: nil, message: nil)
    }

    let desiredId = (requestId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let chosen: JSONValue
    if !desiredId.isEmpty,
       let match = rawList.first(where: { ($0.stringValue ?? $0["requestId"]?.stringValue ?? $0["id"]?.stringValue) == desiredId }) {
      chosen = match
    } else {
      chosen = rawList[0]
    }
    let reqId = (chosen.stringValue ?? chosen["requestId"]?.stringValue ?? chosen["id"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

    var detailObj = chosen.objectValue ?? ["requestId": .string(reqId)]
    if !reqId.isEmpty {
      var readArgs: [String: JSONValue] = ["action": "read", "requestId": .string(reqId)]
      if !targetId.isEmpty { readArgs["threadId"] = .string(targetId) }
      let readRes = await invoke("t3_pending_request", arguments: readArgs)
      if readRes.ok, let readObj = readRes.data?.objectValue {
        for (k, v) in readObj { detailObj[k] = v }
        detailObj["requestId"] = .string(reqId)
      }
    }

    let pending = Self.normalizePendingRequest(.object(detailObj), fallbackThreadId: targetId.isEmpty ? nil : targetId)
    return T3PendingResult(ok: true, threadId: pending?.threadId ?? (targetId.isEmpty ? nil : targetId), pending: pending, error: nil, message: nil)
  }

  public func answerPendingRequest(
    threadId: String? = nil,
    requestId: String? = nil,
    answers: [String: JSONValue]? = nil,
    choice: String? = nil,
    option: Int = 0
  ) async -> T3AnswerResult {
    let targetId = (threadId ?? activeThreadId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    var reqId = (requestId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

    if reqId.isEmpty {
      let current = await getPendingRequest(threadId: targetId.isEmpty ? nil : targetId)
      guard current.ok else {
        return T3AnswerResult(ok: false, answered: false, requestId: nil, threadId: targetId.isEmpty ? nil : targetId, error: current.error, message: current.message)
      }
      guard let pending = current.pending else {
        return T3AnswerResult(ok: false, answered: false, requestId: nil, threadId: targetId.isEmpty ? nil : targetId, error: "no_pending_request", message: nil)
      }
      reqId = pending.id
    }

    let payload: [String: JSONValue]
    if let answers {
      payload = answers
    } else if let c = choice?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty {
      var p: [String: JSONValue] = ["choice": .string(c)]
      if option > 0 { p["option"] = .number(Double(option)) }
      payload = p
    } else {
      return T3AnswerResult(ok: false, answered: false, requestId: reqId, threadId: targetId.isEmpty ? nil : targetId, error: "missing_answers", message: nil)
    }

    var args: [String: JSONValue] = [
      "action": "respond",
      "requestId": .string(reqId),
      "answers": .object(payload),
    ]
    if !targetId.isEmpty { args["threadId"] = .string(targetId) }

    let res = await invoke("t3_pending_request", arguments: args)
    guard res.ok else {
      return T3AnswerResult(ok: false, answered: false, requestId: reqId, threadId: targetId.isEmpty ? nil : targetId, error: res.error, message: res.message)
    }
    if !targetId.isEmpty { touchRecent(targetId) }
    return T3AnswerResult(ok: true, answered: true, requestId: reqId, threadId: targetId.isEmpty ? nil : targetId, error: nil, message: nil)
  }
}
