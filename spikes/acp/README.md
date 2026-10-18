# ACP spike (Orbit Agents, build step 1)

This drives one Claude agent over the Agent Client Protocol (ACP) and checks what the [orchestration design](../../docs/design/agent-orchestration.md) depends on:

- **Progress:** does the update stream give enough to fill a card?
- **Pause:** does `session/cancel` stop a turn, and does the agent keep its memory afterwards?
- **Redirect:** does a cancel followed by a new prompt change the agent's direction?
- **Soft pause:** does holding a permission request stop the agent safely?

The agent works in a fresh temp folder, never in this repo.

```bash
npm install
npm run spike          # isolated from your Claude Code settings (recommended)
ISOLATE=0 npm run spike   # inherit your settings, for comparison
```

## Files

- **Logs:** every ACP update goes to `runs/<stamp>.jsonl`, and the pass/fail verdict to `runs/<stamp>.results.json`.
- **`spike.mjs`:** the test client. It uses `@agentclientprotocol/sdk`'s `ClientSideConnection`.
- **`progress-mcp.mjs`:** a tiny MCP server injected into the session through `session/new`'s `mcpServers` parameter. The agent calls its `report_progress(done, total, step)` tool, and the client reads the arguments off the ACP stream.

## Cost

The test runs against your Claude Code login and takes about a minute. It is a real agent, so it uses real tokens.

Package versions are pinned to releases more than two weeks old.

## Supervisor smoke test (build step 2)

`supervisor-smoke.mjs` runs Orbit's real Supervisor (`src/agents/supervisor.js`) against two Claude agents at once. A writer is paused after a step and then resumed. A reader works read-only, and the script approves its "Needs you" requests the way you would.

```bash
node supervisor-smoke.mjs
```
