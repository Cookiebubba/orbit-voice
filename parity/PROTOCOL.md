# Orbit parity suite: protocol

One set of test cases, two apps: the Electron build (`electron/`) and the native Swift build
(`mac-swift/`). Neither the cases nor the protocol depend on either language. Each app, when started
for testing, exposes the same small **driver** over HTTP; the runners speak only that driver and the
bridge's own HTTP/WebSocket API.

Two runners execute the same case files:

- `parity/run.mjs` (Node): `npm run parity -- --app electron|swift|both`. Writes the parity matrix.
- `mac-swift/Tests/OrbitParityTests` (XCTest): `swift test --filter OrbitParityTests` runs every case
  against the Swift build (it reads the same `parity/cases/*.json`).

## Starting an app for testing

The runner starts the app with these environment variables (each app honours them only when it is
not a packaged release: Electron `!app.isPackaged`; Swift: a build with `ORBIT_PARITY_ALLOWED=1`
baked in at build time by `mac-swift/scripts/build-app.sh --test`, never in a release build):

| Variable | Meaning |
| --- | --- |
| `ORBIT_PARITY_PORT` | Port for the driver (127.0.0.1 only). No driver without it. |
| `ORBIT_PARITY_TOKEN` | Every driver request must carry `x-parity-token: <token>`; others get 403. |
| `ORBIT_PROFILE_DIR` | Throwaway profile folder: settings, keys, logs, caches. The user's own profile is never read or written. |
| `PORT` | The bridge's port (never 4317 in tests). |
| `XAI_REALTIME_URL` | The fake Grok (`test/e2e/fake-grok.mjs`) when a case uses the Grok engine. |
| `ORBIT_FAKE_DESKTOP` | A JS stand-in for the Claude desktop driver (`parity/fixtures/fake-desktop.mjs`), or unset to drive the stand-in Claude *window* (`parity/fixtures/mac/StandInClaude`). |
| `ORBIT_TEST_CLAUDE_PID` | The stand-in Claude window's pid: the only Claude window either app may read or act on. |
| `ORBIT_FAKE_MIC` | A WAV file (any rate, mono or stereo) used as the microphone instead of the real one. Electron maps it to Chromium's fake capture device; Swift's audio engine reads it in real time. Can be swapped at run time with `mic.play`. |
| `ORBIT_MUTE_OUTPUT` | `1`: the voice is "played" (timed, counted, levels computed) but not sent to the speakers. |
| `ORBIT_FAKE_LOGIN` | `1`: "Open at login" is kept in memory only (reported in `login.enabled`), never registered with macOS. |
| `ORBIT_FAKE_PERMS` | JSON `{"mic":"granted|denied|not-determined|restricted","ax":bool,"screen":bool}`: what the permissions check reports, for the onboarding cases (never touches the real TCC state). The runners set all granted unless a case sets it (a real macOS prompt would hold an app up). |

## The driver

Base: `http://127.0.0.1:$ORBIT_PARITY_PORT`. JSON in and out. Header `x-parity-token`.

### `GET /parity/hello`
```json
{ "app": "electron" | "swift", "version": "1.3.0-beta.1", "pid": 123, "ready": true,
  "bridge": { "base": "http://127.0.0.1:4521", "authUrl": "http://127.0.0.1:4521/auth?t=..." },
  "features": ["avatar", "mouse", "voice", "settings", "onboarding", "window", "hotkey", "login", "updater"] }
```
`ready` is true once the app has finished starting (bridge up, main window and its page loaded,
hotkey held); runners wait for it before the first step. `authUrl` signs a runner in to the bridge (GET it, keep the cookie) for the bridge contract cases.
`features` lists what this build implements; a case whose `needs` names a missing feature is
reported `unsupported` (counted as not passing).

