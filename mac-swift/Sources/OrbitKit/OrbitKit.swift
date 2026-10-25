// OrbitKit: Orbit Native's logic with no UI (bridge client, settings, voice protocol, geometry...).
import Foundation

public enum OrbitKit {
  /** The Orbit version this build matches (package.json's), set by build-app.sh into Info.plist. */
  public static var version: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
  }
}
