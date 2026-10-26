# Orbit on macOS

Orbit for Mac is **Orbit Native**, a native Swift app (`mac-swift/`) around the same Node core the
Windows app runs. It does what Orbit does on Windows: the voice (Claude or Grok), the wake word,
hearing what your Claude sessions are doing, the second brain and web search, driving the Claude
desktop app (typing drafts, Send, Stop, answering Claude's cards, switching sessions, starting new
ones in a folder, Claude's own controls), Qubit on Claude's window, and Orbit anywhere (reading and
acting in other apps, looking at a window, Orbit's mouse, apps under Orbit).

Where Windows uses PowerShell helpers and UI Automation, the Mac uses **orbit-helper**, one small
Swift binary built from `native/mac/OrbitHelper/` and shipped inside the app's core
(`Orbit Native.app/Contents/Resources/core/resources/mac/orbit-helper`). It speaks the same JSON
protocols as the Windows helpers, through the macOS accessibility API (AXUIElement), the window
server (CGWindowList), ScreenCaptureKit and Vision. Orbit starts it as its own child process, so
macOS counts it as Orbit: the switches you turn on for Orbit Native in System Settings cover it.

(Until 1.3.0 beta 4 the Electron app also had a Mac build. It's gone: the Electron app is Orbit for
Windows.)

## Requirements

- macOS 14 or later on Apple silicon.
- The [Claude desktop app](https://claude.ai/download) and Claude Code, signed in. If the Claude app's
  copy isn't there and `claude` isn't installed, install it in Terminal:

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  ```

  (or `brew install --cask claude-code`, or `npm install -g @anthropic-ai/claude-code` with Node.js 22
  or later), then run `claude` once and sign in with your Claude account. See Anthropic's
  [setup guide](https://code.claude.com/docs/en/setup). Orbit shows the same command, with Copy and
  Check again, when it can't find Claude Code. It never runs the installer itself.
- Only for Grok voice: an xAI API key.

## Install

Download `Orbit-Native-<version>-arm64.dmg` from the [releases](../../../releases), open it and drag
**Orbit Native** to Applications. It isn't notarized by Apple yet, so the first time macOS says it
can't check it: open **System Settings → Privacy & Security**, click **Open Anyway** next to Orbit
Native and confirm. Then Orbit walks you through choosing a voice and the permissions below.

## What works

| On a Mac | |
| --- | --- |
| First launch: choose Claude voice or Grok voice and set it up; no key needed for Claude voice | Works |
| Grok voice, the hotkey (**⌘⌥G** by default), the "Hey Orbit" wake word | Works |
| Claude voice: Silero VAD, Moonshine / Parakeet speech to text, Kitten speech, all on the Mac | Works |
| Typing a draft into Claude, Send, Stop, answering permission and question cards | Works (Accessibility) |
| Switching sessions, new session (in a folder), the model / permission pickers, sidebar, panels | Works (Accessibility) |
| Qubit standing on Claude's prompt box, and joining other windows | Works (Accessibility) |
| Orbit anywhere: the window in front, reading a window, its selection, acting in it | Works (Accessibility) |
| Looking at a window (a picture and on-device OCR) | Works (Screen Recording) |
| Orbit's mouse | Works: a click-through panel on every Space, over full-screen apps too |
| Apps under Orbit (the pipe keeper) | Works: closes the app (SIGTERM, then SIGKILL), runs it under a private DevTools pipe on a user-only Unix socket, relaunches it normally with `open -a` |
| Local MCP servers | Boxed in Apple's sandbox (`sandbox-exec`, see below) or Docker |
| Menu bar icon, Dock, Open at login, single instance | Works |
| Updates (GitHub releases: `Orbit-Native-<version>-arm64-mac.zip` and `latest-mac-native.yml`) | Checks and downloads (SHA-512 checked). Installing on quit needs a release signed by the same Developer ID as the running copy; until releases are, install a new version from its dmg |

## What macOS asks you

Orbit's first-run setup walks through them, and Settings → **Mac permissions** shows each with a
**Turn on** button (macOS's own prompt, or System Settings at the right place). A banner on the main
screen shows while one Orbit needs is off.

| Permission | Why | Where |
| --- | --- | --- |
| **Accessibility** (needed) | Typing into Claude and pressing its buttons, following its window for Qubit, Orbit anywhere | System Settings → Privacy & Security → Accessibility → Orbit Native on |
| **Microphone** (needed) | Hearing you, and the offline "Hey Orbit" | asked by the setup; Privacy & Security → Microphone |
| **Screen Recording** (optional) | Only "look at this window" (a picture plus OCR). Takes effect after Orbit restarts | Privacy & Security → Screen & System Audio Recording |
| Keychain | Your xAI key (and the optional Anthropic key, connector tokens, keeper tokens) are sealed with a key kept in your login Keychain. Choose **Always Allow** | the first time Orbit opens |
| Notifications | Optional: "Claude finished" | the first time |

Until the app is signed with a Developer ID and notarized, each new build has a new signature, so
macOS may ask for Accessibility and the Keychain again after an update.

## Build it

See [mac-swift/README.md](../mac-swift/README.md). In short, on a Mac with Xcode and Node.js:

```bash
npm ci && npm run build:ui && node scripts/fetch-model.mjs   # at the repo root
cd mac-swift
scripts/build-app.sh                                       # dist/Orbit Native.app (release), signed
scripts/package.sh                                         # the zip, the dmg and latest-mac-native.yml
```

`build-app.sh` compiles orbit-helper itself. For a release, sign with a Developer ID and notarize:
`ORBIT_SIGN_ID="Developer ID Application: <name> (<team>)" scripts/build-app.sh`, then
`ORBIT_NOTARY_PROFILE=<keychain profile> scripts/package.sh`. Upload the zip, the dmg and
`latest-mac-native.yml` to the same GitHub release as the Windows installer.

`npm run mac:helper` (`scripts/build-mac-helper.mjs`) builds the helper on its own into
`resources/mac/orbit-helper`, for the helper's tests and `npm run e2e:mac`.

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
| DPAPI | AES-256-GCM, with the key in the login Keychain |
| orbit-jail (low integrity + Job Object) | `sandbox-exec` with Orbit's profile (`src/mcp/sandbox.js macProfile`): writes only to `~/Library/Application Support/Orbit/mcp/<id>`, no reading Keychains, `~/.ssh`, `~/.gnupg`, `~/.aws` or Orbit's settings |

Window handles are CGWindowIDs, rects are points.

## Tests

- `npm test` (any OS): `test/mac-desktop.test.js` runs the Claude driver against a stand-in with the
  real app's accessibility shape; `test/mac-helper.test.js` runs the helper's protocol and its
  self-test on a Mac (skipped elsewhere).
- `cd mac-swift && swift test`: Orbit Native's own tests.
- `npm run parity` (a Mac): the parity suite against a test build of Orbit Native
  ([parity/README.md](../parity/README.md)).
- `npm run e2e:mac` (a Mac, with Accessibility for the app running it): a stand-in Claude window
  (`test/e2e/mac-fake-claude.html`) driven by the real helper and the core's Mac driver, end to end.
- `npm run check:voice -- <folder> --stt parakeet-110m`: Kitten speaks, the VAD finds it, Moonshine
  and Parakeet write it back.

## How Orbit finds things on a Mac

- **The Claude app**: by its bundle id, `com.anthropic.claudefordesktop`.
- **Claude's session list**: `~/Library/Application Support/Claude/claude-code-sessions`.
  Transcripts: `~/.claude/projects`.
- **Claude Code**: the path in Settings → Second brain, your PATH, your login shell's PATH (asked
  once at startup), `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.npm-global/bin`, then the copy inside the Claude app.
- **Logs and settings**: `~/Library/Application Support/Orbit Native` (Settings → About → Open log
  folder).
