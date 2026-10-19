# Changelog

## Unreleased

- **Claude Code sign-in made easy.** Claude Code keeps its own sign-in, separate from the Claude desktop app's, and it can expire. Settings → Second brain now shows whether it's signed in, with a **Sign in** button that opens Claude Code's own sign-in. When a question fails because the sign-in expired, Grok says so and offers to open it; say yes and it opens. The message now says the sign-in expired, instead of a generic "not signed in".
- **Sending is voice-only.** The draft card (Send / Edit / Discard) is gone from Orbit's window. Grok reads the draft back, and only your clear "yes" sends it; to change it, ask Grok to redraft. The bridge no longer accepts the old button messages, so there's one way to approve a send.
- **Start a new session by voice:** "start a new session" or "new thread in castpilot".
  - Orbit presses Claude's own New session button (or New session in that project) and confirms an empty session opened. Nothing is typed.
  - Grok then asks what to tell Claude. The usual draft, read-back and "yes" follow, and you never touch the keyboard.
  - That first prompt only goes into the new, still-empty session, in the folder you heard.
  - Reading it back waits a few seconds for Claude to save it. It never reads an older session that happens to have the same title.
  - It only happens when you ask in your own words.
- **Spoken updates while asleep** (Settings → When Claude finishes → "Wake Grok to say it", off by default).
  - When Claude finishes while Grok sleeps, Grok connects just long enough to say what Claude did, then asks what you'd like to do.
  - The mic opens only after Grok has spoken, for 3 seconds. Answer and the conversation carries on (and hangs up after 20 s of quiet). Stay quiet and it hangs up.
  - There's no always-on listening, and the bridge enforces the window too. Each wake bills a few seconds of xAI time.
- Switching sessions by voice now needs you to have asked for it. Notifications and text in transcripts never count.
- Fixed: the orb and status could get stuck on "Connecting…" after Grok hung up.
- **Security review (b)** ([report](docs/security/2026-10-19b-review.md)): 11 issues fixed or documented (2 medium, 9 low), plus 6 bugs found by testing. Highlights:
  - A noise during a spoken update's listening window can't keep the mic open: only transcribed words continue the conversation.
  - Orbit only ever presses or types into Claude's own page, never a web page shown inside Claude's window. Send must sit right next to the prompt box.
  - A refused spoken update never connects to xAI.
- The fuzzer covers the new tool, spoken updates (mic timing at the bridge) and the new setting.

- **Second brain:** for hard questions, or questions about the code in your current project, Grok quietly asks Claude (Haiku, Sonnet or Opus, picked per question or fixed in Settings) and answers in its own words. Claude can read the open session's project (read-only) and never changes anything. It runs your own Claude Code headless and isolated, so it needs no setup if you use Claude Code; an Anthropic API key is optional. The only UI is Settings → Second brain: on/off, model, "Read the current project", connection, a connection test, and the Claude Code location.
- One-question mode waits for a second-brain answer before hanging up.
- **Stick to Claude Code** (Settings → App): the orb rides on the Claude window.
  - It follows moves and resizes at any display scaling.
  - It stays on top of Claude without floating over other apps.
  - It hides while Claude is minimized.
  - Drag it to choose its spot, which is remembered from the nearest corner.
- While Claude works and Grok is off or asleep, Claude-orange tiles flow through the orb, fading in and out smoothly, instead of a pulsing orange ring around it. While Grok is on, the orb keeps its own colors. Otherwise it changes only with Grok's state and its opacity.
- The orb's brightness has one clear step per state: asleep 25%, off 35%, Claude working with Grok off 60%, Grok listening 80%, and full while you talk or Grok thinks or answers. Grok listening is always brighter than Claude working, so you can tell Grok is on.
- Each Grok session's end is logged with its length, who ended it, and counts only (seconds of mic audio sent, loudest level, how often Grok heard you and replied, tool calls). No audio or words are logged.
- The orb has no glow or ring around it any more: its brightness alone shows activity.
- **Pulse with your voice** and **Pulse with Grok's voice** (Settings → App, optional, separate): the orb grows with the voice level, by an amount you set (1–10%). It's drawn inside the shader, so the tile grid stays crisp and the animation isn't disturbed. Scaling the whole orb image made the tiles shimmer.
- **Updates from GitHub Releases** (Settings → Updates).
  - "Update automatically" (on by default) checks at launch and every 6 hours, downloads in the background, and installs when you quit, or right away with "Restart to update".
  - With it off, Orbit checks only when you press "Check now".
  - Each download is verified against the release's SHA-512 before installing. Releases now include `latest.yml` and a blockmap for this.
