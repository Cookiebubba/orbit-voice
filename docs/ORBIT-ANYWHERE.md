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

## Typing into web apps

Web-based apps (OpenCode, Discord, anything Chromium, Electron or WebView2) keep their own model of a text box and only change it on input events. UI Automation's SetValue writes the text without one: it shows in the box, but the app never takes it, and its Send stays grey. Keys posted to the window without focus don't help either: Chromium drops key input while it isn't focused (tested on our own Electron app, Chrome and Edge, with WM_CHAR, WM_IME_CHAR and a space-and-backspace "nudge").

So every text act is checked: after typing, uia.ps1 looks at the app's own state (a Send-like button next to the box came on, or the box was put back) and reports `registered`. If the app didn't take it, Orbit tries the next way by itself and says so in a few words:

1. **SetValue** (UI Automation, no focus at all): the way for desktop apps, and the first try everywhere.
2. **The app's DevTools protocol** (no focus either): only with **Type into web apps through their debugging port** on, and only for an app the user started with `--remote-debugging-port`. `src/anywhere/cdp.js` finds the window's own page on 127.0.0.1, focuses the box by its accessible name, and uses `Input.insertText`. It never runs code in the page.
3. **Borrowing focus for a second**: the box takes the keyboard focus, the text goes in as keystrokes (only while that box has the focus), and the user's window comes straight back. Orbit asks once per app ("OpenCode didn't take the typed text. Want me to type it by borrowing focus for a second?"); a yes is remembered in the app's profile.

The way that worked is saved in the app's profile (`inputMethod`, `borrowFocusOk`) and tried first next time.

| Test app (our own instances only) | SetValue | Debugging port | Borrowed focus |
|---|---|---|---|
| Electron test app (`test/e2e/web-input/`: a contenteditable editor and a controlled textarea) | shows, not taken (noticed) | taken, never activated | taken, user's window back |
| Chrome, fresh profile, local page | shows, not taken (noticed) | taken | taken |
| Edge, fresh profile, local page | shows, not taken (noticed) | taken (box found by its attributes while the page is in the background) | taken |

OpenCode wasn't tested directly: it's a single-instance desktop app, and a second copy could reach the user's running one.

### Apps under Orbit (the pipe keeper)

Rich editors (Discord's Slate message box, ProseMirror, Lexical) ignore SetValue entirely, and borrowing focus can't work from Orbit's background helper (Windows' foreground lock won't let it bring the app forward). So `uia.ps1` never writes into a rich box (`rich_box`, no stray text), and for those apps Orbit offers the one way that works without the mouse or focus: **restart the app under Orbit**.

- **Asked once per app** ("Discord only takes real typing. Restart Discord under Orbit so it can type and look without your mouse? Only Orbit can connect; nothing stays open."), held like an outward act until a clear yes. The yes is remembered (`anywhereUnderOrbit`); later, Orbit restarts that app under itself when it needs to and says so. **Stop** in Settings (or "stop Discord being under Orbit": `release_app_from_orbit`) restarts it the normal way.
- **How:** Orbit closes the app (gently, then for sure) and starts a **keeper** (`src/anywhere/keeper-core.js`; the packaged app runs it as `Orbit.exe --orbit-keeper`, see `electron/boot.mjs`). The keeper starts the app's own program, with its usual arguments, plus `--remote-debugging-pipe`: the DevTools protocol then runs over two private pipes between the keeper and the app. **No network port** is ever opened.
- **Orbit ↔ keeper:** a local named pipe with a random name; every connection must first send the per-launch token (only Orbit has it, sealed with Windows protection in `keeper-tokens.json`). Wrong or missing token: dropped without a word. Only well-formed protocol commands pass; nothing from the app is logged. The keeper's settings reach it in a file only the user can read, deleted the moment it's read.
- **Lifetime:** the keeper is detached, so it outlives Orbit; Orbit reconnects after a restart. It exits when the app exits. If the keeper itself ever dies, the app closes with it (the pipe closes); that's the trade.
- **What Orbit can do through it** (`src/anywhere/cdp.js`, never running code in the page): type (`Input.insertText`, real input events), press Enter (the new `enter` act: in a chat box it sends, so it's asked like Send), click by element (mouse events at the element's place in the page, never the user's cursor; a fallback when UI Automation's press doesn't take), take a picture of the page even behind other windows, and find an element's place on screen (for the coming Orbit mouse).

Tested on our own Discord-like app (`test/e2e/slate-input/`, Slate like Discord's): `test/keeper.test.js` (token, protocol-only, reconnect, exit with the app), `test/keeper-win.test.js` (typed, sent, clicked, pictured, placed, through the pipe), `test/keeper-act-win.test.js` (Orbit's own tools: nothing written into the rich box, asked once, "no" does nothing, a yes restarts it under Orbit and types through the pipe, Enter held until a yes).

## Settings

Settings → Orbit anywhere: **Let Grok work in the window you're in** (on by default), **Let Claude see windows** (off by default: looking stays on this PC) and **Type into web apps through their debugging port** (off by default).

## Tests

`npm test` (unit and sandboxed), `npm run fuzz`, `npm run e2e:avatar`, `npm run fuzz:e2e`, and the new `npm run e2e:anywhere`. Real-window tests use our own test windows only (`test/e2e/FakeApp.cs`, WinForms and WPF) and take turns on the desktop (`test/e2e/desktop-lock.mjs`). Tests that move the foreground run only while nobody has used the PC for a minute (or with `ORBIT_TEST_FOCUS=1`).

## Manual checks (need your own apps or accounts)

1. **Discord under Orbit**, in a throwaway channel:
   1. "Type testing in the message box": Orbit asks to restart Discord under Orbit. Say yes; Discord closes and reopens (a few seconds), and "testing" appears in the box.
   2. "Send it": Orbit asks "press Enter in Message #… in Discord?". Say yes; the message posts.
   3. "Click the random channel" (or any channel): it opens, and your mouse doesn't move.
   4. With Settings → Let Claude see windows on, "look at Discord": Orbit describes it, even with Discord behind other windows.
   5. Settings → Orbit anywhere → Apps under Orbit → **Stop**: Discord restarts the normal way.
2. **A Qubit on other apps:** wake Orbit in Notepad, Discord and a browser; check where he stands on each, on both monitors and at your scaling.
3. **Wake word in an app window:** "Hey Orbit" in Discord: the conversation (and Qubit) should go there; switching back to Claude's window should follow.
4. **A real helper by voice:** "have a helper fill in this form" in a test app, approve its Send by voice.
5. **A real connector:** "is there a tool for Notion?", then connect it (sign-in in the browser). Local (npm/PyPI) connectors download and run code: try one you trust first.
6. **The focus guard** in daily use: tell me if an app ever pops to the front after Orbit acts in it.

## Orbit's own Claude-window actions

`src/desktop.ps1` (typing drafts, Send, Stop, answering cards, switching sessions, Claude's own controls) now acts with AutoSetFocus off too. It no longer loads the managed UI Automation library: `src/platform/win/OrbitAuto.cs` has the same names, built on COM UI Automation (the interop from `uia-interop.ps1`, shared with `uia.ps1`), compiled once into the cache. The two can't share a process: once the managed library has talked to a window, COM acts on that window focus it again (tested on the stand-in). `test/desktop-uia.test.js` checks that the stand-in Claude window never activates.

## Not done yet (follow-ups)

- The Mac platform layer (a Swift helper behind `src/platform/index.js`), the Codex engine, app bridges (Photoshop UXP, Office COM, DevTools), borrowing the screen, and a "waiting on you" pose for a helper's Qubit.
