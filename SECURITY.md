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
| Your clipboard | Secrets leaking, or a planted command | Sending prompts never touches the clipboard: Orbit fills Claude's prompt box through Windows accessibility and presses Claude's own Send button. Grok can copy to the clipboard only when you asked to copy something in the last 2 minutes, so text in a transcript can't quietly put a command there. |
| Your project and machine | The second brain (Claude, asked by Grok) being steered into running or changing something, or leaking secrets | It runs your Claude Code headless with only read-only tools (Read, Glob, Grep), or none at all. There's no Bash, no edits and no web tools. It loads none of your Claude Code settings, hooks, plugins or MCP servers, so no inherited "bypass permissions" and no connectors. `.env` files and keys are denied. The question goes in on stdin, never on a command line, and nothing is saved to your session history. Orbit only ever runs a file named `claude`/`claude.exe`, and a custom path must be absolute. Its answer reaches Grok as tool output marked as data, never as your consent. |
| Your Anthropic API key (optional) | Theft from disk or logs | Encrypted with Windows DPAPI in `%APPDATA%\Orbit\anthropic-key.bin`, used only by the second brain, never logged. By default the second brain uses your Claude Code sign-in and needs no key. |
| Your microphone | Always-on listening | Off by default. The "Hey Grok" wake word, when you turn it on, runs fully offline (Vosk) and only while Grok is off or asleep. Its audio never leaves the PC. It runs in a hidden helper page with its own script policy (the recognizer needs `eval` and WebAssembly), kept separate from the main window, which keeps the strict policy. |
| Your machine | A tampered or broken update | Updates come only from this repository's published GitHub Releases, over HTTPS. Each download must match the SHA-512 in the release's `latest.yml` before it's installed, and a damaged download is thrown away. The installer isn't code-signed yet, so there's no publisher signature check: an update is as trustworthy as the GitHub account that publishes it. "Update automatically" can be turned off in Settings → Updates. |
| Your machine | Code execution through the app | Renderers are sandboxed with context isolation and no Node integration. Navigation is locked to the local page and external links open in your browser. The only permissions are microphone and notifications, for Orbit's own page. A strict Content-Security-Policy applies. PowerShell is called by full path with fixed arguments, and text is passed base64-encoded, never interpolated into a command. |

## What Orbit does *not* protect against

- **Malware already running as your Windows user.** It can read your files and control your desktop anyway.
- **What Claude Code does with a prompt you approved.** That's governed by Claude Code's own permission mode.
- **Data you choose to send to xAI.** The parts of your sessions Grok reads go to xAI to produce answers.

## Data handling

- **Stays local:** session transcripts are read from disk, read-only. Settings, usage and logs live in `%APPDATA%\Orbit`. Logs contain no keys and no prompt or transcript text.
- **Sent to xAI:** your voice audio, whatever session text Grok reads to answer you, and the second brain's answers.
- **Sent to Anthropic (second brain only):** the question Grok asks, the recent messages of your open Claude session, and any project files Claude reads to answer. It goes through your own Claude Code. Logs record only the model, the time taken and the cost, never the question or the answer.
- **No telemetry or analytics.** The only automatic request is the update check against GitHub Releases (at launch and every 6 hours), which you can turn off.

## Reviews

- **2026-10-18:** a full-repository review of 48 files at medium effort found 7 issues: 1 medium and 6 low. All were fixed before 1.0.0. [Report and resolutions](docs/security/2026-10-18-review.md).

## Known limitations

- The Windows installer is not code-signed yet, so SmartScreen will warn. Verify downloads against the `.sha256` file published with each release.
- Releases are built by GitHub Actions from the tagged source (see `.github/workflows/release.yml`).
