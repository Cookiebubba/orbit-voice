// Claude voice's speech models (src/voice-models.js), downloaded only when the user turns it on:
// Silero VAD (when you start and stop talking), Moonshine base (speech to text) and Kitten nano (text
// to speech), about 175 MB from sherpa-onnx's GitHub releases; and the other speech-to-text choices,
// each downloaded when chosen. Every file is checked against a pinned SHA-256 before it's unpacked
// (/usr/bin/tar) or used, and a marker is written only after every check passed.
import CryptoKit
import Foundation
import OrbitIntent
import OrbitKit

public struct SpeechModelFile: Sendable {
  public let id: String
  public let file: String
  public let dir: String?
  public let url: String
  public let sha256: String
  public let size: Int

  public init(id: String, file: String, dir: String? = nil, url: String, sha256: String, size: Int) {
    self.id = id
    self.file = file
    self.dir = dir
    self.url = url
    self.sha256 = sha256
    self.size = size
  }
}

public struct SttChoice: Sendable {
  public let id: String
  public let label: String
  public let bundled: Bool
  public let maxSeconds: Int
  /** A download of its own (nil for Moonshine, which comes with the rest). */
  public let download: SpeechModelFile?
  public let files: [String]
}

public struct VoiceModelError: Error, CustomStringConvertible, Equatable {
  public let description: String
  public init(_ d: String) { description = d }
}

public final class VoiceModels: @unchecked Sendable {
  static let base = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

  public static let voice: [SpeechModelFile] = [
    SpeechModelFile(id: "vad", file: "silero_vad.onnx", url: "\(base)/asr-models/silero_vad.onnx", sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6", size: 643_854),
    SpeechModelFile(id: "stt", file: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2", dir: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
                    url: "\(base)/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2", sha256: "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891", size: 111_266_225),
    SpeechModelFile(id: "tts", file: "kitten-nano-en-v0_8-fp32.tar.bz2", dir: "kitten-nano-en-v0_8-fp32",
                    url: "\(base)/tts-models/kitten-nano-en-v0_8-fp32.tar.bz2", sha256: "16092117bfe591ddcd58d078e1454603b8e1caea46f85653b2c2efae76bd883e", size: 63_815_222),
  ]

  public static let stt: [SttChoice] = [
    SttChoice(id: "moonshine", label: "Moonshine base", bundled: true, maxSeconds: 8, download: nil, files: []),
    SttChoice(id: "parakeet-110m", label: "Parakeet 110M", bundled: false, maxSeconds: 28,
              download: SpeechModelFile(id: "parakeet-110m", file: "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2", dir: "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8",
                                        url: "\(base)/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2", sha256: "17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b", size: 104_337_827),
              files: ["model.int8.onnx", "tokens.txt"]),
    SttChoice(id: "parakeet-v2", label: "Parakeet 0.6B v2", bundled: false, maxSeconds: 28,
              download: SpeechModelFile(id: "parakeet-v2", file: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2", dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
                                        url: "\(base)/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2", sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad", size: 482_468_385),
              files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]),
  ]

  /** VOICE_MODELS_MB */
  public static var mb: Int { Int((Double(voice.reduce(0) { $0 + $1.size }) / 1_048_576).rounded(.toNearestOrAwayFromZero)) }
  public static var sttIds: [String] { stt.map(\.id) }
  public static func sttOk(_ id: JSONValue?) -> Bool { id?.stringValue.map { s in stt.contains { $0.id == s } } ?? false }
  static func choice(_ id: String) -> SttChoice? { stt.first { $0.id == id } }

  /** A response's status and its body as chunks (nil body: none). Tests pass a stand-in. */
  public typealias Fetcher = @Sendable (URL) async throws -> (status: Int, body: AsyncThrowingStream<Data, Error>?)

  public let root: String
  let voiceCatalog: [SpeechModelFile]
  let sttCatalog: [SttChoice]
  let fetch: Fetcher
  let log: @Sendable (String) -> Void
  private let lock = NSLock()
  private var job: Task<Void, Error>?
  private var progress: (state: String, percent: Int, error: String) = ("idle", 0, "")
  private var sttJobs: [String: Task<Void, Error>] = [:]
  private var sttProgress: [String: (state: String, percent: Int, error: String)] = [:]

  public init(root: String, fetch: @escaping Fetcher = VoiceModels.urlSessionFetch, log: @escaping @Sendable (String) -> Void = { _ in },
              voiceCatalog: [SpeechModelFile] = VoiceModels.voice, sttCatalog: [SttChoice] = VoiceModels.stt) {
    self.root = root
    self.fetch = fetch
    self.log = log
    self.voiceCatalog = voiceCatalog
    self.sttCatalog = sttCatalog
  }

  func p(_ parts: String...) -> String { MacSystem.join(([root] + parts).joined(separator: "/")) }

  // MARK: paths and readiness

  /** modelPaths(root): what the engine loads. */
  public static func paths(root: String) -> JSONValue {
    let j = { (parts: [String]) in JSONValue.string(MacSystem.join(([root] + parts).joined(separator: "/"))) }
    let stt = voice[1].dir!, tts = voice[2].dir!
    return [
      "vad": j([voice[0].file]),
      "stt": ["encoder": j([stt, "encoder_model.ort"]), "mergedDecoder": j([stt, "decoder_model_merged.ort"]), "tokens": j([stt, "tokens.txt"])],
      "tts": ["model": j([tts, "model.fp32.onnx"]), "voices": j([tts, "voices.bin"]), "tokens": j([tts, "tokens.txt"]), "dataDir": j([tts, "espeak-ng-data"])],
    ]
  }

  static func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }

