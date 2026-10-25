// swift-tools-version:6.0
// Orbit Native: the macOS app in Swift. See README.md.
import PackageDescription

let package = Package(
  name: "OrbitNative",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "OrbitNative", targets: ["OrbitNative"]),
    .executable(name: "StandInClaude", targets: ["StandInClaude"]),
    .library(name: "OrbitKit", targets: ["OrbitKit"]),
  ],
  targets: [
    // Logic with no UI: everything here is unit tested (Tests/OrbitKitTests).
    .target(name: "OrbitKit", path: "Sources/OrbitKit"),
    // The app: AppKit/SwiftUI windows, overlays, audio, hotkeys.
    .executableTarget(
      name: "OrbitNative",
      dependencies: ["OrbitKit"],
      path: "Sources/OrbitNative",
      linkerSettings: [
        .linkedFramework("AppKit"), .linkedFramework("WebKit"), .linkedFramework("AVFoundation"),
        .linkedFramework("Carbon"), .linkedFramework("ServiceManagement"), .linkedFramework("ApplicationServices"),
      ]
    ),
    // A stand-in "Claude" window for tests (never the real Claude app).
    .executableTarget(name: "StandInClaude", path: "Sources/StandInClaude", linkerSettings: [.linkedFramework("AppKit")]),
    .testTarget(name: "OrbitKitTests", dependencies: ["OrbitKit"], path: "Tests/OrbitKitTests"),
    // Runs ../parity/cases against the Swift build (needs a built test app; see README).
    .testTarget(name: "OrbitParityTests", dependencies: ["OrbitKit"], path: "Tests/OrbitParityTests"),
  ]
)