### `GET /parity/state`
A snapshot of everything the cases look at. Frames are screen points, top-left origin
(`{x,y,w,h}`), on the main display's coordinate space.
```json
{
  "windows": {
    "main":   { "visible": true, "frame": {...}, "view": "main" | "settings" | "history" | "onboarding" },
    "orb":    { "visible": false, "frame": {...} }
  },
  "claude": { "found": true, "pid": 456, "frame": {...}, "box": {...} | null, "send": {...} | null },
  "avatars": [
    { "id": "home", "kind": "qubit" | "buddy", "role": "home" | "guest",
      "visible": true, "frame": {...},            // the overlay window
      "host": { "pid": 456, "frame": {...} } | null, // the window he lives on (null: free-floating)
      "figure": {...} | null,                     // where he is drawn (screen points), from the page's buddyHit
      "standingOn": "box" | "floor" | "air" | null,
      "lifted": false, "asleep": true, "takesMouse": false, "leaving": false }
  ],
  "mouse": { "visible": false, "pos": {...} | null, "windows": 0 },
  "voice": { "phase": "off|connecting|listening|thinking|speaking", "asleep": false, "connected": false,
             "muted": false, "playedMs": 0, "scheduledMs": 0, "chunks": 0, "lastError": null,
             "draft": null | { "id": 1, "text": "...", "targetTitle": null }, "sentCount": 0,
             "wakeWord": "off|loading|listening|error" },  // "Hey Orbit": listening = ready to hear it
  "onboarding": { "mic": "granted|denied|not-determined|restricted", "ax": true, "screen": true,
                  "step": "done" | "mic" | "ax", "shown": false },  // required: mic, then ax; screen is optional
  "hotkey": { "accelerator": "Control+Alt+G", "label": "⌃⌥G", "registered": true },
  "login": { "enabled": false },
  "sounds": [ { "name": "throw", "at": 1700000000000 } ],
  "events": [ { "at": 0, "type": "buddy:talk" | "buddy:lift" | "buddy:sound" | "orb:state" | ..., "data": {} } ]
}
```
`events` is a ring buffer (last 200) of shell-level happenings a case may wait for; `sounds` lists
the sounds the shell played (name and time only). Event types (both builds use exactly these):

| type | data | when |
| --- | --- | --- |
| `avatar.created` | `{id, kind, role}` | an avatar's window was made |
| `avatar.closed` | `{id}` | an avatar's window closed (after its fade-out) |
| `avatar.talk` | `{id}` | a quick click on the avatar started talking |
| `avatar.lift` | `{id, on}` | picked up (`on: true`) or put back |
| `avatar.sound` | `{id, name}` | the avatar asked for a sound (`throw`: "Wheee!") |
| `avatar.command` | `{id, action, dir}` | a command reached the avatar's page |
| `voice.phase` | `{phase, asleep}` | the voice phase changed |
| `hotkey` | `{}` | the global hotkey fired (or `voice.hotkey`) |
| `core.ready` | `{}` | the bridge is up |
| `perms.request` | `{kind}` | the app asked for a permission (`microphone`, `accessibility`, `screen`): macOS's prompt, or its pane opened |

### `POST /parity/act`
`{ "action": "...", "args": { ... } }` → `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`.

| Action | Args | Effect |
| --- | --- | --- |
| `voice.hotkey` | | What the global hotkey does (start / sleep / wake). |
| `voice.sleep`, `voice.wake` | | Put the conversation to sleep / wake it. |
| `voice.type` | `text` | Type a message into the conversation (the typing box). |
| `voice.hangup` | | End the call. |
| `mic.play` | `wav` (path), `gapMs` | Play this WAV into the fake microphone now (after the current one). Silence otherwise. |
| `cursor.set` | `x`,`y` or `null` | Test cursor: overrides where the shell thinks the real cursor is (the avatar's hover poll). `null`: back to the real one. |
| `pointer` | `avatar` (id), `type` (`down`/`move`/`up`), `x`,`y` (screen points) | A synthetic mouse event delivered to that avatar's overlay window only (never posted to the system, never moves the real cursor). |
| `avatar.eval` | `avatar`, `probe` (file name in `parity/probes/`) | Runs the probe script in the avatar's page and returns its result as `value`. `qubit-art.js` returns `{ drawn, paths, fills: [css colours], solidFill, eyeIsHole, strokes, gradients, filters, shadows, opacityLayers }`. |
| `avatar.command` | `action`, `dir` | As if the voice asked the avatar to do something. |
| `settings.ui` | `key`, `value` | Change a setting through the app's own Settings screen model (not the bridge): `{ ok, value }` or `{ ok: false, error }`. |
| `settings.read` | `key` | What the app's Settings screen shows for a key: `{ ok: true, value }`. |
| `window.show` | `name` (`main`/`settings`) | Show a window/view. |
| `window.minimize` | | Minimize the main window (turns into the orb). |
| `perms.set` | as `ORBIT_FAKE_PERMS` | Change the fake permission state; the shell re-checks as it would after the user returns from System Settings. |
| `onboarding.next` | | Press the onboarding's (or the permissions banner's) primary button for the current step. |
| `key.saved` | | What the app does once its key screen has saved an xAI key (the runner saves it through the bridge first): the app now knows it has one. |
| `core.kill` | | Test builds with a separate core process only (`sidecar` feature): kill it as a crash would (SIGKILL). |
| `quit` | | Quit cleanly. |

