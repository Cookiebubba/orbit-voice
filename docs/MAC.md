# Orbit on macOS (phase 1)

Phase 1 makes Orbit's core run on a Mac: the voice (Grok or Claude), the wake word, the orb, the
avatars, hearing what your Claude sessions are doing, the second brain and web search. What it
doesn't do on a Mac yet is reach into the Claude app itself. That's phase 2.

## Requirements

- Claude Code, signed in. If the Claude app's copy isn't there and `claude` isn't installed, install it
  in Terminal:

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  ```

  (or `brew install --cask claude-code`, or `npm install -g @anthropic-ai/claude-code` with Node.js 22
  or later), then run `claude` once and sign in with your Claude account. See Anthropic's
  [setup guide](https://code.claude.com/docs/en/setup). Orbit shows the same command, with Copy and
  Check again, when it can't find Claude Code. It never runs the installer itself.
- Only for Grok voice: an xAI API key.

## What works, and what doesn't yet

| On a Mac | Phase 1 |
| --- | --- |
| Grok voice, the hotkey (⌃⌥G), the "Hey Orbit" wake word | Works |
| Claude voice (beta): speech recognized and spoken on the Mac, Claude Haiku through your Claude Code | Works (needs macOS 14+ on Apple silicon, 15+ on Intel) |
| Hearing your sessions: "Claude finished", what a session did, spoken updates | Works (reads `~/.claude/projects` and the Claude app's session list) |
| The second brain and web search (through your own Claude Code) | Works |
| The orb | Floats free, on every Space, wherever you drag it |
| The avatar (Qubit or the pixel buddy) | Floats free along the bottom of the screen, just above the Dock |
| Menu-bar icon, Open at login, updates check | Works (installing an update needs a signed build) |
| **Typing a prompt into Claude, sending it, Stop** | **Not yet.** Grok says "Typing into Claude isn't on Mac yet" and can read the prompt out for you to paste |
| **Answering Claude's permission cards and questions** | **Not yet** |
| **Switching sessions or starting a new one in the Claude app** | **Not yet** (the session list still shows, from disk) |
| **The orb sticking to the Claude window; the avatar standing on its prompt box** | **Not yet** (both float free instead) |

## What macOS will ask you

| When | What | Why |
| --- | --- | --- |
| First launch | **Microphone**: "Orbit would like to access the microphone" | To hear you. Say OK. If you said no: System Settings → Privacy & Security → Microphone → Orbit on, then quit and reopen Orbit. Orbit shows a dialog with a button that opens that page. |
| First time you save a key | **Keychain**: Orbit wants to use "Orbit Safe Storage" in your keychain | Your xAI key (and the optional Anthropic key) is encrypted with a key kept in your login Keychain. Choose **Always Allow**. If you deny it, Orbit says the key wasn't saved; nothing crashes. |
| First "Claude finished" | **Notifications** | Optional. The chime and the spoken update work without them. |
| Signing in to Claude Code from Orbit | Terminal opens and runs `claude auth login` | A Mac app has no console of its own. Close the Terminal window when it's done. |
| Open at login (tray menu or Settings) | Orbit appears in System Settings → General → Login Items | It starts quietly as the orb. |

Phase 1 never asks for Accessibility or for permission to control other apps (Apple Events). The
app declares why it would want them (Info.plist) for phase 2.

Running from source (`npm run app`), macOS asks on behalf of **Terminal** (or your editor), since
that's the app that started Electron.

## Run it from source

```bash
git clone https://github.com/Cookiebubba/orbit-voice.git && cd orbit-voice
bash scripts/mac-setup.sh      # checks Node 20+, npm ci, builds the UI, fetches the wake-word model
npm run app
```

## Build the Mac apps

```bash
npm run dist:mac
```

This builds the UI, fetches the wake-word model, makes sure both Mac versions of the speech engine
are in `node_modules` (`scripts/mac-native.mjs`: npm only installs the one for your Mac; the other
is fetched at the exact version and SHA-512 in `package-lock.json`), then runs
`electron-builder --mac`. Into `dist/`:

- `Orbit-<version>-arm64.dmg` and `.zip` (Apple silicon)
- `Orbit-<version>-x64.dmg` and `.zip` (Intel)
- `latest-mac.yml` (what the updater reads) and `.blockmap` files

The two architectures are separate apps, not one universal app: sherpa-onnx ships each
architecture's native speech engine as its own package, which a universal merge can't reconcile
without extra rules. Each app also carries the other architecture's speech engine (about 37 MB
unused); trimming that is a later clean-up.

Without a Developer ID certificate in your keychain the apps are **unsigned and not notarized**,
and the build still succeeds (electron-builder logs "skipped macOS application code signing").

### Opening an unsigned build

Downloaded or copied apps get the quarantine flag, and Gatekeeper refuses unsigned ones. Either:

- right-click (or Control-click) **Orbit.app → Open**, then **Open** in the dialog (once), or
- `xattr -dr com.apple.quarantine /Applications/Orbit.app`

If macOS still says the app "is damaged" or it quits at once (an Apple silicon Mac insists on a
valid signature), give it an ad-hoc signature:

```bash
codesign --force --deep --sign - /Applications/Orbit.app
```

An app built on the same Mac isn't quarantined, so it usually just opens.

### Signing and notarizing (later)

1. Join the Apple Developer Program ($99/year) and create a **Developer ID Application**
   certificate. Put it in your login keychain (or export it as a .p12 and set `CSC_LINK` and
   `CSC_KEY_PASSWORD`).
2. Set notarization credentials in the environment, never in the repo. Either:
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (from appleid.apple.com) and `APPLE_TEAM_ID`, or
   - an App Store Connect API key: `APPLE_API_KEY` (path to the .p8), `APPLE_API_KEY_ID`,
     `APPLE_API_ISSUER`.
3. `npm run dist:mac`. electron-builder signs every binary in the app with the hardened runtime and
   `build/entitlements.mac.plist`, then notarizes and staples. Without the variables it signs but
   skips notarizing (with a warning).
4. Check: `spctl -a -vvv -t install dist/mac-arm64/Orbit.app` and
   `xcrun stapler validate dist/Orbit-<version>-arm64.dmg`.
5. Publish: upload the four Mac files, their blockmaps and `latest-mac.yml` to the same GitHub
   release as the Windows installer. Updates on a Mac install only into a signed app; an unsigned
   one can check and download but says it needs a signed copy.

The entitlements: `allow-jit` and `allow-unsigned-executable-memory` for V8;
`disable-library-validation` so unsigned and ad-hoc test builds can load sherpa-onnx's native addon
and dylibs (a Developer ID build re-signs them with Orbit's identity, so it would pass without it;
`DYLD_*` variables stay blocked, and aren't needed: the libraries find each other through `@rpath`
= `@loader_path`); `device.audio-input` for the microphone; `automation.apple-events` for phase 2.

## How Orbit finds things on a Mac

- **Claude's session list**: `~/Library/Application Support/Claude/claude-code-sessions` (the Claude
  app's data folder, like `%APPDATA%\Claude` on Windows). Transcripts: `~/.claude/projects`.
- **Claude Code**, in order: the path in Settings → Second brain, your PATH, your login shell's PATH,
  `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`,
  then the copy inside the Claude app
  (`~/Library/Application Support/Claude/claude-code/<version>/…/claude`, newest first).
- **Your login shell's PATH**: an app opened from Finder or the Dock doesn't get your terminal's
  PATH, so Orbit asks your shell once at startup (`$SHELL -ilc`, with a time limit) and keeps the
  answer in memory. Only the number of folders is logged. Claude Code runs with that PATH, so an
  npm-installed Claude Code finds its `node`.
- **Stopping Claude Code**: every run Orbit starts is its own process group; ending it ends the
  whole group (SIGTERM, then SIGKILL), and everything is killed when Orbit quits.
- **Logs and settings**: `~/Library/Application Support/Orbit` (Settings → About → Open log folder).

## Mac phase 1 test checklist

Use a Mac with the Claude app (or Claude Code) signed in and a few recent Claude Code sessions.
Open the log folder (Settings → About) when something looks wrong.

1. **Setup**: `bash scripts/mac-setup.sh`. Expect: Node version printed, `npm ci` finishes, the UI
   builds, "model saved and verified" (or "model ok"), and the speech engine line says
   `sherpa-onnx-darwin-arm64` (or `-x64`) is installed.
2. **Launch from source**: `npm run app`. Expect: macOS asks for the microphone (for Terminal), then
   the small black Orbit window with the traffic lights at its top left, a menu-bar icon (a small
   planet with a moon, tinted for your menu bar) and the Orbit dock icon. No error dialog.
3. **Microphone denied path**: in System Settings → Privacy & Security → Microphone turn Terminal
   off, relaunch. Expect: a dialog "Orbit can't use the microphone" with "Open System Settings",
   and pressing Start talking shows a caption telling you where to allow it. Turn it back on.
4. **Key** (Grok voice only; Orbit opens without one): Settings → Voice engine → Grok, paste your
   xAI key. Expect: a Keychain prompt for "Orbit Safe Storage"; Always Allow. Settings → Voice
   engine says "xAI key saved, encrypted with a key in your macOS Keychain".
5. **Hotkey**: the main window and Settings show **⌃⌥G**. Press Control-Option-G in another app.
   Expect: Grok starts; press again: it sleeps. Record a new shortcut in Settings with ⌘ in it,
   then set it back.
6. **Grok voice**: talk to it, interrupt it, say "go to sleep". Expect: the same as on Windows.
7. **Wake word**: Settings → Listening → Wake word on. With Grok asleep say "Hey Orbit". Expect:
   it wakes within a second or two.
8. **Claude voice**: Settings → Voice engine → Claude (beta). Expect: the ~175 MB download with progress,
   then "ready". Talk to it; note the latency line in the log ("Claude voice turn: you stopped →
   first audio …"; under about 2 s is good). On an Intel Mac below macOS 15 expect a clear
   "needs macOS 15" error instead.
9. **Sessions**: open the session menu in the title bar. Expect: your recent Claude sessions listed
   (from disk). Ask Grok "what's Claude doing in <session>?". Expect: a sensible answer from the
   transcript. Finish a task in Claude. Expect: the chime and the spoken "Claude finished".
10. **Typing into Claude**: ask Grok to send Claude a prompt. Expect: it says, in a sentence,
    that typing into Claude isn't on Mac yet (and offers to read the prompt out). Same for "stop
    Claude" and "approve that".
11. **findClaude**: Settings → Second brain. Expect: "Using Claude Code on this Mac." (or "the copy
    inside the Claude app"), and the path field's placeholder shows the path it found. Then quit
    Orbit, start the built app from Finder (step 16) and check again: still found (the login-shell
    PATH or the usual folders). The log has "login shell PATH: N folders", never the folders.
12. **Second brain**: ask Grok something hard about a project ("explore"). Expect: "Let me look
    into that", then an answer. Ask another and quit Orbit while it works: Activity Monitor shows no
    `claude` left over a few seconds later.
13. **Web search**: ask "what's the latest Node release?" Expect: an answer with sources.
14. **The orb**: minimize (yellow light). Expect: the orb floats bottom-right, draggable, stays put
    after a relaunch, follows you to other Spaces. The dock icon brings the window back.
15. **Qubit free-floating**: Settings → Avatar → Qubit. Expect: Qubit along the bottom of the
    screen just above the Dock, asleep while Orbit is asleep, waking when you call, reacting while
    Grok talks, clicks passing through except on him. Turn "Show the orb" off: he stands in for it.
    Try the pixel buddy too. Move the Dock or plug in a display: the strip follows.
16. **Built app**: `npm run dist:mac`, open `dist/Orbit-<version>-arm64.dmg`, drag Orbit to
    Applications, open it (right-click → Open the first time). Expect: the microphone prompt now
    names Orbit; everything above works the same; the speech engine loads (Claude voice).
17. **Menu bar and login**: click the menu-bar icon. Expect: Open Orbit, Talk / sleep (⌃⌥G), Open at
    login, Quit. Turn Open at login on; log out and in. Expect: Orbit starts as the orb only.
18. **Updater**: in the built app, Settings → Updates → Check now. Expect: it reaches GitHub and
    reports the newest beta (or "up to date"); with an unsigned app a download may end in "Updates
    on a Mac need a signed copy of Orbit", which is expected until it's signed.
19. **Quit**: Quit from the menu bar. Expect: no Orbit or `claude` processes left (Activity Monitor).

## Rough edges

- The avatar floats free on Macs; it can't stand on Claude's prompt box or stomp Send yet.
- Floating over another app's full-screen Space isn't possible while Orbit keeps its dock icon
  (macOS only lets accessory apps do that). It follows you across normal Spaces.
- The Claude app's Mac data folder and its bundled Claude Code location mirror Windows; if the
  Claude app lays them out differently on your Mac, Orbit still finds Claude Code on your PATH.
