// swift-tools-version:6.0
// Orbit Native: the macOS app in Swift. See README.md.
import Foundation
import PackageDescription

// sherpa-onnx's C library: the copy Orbit's core already has (npm ci at the repo root).
let sherpaLib = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../node_modules/sherpa-onnx-darwin-arm64").standardizedFileURL.path
// Vosk's C library for "Hey Orbit" (scripts/fetch-vosk.sh puts it in .vendor/vosk).
let voskLib = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(".vendor/vosk").standardizedFileURL.path
let voskLink: [LinkerSetting] = [.unsafeFlags(["-L\(voskLib)", "-Xlinker", "-rpath", "-Xlinker", voskLib])]
let sherpaLink: [LinkerSetting] = [.unsafeFlags(["-L\(sherpaLib)", "-Xlinker", "-rpath", "-Xlinker", sherpaLib, "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Resources/core/node_modules/sherpa-onnx-darwin-arm64", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]

let package = Package(
  name: "OrbitNative",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "OrbitNative", targets: ["OrbitNative"]),
    .executable(name: "UIDemo", targets: ["UIDemo"]),
    .executable(name: "VoiceDemo", targets: ["VoiceDemo"]),
    .executable(name: "OverlayDemo", targets: ["OverlayDemo"]),
    .library(name: "OrbitKit", targets: ["OrbitKit"]),
    .library(name: "OrbitUI", targets: ["OrbitUI"]),
    .library(name: "OrbitVoice", targets: ["OrbitVoice"]),
    .library(name: "OrbitOverlays", targets: ["OrbitOverlays"]),
    .library(name: "OrbitSpeech", targets: ["OrbitSpeech"]),
    .library(name: "OrbitWake", targets: ["OrbitWake"]),
    .library(name: "OrbitBridge", targets: ["OrbitBridge"]),
    .library(name: "OrbitEngine", targets: ["OrbitEngine"]),
  ],
  targets: [
    // Logic with no UI: everything here is unit tested (Tests/OrbitKitTests).
    .target(name: "OrbitKit", path: "Sources/OrbitKit"),
    // The windows: launcher, Settings, History, onboarding, menu bar (SwiftUI in AppKit windows).
    // A library so the app and UIDemo both use it.
    .target(
      name: "OrbitUI",
      dependencies: ["OrbitKit"],
      path: "Sources/OrbitUI",
      linkerSettings: [
        .linkedFramework("AppKit"), .linkedFramework("SwiftUI"), .linkedFramework("WebKit"), .linkedFramework("AVFoundation"),
        .linkedFramework("ServiceManagement"), .linkedFramework("ApplicationServices"),
      ]
    ),
    // The voice client's device side (AVAudioEngine, the /voice socket, the Carbon hotkey, the wake
    // word page): a library so the app and VoiceDemo share it. Its logic lives in OrbitKit.
    .target(
      name: "OrbitVoice",
      dependencies: ["OrbitKit"],
      path: "Sources/OrbitVoice",
      linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit"), .linkedFramework("AVFoundation"), .linkedFramework("Carbon")]
    ),
    // The overlays (avatars, the orb, Orbit's mouse, the Claude window tracker) in AppKit + WebKit,
    // behind one facade (Overlays). A library so both the app and OverlayDemo use it.
    .target(
      name: "OrbitOverlays",
      dependencies: ["OrbitKit"],
      path: "Sources/OrbitOverlays",
      linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit")]
    ),
    // Phase 2: Orbit's on-device speech in Swift (sherpa-onnx's C API).
    .target(name: "SherpaOnnxC", path: "Sources/SherpaOnnxC"),
    .target(name: "OrbitSpeech", dependencies: ["SherpaOnnxC"], path: "Sources/OrbitSpeech", swiftSettings: [.swiftLanguageMode(.v5)], linkerSettings: sherpaLink),
    // Phase 2: "Hey Orbit" in Swift (Vosk's C library, the same model and grammar as the wake page).
    .target(name: "VoskC", path: "Sources/VoskC"),
    .target(name: "OrbitWake", dependencies: ["VoskC"], path: "Sources/OrbitWake", linkerSettings: voskLink),
    // The engine, moving from the Node core to Swift (README "Engine"): the bridge's HTTP server...
    .target(name: "OrbitBridge", path: "Sources/OrbitBridge", linkerSettings: [.linkedFramework("Network")]),
    // ...and what answers behind it.
    .target(name: "OrbitEngine", dependencies: ["OrbitKit", "OrbitBridge"], path: "Sources/OrbitEngine"),
    // The app: the shell that puts it all together.
    .executableTarget(
      name: "OrbitNative",
      dependencies: ["OrbitKit", "OrbitUI", "OrbitVoice", "OrbitOverlays", "OrbitSpeech", "OrbitWake", "OrbitBridge", "OrbitEngine"],
      path: "Sources/OrbitNative",
      linkerSettings: [
        .linkedFramework("AppKit"), .linkedFramework("WebKit"), .linkedFramework("AVFoundation"),
        .linkedFramework("Carbon"), .linkedFramework("ServiceManagement"), .linkedFramework("ApplicationServices"),
      ] + sherpaLink + voskLink
    ),
    // OrbitUI's windows against a running bridge, with a fake voice and hotkey (checks, snapshots).
    .executableTarget(name: "UIDemo", dependencies: ["OrbitKit", "OrbitUI"], path: "Sources/UIDemo", linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit")]),
    // Runs the voice client headless against a bridge, for checks (see its header).
    .executableTarget(name: "VoiceDemo", dependencies: ["OrbitKit", "OrbitVoice"], path: "Sources/VoiceDemo"),
    // Hosts the overlays against a bridge for manual and scripted checks, with its own stand-in host
    // window and stand-in claude-window helper (see Sources/OverlayDemo/main.swift).
    .executableTarget(name: "OverlayDemo", dependencies: ["OrbitKit", "OrbitOverlays"], path: "Sources/OverlayDemo", linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit")]),
    // (Fixtures are read from the source tree by path, as the JS tests read test/fixtures.)
    .testTarget(name: "OrbitKitTests", dependencies: ["OrbitKit"], path: "Tests/OrbitKitTests", exclude: ["Fixtures"]),
    .testTarget(name: "OrbitEngineTests", dependencies: ["OrbitEngine", "OrbitBridge", "OrbitKit"], path: "Tests/OrbitEngineTests"),
    .testTarget(name: "OrbitWakeTests", dependencies: ["OrbitWake"], path: "Tests/OrbitWakeTests", linkerSettings: voskLink),
    .testTarget(name: "OrbitSpeechTests", dependencies: ["OrbitSpeech", "OrbitKit"], path: "Tests/OrbitSpeechTests", exclude: ["reference.mjs", "engine-reference.mjs"], linkerSettings: sherpaLink),
    // Runs ../parity/cases against the Swift build (needs a built test app; see README).
    .testTarget(name: "OrbitParityTests", dependencies: ["OrbitKit"], path: "Tests/OrbitParityTests"),
  ]
)
