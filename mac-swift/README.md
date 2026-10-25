# Orbit Native (macOS, Swift)

A native macOS build of Orbit, in Swift 6 (AppKit + SwiftUI). It does what the Electron app's shell
(`electron/`) does, natively, and reuses Orbit's Node core unchanged as a sidecar. A parity suite
(`../parity/`) holds both builds to the same behaviour.

Status and what is native vs. still shared: see "Status" at the end.

## Layout

```
mac-swift/
  Package.swift              SwiftPM: OrbitKit (logic, no UI), OrbitNative (the app), tests
  Sources/OrbitKit/          testable logic: bridge client, settings, voice protocol + state,
                             audio math, avatar geometry, hotkey parsing, onboarding, sidecar,
                             the parity driver server, the parity case runner
  Sources/OrbitNative/       the app: AppKit/SwiftUI windows, overlays, audio engine, hotkeys
  Sources/StandInClaude/     a stand-in "Claude" window for tests (never the real Claude app)
  Tests/OrbitKitTests/       XCTest unit tests for OrbitKit
  Tests/OrbitParityTests/    XCTest runner of ../parity/cases against the Swift build
  sidecar/sidecar.mjs        starts Orbit's bridge (src/server.js) for the Swift shell
  scripts/build-app.sh       builds "Orbit Native.app" (embedded Node, the core, the UI pages, models)
  scripts/sign.sh            signs it with the dev identity (stable designated requirement)
  Resources/                 Info.plist, entitlements, the hero page
```

## How it fits together

```
Orbit Native.app (Swift)                         sidecar (embedded node, child process)
 ├─ menu bar, dock, launcher, Settings (SwiftUI)  ├─ src/server.js: the bridge on 127.0.0.1:$PORT
 ├─ voice client: AVAudioEngine mic → 24 kHz      │   (claude-voice / Grok, agent, tools, consent,
 │   PCM16 → ws /voice; playback + volume         │    send-intent, Orbit anywhere, MCP manager)
 ├─ avatar overlays: WKWebView per place running  ├─ src/platform/mac (Accessibility helper:
 │   qubit.html / buddy.html (engine unchanged)   │    native/mac/OrbitHelper, from the orbit-mac work)
 ├─ Orbit's mouse overlay (mouse.html)            └─ stdio JSON channel ⇄ the Swift shell
 ├─ the orb (index.html#orb)
 ├─ global hotkey (Carbon), login item (SMAppService), single instance, updater
 └─ Claude window tracker: orbit-helper claude-window (same helper binary)
```

The Swift app talks to the bridge over its existing HTTP/WebSocket API, exactly as the Electron
page does, so agent behaviour matches by construction.

### Sidecar channel (stdin/stdout, one JSON object per line)

Swift starts `node sidecar.mjs` with `ORBIT_PROFILE_DIR`, `PORT`, and on stdin a first line
`{"t":"init","sealKey":"<base64 32 bytes>"}` (the key that seals the xAI/Anthropic keys and
connector tokens on disk; Swift keeps it in the login Keychain). Then:

Sidecar → Swift:

| `t` | Fields | When |
| --- | --- | --- |
| `ready` | `base`, `auth` (`{main,orb,qubit,buddy,mouse}` sign-in URLs) | The bridge is listening. |
| `error` | `message`, `code` | Startup failed (e.g. `EADDRINUSE`). |
| `avatar.cmd` | `cmd` (`{action,dir}`) | The voice asked the avatar to do something. (The sidecar answers the core at once from the avatar state Swift last reported.) |
| `mouse.glide` | `x`,`y` (physical px), `ms`, `holdMs` | Orbit's mouse glides. |
| `mouse.press` / `mouse.hide` | | |
| `contexts` | `snap` | Orbit anywhere's contexts changed (guest avatars follow them). |
| `focus` | `current`, `recent` | The window in front changed. |
| `wins` | `wins` | Windows of watched contexts moved. |
| `promptBoxWork` | | Orbit is typing into Claude's box (look at the box now). |
| `clipboard` | `text` | Copy to the clipboard. |
| `openExternal` | `url` | Open an https link in the browser. |
| `log` | `level`, `scope`, `message` | (No user words, no keys.) |

Swift → Sidecar:

