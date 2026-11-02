# External host integration

An explicitly selected host lets Orbit talk to a workspace app. [Bro](https://github.com/JustSuperHuman/bro-cli) is the first one. Orbit owns realtime audio, provider credentials, microphone controls and its native character. The host owns session identity and durable work delivery. Audio never travels over the host protocol.

Windows x64 is the current native attachment and managed-voice target. Ordinary Orbit retains its existing application identity, profile, updater, wake shortcut and default port. Native Swift sources and packaging are unchanged.

## Review guide

| Area | Entry points | Behavior |
| --- | --- | --- |
| Launch isolation | `electron/external-launch.js`, `electron/main.js` | Choose an isolated profile before the instance lock; preserve standalone defaults |
| Host transport | `src/external-host.js` | Protected descriptor, bounded authenticated requests, pinned utterances, recovery without replay |
| Voice tools | `src/external-tools.js`, `src/tools.js`, `src/agent.js` | Offer the host's own read tools; preserve fresh user consent; reject unsupported desktop operations |
| Managed voice | `electron/managed-runtime.js`, `ui/src/useManagedVoice.ts` | Reuse one renderer; enforce leases and expiring commands; release devices on Stop/Quit |
| OpenAI provider | `src/openai-realtime.js`, `electron/openai-credentials.js`, `src/config.js` | Optional realtime adapter and native credential source policies |
| Character | `electron/external-avatar.js`, `src/avatar-stage.js`, Qubit modules | Validate native identity/geometry and reuse navigation and throw physics |

`npm run dist` builds the ordinary Orbit installer with upstream branding, version, publisher and shortcut name. Fork-specific distribution scripts and compatibility-manifest generation remain outside this change. Both dependency lockfiles retain upstream versions.

## Build and launch

```sh
npm ci
npm run build:ui
```

Ordinary development still uses `npm run app`. A host developer can select an existing protected descriptor explicitly:

```sh
npx --no-install electron . --external-host-file /absolute/path/to/connection.json --open-settings
```

Use an absolute Windows path on Windows. The descriptor belongs to the current user and points to an IPv4 loopback origin. Pass its path, never its token. Development launches also accept `ORBIT_EXTERNAL_HOST_FILE`; packaged launches require the flag.

| Setting | Ordinary Orbit | Explicitly selected host |
| --- | --- | --- |
| Profile | Existing `Orbit` profile | Separate `OrbitCompanion` profile |
| Windows app ID | `dev.orbit.voice` | `dev.orbit.voice.companion` |
| Local UI port | `4317`, or development `PORT` | Available IPv4 loopback port |
| Environment settings import | Existing behavior | Disabled, apart from the specific OpenAI policy below |
| Wake shortcut | Existing startup registration | Off until explicitly configured |
| In-app updates | Existing upstream behavior | Disabled, including manual checks |
| Development profile override | `ORBIT_USER_DATA` | `ORBIT_COMPANION_USER_DATA` |

The companion identity is the same for every host, so moving between hosts keeps one companion profile. It applies only to an explicit host launch. Packaged launches ignore development profile overrides. Managed mode never changes startup-at-login or imports the ordinary Orbit profile.

A conservative probe refuses a paired launch while `127.0.0.1:4317` is occupied. It does not authenticate to or terminate that process. A standalone runtime on a different port is outside this probe's detection. A second managed launch can open settings only for the same original canonical pairing path; it cannot adopt a differently paired process.

A host decides which Orbit builds it launches. Bro, for example, launches only companion builds whose payload matches a compatibility manifest it verifies. Merging this change does not register the ordinary installer with any host or bypass a host's own checks.

## Protocol v1

The local descriptor has this shape:

```json
{
  "protocol": 1,
  "instanceId": "host-instance-id",
  "url": "http://127.0.0.1:12345",
  "token": "random-host-generated-secret"
}
```

Native startup rejects relative paths, symlinks, oversized files and insecure ownership/permissions. Windows validates the current-user ACL; Unix requires the current owner and mode `0600`. Redirects are rejected. Bearer credentials stay in the native transport closure and never enter renderer state, URLs, logs or model context. Response bodies and retained requests/results are bounded.

All routes use the descriptor's exact origin and the `/orbit/v1` prefix:

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/host` | Protocol, capabilities, instance identity and bounded session/window snapshot |
| POST | `/utterances` | `{id}`; return the session/generation pinned at speech onset |
| POST | `/requests` | `{id, utteranceId, text}`; approved work with a stable ID |
| GET | `/requests/:id` | Correlated status, progress, initial reply and accepted-task outcome |
| POST | `/requests/:id/cancel` | Cancel one known queued request |
| POST | `/focus` | `{sessionId}`; focus an advertised stable ID |
| GET | `/events?after=<cursor>` | Ordered bounded hints; gaps trigger authoritative reads |
| GET | `/tools/catalog` | Optional host tool catalog (`tools.v1`) |
| POST | `/tools/call` | Catalog revision, tool name, arguments and pinned utterance |
| GET | `/stage?after=<revision>` | Optional latest-value geometry watch |
| POST | `/runtime/heartbeat` | Optional managed status, acknowledgements and expiring controls |

Required capabilities are `sessions.read`, `orchestrator.submit` and `requests.observe`. Focus, queued cancellation, avatar placement/stage/roaming, host tools and managed voice are negotiated separately. Session IDs and opaque generations identify targets; titles remain labels.

### Input, consent and delivery

The renderer emits an utterance ID before forwarding audio at a local speech onset. The native process latches that ID through `/utterances`. Provider item and response IDs retain the captured utterance, so changing tabs during speech cannot redirect a later transcript, tool call or draft confirmation.

Draft text comes from captured user input. Sending requires a fresh clear yes after the draft, or an explicit send instruction in that same utterance. The request ID is allocated once. A transport failure leaves an observable uncertain request; reconnecting never automatically resends it or reuses its ID for changed content.

`received` means transport receipt. `queued` or a later confirmed state means durable acceptance, which is separate from completion. Supported states are `received`, `queued`, `dispatched`, `completed`, `failed`, `cancelled` and `uncertain`. Initial coordinator replies and later accepted-task outcomes are delivered separately and deduplicated.

Progress, session content and results are untrusted non-user data. Results enter the realtime conversation as correlated function-call outputs. They cannot authorize a send, answer a permission prompt or start new work. Unsupported Claude Desktop controls and generic app automation remain unavailable while a host is selected, including during disconnection. Stopping speech and cancelling one queued request are separate operations; the protocol exposes no terminal interruption.

Within one companion process, request identities survive voice and transport reconnects. Orbit does not add an on-disk request journal or promise to rediscover every old spoken result after its own process restarts. The host's durable inbox remains authoritative.

A host that admits work asynchronously should hold `POST /requests` briefly until it has saved or refused the request. Orbit reports the state in that reply to the model, so a reply of `received` makes it say only that the request arrived.

### Host tools (`tools.v1`)

A host can give the voice model its own read tools without an Orbit release. It advertises `tools.v1` and a `toolCatalogRevision` in `/host`, and Orbit fetches the catalog when that revision changes:

```json
{
  "schema": 1,
  "revision": "host-tools-7",
  "tools": [{
    "name": "read_session",
    "description": "Read a session's recent screen text by exact session ID.",
    "effect": "read",
    "scope": "pinned",
    "inputSchema": { "type": "object", "properties": { "sessionId": { "type": "string" } }, "required": ["sessionId"], "additionalProperties": false }
  }]
}
```

Orbit offers each usable definition to the realtime model as written. When the model calls one, Orbit posts `{id, catalogRevision, utteranceId, name, arguments}` to `/tools/call` and returns the host's JSON object, marked `nonUser`, as the function output. A `discovery` tool runs without a user turn. A `pinned` tool needs a current utterance, and the host scopes it to the target latched at speech onset. Any read makes host data the latest input, so it can never stand in for consent to a pending draft.

Orbit checks each definition on its own and skips, without failing the catalog, any that has:

- a name outside `^[a-z][a-z0-9_]{0,63}$`, a duplicate name or one of Orbit's own host-mode tools (`get_current_session`, `draft_prompt`, `send_draft`, `cancel_draft`, `switch_session`, `request_status`, `cancel_request`, `go_to_sleep`, `avatar`, `observe_host_request`);
- an `effect` other than `read`, or a `scope` other than `discovery` or `pinned`;
- a missing or overlong description (3,000 characters), or an input schema that is not a closed object (`additionalProperties: false`) of at most 8 KiB.

Orbit uses at most 32 tools from a catalog of at most 128 entries. Fields Orbit does not recognize are not forwarded to the model. A newer effect or scope therefore never reaches a client that cannot enforce it, and one bad entry cannot hide the rest of the host's tools.

A refused call can return `{"error":{"code":"outside_scope","message":"..."}}` with a 4xx status. Orbit passes the message (up to 300 characters, control characters removed) and code to the model as non-user data, so it can recover, for example by asking which session the user meant. Once a host has offered `tools.v1` in a pairing, Orbit no longer falls back to its snapshot-based `list_sessions`/`read_session`, including while the catalog is unavailable.

Work that changes anything is not a host tool. It goes through `orchestrator.submit`, where Orbit drafts the user's own words and the user confirms. The host then decides how to carry the work out. A future action effect would need its own consent rules in Orbit and its own capability.

### Managed lifecycle

`--host-managed` requires an explicit protected descriptor and starts the existing renderer hidden. The descriptor also contains a stable `lineage` and an `ownerEpoch` equal to `instanceId`. The native shell reports renderer readiness, phase, microphone state, provider preferences and credential-source metadata. It sends no credential material.

Controls contain runtime/owner identities, an ID and a remaining lifetime. The renderer acknowledges an applied command, not receipt alone. Duplicate, expired or wrong-owner commands cannot restart audio. Startup, owner recovery and workspace results never start a conversation automatically. Closing advanced settings hides the same renderer while preserving an active conversation.

Both native and renderer layers enforce the owner lease. Lease expiry stops audio. Quit waits for device release, reports intentional stop and exits. Replacing the original canonical descriptor is allowed only within the same lineage. In-flight old-owner operations and captures cannot acquire new authority.

A build that ships an `orbit-host-compatibility.json` manifest reports that file's digest as `buildId`, so a host that verified the payload can recognize the running process. A source checkout without the optional file reports its package-metadata digest instead. The fallback does not relax any host's own build checks.

## Voice providers and credentials

OpenAI Realtime is an optional adapter to Orbit's existing socket/audio runtime. It uses the GA WebSocket API, 24 kHz PCM, streaming audio/transcripts, function tools, server VAD and playback-clock truncation on interruption. Late tools from interrupted responses are suppressed. The native adapter filters provider metadata and redacts errors before forwarding them to the UI.

Standalone Orbit retains its existing Claude/Grok startup choice. A managed companion uses OpenAI or Grok and keeps its preferences in `managed-settings.json`. Account, provider, model and voice changes apply to the next conversation. They never trigger a paid preview or switch accounts after an authentication failure.

OpenAI source policies are saved-only, system-only and saved-otherwise-system. Standalone defaults to saved-only; explicit pairing defaults to saved-otherwise-system. A valid separately saved key wins in that mode. An unreadable saved store reports an error rather than silently switching billing accounts.

The native resolver reads only `OPENAI_API_KEY`, in process, Windows user, then Windows machine order. Refresh is asynchronous, bounded and deduplicated; config reads use cached metadata. Keys never enter HTTP config, renderer state or logs. System keys are not copied into the profile. Removing a separately saved key leaves the system key untouched. Saved Electron credentials use native encryption with atomic file replacement.

## Qubit and workspace geometry

Desktop and attached modes reuse the original native Qubit/Buddy renderer, director, navigation, emotes, click-through behavior, pickup and throw physics. Host geometry grants no execution authority. Standalone placement remains independent of host selection.

Qubit's mic control follows the audio owner's actual capture and input gate. It stays hidden until it's wanted: while the cursor is on him or on the control, while its button has focus, and for three seconds after the voice state changes (off, connecting, listening, muted, or speaking with the mic on/off). Hidden, it takes no clicks. Start wakes or unmutes the existing conversation; Stop hangs up and releases the microphone. Missing provider setup opens settings. Single-click keeps the original wake behavior, right-click keeps the orb's sleep/wake action, and double-click opens settings without starting voice. Reduced motion preserves dragging and drops him without an inertial throw. Mouse input is limited to the body and visible control.

With `avatar.stage.v1`, Orbit validates the native HWND/PID, client origin, DPI, window epoch and bounded geometry revision. Surfaces are `solid` or `oneWay`, with an optional preferred surface. Missing, malformed, stale or mismatched geometry removes old colliders. Suspended/excluded regions hide the attached character rather than leaving invisible obstacles. Geometry transport is separate from voice and work delivery.

`avatar.roam.v1` optionally allows Qubit to move between the host and one display's usable desktop area while retaining one native controller and one voice runtime. Dragging, walking and swept throws use the same physics. A host advertising `avatar.containment.v1` must explicitly grant `avatarPlacement:{schema:1,allowEscape:true}` before roaming is permitted. Missing permission keeps Qubit contained. Other selected avatars retain their existing placement.

An outside character can survive host loss; stale host geometry cannot accept entry or supply support. Display loss or invalid DPI recovers the same character safely. Continuous cross-monitor flight and collision discovery in arbitrary other applications are outside this implementation.

## Reproducing verification

```sh
npm ci
npm run build:ui
npm test
npm run test:native
npm run test:external-host
npm run e2e:managed
npm run e2e:avatar-stage
npx --no-install electron scripts/avatar-auto-e2e.mjs
npx --no-install electron scripts/avatar-auto-e2e.mjs --interactions-only --reduced-motion
git diff --check
```

Set `CI=true` when native desktop/input tests must remain skipped. The pull request records executed commands and counts. CI builds the typed UI, runs unit/sandboxed tests and native sidecar/parity matcher tests, then builds the standard Windows installer. The existing Mac job still compiles Orbit Native.

`e2e:managed` needs no host app or running workspace. It starts the actual hidden Electron main, React audio owner and HTTP/voice bridge against a temporary protected loopback host. Fake devices and provider connections check startup silence, Start/Stop/Mute, avatar wake/unmute/stop, closing settings during voice, same-lineage owner handover, catalog recovery on the same provider socket and clean device release. External connections, desktop helpers and real clipboard writes are blocked. Pairing credentials are removed after the fixture.

Stage and Automatic harnesses use temporary profiles and their own hidden Electron compositor. They import no microphone/provider runtime and send no OS input. Their printed output directories contain renderer captures and state. The default fixture mode never inspects a user-owned window. Real HWND testing requires an explicitly supplied isolated host descriptor and expected PID through `--host-file` and `--expected-host-pid`.

Production dependency audits at the upstream high-severity threshold pass. The unchanged UI dependency tree retains moderate `uuid` / `vosk-browser` advisories; this change does not upgrade or override that speech dependency.

## Platform and acceptance limits

Live microphone capture, paid-provider/account access and a complete speech-to-durable-work-to-spoken-result run are not established by simulated-device tests. Native stacking, real pointer pass-through, mixed-DPI displays, virtual desktops and monitor removal need manual acceptance. Renderer captures alone do not prove those behaviors.

Native Swift host integration, macOS managed voice and continuous cross-monitor character flight are outside this change. Native Swift's existing profile, bundle identity, Keychain and updater remain unchanged. No macOS runtime acceptance has been performed on this Windows machine; Mac CI compilation is reported separately in the PR.
