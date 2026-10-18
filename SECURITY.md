# Security

Orbit can type prompts into Claude Code, an agent that can edit files and run commands on your computer. That makes its security worth taking seriously. This page explains what Orbit protects, how, and how to report a problem.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and the impact. Expect a first reply within a week. Fixes ship as a new release with a note in the [changelog](CHANGELOG.md).

## What Orbit protects

| Asset | Threat | Protection |
| --- | --- | --- |
| Your Claude Code session | Someone else gets a prompt typed into it | A prompt is only sent after **you** confirm it: either you click **Send** on that exact draft, or your transcribed reply after the draft is a clear "yes". A spoken "no", "wait" or "change it", silence, or text inside a transcript never counts. The send re-checks that the same Claude session is still open. |
| Your Claude Code session | Text in a transcript or web page steers Grok (prompt injection) | Transcript content reaches Grok only as tool output marked as untrusted data, never as something you said. The consent rule above is enforced by Orbit's code, not by asking the model nicely. |
| The local bridge (127.0.0.1:4317) | Another program, Windows user or web page drives it | A random per-launch token is exchanged once for an `HttpOnly; SameSite=Strict` cookie that only Orbit's own windows receive. Every API call and the voice socket require it. Host checks (DNS rebinding), Origin checks and `Sec-Fetch-Site` checks (CSRF) add defence in depth. |
| Your xAI key | Theft from disk or logs | Encrypted with Windows DPAPI (Electron `safeStorage`) in `%APPDATA%\Orbit\xai-key.bin`. Never written to logs (scrubbed) or sent anywhere but `api.x.ai`. |
| Your clipboard | Secrets leaking into clipboard history | Orbit never touches the clipboard. It fills Claude's prompt box through Windows accessibility and presses Claude's own Send button. |
| Your machine | Code execution through the app | Renderers are sandboxed with context isolation and no Node integration. Navigation is locked to the local page and external links open in your browser. The only permissions are microphone and notifications, for Orbit's own page. A strict Content-Security-Policy applies. PowerShell is called by full path with fixed arguments, and text is passed base64-encoded, never interpolated into a command. |

## What Orbit does *not* protect against

- **Malware already running as your Windows user.** It can read your files and control your desktop anyway.
- **What Claude Code does with a prompt you approved.** That's governed by Claude Code's own permission mode.
- **Data you choose to send to xAI.** The parts of your sessions Grok reads go to xAI to produce answers.

## Data handling

- **Stays local:** session transcripts are read from disk, read-only. Settings, usage and logs live in `%APPDATA%\Orbit`. Logs contain no keys and no prompt or transcript text.
- **Sent to xAI:** your voice audio, and whatever session text Grok reads to answer you.
- **No telemetry, analytics or auto-update.**

## Reviews

- **2026-10-18:** a full-repository review of 48 files at medium effort found 7 issues: 1 medium and 6 low. All were fixed before 1.0.0. [Report and resolutions](docs/security/2026-10-18-review.md).

## Known limitations

- The Windows installer is not code-signed yet, so SmartScreen will warn. Verify downloads against the `.sha256` file published with each release.
- Releases are built by GitHub Actions from the tagged source (see `.github/workflows/release.yml`).
