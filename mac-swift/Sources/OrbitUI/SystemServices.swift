// macOS pieces the windows use: the login item (SMAppService), the real permission checks and
// requests, and the voice preview's playback.
import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import OrbitKit
import ServiceManagement

/** "Open at login" (Electron: app.setLoginItemSettings). */
@MainActor
public protocol LoginItemControl: AnyObject {
  var enabled: Bool { get }
  /** Turn it on or off; answers whether it's on afterwards. */
  @discardableResult func set(_ on: Bool) -> Bool
  /** Why the last change didn't take (shown under the switch), if it didn't. */
  var lastError: String? { get }
}

/** The app itself as a login item (SMAppService.mainApp): it shows in System Settings → General → Login Items. */
@MainActor
public final class MainAppLoginItem: LoginItemControl {
  public private(set) var lastError: String?
  public init() {}
  public var enabled: Bool { SMAppService.mainApp.status == .enabled }
  @discardableResult public func set(_ on: Bool) -> Bool {
    lastError = nil
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      // e.g. an unbundled build, or the user has to approve it in System Settings first.
      lastError = SMAppService.mainApp.status == .requiresApproval ? "Approve Orbit in System Settings → General → Login Items." : "macOS didn't take it: \(error.localizedDescription)"
    }
    return enabled
  }
}

/** For UIDemo and tests: remembers the switch, touches nothing. */
@MainActor
public final class MemoryLoginItem: LoginItemControl {
  public private(set) var enabled: Bool
  public var lastError: String? { nil }
  public init(enabled: Bool = false) { self.enabled = enabled }
  @discardableResult public func set(_ on: Bool) -> Bool { enabled = on; return on }
}

/** The real checks: AVCaptureDevice, AXIsProcessTrusted, CGPreflightScreenCaptureAccess. */
@MainActor
public final class SystemPermissionProbe: PermissionProbe {
  public init() {}
  public func current() -> PermissionState {
    let mic: MicPermission
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: mic = .granted
    case .denied: mic = .denied
    case .restricted: mic = .restricted
    default: mic = .notDetermined
    }
    return PermissionState(mic: mic, ax: AXIsProcessTrusted(), screen: CGPreflightScreenCaptureAccess())
  }
  public func requestMic() async -> Bool { await AVCaptureDevice.requestAccess(for: .audio) }
  public func promptAccessibility() {
    // The prompt key's string value, spelled out (the global is not concurrency-safe in Swift 6).
    let opts = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
  }
  public func requestScreenCapture() -> Bool { CGRequestScreenCaptureAccess() }
  public func open(_ url: URL) { NSWorkspace.shared.open(url) }
}

/** Plays a voice preview (the bytes /api/voice/preview answers) at Orbit's voice volume. */
@MainActor
final class PreviewPlayer: NSObject, AVAudioPlayerDelegate {
  private var player: AVAudioPlayer?
  var onEnd: (() -> Void)?
  var playing: Bool { player?.isPlaying ?? false }
  /** ui/src/playback.js volumeGain: the setting squared. */
  static func gain(_ v: Double) -> Float { Float(max(0, min(1, v)) * max(0, min(1, v))) }
  func play(_ data: Data, volume: Double) throws {
    stop()
    let p = try AVAudioPlayer(data: data)
    p.volume = Self.gain(volume)
    p.delegate = self
    p.play()
    player = p
  }
  func setVolume(_ v: Double) { player?.volume = Self.gain(v) }
  func stop() { player?.stop(); player = nil }
  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in self.player = nil; self.onEnd?() }
  }
}