- The session finder no longer shows "Loading…" before you type.
- Settings has a thin pill scrollbar. Hovering or dragging it outlines the whole track.
- `npm test` runs the new tests.
- **Security review** ([report](docs/security/2026-10-19-review.md)): 13 issues fixed or documented (3 medium, 10 low).
  - **Second brain:**
    - It runs in Claude Code's restricted mode, so its file tools can't leave the project folder.
    - It reads only the project of the session open in Claude, with more secret files blocked.
    - Each question needs new words from you, with at most 10 per conversation.
    - Stopped runs end everything they started, also when Orbit quits.
  - **Copy to clipboard:**
    - One request allows one copy, and "don't copy" isn't a request.
    - The copied text is shown on screen.
  - **Consent:** a "yes" must be under a minute old, and is timed from when that speech started.
  - **Release builds:** npm code never holds a token that can write releases, and the CI actions are pinned to commit SHAs.
  - **Electron 44** (was 33, out of support), with security fuses set.
  - Window, IPC and permission checks match Orbit's exact origin.
- **Robustness**, from a new fuzzer (`npm run fuzz`). Each of these no longer breaks or crashes anything:
  - a damaged Claude session file
  - odd transcript records
  - unusual settings values
  - oversized or malformed voice messages
  - Transcript parsing also stays fast on huge pastes.

## 1.1.0 (2026-10-18)

- **"Go to sleep" now hangs up,** so nothing is billed while asleep. "Hey Grok", the hotkey or a click starts a fresh conversation. One-question mode hangs up after each answer. The 10-minute auto hang-up and the separate hang-up button are gone.
- **"Hey Grok" wake word** (opt-in, Settings → Listening): starts Grok again hands-free. Recognized fully offline by a bundled Vosk model, only while Grok is off or asleep, at no cost and with no audio leaving the PC.
- **Copy to clipboard:** ask Grok to copy text, Claude's last reply or the current draft. It only copies when you just asked it to.
- The installer now includes the offline speech model (verified against a pinned SHA-256 at build time).

## 1.0.0 (2026-10-18)

First public release.

- **Voice companion for Claude Code Desktop,** powered by Grok Voice (xAI realtime API).
- **Read sessions:** ask what Claude is doing, summarize any session, list recent sessions.
- **Send prompts with confirmation:** Grok drafts, reads back, and sends only after a clear yes or a click. Drafts are editable.
- **Switch sessions** by voice or from the title-bar menu (uses Claude's sidebar through Windows accessibility).
- **"Claude finished" alerts:** chime, Windows notification, and an optional spoken summary.
- **Listening modes:** always on (say "go to sleep"), or one question per hotkey press. Optional "don't listen while Grok talks" for speakers.
- **Floating always-on-top orb** (orbkit SHDR-29). It glows when you talk, dims asleep, and pulses amber while Claude works.
- **Settings:** voice (live list from xAI with preview), speed, global wake hotkey (default Ctrl+Alt+G), start with Windows, usage meter and cost estimate.
- **Error log** readable by Grok ("what went wrong?") and openable from Settings.
- **Security:** per-launch session token for the local bridge, encrypted key storage, no clipboard use, sandboxed renderers. A full review was done and every finding fixed before release ([report](docs/security/2026-10-18-review.md)).
- **Windows installer** (NSIS, per-user).