## Cases

`parity/cases/<area>.json`: `{ "area": "bridge", "cases": [ ... ] }`. Areas: `bridge`, `settings`,
`avatar`, `onboarding`, `window`, `voice`.

```json
{
  "id": "bridge.config.shape",
  "title": "GET /api/config has version, settings, limits and defaults",
  "needs": ["settings"],                  // driver features required (optional)
  "env": { "ORBIT_FAKE_DESKTOP": "fixtures/fake-desktop.mjs" },  // extra env for the app (optional; implies a fresh app)
  "profile": { "settings": { "avatar": "qubit" } }, // settings.json written before start (optional; implies a fresh app)
  "steps": [
    { "do": "http", "method": "GET", "path": "/api/config", "expect": { "status": 200, "body": { "version": { "$type": "string" } } } },
    { "do": "act", "action": "voice.hotkey" },
    { "do": "until", "probe": "state", "expect": { "voice.phase": "listening" }, "timeoutMs": 8000 },
    { "do": "save", "from": "state", "path": "avatars.0.frame", "as": "frame0" },
    { "do": "sleep", "ms": 500 }
  ]
}
```

Step kinds:

- `http`: a request to the **bridge** with the runner's session cookie. `auth: false` sends none;
  `origin`/`host` override those headers (for the security cases). `body` is JSON.
- `ws`: open `/voice` and exchange messages: `{ "do": "ws", "send": [...], "expect": [...], "timeoutMs": n }`.
- `act`: a driver action (above). `expect` matches its reply.
- `state`: `GET /parity/state` once, matched against `expect`.
- `until`: repeat a probe (`state`, `hello`, `http` with `path`, `fake` with `name`, `standin`, or `act` with `action`/`args`) until `expect` matches or the timeout.
- `signin`: sign in to the bridge again from the app's current `hello` (after the app relaunched itself: each launch has a new sign-in link).
- `fake`: read a test double's record (`fake-claude`, `fake-desktop`, `stand-in`), e.g. the tool calls seen.
- `save`: keep a value for later steps as `${name}`.
- `check`: a saved or computed value against `expect`: `{ "do": "check", "value": "${gap}", "expect": { "$lte": 4 } }`.
- `calc`: arithmetic on saved numbers, kept as a new value: `{ "do": "calc", "as": "cx", "expr": "${fig.x} + ${fig.w} / 2" }` (numbers and `+ - * / ( )` only).
- `sleep`: wait.

### Matchers (`expect`)

Keys are dotted paths into the value (`avatars.0.frame.w`, `body.settings.avatar`). A value is
either a literal (deep-equal) or an operator object:

| Operator | Meaning |
| --- | --- |
| `{"$type": "string"}` | `typeof` (also `array`, `null`, `integer`) |
| `{"$gt": n}`, `$gte`, `$lt`, `$lte` | numeric comparisons |
| `{"$near": n, "$tol": t}` | within a tolerance |
| `{"$in": [...]}` | one of |
| `{"$match": "regex"}` | string matches |
| `{"$contains": x}` | array contains (deep) / string contains |
| `{"$len": n}` or `{"$len": {"$gte": 1}}` | length |
| `{"$every": {...}}` / `{"$some": {...}}` | every / some array element matches |
| `{"$count": {"where": {...}, "is": n or matcher}}` | how many elements match `where` |
| `{"$inside": "${frame}"}` / `{"$inside": {"x":..}}` | a rect inside another (1 pt slack) |
| `{"$not": ...}` | negation |
| `{"$absent": true}` | path missing or undefined |
| `{"$eq": "${saved}"}` | equals a saved value |

## Results

`parity/out/matrix.json`:
```json
{ "at": "...", "apps": ["electron", "swift"],
  "cases": [ { "id": "...", "area": "...", "electron": { "status": "pass|fail|unsupported|error", "ms": 120, "error": "..." }, "swift": { ... } } ],
  "summary": { "electron": { "bridge": { "pass": 10, "total": 12 } }, "swift": { ... } } }
```
and `parity/out/matrix.md`, a readable table (one row per case, a summary per area). Both are
generated, not committed.
