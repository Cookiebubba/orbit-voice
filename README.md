# Grok Voice for Claude Code

A small Grok-style desktop app for talking to your **Claude Code Desktop** sessions out loud, using **Grok Voice** from xAI.

- **Ask about your sessions:** "What's Claude doing?", "Did it finish?", "Summarize my launchpad session."
- **Dictate prompts:** "Tell Claude to run the tests." Grok reads the prompt back. It types the prompt into the Claude app's prompt box and presses Enter only after you say **yes**.
- **Minimize it** and it shrinks to a little **always-on-top orb** that keeps listening. The orb lights up when Grok talks.
- **Say "go to sleep"** and Grok stops listening. Press **Ctrl+Alt+G** from any app to wake it again (or to start it when it is off).

Everything runs on your own PC. Your xAI key is stored in a local file.

---

## Setup

1. **Install Node.js** (the free "LTS" version) from https://nodejs.org, if you don't have it.
2. Put this folder somewhere normal, like `C:\Users\<you>\grok-voice`. Avoid OneDrive.
3. **Double-click `start.bat`.** The first run installs everything, which takes a few minutes.
4. The app asks for your **xAI API key**. Get one at https://console.x.ai → *API Keys*, paste it in, and click *Save key*. Voice usage is billed by xAI to that account.
5. Click the orb, or **Start talking**.

Keep the Claude desktop app open on the Code session you want to work with.

> Tip: headphones stop Grok from hearing itself.

## Using it

**Main window**
- **Orb / Start talking:** connects to Grok. You're only billed while connected.
- **Moon button:** put Grok to sleep (it stops hearing you). Press it again, click the orb, or press **Ctrl+Alt+G** to wake it. After 10 minutes asleep it hangs up to stop xAI billing; Ctrl+Alt+G reconnects.
- **Keyboard button:** type to Grok instead of talking.
- **Red phone button:** hang up.
- **Draft card:** when Grok drafts a prompt for Claude, it shows here. Say "yes", or click **Send** or **Discard**.
- **— button** (or any way of minimizing): shrinks the app to the floating orb.
- **Gear button:** Settings.
  - **Voice:** pick any of Grok's voices (the list comes live from xAI) and click **Preview** to hear it.
  - **Talking speed:** 0.7× to 1.5×.
  - **Wake hotkey:** click the shortcut box and press a new key combo. It works from any app; *Reset* puts back Ctrl+Alt+G.

  Everything saves right away and applies even mid-conversation.

**Floating orb**
- **Click:** opens the main window again.
- **Drag:** move it anywhere.
- **Right-click:** sleep / wake.

**How bright the orb is** tells you its state: faint while asleep, half-lit while it waits in silence, and fully lit while you talk to it or Grok answers.

**Things to say**

| You say | What happens |
| --- | --- |
| "What's Claude doing right now?" | Reads the open session and summarizes it |
| "List my sessions" | Lists recent sessions with project names |
| "What did Claude say in the shakeout session?" | Finds that session by title and reads it |
| "Go to sleep" / "Stop listening" | Says goodbye and stops hearing you until Ctrl+Alt+G |
| "Tell Claude: add a dark mode toggle" | Shows a draft, reads it back, asks "Send it?" |
| "Yes" / "No" / "Change it to…" | Sends, discards, or redrafts |

## How it works

```
 Grok Voice app (Electron)
   ├── main window + floating orb  (React, orb = orbkit SHDR-29)
   └── local bridge  (127.0.0.1:4317, inside the app)
         ├── Grok Voice realtime API   wss://api.x.ai/v1/realtime
         ├── reads sessions:  %APPDATA%\Claude\claude-code-sessions\…  +  ~\.claude\projects\…\*.jsonl
         └── types prompts:   Windows UI Automation → Claude window → "Prompt" box → paste → Enter
```

- **Reading** is read-only. It uses the session list the Claude app keeps on disk and the normal Claude Code transcript files. The Microsoft Store version of Claude keeps its list in `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude`, and the regular installer uses `%APPDATA%\Claude`. Both are checked.
- **"Current session"** is whichever session is open in the Claude window.
- **Sending** finds the prompt box through Windows accessibility, not screen coordinates. It pastes, checks the text landed, presses Enter, and restores your clipboard. It **refuses to send** if:
  - the box already has your own typing in it,
  - you switched sessions after the draft was made,
  - or it can't confirm the paste.

## Terms of service

*Not legal advice, just how it's designed.*

- **xAI:** it uses xAI's official Voice API with your own key.
- **Anthropic / Claude:** this is a voice **input method** for you. It's like dictation, not a bot. Every prompt comes from you, is shown to you, and is sent only after you confirm it, one prompt per "yes". Grok is told never to send on its own. Don't modify it to loop prompts or run Claude unattended through the desktop UI. For automation, use Claude Code's official headless options (`claude -p`, the Agent SDK).
- The bits of your sessions that Grok reads out **are sent to xAI**. Don't use it on sessions containing secrets.
- It's built from scratch and shares no code with any other voice/Claude project. The orb is the open-source orbkit SHDR-29 component, added with `shadcn add zzzzshawn/orbkit/shdr-29`.

## Settings (`.env`, optional)

| Setting | Default | Meaning |
| --- | --- | --- |
| `XAI_API_KEY` | — | Saved automatically by the setup screen |
| `GROK_VOICE` | `eve` | Grok's voice. Easiest to change in Settings |
| `GROK_VOICE_SPEED` | `1` | Talking speed, 0.7 to 1.5. Easiest to change in Settings |
| `GROK_VOICE_MODEL` | `grok-voice-latest` | xAI voice model |
| `RETURN_FOCUS` | `true` | After sending, switch back to the window you were in |
| `WAKE_HOTKEY` | `Control+Alt+G` | Global start / sleep / wake hotkey. Easiest to change in the app's Settings ([Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator) format) |
| `PORT` | `4317` | Local port |

## For developers

```bash
npm install
npm run build:ui     # builds ui/ into public/
npm run app          # desktop app
npm run web          # same UI in a browser tab at http://127.0.0.1:4317 (no floating orb)
npm run check        # lists sessions + reads the open one, no key needed
```

- `ui/`: React + Tailwind + shadcn. `App.tsx` is the main window, `OrbWindow.tsx` the floating orb, and `useVoice.ts` handles mic, audio, phase and levels.
- `electron/`: the window shell, starting the bridge in-process.
- `src/`: bridge server, Grok tools, session reader, Windows UI Automation script.
- `GVB_SNAPSHOT_DIR=<dir> npm run app` saves screenshots of both windows and quits. Handy for checking UI changes. Add `GVB_SNAPSHOT_SETTINGS=1` to self-test the hotkey settings: it records a new shortcut, presses it, then resets to the default.

## Known limits

- **Windows only** for sending prompts.
- Sends only to the session **open in the Claude window**.
- If the Claude window is hidden in the system tray, it can't be found. Open it.
- "Working / idle" is a best guess from the transcript.
