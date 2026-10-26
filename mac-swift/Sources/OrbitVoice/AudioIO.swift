// The voice's audio device side: AVAudioEngine mic capture → 24 kHz PCM16 frames, and playback of
// the voice's chunks at the times VoiceSession gives them (on the host-time clock), through a mixer
// for Settings → Voice → Volume; the chimes on their own player. No call logic here.
//
// Test switches (parity/PROTOCOL.md):
//   ORBIT_MUTE_OUTPUT=1   the voice is "played" (timed and counted by VoiceSession) but nothing
//                         reaches the speakers; the output device is never opened.
//   ORBIT_FAKE_MIC=<wav>  the microphone is that file played in real time (any rate or channels,
//                         resampled), then silence; play(wav:) queues another clip. Set but empty
//                         (or "silence"): a fake mic that starts silent. The real mic is never
//                         touched, so no microphone permission is needed.
import AVFoundation
import CoreAudio
import Foundation
import OrbitKit

/** The host-time clock playback is scheduled on (AudioContext.currentTime's role). */
public final class HostAudioClock: AudioClock, @unchecked Sendable {
  private let lock = NSLock()
  private var latency = 0.0
  public init() {}
  public var audioTime: Double { AVAudioTime.seconds(forHostTime: mach_absolute_time()) }
  public var outputLatency: Double {
    get { lock.lock(); defer { lock.unlock() }; return latency }
    set { lock.lock(); latency = newValue; lock.unlock() }
  }
}

@MainActor
public final class AudioIO {
  public struct Config: Sendable {
    public var muteOutput: Bool
    /** Use the stand-in microphone instead of the real one. */
    public var fakeMic: Bool
    /** Its first clip (played when the mic first opens). */
    public var fakeMicClip: URL?
    /** Echo cancellation on the real mic (macOS voice processing), as the page asks getUserMedia for. */
    public var voiceProcessing: Bool
    public init(muteOutput: Bool = false, fakeMic: Bool = false, fakeMicClip: URL? = nil, voiceProcessing: Bool = true) {
      self.muteOutput = muteOutput; self.fakeMic = fakeMic || fakeMicClip != nil; self.fakeMicClip = fakeMicClip; self.voiceProcessing = voiceProcessing
    }
    /** From ORBIT_MUTE_OUTPUT, ORBIT_FAKE_MIC and ORBIT_NO_AEC. */
    public static func fromEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> Config {
      let fake = env["ORBIT_FAKE_MIC"]
      return Config(muteOutput: env["ORBIT_MUTE_OUTPUT"] == "1", fakeMic: fake != nil,
                    fakeMicClip: fake.flatMap { $0.isEmpty || $0 == "silence" ? nil : URL(fileURLWithPath: $0) },
                    voiceProcessing: env["ORBIT_NO_AEC"] != "1")
    }
  }

  public let config: Config
  public let clock = HostAudioClock()
  /** 24 kHz PCM16, ~100 ms each, on the main thread. */
  public var onFrame: ([Int16]) -> Void = { _ in }
  /** The output was reset (device change): scheduled audio is gone. */
  public var onOutputLost: () -> Void = {}
  /** Where the voice plays and when that changes (device names only), for the app's log. */
  public var log: (String) -> Void = { _ in }
  /**
   * A second listener on the same microphone ("Hey Orbit", while the call is off or asleep): gets the
   * same 24 kHz frames, on the main thread, whether or not a call has the mic open.
   */
  private var wakeListener: (([Int16]) -> Void)?

  // Counts (also kept when muted): chunks and seconds handed to playback.
  public private(set) var chunksScheduled = 0
  public private(set) var secondsScheduled = 0.0
  /** Chunks the output really played (AVAudioPlayerNode's played-back callbacks; 0 when muted). */
  public private(set) var chunksPlayedBack = 0
  /** How late the last chunk finished against its scheduled end (s): the host-time scheduling check. */
  public private(set) var lastPlaybackLateness = 0.0

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let voiceMixer = AVAudioMixerNode()
  private let chimePlayer = AVAudioPlayerNode()
  private let voiceFormat = AVAudioFormat(standardFormatWithSampleRate: VoiceAudio.rate, channels: 1)!
  private let chimeFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
  private var graphReady = false
  private var capturing = false
  private var tapInstalled = false
  private var capture: CaptureConverter?
  private var fakeMic: FakeMic?
  private var configObserver: NSObjectProtocol?
  private var idleStop: DispatchWorkItem?

