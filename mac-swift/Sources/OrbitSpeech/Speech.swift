// Orbit's on-device speech in Swift (phase 2, step 1): Silero VAD, Moonshine speech to text and
// Kitten text to speech through sherpa-onnx's C API, with the same models, settings and audio
// handling as the Node core (src/claude-voice.js loadSpeech, src/stt-chunks.js, src/voice-models.js),
// so either side hears and speaks the same. The library is the one the core already ships
// (node_modules/sherpa-onnx-darwin-*/libsherpa-onnx-c-api.dylib, v1.13.8); its header and the
// upstream Swift wrapper are vendored (Sources/SherpaOnnxC, Vendor/SherpaOnnx.swift; Apache-2.0).
import Foundation
import SherpaOnnxC

/** The engine's constants, as src/claude-voice.js has them. */
public enum SpeechConfig {
  public static let inRate = 24_000 // what the page sends and plays
  public static let vadRate = 16_000
  public static let window = 512
  public static let endOfTurnS: Float = 0.45
  public static let moonshineMaxS = 8.0
  public static let threads = 4
}

/** Where the models are under the speech models folder (src/voice-models.js modelPaths). */
public struct SpeechModelPaths: Sendable, Equatable {
  public var vad: String
  public var sttEncoder: String, sttMergedDecoder: String, sttTokens: String
  public var ttsModel: String, ttsVoices: String, ttsTokens: String, ttsDataDir: String

  public init(root: URL) {
    let stt = root.appendingPathComponent("sherpa-onnx-moonshine-base-en-quantized-2026-02-27")
    let tts = root.appendingPathComponent("kitten-nano-en-v0_8-fp32")
    vad = root.appendingPathComponent("silero_vad.onnx").path
    sttEncoder = stt.appendingPathComponent("encoder_model.ort").path
    sttMergedDecoder = stt.appendingPathComponent("decoder_model_merged.ort").path
    sttTokens = stt.appendingPathComponent("tokens.txt").path
    ttsModel = tts.appendingPathComponent("model.fp32.onnx").path
    ttsVoices = tts.appendingPathComponent("voices.bin").path
    ttsTokens = tts.appendingPathComponent("tokens.txt").path
    ttsDataDir = tts.appendingPathComponent("espeak-ng-data").path
  }

  /** modelsReady: every file there and the verified marker written. */
  public func ready(root: URL) -> Bool {
    let fm = FileManager.default
    return fm.fileExists(atPath: root.appendingPathComponent("verified.json").path) && [vad, sttEncoder, sttMergedDecoder, ttsModel, ttsVoices].allSatisfy { fm.fileExists(atPath: $0) }
  }
}

/** Long speech split for Moonshine (src/stt-chunks.js): pieces of at most `maxSeconds`, each cut at
 *  the quietest 100 ms between half and all of the limit; pieces under 0.1 s dropped. */
public enum SttChunks {
  public static func split(_ s: [Float], maxSeconds: Double, rate: Int = SpeechConfig.vadRate) -> [ArraySlice<Float>] {
    let frame = 320
    let maxN = max(1, Int(floor(maxSeconds * Double(rate))))
    var pieces: [ArraySlice<Float>] = []
    var start = 0
    while s.count - start > maxN {
      let lo = start + maxN / 2, hi = start + maxN
      var frames: [(at: Int, e: Float)] = []
      var i = lo
      while i + frame <= hi {
        var e: Float = 0
        for j in i..<(i + frame) { e += s[j] * s[j] }
        frames.append((i, e / Float(frame)))
        i += frame
      }
      var cut = hi
      var best = Float.infinity
      var k = 0
      while k + 5 <= frames.count {
        var e: Float = 0
        for m in k..<(k + 5) { e += frames[m].e }
        if e < best { best = e; cut = frames[k + 2].at + frame / 2 }
        k += 1
      }
      pieces.append(s[start..<cut])
      start = cut
    }
    pieces.append(s[start...])
    return pieces.filter { Double($0.count) > Double(rate) * 0.1 }
  }

  public static func join(_ texts: [String]) -> String {
    texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
  }
}

/** A linear resampler (sherpa-onnx's, as the core uses). */
public final class LinearResampler {
  private let ptr: OpaquePointer
  public init(from: Int, to: Int) {
    let lowpass = Float(min(from, to)) / 2 * 0.99 // (sherpa's own default cutoff)
    ptr = SherpaOnnxCreateLinearResampler(Int32(from), Int32(to), lowpass, 6)
  }
  deinit { SherpaOnnxDestroyLinearResampler(ptr) }

