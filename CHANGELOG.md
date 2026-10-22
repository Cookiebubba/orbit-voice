# Changelog

## Unreleased

- **Pixel buddy:** a 16-pixel character lives along the bottom of your Claude window. It's on by default and can be switched off, or set to Tiny, Small or Big, in Settings → App.
  - It naps with drifting Z's while Orbit sleeps, and wakes with a stretch and a yawn.
  - It cups an ear while you talk, paces with thought dots while Orbit thinks, and moves its mouth with Orbit's voice. Its antenna takes Orbit's colour.
  - It hops up onto Claude's prompt box and over it, since the box is too low to walk under. It carries each draft in as a letter, and stomps Send with a paper plane flying off.
  - While Claude works it types along on a tiny laptop, and it celebrates with sparkles when Claude finishes.
  - On its own it wanders, sits and swings its legs off the box's edge, kicks a ball, dances, trips, waves at your cursor and dodges it.
  - Click it for a reaction, or pick it up and drop it. A high drop leaves it seeing stars.
  - It never takes clicks meant for Claude: only the character itself is clickable.
- **Settings follow the voice engine:** Grok and Claude each show their own voice card (Claude voice has 8 voices with a local preview), wording, and costs. Sections open and close with smooth animations.
- **Call bar:** the big sleep button is back in the middle, with typing on its left and mute on its right.

- **Claude voice (beta, opt-in):** Settings → Voice engine → Claude. Claude Haiku is the voice, through your own Claude Code sign-in, with speech heard and spoken on your PC (Silero VAD, Moonshine and Kitten TTS via sherpa-onnx, about 170 MB downloaded when you first turn it on, each file checked against a pinned SHA-256). No xAI key or cost. All of Orbit's tools, consent checks, wakes and resume notes work as with Grok. Replies start about 2 s after you stop talking; a quick "One sec." covers tool calls. Per turn, the log keeps timings only. `npm run latency:claude-voice` measures it end to end.

## 1.2.0 (2026-10-20)

- **Fixed: "switch to…" and "copy that" were refused although you'd asked.** Other Claude sessions finishing mid-call sent an app notification between your words and Grok acting on them, and that voided your request. Now your own words, when they ask for it ("switch to…", "open…", "go to…", "copy…", "start a new session", "tell Claude to…"), stay a request for 2 minutes, once each and never when negated. Words that don't ask, like "yes" to Grok's offer, still have to come after the latest notification, so a notification or transcript still can't make Grok switch, copy or start a session on its own. The bridge also holds an update back while Grok is still acting on what you asked.
- **Several Claude windows.** Orbit now sees every Claude window: the main one and sessions popped out into their own.
  - Grok's "current session" is the one in the window you were in last, the same window the orb sits on. Grok hears which sessions the other windows show.
  - "Switch to…" brings forward the window a session is already open in, or opens it from the sidebar.
  - A prompt goes into the one window showing its session, and is refused if two do. It's still checked again just before Send.
- **The orb follows you between Claude windows** (Stick to Claude Code). It docks on the Claude window most recently in front, with the same spot and no lag. If that window is minimized, it moves to one that's still on screen, and it hides only when every Claude window is minimized.
- Bugs found by the new end-to-end fuzzer, all fixed:
  - Your words could reach the log. A failed tool logged its whole error, and some errors quote you back to Grok: "No session matched …" with your search words, or "your reply (…) isn't a clear yes". Quoted text is now left out of the log. A failed Claude-window script no longer logs its command line, which carried the prompt in base64.
  - An expired Claude Code token ("OAuth token has expired") was reported as an expired sign-in, but Grok didn't offer to open the sign-in.
  - A prompt you dictated ("tell Claude to…") was refused as a draft when a second-brain answer arrived before Grok drafted it.
  - Orbit's window went blank, until a restart, if Grok called a tool named like `__proto__`. The page now only shows its own tool notes, and every caption is plain text.
- **End-to-end fuzzer** (`npm run fuzz:e2e -- --seed N --iterations M`). It drives the real app, hidden, against a fake Grok, a fake `claude.exe` built from C# and a fake Claude window, with every connection outside 127.0.0.1 blocked. See README → Testing.
- `npm run e2e:wake` takes its port from `E2E_PORT`.

- **Fixed: Grok was silent on spoken updates.** The page's playback position carried over from the previous call. With nobody speaking first, as on a wake, Grok's audio was scheduled as many seconds late as the last call had lasted. It now starts on time, and a wake can't wedge on audio that never plays.
- **Fixed: a spoken update could leave the mic shut.** That happened when Grok answered with a tool call and then a reply without audio, so you couldn't answer or say "go to sleep". The window now opens once Grok has spoken and gone quiet, or after 2 s if it never made a sound. Pressing the hotkey or clicking the orb hangs up a wake at once.
- **Spoken updates come together.** One wake says everything that's due, and wakes are at least 30 s apart and at most 6 an hour. A busy session can't wake Grok again for 3 minutes, and a call Grok started by itself ends after 3 minutes unless you type to it. Updates name the session exactly, by id.
- **Picks up where you left off.** For 30 minutes after hanging up, the next call gets Orbit's short resume note: the last few exchanges, the session that was open, an unsent draft, and what you're waiting on. Grok uses it only when you refer back. It's memory only and never counts as your words or consent. A draft in it is just text: Grok drafts it again, reads it back and waits for a fresh yes.
- **Wake Grok when something you asked for is ready** (Settings → When Claude finishes, on by default with "Grok tells me").
  - Grok wakes when Claude finishes a prompt it sent for you, or when the second brain answers after you hung up. A question still running at hang-up keeps going to its usual limits.
  - In a call that's on, it's said there instead.
  - "Chime only" and "Off" never wake Grok. Results then wait for your next call.
- **Second-brain answers built for voice.** Claude Code returns a structured answer (`--json-schema`): a short spoken answer, details and file references for follow-ups, and an optional suggested prompt. Grok offers that prompt and drafts it only if you say yes. Every field is checked and trimmed, and a plain-text answer still works.
- A draft read back before a notification or a second-brain answer came in has to be read back again before a "yes" sends it.
- The end of each call is logged with Grok's audio received, what the page scheduled and played, and why it hung up (counts and codes only).
- **Security review (2026-10-20)** ([report](docs/security/2026-10-20-review.md)): 15 issues (6 medium, 9 low), 13 fixed and 2 accepted by design, plus the silent-wake root cause and 6 bugs found by testing.
- The fuzzer gained `resume` and `wake` phases and hostile structured answers. `npm run e2e:wake` checks in Electron that a wake's audio really plays.

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
