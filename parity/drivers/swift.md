# The parity driver in Orbit Native (Swift)

Where each part of [PROTOCOL.md](../PROTOCOL.md) comes from in the Swift build. The driver itself is
`mac-swift/Sources/OrbitKit/ParityDriver.swift` (a loopback HTTP server, token-checked) and
`mac-swift/Sources/OrbitNative/ParityBridge.swift` (state and actions, on the main actor).

## When it runs

Only in a test build (`mac-swift/scripts/build-app.sh --test` writes `OrbitParityAllowed` into
Info.plist) launched with `ORBIT_PARITY_PORT` and a token of at least 16 characters. A release build
never listens, and ignores every test switch (`ORBIT_PROFILE_DIR`, `PORT`, `ORBIT_FAKE_*`,
`ORBIT_MUTE_OUTPUT`, the fakes for the core): `LaunchConfig.resolve` only honours them with that key.

## hello

`ready` is true once the bridge answered `ready` on the sidecar channel and the launcher (OrbitUI) is
up. `speech` says who hears and speaks for Claude voice: `local` (OrbitSpeech in the app, phase 2) or
`core`. `features`: settings, onboarding, login, hotkey, voice, avatar, mouse, window.

## state

| Field | Source |
| --- | --- |
| `windows.main` | OrbitUI's launcher window (`parityWindows()`), its view (main, settings, history, onboarding) |
| `windows.orb` | Overlays' orb window |
| `claude` | Overlays' Claude window tracker (the macOS helper's `claude-window` mode; `ORBIT_TEST_CLAUDE_PID` limits it to the stand-in) |
| `avatars` | Overlays: the home avatar and guests, their windows, host window, `figure` (the page's `buddy:hit`), `standingOn`, lifted, asleep, takesMouse, leaving |
| `mouse` | Overlays' Orbit's mouse model |
| `voice` | VoiceController's VoiceSession (`parity`): phase, asleep, connected, muted, played and scheduled ms, chunks, last error, draft, sent count |
| `onboarding` | OrbitUI's OnboardingModel (Microphone and Accessibility are steps; Screen Recording optional) |
| `hotkey` | ShellHotkey (the real Carbon hotkey, or in a driven test build an in-memory one) |
| `login` | OrbitUI's login item (`ORBIT_FAKE_LOGIN=1`: in memory) |
| `events`, `sounds` | The shell's EventLog: the overlays' avatar events, the voice controller's `voice.phase`/`hotkey`/`hangup`, `perms.request`, `core.ready`; sounds as played |

## Actions

| Action | What it calls |
| --- | --- |
| `voice.hotkey` | ShellHotkey's press (fails if not registered) |
| `voice.sleep` / `wake` / `hangup` / `type` | VoiceController |
| `mic.play` | AudioIO's fake microphone (`ORBIT_FAKE_MIC`; the runners always set one) |
| `cursor.set`, `pointer` | Overlays' test cursor, and a synthetic event into that avatar window only |
| `avatar.eval` | The probe file (shipped in a test build's `Resources/parity-probes`) run in the avatar's page |
| `avatar.command` | Overlays (as the core's avatar sink would) |
| `settings.ui` / `settings.read` | OrbitUI's Settings model (`wakeHotkey` through the hotkey, `openAtLogin` through the login item) |
| `window.show` / `window.minimize` | OrbitUI (minimize turns into the orb) |
| `perms.set`, `onboarding.next` | OrbitUI's onboarding (the latter logs `perms.request` with the step's permission) |
| `quit` | NSApp.terminate (the sidecar is stopped on the way out) |

## Known differences

- Claude voice's speech runs in the app by default (`speech: local`); `ORBIT_SPEECH=core` in a test
  build switches back to the core's, for comparing the two.