  public init(config: Config = .fromEnvironment()) {
    self.config = config
    if config.fakeMic {
      let fm = FakeMic(initial: config.fakeMicClip)
      fm.deliver = { [weak self] pcm in
        DispatchQueue.main.async { MainActor.assumeIsolated { self?.frame(pcm) } }
      }
      fakeMic = fm
    }
    configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.configurationChanged() }
    }
    if !config.muteOutput { followDefaultOutput() }
  }

  // MARK: - which output the voice plays on

  /**
   * The Mac's default output changed (headphones in, AirPods, a display, a choice in Control
   * Center): the voice follows it. With echo cancellation on, the engine stays on the device it
   * started with, so it's restarted as for a device change. (The preview in Settings always plays
   * on the default output: a call that didn't follow it played where nobody was listening.)
   */
  private func followDefaultOutput() {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.defaultOutputChanged() } }
    }
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, block)
  }

  private func defaultOutputChanged() {
    log("default output is now \(Self.deviceName(Self.defaultOutputDevice))")
    guard graphReady, engine.isRunning else { return }
    log("the voice moves to it")
    engine.stop()
    configurationChanged()
  }

  static var defaultOutputDevice: AudioDeviceID {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return id
  }

  static func deviceName(_ id: AudioDeviceID) -> String {
    guard id != 0 else { return "none" }
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr, let n = name?.takeRetainedValue() else { return "device \(id)" }
    return n as String
  }

  /** The device the engine's output really plays on (with echo cancellation, possibly not the default). */
  var engineOutputDevice: AudioDeviceID? {
    guard let unit = engine.outputNode.audioUnit else { return nil }
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, &size) == noErr else { return nil }
    return id
  }

  /** "on <device> (the default: <device>), echo cancellation on|off", for the log at the start of a call. */
  public var outputDescription: String {
    let def = Self.defaultOutputDevice
    let cur = engineOutputDevice
    let on = cur.map { Self.deviceName($0) } ?? "the default output"
    let same = cur == nil || cur == def
    return "voice plays on \(on)\(same ? "" : " (the default output is \(Self.deviceName(def)))"), echo cancellation \(engine.inputNode.isVoiceProcessingEnabled ? "on" : "off")"
  }

  /** "running", or why not, for ui.bye. */
  public var stateName: String { config.muteOutput || engine.isRunning ? "running" : "suspended" }

  // MARK: - output

  private func ensureGraph() {
    guard !graphReady else { return }
    graphReady = true
    engine.attach(player)
    engine.attach(voiceMixer)
    engine.attach(chimePlayer)
    engine.connect(player, to: voiceMixer, format: voiceFormat)
    engine.connect(voiceMixer, to: engine.mainMixerNode, format: voiceFormat)
    engine.connect(chimePlayer, to: engine.mainMixerNode, format: chimeFormat)
  }

  /** Start the engine (and the players) if it isn't running. */
  @discardableResult private func ensureRunning() -> Bool {
    idleStop?.cancel()
    ensureGraph()
    if !engine.isRunning {
      engine.prepare()
      do { try engine.start() } catch { return false }
      // A player that was playing before the engine stopped (the mic opening restarts it for echo
      // cancellation; a device change) still says it is playing but never sounds again: nothing it's
      // given is heard. Stop them so they start afresh below.
      player.stop()
      chimePlayer.stop()
    }
    if !player.isPlaying { player.play() }
    if !chimePlayer.isPlaying { chimePlayer.play() }
    clock.outputLatency = engine.outputNode.presentationLatency
    return true
  }

  /** Tests: the engine stops and starts again, as it does when the mic opens for a call. */
  func restartEngine() {
    engine.stop()
    ensureRunning()
  }

  /** A call is starting: get the output ready so the first chunk isn't late. */
  public func prepareOutput() {
    if !config.muteOutput { ensureRunning() }
  }

  /**
   * How far (host seconds) the engine has rendered: its last render cycle's time plus one cycle
   * (about 10 ms of output on a Mac; 15 ms allowed). A buffer due before this is already too late
   * for that much of it. 0 if the player hasn't rendered yet (nothing can be late then).
   */
  private func renderedUpTo() -> Double {
    guard player.isPlaying, let last = player.lastRenderTime, last.isHostTimeValid else { return 0 }
    return AVAudioTime.seconds(forHostTime: last.hostTime) + 0.015
  }

  /** One call's voice output, for the log when it ends: what was scheduled, late, and really heard. */
  final class Meter: @unchecked Sendable {
    private let lock = NSLock()
    private var scheduledS = 0.0, lateChunks = 0, maxLateMs = 0.0, audibleS = 0.0, peak: Float = 0
    func reset() { lock.withLock { scheduledS = 0; lateChunks = 0; maxLateMs = 0; audibleS = 0; peak = 0 } }
    func scheduled(_ s: Double) { lock.withLock { scheduledS += s } }
    func late(ms: Double) { lock.withLock { lateChunks += 1; maxLateMs = max(maxLateMs, ms) } }
    /** A buffer that left the voice's mixer (the render thread): how loud, how long. */
    func rendered(_ buf: AVAudioPCMBuffer) {
      guard let d = buf.floatChannelData?[0] else { return }
      let n = Int(buf.frameLength)
      var p: Float = 0
      for i in 0..<n { p = max(p, abs(d[i])) }
      let secs = Double(n) / buf.format.sampleRate
      lock.withLock {
        peak = max(peak, p)
        if p > 0.01 { audibleS += secs }
      }
    }
    var summary: (scheduled: Double, late: Int, maxLateMs: Double, audible: Double, peak: Float) {
      lock.withLock { (scheduledS, lateChunks, maxLateMs, audibleS, peak) }
    }
  }
  let meter = Meter()
  private var meterTapped = false

  /** The voice's mixer is watched while a call is on (its level, after the volume). */
  private func tapMeter() {
    guard !meterTapped, graphReady else { return }
    meterTapped = true
    let m = meter
    voiceMixer.installTap(onBus: 0, bufferSize: 2048, format: nil) { @Sendable buf, _ in m.rendered(buf) }
  }

  /** Once per call, once its mic is open: where the voice will play (the log), and its meter starts. */
  public func logOutput() {
    guard !config.muteOutput else { return }
    meter.reset()
    tapMeter()
    log(outputDescription)
  }

  /** The call's voice output, for the log as it ends (seconds and levels only). */
  public func logCallOutput() {
    guard !config.muteOutput, meterTapped else { return }
    let s = meter.summary
    guard s.scheduled > 0 else { return }
    let r1 = { (v: Double) in String(format: "%.1f", v) }
    log("voice output: \(r1(s.scheduled))s scheduled, \(r1(s.audible))s left the mixer with sound (peak \(String(format: "%.2f", s.peak))), \(s.late) chunk(s) late\(s.late > 0 ? " (up to \(Int(s.maxLateMs)) ms, played at once)" : "")")
    meter.reset()
  }

  /** The call ended: let the device go after a moment (a chime may still be playing). */
  public func callEnded() {
    logCallOutput()
    guard !capturing, wakeListener == nil else { return }
    idleStop?.cancel()
    let w = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self, !self.capturing, self.wakeListener == nil else { return }
        self.player.stop()
        self.chimePlayer.stop()
        self.engine.stop()
      }
    }
    idleStop = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: w)
  }

  /**
   * Play a chunk at `chunk.at` on the host clock. A chunk whose start the engine has already passed
   * (it renders ahead of the speakers, more so with echo cancellation) would have that much of it
   * skipped, all of it if it's short, while still counting as played: it plays at once instead,
   * right after anything still queued.
   */
  public func schedule(_ chunk: PlaybackChunk) {
    chunksScheduled += chunk.isTail ? 0 : 1
    secondsScheduled += chunk.isTail ? 0 : chunk.duration
    guard !config.muteOutput, !chunk.samples.isEmpty, ensureRunning() else { return }
    guard let buf = AVAudioPCMBuffer(pcmFormat: voiceFormat, frameCapacity: AVAudioFrameCount(chunk.samples.count)) else { return }
    buf.frameLength = AVAudioFrameCount(chunk.samples.count)
    chunk.samples.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress!, count: src.count) }
    var when: AVAudioTime? = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: chunk.at))
    let lateBy = renderedUpTo() - chunk.at
    if lateBy > 0 {
      when = nil
      meter.late(ms: lateBy * 1000)
    }
    meter.scheduled(chunk.isTail ? 0 : chunk.duration)
    let end = chunk.at + chunk.duration
    let clock = self.clock
    player.scheduleBuffer(buf, at: when, options: [], completionCallbackType: .dataPlayedBack) { @Sendable [weak self] _ in
      let late = clock.audioTime - end
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.chunksPlayedBack += 1
          self?.lastPlaybackLateness = late
        }
      }
    }
  }

  /** Barge-in or hang-up: drop everything scheduled. */
  public func stopPlayback() {
    guard !config.muteOutput, graphReady else { return }
    player.stop()
    if engine.isRunning { player.play() }
  }

  /** The voice's gain (Settings → Voice → Volume); the level the orb reads is taken before it. */
  public func setVolume(gain: Double) {
    voiceMixer.outputVolume = Float(max(0, min(1, gain)))
  }

  /** A chime at `volume` (its own gain; the chimes follow the voice volume through chimeLevel). */
  public func chime(_ c: Chime, volume: Double) {
    guard !config.muteOutput, ensureRunning() else { return }
    let s = c.render(volume: volume, rate: chimeFormat.sampleRate)
    guard let buf = AVAudioPCMBuffer(pcmFormat: chimeFormat, frameCapacity: AVAudioFrameCount(s.count)) else { return }
    buf.frameLength = AVAudioFrameCount(s.count)
    s.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress!, count: src.count) }
    chimePlayer.scheduleBuffer(buf, at: nil, options: [], completionHandler: nil)
  }

  // MARK: - the microphone

  /** A frame from the mic (or the fake one): to the call while it has the mic open, and to the wake word. */
  private func frame(_ pcm: [Int16]) {
    if capturing { onFrame(pcm) }
    wakeListener?(pcm)
  }

  /**
   * Listen for the wake word: the mic's frames go to `listener` too, opening the device if no call has
   * it. Never asks for permission (the wake word is off until the mic is allowed); false if it can't.
   */
  @discardableResult public func startWakeListening(_ listener: @escaping ([Int16]) -> Void) -> Bool {
    wakeListener = listener
    if let fakeMic { fakeMic.micOpened(); return true }
    if tapInstalled { return true }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { wakeListener = nil; return false }
    if case .failure = openRealDevice() { wakeListener = nil; return false }
    return true
  }

  public func stopWakeListening() {
    wakeListener = nil
    if !capturing {
      fakeMic?.micClosed()
      closeRealDevice()
    }
  }

  /** Open the mic (or the fake one). The real one needs the user's permission. */
  public func startCapture(_ done: @escaping @MainActor (Result<Void, MicError>) -> Void) {
    if capturing { return done(.success(())) }
    if let fakeMic {
      capturing = true
      fakeMic.micOpened()
      return done(.success(()))
    }
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
      done(startRealCapture())
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .audio) { granted in
        DispatchQueue.main.async {
          MainActor.assumeIsolated { done(granted ? self.startRealCapture() : .failure(MicError(.notAllowed, "Permission denied"))) }
        }
      }
    default:
      done(.failure(MicError(.notAllowed, "Permission denied")))
    }
  }

  private func startRealCapture() -> Result<Void, MicError> {
    if tapInstalled { capturing = true; return .success(()) } // (the wake word has it open already)
    let r = openRealDevice()
    if case .success = r { capturing = true }
    return r
  }

  /** The real mic device with its tap (for the call, the wake word, or both). */
  private func openRealDevice() -> Result<Void, MicError> {
    guard AVCaptureDevice.default(for: .audio) != nil else { return .failure(MicError(.notFound, "Requested device not found")) }
    idleStop?.cancel()
    ensureGraph()
    let wasRunning = engine.isRunning
    if wasRunning { engine.stop() }
    let input = engine.inputNode
    if config.voiceProcessing && !input.isVoiceProcessingEnabled {
      // Echo cancellation, so Orbit doesn't hear itself; other apps are ducked as little as possible.
      if (try? input.setVoiceProcessingEnabled(true)) != nil {
        input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
      }
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      if wasRunning { ensureRunning() }
      return .failure(MicError(.notFound, "Requested device not found"))
    }
    let conv = CaptureConverter(rate: format.sampleRate)
    conv.deliver = { [weak self] pcm in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.frame(pcm) } }
    }
    capture = conv
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { @Sendable buf, _ in conv.process(buf) }
    tapInstalled = true
    if !ensureRunning() {
      closeRealDevice()
      return .failure(MicError(.other, "Could not start audio input"))
    }
    return .success(())
  }

  private func closeRealDevice() {
    if tapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
      capture = nil
    }
  }

  /** The call lets go of the mic (the wake word may keep the device open). */
  public func stopCapture() {
    guard capturing else { return }
    capturing = false
    guard wakeListener == nil else { return }
    fakeMic?.micClosed()
    closeRealDevice()
  }

  public var isCapturing: Bool { capturing }

  /** The fake mic: play this WAV into it now (after what's still playing, `gapMs` of silence first). */
  @discardableResult public func play(wav url: URL, gapMs: Double = 0) -> Bool {
    guard let fakeMic else { return false }
    return fakeMic.enqueue(url, gapMs: gapMs)
  }

  // MARK: - device changes

  private func configurationChanged() {
    // The engine stopped itself (another output or input device). Start again; what was scheduled is gone.
    let hadTap = tapInstalled
    if hadTap {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    if hadTap && (capturing || wakeListener != nil) {
      let call = capturing
      capturing = false
      if case .success = openRealDevice() { capturing = call }
    } else if engine.attachedNodes.contains(player) && (capturing || player.isPlaying) {
      ensureRunning()
    }
    if engine.isRunning { log("audio device changed: \(outputDescription)") }
    onOutputLost()
  }
}

