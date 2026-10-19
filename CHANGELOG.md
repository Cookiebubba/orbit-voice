# Changelog

## Unreleased

- **Second brain:** for hard questions, or questions about the code in your current project, Grok quietly asks Claude (Haiku, Sonnet or Opus, picked per question or fixed in Settings) and answers in its own words. Claude can read the open session's project (read-only) and never changes anything. It runs your own Claude Code headless and isolated, so it needs no setup if you use Claude Code; an Anthropic API key is optional. The only UI is Settings → Second brain: on/off, model, "Read the current project", connection, a connection test, and the Claude Code location.
- One-question mode waits for a second-brain answer before hanging up.
- **Stick to Claude Code** (Settings → App): the orb rides on the Claude window.
  - It follows moves and resizes at any display scaling.
  - It stays on top of Claude without floating over other apps.
  - It hides while Claude is minimized.
  - Drag it to choose its spot, which is remembered from the nearest corner.
- While Claude works, Claude-orange tiles flow through the orb, fading in and out smoothly, instead of a pulsing orange ring around it. The orb also brightens to at least 85% opacity, even when Grok is off or asleep (normally 55% and 30%). Otherwise it changes only with Grok's state and its opacity.
- The orb has no glow or ring around it any more: its brightness alone shows activity.
- **Pulse with your voice** (Settings → App, optional): the orb grows up to 6% with your voice level.
- **Mute my mic in other apps while Grok listens** (Settings → Listening, optional): the apps you choose get silence while Grok has your mic, and get it back when Grok sleeps.
  - Choose "mute all apps except…" or "mute only…", and switch individual apps from the list of apps using your mic.
  - Recording and audio-routing apps (OBS, Streamlabs, Cap, Voicemeeter, Krisp, NVIDIA Broadcast, Voicemod…) are left alone by default.
  - Orbit only unmutes what it muted, and recovers after a crash.
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
