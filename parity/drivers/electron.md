# The Electron driver

How the Electron build (`electron/`) implements the parity driver in [`../PROTOCOL.md`](../PROTOCOL.md):
where each state field comes from, what each action does, and what it can't do yet.

## Files

| File | What |
| --- | --- |
| `electron/parity-driver.js` | The HTTP server and the Electron side: state, actions, events, the stubs below. |
| `electron/parity-core.js` | The pure parts (token and Host checks, action arguments, fake permissions, state shaping). Tested by `test/parity-driver.test.js` in `npm test`, no Electron needed. |
| `electron/parity-preload.cjs` | A session preload the driver registers: `window.__orbitParity` in every Orbit page, and the fake microphone. |
| `parity/probes/qubit-art.js`, `figure.js` | Probes for `avatar.eval` (each is one JS expression run in the avatar's page). |

Hooks in shared files, all inert unless the parity driver's preload made `window.__orbitParity`, or
the driver called them:

- `electron/main.js`: `PROFILE` (`ORBIT_PROFILE_DIR`, unpackaged only) and one `if` that imports the
  driver when `!app.isPackaged && process.env.ORBIT_PARITY_PORT`, passing it accessors
  (`main`, `orb`, `avatar`, `avatarHost`, `claude`, `orbitMouse`, `showMain`, `showOrb`).
- `electron/avatar.js` `debug()`, `electron/avatar-host.js` `debug()`: read-only snapshots.
- `electron/avatar-hover.js` `setTestCursor()` (and `hitRect`): the cursor the hover poll reads.
- `ui/src/useVoice.ts`, `ui/src/App.tsx`: fill `window.__orbitParity.voice` / `.app` only if it exists.
- `package.json` `build.files`: `!electron/parity-*` (the installed app doesn't even contain it).

## Starting it

```sh
open -n -g \
  --env ORBIT_PARITY_PORT=4540 --env ORBIT_PARITY_TOKEN=<random> \
  --env ORBIT_PROFILE_DIR=/tmp/orbit-profile --env PORT=4541 \
  --env XAI_REALTIME_URL=ws://127.0.0.1:<fake grok> \
  --env ORBIT_FAKE_MIC=1 --env ORBIT_MUTE_OUTPUT=1 \
  --env 'ORBIT_FAKE_PERMS={"mic":"granted","ax":true,"screen":true}' \
  --stdout out.log --stderr err.log \
  <repo>/node_modules/electron/dist/Electron.app --args <repo>
```

(Windows: the same variables, `node_modules\electron\dist\electron.exe <repo>`.) `node_modules/electron`
needs its `dist/` (`node node_modules/electron/install.js` if npm skipped electron's postinstall).

| Variable | Electron |
| --- | --- |
| `ORBIT_PARITY_PORT` | The driver on `127.0.0.1:<port>`. Without it the driver module is never imported. |
| `ORBIT_PARITY_TOKEN` | Required (8+ characters): requests without the exact `x-parity-token` get 403, as do requests with an `Origin` header or a `Host` other than `127.0.0.1:<port>` / `localhost:<port>`. |
| `ORBIT_PROFILE_DIR` | Electron's `userData` and the bridge's `configDir`: `settings.json`, logs, caches, Chromium's profile and the single-instance lock all live there, so it runs beside a real Orbit. Keys are read from and saved to a plain `.env` there (`XAI_API_KEY=...`, `ANTHROPIC_API_KEY=...`), never the Keychain or DPAPI; on macOS Chromium uses a mock keychain (`--use-mock-keychain`), so the `Orbit Safe Storage` item isn't read or written. Seed a profile with `settings.json` and `.env`. |
| `PORT` | The bridge's port (as before). |
| `XAI_REALTIME_URL` | The Grok realtime URL (as before; `test/e2e/fake-grok.mjs`). |
| `ORBIT_FAKE_DESKTOP` | As before (`electron/main.js`): a JS stand-in for the Claude window and its tools. |
| `ORBIT_TEST_CLAUDE_PID` | Read by `electron/main.js` on the macOS branch (`claude/orbit-mac-af0868`), not by the driver. |
| `ORBIT_FAKE_MIC` | Turns on the fake microphone in the pages: `getUserMedia({ audio })` returns a stream from a WebAudio graph (mono) that plays the clips `mic.play` hands it, one after another, silence otherwise. Chromium's file capture isn't used (it can't be swapped). If the value is a path to a WAV file, that file plays once when the page first opens the mic; any other value (`1`) starts silent. Without it `mic.play` is refused and the real microphone is used. |
| `ORBIT_MUTE_OUTPUT=1` | Every page's audio is muted (`webContents.setAudioMuted`); the voice still plays on its AudioContext clock, so `playedMs`, `scheduledMs` and the levels run. |
| `ORBIT_FAKE_PERMS` | `systemPreferences.getMediaAccessStatus` (microphone, screen), `askForMediaAccess` and `isTrustedAccessibilityClient` report these, never the real TCC (no prompt). Without it the state reads the real ones, read-only (`isTrustedAccessibilityClient(false)`). |
| `ORBIT_FAKE_LOGIN=1` | Always the case under the driver: see "Kept off the machine". |

### Kept off the machine (whenever the driver is loaded)

- The global hotkey is held by the driver (`globalShortcut` stubbed): nothing is registered with the
  system; `voice.hotkey` runs the very callback main.js registered.
- "Open at login" lives in memory (`app.setLoginItemSettings` / `getLoginItemSettings` stubbed);
  `state.login.enabled` reads it.
- `dialog.showMessageBox` (answers with its last button, "Not now"/"OK"), `dialog.showErrorBox`,
  `shell.openExternal` and `shell.openPath` only log a line.
- The tray / menu-bar icon is real (Electron can't make one hidden) and shows during the run.

## `GET /parity/hello`

`app: "electron"`, `version` (package.json), `pid` (the main process), `platform`, `bridge.base` and
`bridge.authUrl` (`authUrl('main')`; null until the bridge listens), `features`, and `actions`.
Features: `avatar`, `mouse`, `voice`, `settings`, `window`, `hotkey`, `login`, `updater`. Not
`onboarding`: Electron has no onboarding screen.

## `GET /parity/state`

Frames are DIPs, which are screen points with a top-left origin on both macOS and Windows. Pixel
sources (the Claude window tracker, the focus helper, Orbit's mouse) go through
`screen.screenToDipRect` / `screenToDipPoint` on Windows.

| Field | Source |
| --- | --- |
| `windows.main` | `main.isVisible()`, `main.getBounds()`; `view` from the page (`App.tsx`'s `view`: `main`, `settings`, `history`; never `onboarding`). |
| `windows.orb` | `orb.isVisible()`, `orb.getBounds()`. |
| `claude` | The window tracker's state (`found`, `frame`; plus `hwnd`); `pid` is always null (the tracker knows windows, not pids). `box` / `send`: the home avatar's prompt box and Send button (strip px moved by the strip's origin). On macOS (no tracker in this build): `found: false`. |
| `avatars[]` | Home (`main.js`'s `avatar`, id `home`) then the guests (`avatar-host.js`, id = the context id). `frame`: the overlay window's bounds. `host`: home, the Claude window (`claudeDip`), null when free-floating (macOS); a guest, its window from the focus helper; `pid` null (plus `hwnd`). `figure`: the page's last `buddy:hit` rect (window px) moved by the window's origin. Note this is the page's hit rect (for Qubit, 1.24 × his side, centred on him), not his exact square. `standingOn` / `asleep`: from `parity/probes/figure.js`, run in his page on every state read (Qubit: `air` if mid-air, held or thrown, `box` on the prompt box, `floor` otherwise; `asleep` = engine mode `asleep`). For the pixel buddy `standingOn` is null and `asleep` falls back to "Orbit is off or asleep". `lifted`, `takesMouse`, `leaving`: avatar.js. `visible` is false while leaving. |
| `mouse` | `orbitMouse.debug()`: `visible`, `pos` (where the glide is now, else its target), `windows` = overlay windows showing. |
| `voice` | `window.__orbitParity.voice()` in the main page (`useVoice.ts`): `phase`, `asleep`, `connected` (socket open and session ready), `muted`, `playedMs` (played so far, from the AudioContext clock), `scheduledMs`, `chunks` (this call's), `lastError` (the last error caption, 200 chars), `draft`, `sentCount`. |
| `onboarding` | `mic`, `ax`, `screen` from the (fake or real) permission checks; `step: "done"`, `shown: false` always. |
| `hotkey` | `wakeHotkey`, `hotkeyLabel()`, `registered` = the driver holds it. |
| `login` | The in-memory login item. |
| `sounds` | Each `avatar:sound` the shell sent the main page to play (`throw`). Chimes aren't listed. |
| `events` | Ring of 200, these types only: `core.ready` (the bridge listens), `avatar.created {id,kind,role}` / `avatar.closed {id}` (an avatar window appears / is closed: a switch closes the old one after its fade), `avatar.talk {id}`, `avatar.lift {id,on}`, `avatar.sound {id,name}` (from the avatar's page: `buddy:talk`, `buddy:lift`, `buddy:sound`), `avatar.command {id,action,dir}` (a `buddy:command` sent to that avatar's page), `voice.phase {phase,asleep}` (from `orb:state`, when either changes), `hotkey {}` (the shell sent the main page `hotkey`). |

## `POST /parity/act`

| Action | Electron |
| --- | --- |
| `voice.hotkey` | Runs the callback main.js registered for the hotkey (the same as pressing it: `main.webContents.send('hotkey')`). |
| `voice.sleep`, `voice.wake`, `voice.hangup` | `useVoice`'s `sleep()`, `wake()`, `stop()` through `window.__orbitParity.app`. |
| `voice.type` | `useVoice.sendText` (what the typing box submits). Refused while the call is off (the box only shows during a call). |
| `mic.play` | `wav`: an absolute path to a WAV file (RIFF/WAVE, 30 MB at most, any rate and channels). The driver reads it and hands it to the page's fake mic, which decodes it (`decodeAudioData`) and plays it after whatever is queued (`gapMs` later). Returns `startsInMs`, `durationMs`, `sampleRate`, `channels`. |
| `cursor.set` | `setTestCursor` in `avatar-hover.js`: every avatar's hover poll takes this as the cursor (and his eye follows it) until `null`. The real cursor is never read for it nor moved. |
| `pointer` | `webContents.sendInputEvent` to that avatar's window only (`mouseDown` / `mouseMove` / `mouseUp`, x/y relative to the window, `globalX/Y` the screen point; a move during a press carries `leftButtonDown`). Never the system's input, never the real cursor, and the window's click-through setting doesn't matter. |
| `avatar.eval` | Reads `parity/probes/<probe>` (a bare file name; `.js` added if missing) and runs it with `executeJavaScript` in that avatar's page; returns its value (promises awaited, 5 s limit). |
| `avatar.command` | `runAvatarCommand({ action, dir }, { source: 'model' })` from `src/avatar-commands.js`, exactly what the voice model's `avatar` tool calls (same checks, rate limit and sink). |
| `settings.ui` | Through the Settings page's own model, not the driver: `useAppState.updateSettings` (which posts `/api/settings` with the page's sign-in, optimistic like the controls). `wakeHotkey` goes through `desktop.hotkey.set` and `openAtLogin` through `desktop.startWithWindows.set`, as their controls do. Unknown keys are refused. |
| `settings.read` | The page's `config.settings[key]` (what the Settings screen renders); `openAtLogin` from `desktop.startWithWindows.get()`. |
| `window.show` | `showMain()`, then the page's view (`main`, `settings`, `history`). |
| `window.minimize` | `showOrb()` (what the minimize button and the traffic light do). |
| `perms.set` | Updates the fake permissions. Electron checks the microphone once at launch and has nothing that re-checks, so nothing else happens. |
| `onboarding.next` | `{ ok: false }`: no onboarding screen. |
| `quit` | `app.quit()` 100 ms after answering. |

## Known gaps

- No onboarding screen (`features` leaves it out; `onboarding.step` is always `done`).
- `claude.pid` and `host.pid` are null (the Windows tracker knows HWNDs, given as `hwnd`); on macOS
  this build has no Claude window tracker, so `claude.found` is false and the avatar floats free
  (`host: null`). The macOS branch's `ORBIT_TEST_CLAUDE_PID` tracker isn't mapped here yet.
- The pixel buddy's `standingOn` is null (his page exposes nothing without `?debug=1`).
- `figure` is the page's hit rect, a little bigger than Qubit himself.
- `sounds` lists the avatar's throw sound only, not the UI chimes.
- On the macOS branch, `perms:request` for Screen Recording runs Orbit's helper
  (`runHelperOnce(['perms', '--prompt-screen'])`), which the driver can't stub: don't press "Turn on"
  for Screen Recording in a parity case.
- Events are polled every 100 ms for windows coming and going (macOS sends no show/hide events for a
  background app's windows), so `avatar.created` can trail the window by up to 100 ms.
- The driver's own log lines before the bridge starts are dropped (the log has no folder yet).
