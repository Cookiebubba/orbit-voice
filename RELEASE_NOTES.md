**Orbit 1.3.0 beta 4: Orbit for Mac, native.**

This is a beta. A beta install updates to later betas and to the next stable release.

**New: Orbit Native for Mac** (Apple silicon, macOS 14 or later). A native Mac app written in Swift, with the same Orbit inside:
- **Pick your voice at the start.** The first screen lets you choose Claude voice or Grok voice and set it up right there: install and sign in to Claude Code, or add an xAI key. You can skip it, or skip the whole setup.
- **Qubit is the avatar.** He stands on the Claude window's prompt box and comes with you into other windows when you ask.
- **Orbit anywhere.** Orbit can read and act in other apps' windows, including System Settings: "click Wi‑Fi" picks the sidebar row.
- **Claude voice is heard from the first word.** Speech recognition and Orbit's voice run on your Mac, ready a moment after Orbit opens.

**For Windows and Mac:**
- **Help without Claude Code.** If Claude Code isn't installed, Orbit shows the install command with Copy, the sign-in step, Check again and Anthropic's setup guide. It also tells you when Claude Code isn't signed in.
- **Acting in other windows is more forgiving.** When you name a list or sidebar item, Orbit acts on the row, not just its label, and pressing a row that can only be picked picks it.

You need the Claude desktop app and Claude Code. Grok voice is optional and billed by xAI per minute while connected; the wake word costs nothing.

**Install on Windows:** download `Orbit-Setup-1.3.0-beta.4.exe` below and run it. The installer isn't code-signed yet, so on the SmartScreen prompt click **More info → Run anyway**. You can verify it with the `.sha256` file.

**Install on Mac:** download `Orbit-Native-1.3.0-beta.4-arm64.dmg`, open it and drag **Orbit Native** to Applications. The app isn't notarized by Apple yet, so the first time:
1. Open Orbit Native. macOS says it can't check it for malicious software. Click **Done**.
2. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Orbit Native, then confirm.
3. Orbit asks for the Microphone and Accessibility. Choose **Always Allow** if macOS asks about the Keychain.

Because it isn't notarized yet, macOS may ask for Accessibility and the Keychain again after an update.

The latest stable release is [1.2.0](https://github.com/Cookiebubba/orbit-voice/releases/tag/v1.2.0). Not affiliated with xAI or Anthropic.
