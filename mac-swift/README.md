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
  Sources/OrbitBridge/       the engine's HTTP server (Network.framework): keep-alive, files, events,
                             pass-through to the Node core for what hasn't moved yet
  Sources/OrbitEngine/       the engine in Swift, moving over from the Node core (see "Engine")
  Sources/OrbitNative/       the app: the shell that wires it all to the core (AppDelegate, Wiring)
  Sources/{UI,Voice,Overlay}Demo/  each part on its own against a bridge, for checks
  Tests/                     XCTest: OrbitKitTests, OrbitEngineTests, OrbitSpeechTests, OrbitWakeTests,
                             OrbitParityTests
  sidecar/sidecar.mjs        runs what's left of the Node core (src/server.js) behind the engine
  scripts/build-app.sh       builds "Orbit Native.app" (embedded Node, the core, the UI pages, models)
  scripts/sign.sh            signs it (a Developer ID, the dev identity, or ad hoc)
  scripts/package.sh         the release files: zip, DMG, latest-mac-native.yml (notarized when asked)
  scripts/fetch-vosk.sh      Vosk's macOS library, pinned checksum, into .vendor/
  Resources/                 entitlements
```

## How it fits together

```
Orbit Native.app (Swift)                         sidecar (embedded node, child process)
 ├─ the engine (OrbitEngine): the bridge on       ├─ src/server.js on an internal port: what of
 │   127.0.0.1:4317, settings, keys, the log      │   the engine is still there (claude-voice / Grok,
 ├─ menu bar, dock, launcher, Settings (SwiftUI)  │   agent, tools, consent, send-intent, Orbit
 ├─ voice client: AVAudioEngine mic → 24 kHz      │   anywhere, MCP manager); only the engine talks
 │   PCM16 → ws /voice; playback + volume         │   to it
 ├─ avatar overlays: WKWebView per place running  ├─ src/platform/mac (Accessibility helper:
 │   qubit.html / buddy.html (engine unchanged)   │    native/mac/OrbitHelper, from the orbit-mac work)
 ├─ Orbit's mouse overlay (mouse.html)            └─ stdio JSON channel ⇄ the Swift shell
 ├─ the orb (index.html#orb)
 ├─ global hotkey (Carbon), login item (SMAppService), single instance, updater
 └─ Claude window tracker: orbit-helper claude-window (same helper binary)
```

The Swift app talks to the bridge over its existing HTTP/WebSocket API, exactly as the Electron
page does, so agent behaviour matches by construction.

### Engine

The engine is moving from the Node core into Swift, part by part, each part switched over only once
it passes the same tests as the JS (its ported unit tests, the oracle fixtures in `parity/oracle`, made
by running the JS, and the parity suite). The bridge is Swift's and keeps `src/server.js`'s API
exactly; whatever it doesn't answer yet it passes on, as bytes, to the Node core on an internal port,
signed in as the core. When nothing is passed on any more, Node leaves the bundle.

In Swift now: the bridge itself (sign-in, Host/Origin/cross-site guards, CSPs, static pages, the
wake-word model), `GET /api/config`, `POST /api/settings`, `POST /api/key`, `GET /api/logs`,
`GET /api/usage`, `GET /api/events` (the core's events merged in); Claude voice's speech models
(`GET /api/claude-voice`, both downloads with their pinned checksums, `/usr/bin/tar`) and the voices
(`GET /api/voice`, both previews: Kitten through OrbitSpeech, xAI's text to speech); the second brain's
status, sign-in, key and connection test (`/api/brain*`: finding Claude Code on PATH, the login shell's
PATH, the usual folders or the Claude app; `claude auth status`; the sign-in in Terminal; a test that
stops when the page goes away). Claude Code runs in a process group of its own, ended as a tree.
The settings, the sealed keys and the log file are the engine's alone; the core keeps a copy of the
settings in memory (`settings` below) and hands its log entries over (`logEntry`).

The voice session is ported and held to the core's answers (step 4):
- the relay on `/voice` (`VoiceRelay.swift`): spoken updates, wakes and their limits, the fast paths,
  suppression, cues, the results the user waits on, the resume note
- the agent's context and tools, the tool runner with every consent check
- Claude voice's Claude Code driver, with its warm spare
- the Grok socket, the Claude window driver (the macOS port's `desktop.js` on the helper's `ax` host),
  Claude Code's sessions on disk and the watcher

`EngineVoice.swift` puts it on real sockets with `/api/sessions` and `/api/switch`. For now it is
switched on only in a test build with `ORBIT_SWIFT_VOICE=1` (parity: `--env ORBIT_SWIFT_VOICE=1`). It
becomes the default once Orbit anywhere and the MCP connectors move too (step 5), because the voice
reaches them. While it's on, the core's own watcher events (`claude.*`, `orbit.wake`) are dropped
from the event stream, so there's one watcher.

The oracle (`parity/oracle`, `node parity/oracle/gen.mjs` on a Mac):

| Area | Cases |
| --- | --- |
| Settings | 5133, and 11 start-ups (the voice engine an install starts on) |
| Log scrub | 321 |
| Hotkeys | 15 |
| Text checks (22 functions) | 2562 |
| Window policy | 81 |
| Claude driver | 53 scenarios |
| Sessions and watcher | 51 steps |
| Second brain, web search, finding Claude Code, speech models | 1010 cases, 44 whole runs, 27 download steps |
| What the voice is told and given | 8945 cases, 26 contexts |
| Tool runner | 1599 steps |
| Claude voice | 297 steps |
| Voice relay | 13 calls, 299 steps |

Swift matches every one.

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
| `logEntry` | `entry` (`{at,level,source,message,detail?}`, scrubbed) | One of the core's log entries: the engine keeps the log. |
| `settingsChanged` | `patch` | The core changed a setting itself (a voice tool, an app okayed for Orbit anywhere): the engine saves it. |

Swift → Sidecar:

| `t` | Fields | |
| --- | --- | --- |
| `avatarState` | `kind` (`qubit`/`buddy`/null), `onScreen` | So avatar commands answer correctly. |
| `screens` | `displays` (`[{x,y,w,h,scale}]` visible frames in points, top-left origin: the mouse's coordinate space on macOS) | For Orbit's mouse "on screen" checks. |
| `wake` | `win` | Avatar clicked: start talking with this window in front (`wakeWith`). |
| `homeWindow` | `id` | The Claude window Orbit lives on. |
| `frontHint` | `id` | The Claude window the tools should act on. |
| `settings` | `all` | Every setting, after any change in the engine: applied in the core's memory (it doesn't save them). |
| `keyChanged` | | A new xAI key was saved: the core drops what it made for the old one. |
| `prewarm` | | `POST /api/settings` came in, or Claude voice's models finished downloading: the core warms Claude voice up, as those routes did there. |
| `sttReady` | | A speech-to-text choice finished downloading: a live Claude voice call switches to it now. |
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
- No xAI key needed to start (main 04098cc):
  - New installs start on Claude voice. A saved choice wins, and installs from before stay on Grok.
  - There is no key screen. Trying to talk to Grok without a key shows a notice on the main page,
    with Open Settings (the key field focused) and Use Claude voice.
  - The key field is in Settings → Voice engine → Grok.
  - The hotkey, the wake word, the orb, Qubit's click and spoken updates all go through the same
    "can talk" check.
- Claude Code not installed: the main page and Settings (Voice engine, Second brain) show
  Anthropic's one-line installer to copy (`curl -fsSL https://claude.ai/install.sh | bash`; Orbit
  never runs it), a link to their install guide, and Check again. On Windows the core also looks in
  the installer's own folder, so a fresh install is found without restarting Orbit.
- Picking Qubit up (main 0edbf9b, 346a5bc):
  - His last rect stands however quiet or frozen his page is. A page reload or crash forgets it.
  - The mouse mode lets go only 150 ms after the cursor leaves him (6 px slack), so it can't flap.
  - Press outcomes and page errors are logged, rate-limited, with fixed words only.
  - The overlay pages' timers aren't throttled when occluded (WebKit's own switches, as before),
    and the hover check doesn't depend on them.
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

- The engine, moving over (see "Engine"):
  - In use: the bridge, settings, keys, log, usage, events, Claude voice's models and the voices,
    and the second brain's routes.
  - Ported and checked, in use only in a test build (`ORBIT_SWIFT_VOICE=1`): the whole voice
    session. That covers the relay, Grok, Claude voice's driver, the agent and its tools, the text
    checks, the Claude window driver, sessions and the watcher.

Still the Node core behind the Swift bridge (a sidecar on an internal port):
- the voice session in a release build
- Orbit anywhere
- the MCP manager

Orbit anywhere and MCP move next; then the Swift voice session becomes the default and Node leaves
the bundle. The Windows build keeps the Node core.

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