  /** Every model unpacked and verified (the marker is written only after all checks passed). */
  public var ready: Bool {
    guard !root.isEmpty else { return false }
    let paths = Self.paths(root: root)
    let files = [paths["vad"], paths["stt"]?["encoder"], paths["stt"]?["mergedDecoder"], paths["tts"]?["model"], paths["tts"]?["voices"]].compactMap { $0?.stringValue }
    return Self.exists(p("verified.json")) && files.allSatisfy(Self.exists)
  }

  /** {state: idle | downloading | ready | error, percent, error} */
  public func status() -> JSONValue {
    let pr = lock.withLock { progress }
    if pr.state != "downloading" && ready { return ["state": "ready", "percent": 100, "error": ""] }
    return ["state": .string(pr.state), "percent": .number(Double(pr.percent)), "error": .string(pr.error)]
  }

  /** sherpa-onnx's modelConfig for a speech-to-text choice (Moonshine, the bundled one, for anything unknown). */
  public static func sttConfig(root: String, id: String?) -> JSONValue {
    let j = { (parts: [String]) in JSONValue.string(MacSystem.join(([root] + parts).joined(separator: "/"))) }
    guard let id, let c = choice(id), let d = c.download?.dir else {
      let p = paths(root: root)["stt"]!
      return ["moonshine": ["encoder": p["encoder"]!, "mergedDecoder": p["mergedDecoder"]!], "tokens": p["tokens"]!]
    }
    if id == "parakeet-110m" { return ["nemoCtc": ["model": j([d, "model.int8.onnx"])], "tokens": j([d, "tokens.txt"])] }
    return ["transducer": ["encoder": j([d, "encoder.int8.onnx"]), "decoder": j([d, "decoder.int8.onnx"]), "joiner": j([d, "joiner.int8.onnx"])], "tokens": j([d, "tokens.txt"]), "modelType": "nemo_transducer"]
  }

  /** Is this speech-to-text choice on disk and verified? (Moonshine: with the rest of Claude voice.) */
  public func sttReady(_ id: String) -> Bool {
    guard !root.isEmpty, let c = sttCatalog.first(where: { $0.id == id }) else { return false }
    if c.bundled { return ready }
    guard let dl = c.download, let dir = dl.dir,
          let data = FileManager.default.contents(atPath: p(dir, "verified.json")), let marker = try? JSONValue.parse(data) else { return false }
    return marker["sha256"]?.stringValue == dl.sha256 && c.files.allSatisfy { Self.exists(p(dir, $0)) }
  }