/** Mic buffers (device rate, any channels) to 24 kHz PCM16 chunks, on the tap's thread. */
final class CaptureConverter: @unchecked Sendable {
  private let resampler: Resampler
  private var chunker = PCMChunker()
  var deliver: ([Int16]) -> Void = { _ in }
  init(rate: Double) { resampler = Resampler(from: rate, to: VoiceAudio.rate) }

  func process(_ buf: AVAudioPCMBuffer) {
    guard let data = buf.floatChannelData else { return }
    let n = Int(buf.frameLength), chans = Int(buf.format.channelCount)
    var mono = [Float](repeating: 0, count: n)
    let k = 1 / Float(chans)
    for c in 0..<chans {
      let p = data[c]
      for i in 0..<n { mono[i] += p[i] * k }
    }
    for chunk in chunker.push(VoiceAudio.pcm16(float: resampler.process(mono))) { deliver(chunk) }
  }
}

/**
 * A stand-in microphone: clips (24 kHz mono after loading) played in real time, silence between and
 * after them. Its clock runs from the start, whether or not anyone listens (like someone talking
 * near a mic); frames go out only while the mic is open. The first clip (ORBIT_FAKE_MIC) starts when
 * the mic first opens, so it isn't spent before a call.
 */
final class FakeMic: @unchecked Sendable {
  private let queue = DispatchQueue(label: "orbit.fake-mic")
  private var timer: DispatchSourceTimer?
  private var pending: [Float] = []
  private var initial: URL?
  private var started = DispatchTime.now()
  private var delivered = 0
  private var chunker = PCMChunker()
  private var open = false
  var deliver: ([Int16]) -> Void = { _ in }

