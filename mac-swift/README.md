# Orbit Native (macOS, Swift)

A native macOS build of Orbit, in Swift 6 (AppKit + SwiftUI). It does what the Electron app's shell
(`electron/`) does, natively, and reuses Orbit's Node core unchanged as a sidecar. A parity suite
(`../parity/`) holds both builds to the same behaviour.

Status and what is native vs. still shared: see "Status" at the end.

## Layout

```
mac-swift/
  Package.swift              SwiftPM: the targets below
  Sources/OrbitKit/          logic with no UI, unit tested: bridge client, settings schema and model,
                             onboarding, updater, the voice call (VoiceSession, a port of useVoice.ts),
                             audio math, hotkey parsing, avatar/mouse/orb geometry and models, the
                             sidecar channel, the parity driver server, the parity runner and matchers
  Sources/OrbitUI/           launcher (Qubit's engine as the hero), Settings, History, onboarding, menu bar
  Sources/OrbitVoice/        AVAudioEngine mic and playback, the /voice socket, VoiceController, the hotkey
  Sources/OrbitOverlays/     the avatars, the orb and Orbit's mouse (pages in WKWebViews), the Claude
                             window tracker (the macOS helper's claude-window mode)
  Sources/OrbitSpeech/       phase 2: Claude voice's speech in Swift (sherpa-onnx's C API)
  Sources/OrbitWake/         phase 2: "Hey Orbit" in Swift (Vosk's C library)
  Sources/OrbitNative/       the app: the shell that wires it all to the core (AppDelegate, Wiring)
  Sources/{UI,Voice,Overlay}Demo/  each part on its own against a bridge, for checks
  Tests/                     XCTest: OrbitKitTests, OrbitSpeechTests, OrbitWakeTests, OrbitParityTests
  sidecar/sidecar.mjs        starts Orbit's bridge (src/server.js) for the Swift shell
  scripts/build-app.sh       builds "Orbit Native.app" (embedded Node, the core, the UI pages, models)
  scripts/sign.sh            signs it (a Developer ID, the dev identity, or ad hoc)
  scripts/package.sh         the release files: zip, DMG, latest-mac-native.yml (notarized when asked)
  scripts/fetch-vosk.sh      Vosk's macOS library, pinned checksum, into .vendor/
  Resources/                 entitlements
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
| `mouse.glide` | `x`,`y` (screen points on macOS), `ms`, `holdMs` | Orbit's mouse glides. |
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
| `screens` | `displays` (`[{x,y,w,h,scale}]` visible frames in points, top-left origin: the mouse's coordinate space on macOS) | For Orbit's mouse "on screen" checks. |
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
the UI built (`npm run build:ui`) and the wake-word model (`node scripts/fetch-model.mjs`); it fetches
Vosk's library itself (`scripts/fetch-vosk.sh`). The macOS helper is built from
`native/mac/OrbitHelper`, which comes with the macOS port (`src/platform/mac`): build from a tree
that has both (the macOS port merged). The app is Apple silicon only, like the Electron Mac build.

## Releasing

```bash
ORBIT_SIGN_ID="Developer ID Application: <name> (<team>)" scripts/build-app.sh
ORBIT_SIGN_ID="..." ORBIT_NOTARY_PROFILE=<profile> scripts/package.sh
```

`package.sh` notarizes and staples the app and the DMG (a keychain profile made once with
`xcrun notarytool store-credentials <profile>`), then writes `dist/Orbit-Native-<v>-arm64-mac.zip`,
`dist/Orbit-Native-<v>-arm64.dmg` and `dist/latest-mac-native.yml`. Upload all three to the same
GitHub release as the Electron build's files: each build reads only its own feed (Orbit Native's
updater takes only Orbit-Native zips). A Developer ID build installs its updates itself, and only an
update that is Orbit Native, of the feed's version, and signed by the same Developer ID. It refuses
a test build (`--test`), and won't notarize anything not signed with a Developer ID.

## Rules this build keeps

- Test only on windows it launched (the stand-in Claude window). Never the user's real Claude window
  in tests: with `ORBIT_TEST_CLAUDE_PID` set, both apps act on that pid only.
- No keys, prompts or transcripts in logs, ever.
- Qubit's art and colours are the engine's, unchanged (`ui/src/vendor/avatars/qubit-engine.js`).

## Status

Native (Swift):

- The app shell: menu bar, dock, single instance per profile, login item (SMAppService), the
  updater (its own feed in each GitHub release, latest-mac-native.yml; SHA-512-checked download;
  a Developer ID build installs only the same signer's Orbit Native), its own log, and recovery:
  if the core process dies, Orbit relaunches itself quietly (it gives up after 3 stops in 10 min).
- The launcher (white, Qubit's unchanged engine as the hero, the avatar carousel, icon-only buttons),
  Settings with every setting, History, the permissions onboarding (Microphone and Accessibility;
  Screen Recording optional, in Settings), as the Electron Mac build has them.
- The overlays: Qubit / the pixel buddy on the Claude window (pages unchanged in WKWebViews),
  click-through except over him, click to talk, pick up and throw inside his window, "Wheee!" on a
  real throw, guests on other apps' windows, the orb, Orbit's mouse; the Claude window tracker runs
  the macOS helper's claude-window mode.
- The voice client: AVAudioEngine mic and playback with the voice volume, the whole call logic of
  useVoice.ts (VoiceSession), the global hotkey (Carbon).
- Phase 2, step 1: Claude voice's listening and speaking (Silero VAD, Moonshine, Kitten) in the app
  through sherpa-onnx's C API, the core then only sees words (`/voice?speech=local`). The models are
  loaded only while Claude voice is the engine, and the core is told not to load them too.
- Phase 2, step 2: "Hey Orbit" with Vosk's C library (the same model, grammar, pattern and debounce
  as the web wake page).

Still the shared Node core (as a sidecar, unchanged): the bridge, the agent and its tools, consent,
send-intent, offers, sleep and stop, the Claude desktop driver and Orbit anywhere (through the macOS
port's helper), the MCP manager, Grok. Phase 2 steps 3 to 5 (consent and friends, tools and the agent
prompt, Orbit anywhere) are not started: those checks run inside the core's tool handlers and its
fast paths on each transcript, so moving them means moving the agent itself (most of the core), while
the Windows build keeps the Node core. The shell plus the shared core is the shippable shape.

Measured on the MacBook Air M4 (parity/tools/measure.mjs, median of 3, display asleep):

| | Orbit Native | Electron (orbit-mac) |
| --- | --- | --- |
| App size | 213 MB | 390 MB (packaged, arm64) |
| Start-up (open → ready) | 0.36 s | 0.39 s (from source) |
| Idle CPU | 0.8 % | 12.4 % |
| Idle memory | 351 MB (8 processes) | 627 MB (8 processes) |

In calls (parity/tools/soak.mjs: Claude voice, the stand-in Claude Code, 40 calls in a row, none
failed on either): Orbit Native about 0.9 to 1.0 GB, Electron about 1.4 to 1.5 GB. Both level off; the
page processes grow for the first ~30 calls (lazy garbage collection), then stay flat. Over 100 calls,
Orbit Native's growth in the second half was 0.6 MB per call, mostly the shared Node core (~0.2 MB per call).