  /** {[id]: {state, percent, error, mb}} */
  public func sttStatus() -> JSONValue {
    var out: [String: JSONValue] = [:]
    for c in sttCatalog {
      let mb = JSONValue.number((Double(c.download?.size ?? 0) / 1_048_576).rounded(.toNearestOrAwayFromZero))
      let pr = lock.withLock { sttProgress[c.id] }
      let s: (state: String, percent: Int, error: String) = pr?.state == "downloading" ? pr! : sttReady(c.id) ? ("ready", 100, "") : (pr ?? ("idle", 0, ""))
      out[c.id] = ["state": .string(s.state), "percent": .number(Double(s.percent)), "error": .string(s.error), "mb": mb]
    }
    return .object(out)
  }

  // MARK: downloads

  /** Download, verify and unpack every model; a call while one runs waits for that one. */
  public func download() async throws { try await startDownload()?.value }

  /** Starts the download (the state says "downloading" from here on), or nil when they're ready. */
  @discardableResult
  public func startDownload() -> Task<Void, Error>? {
    if ready { return nil }
    return lock.withLock {
      if let job { return job }
      progress = ("downloading", 0, "")
      let t = Task { [self] in
        do {
          try await self.runDownload()
          self.lock.withLock {
            self.progress = ("ready", 100, "")
            self.job = nil
          }
        } catch {
          self.lock.withLock {
            self.progress = ("error", 0, JS.slice(Self.message(error), 0, 200))
            self.job = nil
          }
          throw error
        }
      }
      job = t
      return t
    }
  }

  /** What went wrong, in the words the core uses. */
  static func message(_ e: Error) -> String { (e as? VoiceModelError)?.description ?? e.localizedDescription }

  private func runDownload() async throws {
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    let total = voiceCatalog.reduce(0) { $0 + $1.size }
    var done = 0
    for m in voiceCatalog {
      let doneSoFar = done
      try await fetchVerified(m) { got in
        self.lock.withLock { self.progress.percent = min(99, Int((Double(doneSoFar + got) / Double(total) * 100).rounded(.down))) }
      }
      done += m.size
      log("Claude voice: \(m.id) model ready")
    }
    let marker: [String: Any] = ["at": ISO8601DateFormatter.js.string(from: Date()), "models": voiceCatalog.map(\.sha256)]
    try JSONSerialization.data(withJSONObject: marker).write(to: URL(fileURLWithPath: p("verified.json")))
  }

  /** Fetch one file to <file>.part (no larger than it should be), check its hash, rename it, and unpack an archive. */
  private func fetchVerified(_ m: SpeechModelFile, label: String? = nil, progress: @escaping (Int) -> Void) async throws {
    let dest = p(m.file)
    let part = dest + ".part"
    guard let url = URL(string: m.url) else { throw VoiceModelError("Download failed (bad address)") }
    let (status, body) = try await fetch(url)
    guard (200..<300).contains(status), let body else { throw VoiceModelError("Download failed (HTTP \(status))") }
    FileManager.default.createFile(atPath: part, contents: nil)
    guard let out = FileHandle(forWritingAtPath: part) else { throw VoiceModelError("Could not write \(m.file)") }
    var hash = SHA256()
    var got = 0
    do {
      for try await chunk in body {
        got += chunk.count
        if Double(got) > Double(m.size) * 1.01 + 1024 { throw VoiceModelError("Download was larger than expected") }
        try out.write(contentsOf: chunk)
        hash.update(data: chunk)
        progress(got)
      }
      try out.close()
    } catch {
      try? out.close()
      try? FileManager.default.removeItem(atPath: part)
      throw error
    }
    let hex = hash.finalize().map { String(format: "%02x", $0) }.joined()
    if hex != m.sha256 {
      try? FileManager.default.removeItem(atPath: part)
      throw VoiceModelError("\(label ?? "\(m.id) model") failed its checksum")
    }
    try? FileManager.default.removeItem(atPath: dest)
    try FileManager.default.moveItem(atPath: part, toPath: dest)
    if let dir = m.dir {
      try? FileManager.default.removeItem(atPath: p(dir))
      try await untar(dest)
      try? FileManager.default.removeItem(atPath: dest)
    }
  }