  init(initial: URL?) {
    self.initial = initial
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + .milliseconds(20), repeating: .milliseconds(20), leeway: .milliseconds(2))
    t.setEventHandler { [weak self] in self?.tick() }
    timer = t
    t.resume()
  }

  deinit { timer?.cancel() }

  func micOpened() {
    queue.async {
      self.open = true
      if let u = self.initial {
        self.initial = nil
        if let s = FakeMic.load(u) { self.pending += s }
      }
    }
  }

  func micClosed() { queue.async { self.open = false; self.chunker.reset() } }

  func enqueue(_ url: URL, gapMs: Double) -> Bool {
    guard let s = FakeMic.load(url) else { return false }
    queue.async {
      self.pending += [Float](repeating: 0, count: max(0, Int(gapMs * 24))) + s
    }
    return true
  }

  private func tick() {
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e9
    let due = Int(elapsed * VoiceAudio.rate) - delivered
    guard due > 0 else { return }
    delivered += due
    var out = [Float](repeating: 0, count: due)
    let take = min(due, pending.count)
    if take > 0 {
      for i in 0..<take { out[i] = pending[i] }
      pending.removeFirst(take)
    }
    guard open else { return }
    for chunk in chunker.push(VoiceAudio.pcm16(float: out)) { deliver(chunk) }
  }

  /** A WAV (or anything AVAudioFile reads) as 24 kHz mono floats. */
  static func load(_ url: URL) -> [Float]? {
    guard let f = try? AVAudioFile(forReading: url) else { return nil }
    let fmt = f.processingFormat
    guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(f.length)), (try? f.read(into: buf)) != nil,
          let data = buf.floatChannelData else { return nil }
    let n = Int(buf.frameLength), chans = Int(fmt.channelCount)
    var mono = [Float](repeating: 0, count: n)
    for c in 0..<chans { for i in 0..<n { mono[i] += data[c][i] / Float(chans) } }
    let r = Resampler(from: fmt.sampleRate, to: VoiceAudio.rate)
    // Flush the resampler's look-ahead with a little silence so the clip's end isn't cut.
    return r.process(mono) + r.process([Float](repeating: 0, count: Int(fmt.sampleRate / 50)))
  }
}
