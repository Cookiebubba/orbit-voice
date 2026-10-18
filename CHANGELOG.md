# Changelog

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