  /** /usr/bin/tar by its full path (a tar planted on PATH is never used). */
  private func untar(_ archive: String) async throws {
    let child = try ChildProcess("/usr/bin/tar", ["-xjf", archive, "-C", root], cwd: root, env: ["PATH": "/usr/bin:/bin"], stdin: nil)
    let r = await child.finished()
    if r.code != 0 { throw VoiceModelError("Unpacking failed (tar exit \(r.code.map(String.init) ?? "null"))") }
  }

  /** Download, verify and unpack one speech-to-text choice (one job per model at a time). */
  public func downloadStt(_ id: String) async throws { try await startStt(id)?.value }

  /** Starts one choice's download (Moonshine: all of Claude voice's), or nil when it's there. */
  @discardableResult
  public func startStt(_ id: String) throws -> Task<Void, Error>? {
    guard let c = sttCatalog.first(where: { $0.id == id }) else { throw VoiceModelError("Unknown speech-to-text model") }
    if c.bundled { return startDownload() }
    if sttReady(id) { return nil }
    guard let m = c.download, let dir = m.dir else { return nil }
    return lock.withLock {
      if let j = sttJobs[id] { return j }
      sttProgress[id] = ("downloading", 0, "")
      let t = Task { [self] in
        do {
          try FileManager.default.createDirectory(atPath: self.root, withIntermediateDirectories: true)
          try await self.fetchVerified(m, label: c.label) { got in
            self.lock.withLock { self.sttProgress[id] = ("downloading", min(99, Int((Double(got) / Double(m.size) * 100).rounded(.down))), "") }
          }
          guard c.files.allSatisfy({ Self.exists(self.p(dir, $0)) }) else { throw VoiceModelError("\(c.label) unpacked without its model files") }
          let marker: [String: Any] = ["at": ISO8601DateFormatter.js.string(from: Date()), "sha256": m.sha256]
          try JSONSerialization.data(withJSONObject: marker).write(to: URL(fileURLWithPath: self.p(dir, "verified.json")))
          self.lock.withLock {
            self.sttProgress[id] = ("ready", 100, "")
            self.sttJobs[id] = nil
          }
          self.log("Claude voice: \(c.label) ready")
        } catch {
          self.lock.withLock {
            self.sttProgress[id] = ("error", 0, JS.slice(Self.message(error), 0, 200))
            self.sttJobs[id] = nil
          }
          throw error
        }
      }
      sttJobs[id] = t
      return t
    }
  }

  // MARK: fetching (URLSession, following redirects, the body as it comes)

  public static let urlSessionFetch: Fetcher = { url in
    let relay = StreamRelay()
    let session = URLSession(configuration: .ephemeral, delegate: relay, delegateQueue: nil)
    let status = try await relay.start(session.dataTask(with: url))
    return (status, relay.stream)
  }
}

/** One download's response, then its bytes as they arrive, for VoiceModels.urlSessionFetch. */
final class StreamRelay: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var head: CheckedContinuation<Int, Error>?
  private var cont: AsyncThrowingStream<Data, Error>.Continuation?
  let stream: AsyncThrowingStream<Data, Error>

  override init() {
    var c: AsyncThrowingStream<Data, Error>.Continuation?
    stream = AsyncThrowingStream(bufferingPolicy: .unbounded) { c = $0 }
    super.init()
    cont = c
  }

  func start(_ task: URLSessionDataTask) async throws -> Int {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Int, Error>) in
      lock.withLock { head = c }
      cont?.onTermination = { @Sendable _ in task.cancel() }
      task.resume()
    }
  }

  private func takeHead() -> CheckedContinuation<Int, Error>? { lock.withLock { defer { head = nil }; return head } }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    completionHandler(.allow)
    takeHead()?.resume(returning: (response as? HTTPURLResponse)?.statusCode ?? 0)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) { cont?.yield(data) }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let h = takeHead() {
      h.resume(throwing: error ?? VoiceModelError("Download failed (no response)"))
    }
    if let error { cont?.finish(throwing: error) } else { cont?.finish() }
    session.finishTasksAndInvalidate()
  }
}

extension ISO8601DateFormatter {
  /** new Date().toISOString(): UTC with milliseconds. */
  static var js: ISO8601DateFormatter {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }
}
