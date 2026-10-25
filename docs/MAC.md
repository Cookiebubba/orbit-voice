# Orbit on macOS

Orbit on a Mac does what it does on Windows: the voice (Grok or Claude), the wake word, hearing
what your Claude sessions are doing, the second brain and web search, **and** driving the Claude
desktop app (typing drafts, Send, Stop, answering Claude's cards, switching sessions, starting new
ones in a folder, Claude's own controls), the orb and Qubit riding on Claude's window, and Orbit
anywhere (reading and acting in other apps, looking at a window, Orbit's mouse, apps under Orbit).

Where Windows uses PowerShell helpers and UI Automation, the Mac uses **orbit-helper**, one small
Swift binary shipped inside the app (`Orbit.app/Contents/Resources/mac/orbit-helper`, source in
`native/mac/OrbitHelper/`). It speaks the same JSON protocols as the Windows helpers, through the
macOS accessibility API (AXUIElement), the window server (CGWindowList), ScreenCaptureKit and
Vision. Orbit starts it as its own child process, so macOS counts it as Orbit: the switches you turn
on for Orbit in System Settings cover it.

## What works

| On a Mac | |
| --- | --- |
| Grok voice, the hotkey (**⌘⌥G** by default), the "Hey Orbit" wake word | Works |
| Claude voice: Silero VAD, Moonshine / Parakeet speech to text, Kitten speech, all on the Mac | Works (macOS 14+ on Apple silicon, 15+ on Intel) |
| Typing a draft into Claude, Send, Stop, answering permission and question cards | Works (Accessibility) |
| Switching sessions, new session (in a folder), the model / permission pickers, sidebar, panels | Works (Accessibility) |
| The orb sticking to the Claude window; Qubit standing on its prompt box | Works (Accessibility) |
| Orbit anywhere: the window in front, reading a window, its selection, acting in it | Works (Accessibility) |
| Looking at a window (a picture and on-device OCR) | Works (Screen Recording) |
| Orbit's mouse | Works: a click-through panel on every Space, over full-screen apps too |
| Apps under Orbit (the pipe keeper) | Works: closes the app (SIGTERM, then SIGKILL), runs it under a private DevTools pipe on a user-only Unix socket, relaunches it normally with `open -a` |
| Local MCP servers | Boxed in Apple's sandbox (`sandbox-exec`, see below) or Docker |
| Menu bar icon, app menu (Settings… ⌘,), Dock, Open at login, single instance | Works |
| Updates (GitHub releases, the arm64 / x64 zip and `latest-mac.yml`) | Checks and downloads; **installing needs a signed build** |

## What macOS asks you

Settings → **Mac permissions** shows each one with a **Turn on** button (macOS's own prompt, or
System Settings at the right place), and the main screen shows a one-line banner while one Orbit
needs is off. Both look again every two seconds and when Orbit comes back to the front.

| Permission | Why | Where |
| --- | --- | --- |
| **Accessibility** (needed) | Typing into Claude and pressing its buttons, following its window for the orb and Qubit, Orbit anywhere | System Settings → Privacy & Security → Accessibility → Orbit on |
| **Microphone** (needed) | Hearing you, and the offline "Hey Orbit" | asked on first launch; Privacy & Security → Microphone |
| **Screen Recording** (optional) | Only "look at this window" (a picture plus OCR). Takes effect after Orbit restarts | Privacy & Security → Screen & System Audio Recording |
| Keychain | Your xAI key (and the optional Anthropic key, connector tokens, keeper tokens) are encrypted with a key in your login Keychain. Choose **Always Allow** | the first time you save a key |
| Notifications | Optional: "Claude finished" | the first time |

Orbit never sends Apple Events; the entitlement and its Info.plist string are only kept for a
future hand-off to the Claude app.

Running from source (`npm run app`), macOS asks on behalf of the app that started Electron
(Terminal, your editor).

## Run it from source

```bash
git clone https://github.com/Cookiebubba/orbit-voice.git && cd orbit-voice
bash scripts/mac-setup.sh      # Node 20+, npm ci, the UI, the wake-word model
npm run mac:helper             # the Swift helper (needs the Xcode command line tools)
npm run app
```

## Build the Mac apps

```bash
npm run dist:mac
```

This builds the UI, fetches the wake-word model, builds the helper (`scripts/build-mac-helper.mjs`:
a universal arm64 + x86_64 binary with `swiftc`, macOS 12 and later), makes sure both Mac versions
of the speech engine are in `node_modules` (`scripts/mac-native.mjs`), then runs
`electron-builder --mac`. Into `dist/`: `Orbit-<version>-arm64.dmg` / `.zip`,
`Orbit-<version>-x64.dmg` / `.zip`, and the blockmaps (plus `latest-mac.yml` when publishing).

### Signing

electron-builder signs every binary in the app, the helper included, with the hardened runtime and
`build/entitlements.mac.plist`:

- `cs.allow-jit`, `cs.allow-unsigned-executable-memory`: V8's JIT;
- `cs.disable-library-validation`: sherpa-onnx's native addon and dylibs load in ad-hoc test builds
  too (no Team ID to match); `DYLD_*` variables stay stripped and aren't needed (`@rpath` =
  `@loader_path`);
- `device.audio-input`: the microphone (macOS still asks);
- `automation.apple-events`: unused today, see above.

The file has no XML comments on purpose: codesign's entitlements parser rejects them ("Failed to
parse entitlements: AMFIUnserializeXML").

**Without a Developer ID certificate** build an ad-hoc signed app (it runs on the Mac that built
it, and on others after right-click → Open):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never -c.mac.identity=- -c.mac.notarize=false
```

An ad-hoc signature changes with every build, so macOS treats each build as a new app: turn
Accessibility (and Screen Recording) on again after installing a new ad-hoc build. A Developer ID
build keeps its permissions across updates.

### Developer ID and notarization (for a release)

1. Apple Developer Program ($99/year) → Certificates → **Developer ID Application**. Install it in
   the login keychain of the Mac that builds (Xcode → Settings → Accounts → Manage Certificates →
   +, or import the .p12), or export it as a .p12 and set `CSC_LINK` and `CSC_KEY_PASSWORD`.
   `security find-identity -v -p codesigning` must list it.
2. Notarization credentials, in the environment only (never in the repo), either
   `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` (appleid.apple.com → App-Specific Passwords) +
   `APPLE_TEAM_ID`, or an App Store Connect API key: `APPLE_API_KEY` (path to the .p8),
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
3. `npm run dist:mac`. electron-builder signs, notarizes with notarytool and staples.
4. Check: `spctl -a -vvv -t install dist/mac-arm64/Orbit.app` ("source=Notarized Developer ID") and
   `xcrun stapler validate dist/Orbit-<version>-arm64.dmg`.
5. Publish both zips, both dmgs, their blockmaps and `latest-mac.yml` on the same GitHub release as
   the Windows installer (`electron-builder --mac --publish always` with `GH_TOKEN`, or by hand).

## How the Mac side is built

| Windows | macOS |
| --- | --- |
| `src/desktop.ps1` (UI Automation) | `src/platform/mac/desktop.js` over the helper's `ax` mode: the same modes and answers, the same safety checks |
| `electron/claude-window.ps1` | `orbit-helper claude-window`: Claude's windows (AX + CGWindowList), moves, the prompt box |
| `src/platform/win/focus.ps1` | `orbit-helper focus`: NSWorkspace + AX notifications |
| `src/platform/win/uia.ps1` | `orbit-helper ax`: scan / read / selection / act / hit; rich web editors get text through Chromium's own input path |
| `src/platform/win/capture.ps1` | `orbit-helper capture`: ScreenCaptureKit + Vision OCR |
| WMI (`Win32_Process`) | `orbit-helper proc`: `proc_pidpath` + `KERN_PROCARGS2` |
| `taskkill` | SIGTERM, then SIGKILL |
| named pipe | Unix socket in the user's temp folder, mode 0600 |
| DPAPI | Electron safeStorage (Keychain) |
| orbit-jail (low integrity + Job Object) | `sandbox-exec` with Orbit's profile (`src/mcp/sandbox.js macProfile`): writes only to `~/Library/Application Support/Orbit/mcp/<id>`, no reading Keychains, `~/.ssh`, `~/.gnupg`, `~/.aws` or Orbit's settings |

Window handles are CGWindowIDs, rects are points (Electron's own screen coordinates on a Mac).

## Tests

- `npm test` (any OS): `test/mac-desktop.test.js` runs the Claude driver against a stand-in with the
  real app's accessibility shape; `test/mac-helper.test.js` runs the helper's protocol and its
  self-test on a Mac (skipped elsewhere).
- `npm run e2e:mac` (a Mac, with Accessibility for the app running it): a stand-in Claude window
  (`test/e2e/mac-fake-claude.html`) driven by the real helper, end to end.
- `npm run check:voice -- <folder> --stt parakeet-110m`: Kitten speaks, the VAD finds it, Moonshine
  and Parakeet write it back.

## How Orbit finds things on a Mac

- **The Claude app**: by its bundle id, `com.anthropic.claudefordesktop`.
- **Claude's session list**: `~/Library/Application Support/Claude/claude-code-sessions`.
  Transcripts: `~/.claude/projects`.
- **Claude Code**: the path in Settings → Second brain, your PATH, your login shell's PATH (asked
  once at startup), `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.npm-global/bin`, then the copy inside the Claude app.
- **Logs and settings**: `~/Library/Application Support/Orbit` (Settings → About → Open log folder).

## Opening an unsigned or ad-hoc build

Gatekeeper refuses downloaded unsigned apps: right-click **Orbit.app → Open**, then **Open**
(once), or `xattr -dr com.apple.quarantine /Applications/Orbit.app`.