  public func resample(_ s: [Float], flush: Bool) -> [Float] {
    guard let out = SherpaOnnxLinearResamplerResample(ptr, s, Int32(s.count), flush ? 1 : 0) else { return [] }
    defer { SherpaOnnxLinearResamplerResampleFree(out) }
    return Array(UnsafeBufferPointer(start: out.pointee.samples, count: Int(out.pointee.n)))
  }
}

/** Silero VAD with the engine's settings: when you start and stop talking. */
public final class SpeechVad {
  private let vad: SherpaOnnxVoiceActivityDetectorWrapper
  public init(paths: SpeechModelPaths) {
    let silero = sherpaOnnxSileroVadModelConfig(model: paths.vad, threshold: 0.5, minSilenceDuration: SpeechConfig.endOfTurnS, minSpeechDuration: 0.25, windowSize: SpeechConfig.window, maxSpeechDuration: 30)
    var config = sherpaOnnxVadModelConfig(sileroVad: silero, sampleRate: Int32(SpeechConfig.vadRate), numThreads: 1, provider: "cpu")
    vad = SherpaOnnxVoiceActivityDetectorWrapper(config: &config, buffer_size_in_seconds: 60)
  }
  public func accept(_ samples16k: [Float]) { vad.acceptWaveform(samples: samples16k) }
  public var speaking: Bool { vad.isSpeechDetected() }
  public var hasSegment: Bool { !vad.isEmpty() }
  /** The oldest finished speech segment's samples (16 kHz), removed from the queue. */
  public func popSegment() -> [Float]? {
    guard !vad.isEmpty() else { return nil }
    let seg = vad.front()
    let s = seg.samples
    vad.pop()
    return s
  }
  public func flush() { vad.flush() }
  public func reset() { vad.reset() }
}

/** Moonshine (speech to text) and Kitten (text to speech), loaded once. */
public final class OrbitSpeech: @unchecked Sendable {
  public let paths: SpeechModelPaths
  private let recognizer: SherpaOnnxOfflineRecognizer
  private let tts: SherpaOnnxOfflineTtsWrapper
  private let lock = NSLock()

  public init(root: URL, threads: Int = SpeechConfig.threads) throws {
    paths = SpeechModelPaths(root: root)
    guard paths.ready(root: root) else { throw SpeechError.modelsMissing(root.path) }
    let moon = sherpaOnnxOfflineMoonshineModelConfig(encoder: paths.sttEncoder, mergedDecoder: paths.sttMergedDecoder)
    let model = sherpaOnnxOfflineModelConfig(tokens: paths.sttTokens, numThreads: threads, provider: "cpu", moonshine: moon)
    var rc = sherpaOnnxOfflineRecognizerConfig(featConfig: sherpaOnnxFeatureConfig(sampleRate: SpeechConfig.vadRate, featureDim: 80), modelConfig: model)
    recognizer = SherpaOnnxOfflineRecognizer(config: &rc)
    let kitten = sherpaOnnxOfflineTtsKittenModelConfig(model: paths.ttsModel, voices: paths.ttsVoices, tokens: paths.ttsTokens, dataDir: paths.ttsDataDir)
    var tc = sherpaOnnxOfflineTtsConfig(model: sherpaOnnxOfflineTtsModelConfig(numThreads: threads, provider: "cpu", kitten: kitten), maxNumSentences: 1)
    tts = SherpaOnnxOfflineTtsWrapper(config: &tc)
  }

  public func newVad() -> SpeechVad { SpeechVad(paths: paths) }

  /** 16 kHz samples → text; long speech in pieces, as the core does. */
  public func transcribe(_ samples16k: [Float]) -> String {
    lock.withLock {
      SttChunks.join(SttChunks.split(samples16k, maxSeconds: SpeechConfig.moonshineMaxS).map { piece in
        let stream = recognizer.createStream()
        stream.acceptWaveform(samples: Array(piece), sampleRate: SpeechConfig.vadRate)
        recognizer.decode(stream: stream)
        return recognizer.getResult(stream: stream).text
      })
    }
  }

  /** Text → 24 kHz samples (the engine's output rate). */
  public func speak(_ text: String, sid: Int = 0, speed: Float = 1) -> [Float] {
    lock.withLock {
      let a = tts.generate(text: text, sid: sid, speed: speed)
      let s = a.samples
      return Int(a.sampleRate) == SpeechConfig.inRate ? s : LinearResampler(from: Int(a.sampleRate), to: SpeechConfig.inRate).resample(s, flush: true)
    }
  }

  public static var libraryVersion: String { String(cString: SherpaOnnxGetVersionStr()) }
}

public enum SpeechError: Error, Equatable { case modelsMissing(String) }