| `t` | Fields | |
| --- | --- | --- |
| `avatarState` | `kind` (`qubit`/`buddy`/null), `onScreen` | So avatar commands answer correctly. |
| `screens` | `displays` (`[{x,y,w,h,scale}]` work areas, physical px) | For Orbit's mouse "on screen" checks. |
| `wake` | `win` | Avatar clicked: start talking with this window in front (`wakeWith`). |
| `homeWindow` | `id` | The Claude window Orbit lives on. |
| `frontHint` | `id` | The Claude window the tools should act on. |
| `shellSettings` | `patch` | Settings the shell owns (`wakeHotkey`, `orbPosition`, `orbStickAnchor`), saved by the core. |
| `quit` | | Stop background work and exit. |

### The page shim (WKWebView)

The avatar, mouse and orb pages use a small `window.desktop` API (see `electron/preload.cjs`). The
Swift app injects the same API as a `WKUserScript` at document start: calls post to
`webkit.messageHandlers.orbit` (`{ch, args}`), and Swift calls back with
`window.__orbit.emit(channel, payload)`. Channels and payloads are exactly the Electron ones
(`buddy:state`, `buddy:event`, `buddy:cursor`, `buddy:command`, `buddy:emote`, `mouse:state`,
`orb:state`, `orb:action`; and from the page `buddy:hit`, `buddy:hover`, `buddy:talk`, `buddy:lift`,
`buddy:sound`, `orb:*`). So the pages run unchanged.

### Voice

The call logic is `OrbitKit/Voice/VoiceSession` (a faithful port of `ui/src/useVoice.ts`, with the
page's timings, driven by a clock so its tests run in virtual time); the device side is the
`OrbitVoice` library (`AudioIO`, the `/voice` socket, `GlobalHotkey`, `WakeWord`). The shell uses:

```swift
let voice = VoiceController(endpoints: ready)            // the sidecar's `ready` line (base + auth links)
try await voice.loadConfig()                             // settings + hasKey from /api/config
voice.onState = { orb in /* orb:state to the orb and avatars (OrbSync) */ }
voice.onEvent = { name, data in /* parity events: voice.phase {phase, asleep}, hotkey, sound, hangup */ }
voice.onEmote = { cue in /* buddy:emote */ }
voice.onAvatarEvent = { e in /* buddy:event draft | sent | error */ }
voice.orbExtras = (claudeWorking, pulseMe, pulseGrok, pulseAmount)
// Feed it the bridge's /api/events (or call voice.followBridgeEvents()):
voice.handleBridgeEvent(evt)                             // orbit.wake, settings.changed, claude.finished
// Actions: hotkey() sleep() wake() announce() endWake() type(_:) ask(_:) mute(_:) hangup()
//          avatarTalk() playSound("throw") playIntoMic(wav:gapMs:) parityVoice()
// UI: @Published state, captions (history), draft, sessionTitle, settings, hasKey; sounds (parity)

let hotkey = GlobalHotkey(accelerator: settings.wakeHotkey)
hotkey.onPress = { voice.hotkey() }
hotkey.onSaved = { accel in /* POST /api/settings {wakeHotkey: accel} */ }
hotkey.start()                                           // hotkey.set(_:) -> HotkeyInfo, suspend(_:), info

let wake = WakeWord(link: voice.link)                    // "Hey Orbit": hidden WKWebView on the bridge's wake.html
voice.attach(wakeWord: wake)                             // runs only while off/asleep, setting on, with a key
```

`ORBIT_MUTE_OUTPUT=1` and `ORBIT_FAKE_MIC=<wav>` work as `parity/PROTOCOL.md` says (the fake mic
needs no microphone permission). `swift run VoiceDemo` drives the controller headless against a
bridge; `node mac-swift/scripts/voice-check-bridge.mjs` starts one in a throwaway profile with the
stand-in Grok (see both files' headers).

## Build and run (on a Mac)

```bash
cd mac-swift
swift build                       # the app and tools (debug)
swift test --filter OrbitKitTests # unit tests
scripts/build-app.sh              # dist/Orbit Native.app (release), signed with the dev identity
scripts/build-app.sh --test       # the same, with the parity driver allowed (never ship this one)
npm run parity -- --app swift     # (from the repo root) the parity suite against it
```

`build-app.sh` needs `node` (it embeds the running Node's binary), `npm ci` done at the repo root,
and the UI built (`npm run build:ui`).

## Rules this build keeps

- Test only on windows it launched (the stand-in Claude window). Never the user's real Claude window
  in tests: with `ORBIT_TEST_CLAUDE_PID` set, both apps act on that pid only.
- No keys, prompts or transcripts in logs, ever.
- Qubit's art and colours are the engine's, unchanged (`ui/src/vendor/avatars/qubit-engine.js`).
