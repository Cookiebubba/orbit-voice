// swift-tools-version:6.0
// Orbit Native: the macOS app in Swift. See README.md.
import Foundation
import PackageDescription

// sherpa-onnx's C library: the copy Orbit's core already has (npm ci at the repo root).
let sherpaLib = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../node_modules/sherpa-onnx-darwin-arm64").standardizedFileURL.path
let sherpaLink: [LinkerSetting] = [.unsafeFlags(["-L\(sherpaLib)", "-Xlinker", "-rpath", "-Xlinker", sherpaLib, "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]

let package = Package(
  name: "OrbitNative",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "OrbitNative", targets: ["OrbitNative"]),
    .executable(name: "StandInClaude", targets: ["StandInClaude"]),
    .executable(name: "UIDemo", targets: ["UIDemo"]),
    .library(name: "OrbitKit", targets: ["OrbitKit"]),
    .library(name: "OrbitSpeech", targets: ["OrbitSpeech"]),
    .library(name: "OrbitUI", targets: ["OrbitUI"]),
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
    // The app: AppKit/SwiftUI windows, overlays, audio, hotkeys.
    .executableTarget(
      name: "OrbitNative",
      dependencies: ["OrbitKit", "OrbitUI"],
      path: "Sources/OrbitNative",
      linkerSettings: [
        .linkedFramework("AppKit"), .linkedFramework("WebKit"), .linkedFramework("AVFoundation"),
        .linkedFramework("Carbon"), .linkedFramework("ServiceManagement"), .linkedFramework("ApplicationServices"),
      ]
    ),
    // OrbitUI's windows against a running bridge, with a fake voice and hotkey (checks, snapshots).
    .executableTarget(name: "UIDemo", dependencies: ["OrbitKit", "OrbitUI"], path: "Sources/UIDemo", linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit")]),
    // A stand-in "Claude" window for tests (never the real Claude app).
    .executableTarget(name: "StandInClaude", path: "Sources/StandInClaude", linkerSettings: [.linkedFramework("AppKit")]),
    // Phase 2: Orbit's on-device speech in Swift (sherpa-onnx's C API).
    .target(name: "SherpaOnnxC", path: "Sources/SherpaOnnxC"),
    .target(name: "OrbitSpeech", dependencies: ["SherpaOnnxC"], path: "Sources/OrbitSpeech", swiftSettings: [.swiftLanguageMode(.v5)], linkerSettings: sherpaLink),
    .testTarget(name: "OrbitKitTests", dependencies: ["OrbitKit"], path: "Tests/OrbitKitTests", exclude: ["Fixtures"]),
    .testTarget(name: "OrbitSpeechTests", dependencies: ["OrbitSpeech", "OrbitKit"], path: "Tests/OrbitSpeechTests", linkerSettings: sherpaLink),
    // (Fixtures are read from the source tree by path, as the JS tests read test/fixtures.)
    // Runs ../parity/cases against the Swift build (needs a built test app; see README).
    .testTarget(name: "OrbitParityTests", dependencies: ["OrbitKit"], path: "Tests/OrbitParityTests"),
  ]
)
