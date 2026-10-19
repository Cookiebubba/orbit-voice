# Changelog

## Unreleased

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
