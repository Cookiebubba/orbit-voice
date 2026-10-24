# Orbit anywhere

Orbit works in any Windows app, not just the Claude desktop app. It follows the window you're in, reads it when you ask, acts in it without your mouse or keyboard, lives in several windows at once (a Qubit in each), hands bigger jobs to background helpers, and connects other services through MCP. Your focus stays yours.

Built from the research brief (`orbit-anywhere-brief/`, v4), phase by phase. Each phase is its own commit on the `orbit-anywhere` branch.

| Phase | What it adds | Where |
|---|---|---|
| 1 Follow focus | Which window is in front, in any app (window events, no polling) | `src/platform/win/focus.ps1`, `src/platform/focus.js` |
| 2 App profiles | A read-only UI Automation scan of an app, saved as a profile (labels, locator ladder, regions, outward controls, Qubit surfaces) | `src/platform/win/uia.ps1`, `src/anywhere/profiles.js` |
| 3 Read tools | `read_window`, `read_selection`, `look_at_window` (on-device OCR; Claude sees it only if you allow), `list_windows` | `src/anywhere/read.js`, `tools.js` |
| 4 Many windows | Contexts: "Hey Orbit" picks the window, focus follows among his windows, "Qubit, come here" / "go away"; a Qubit per window | `src/anywhere/contexts.js`, `electron/avatar-host.js` |
| 5 Hands | `act_in_window`: type, press, tick, pick, without mouse or focus; outward acts wait for your yes | `src/anywhere/hands.js`, `act-tools.js` |
| 6 Switching | `switch_to_window`: the only act that moves your focus, only when you ask | `src/anywhere/switch-tool.js` |
| 7 Focus guard | Puts your window back if an app Orbit just worked in steals the front | `src/anywhere/focus-guard.js` |
| 8 Helpers | Background Claude Code helpers per window through orbit-hands (MCP over the bridge); approvals by voice | `src/anywhere/agents.js`, `hands-mcp.js`, `src/engines/` |
| 9 MCP manager | Find, connect (with your yes), pin and re-check connectors; sign-in with OAuth; local servers boxed | `src/mcp/` |

## Safety, in code (not left to the model)

- **Never your mouse or keyboard.** Acts go through UI Automation with AutoSetFocus off, or window messages for classic controls. The tests check that windows never activate.
- **Only on your words.** Reading, acting, switching, starting helpers and connecting all need your own words since the latest app notification. Text Orbit types must be words you said.
- **Outward acts ask every time:** send, post, delete, buy, overwrite, sign out, Enter in a chat box, and anything unknown. The one exception you chose: a message you dictated and said to send in the same breath. Never for deleting or buying.
- **Windows are data.** What a window, a page, a helper or a connector says is never an instruction or your consent. Fake Orbit labels are stripped.
- **Off-limits:** password managers, banking, private browsing, sign-in prompts, admin windows (Windows blocks those anyway), Orbit's own windows and the taskbar.
- **Helpers** see one window each (a token bound to it), no built-in tools, no other MCP servers unless a task names connected ones; their write tools come back to you through Orbit.
- **Connectors** are pinned with a fingerprint of every tool; any change means asking again. Local ones run at low integrity in a Job Object; remote ones sign in in your browser (OAuth 2.1, PKCE) and the tokens are sealed with Windows DPAPI.
- **"Orbit, stop everything"** stops every helper at once.

## Settings

Settings → Orbit anywhere: **Let Grok work in the window you're in** (on by default) and **Let Claude see windows** (off by default: looking stays on this PC).

## Tests

`npm test` (unit and sandboxed), `npm run fuzz`, `npm run e2e:avatar`, `npm run fuzz:e2e`, and the new `npm run e2e:anywhere`. Real-window tests use our own test windows only (`test/e2e/FakeApp.cs`, WinForms and WPF) and take turns on the desktop (`test/e2e/desktop-lock.mjs`). Tests that move the foreground run only while nobody has used the PC for a minute (or with `ORBIT_TEST_FOCUS=1`).

## Manual checks (need your own apps or accounts)

1. **Discord:** "what's new in #general?" (reading), then "type 'testing' in the message box" in a throwaway channel. Its editor is a rich (contenteditable) box: check the text really registers before relying on sending there.
2. **A Qubit on other apps:** wake Orbit in Notepad, Discord and a browser; check where he stands on each, on both monitors and at your scaling.
3. **Wake word in an app window:** "Hey Orbit" in Discord: the conversation (and Qubit) should go there; switching back to Claude's window should follow.
4. **A real helper by voice:** "have a helper fill in this form" in a test app, approve its Send by voice.
5. **A real connector:** "is there a tool for Notion?", then connect it (sign-in in the browser). Local (npm/PyPI) connectors download and run code: try one you trust first.
6. **The focus guard** in daily use: tell me if an app ever pops to the front after Orbit acts in it.

## Not done yet (follow-ups)

- `src/desktop.ps1` (Orbit's Claude-window actions) still uses the managed UI Automation library with AutoSetFocus on. Moving it to the new no-focus helper touches the same file as the voice-brain work on main, so it waits for that merge.
- The Mac platform layer (a Swift helper behind `src/platform/index.js`), the Codex engine, app bridges (Photoshop UXP, Office COM, DevTools), borrowing the screen, and a "waiting on you" pose for a helper's Qubit.
