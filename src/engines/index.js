// Helper engines ("Orbit anywhere", phase 8): one interface, a choice per helper. Claude Code (the
// user's Claude subscription) now; OpenAI's Codex (codex app-server, the user's ChatGPT plan) is
// the planned second engine and is listed but not available yet. Each engine:
//   start({ task, mcpUrl, token, tools, onEvent, ... }) -> { send(text), stop(), pid }

import { claudeCodeEngine } from './claude-code.js';

export const codexEngine = Object.freeze({
  id: 'codex',
  label: 'OpenAI Codex',
  available: false,
  start() {
    throw new Error('Codex as a helper engine is not available yet.');
  },
});

export const ENGINES = Object.freeze({ 'claude-code': { ...claudeCodeEngine, available: true }, codex: codexEngine });

/** The engine for an id ('claude-code' unless another one is available and asked for). */
export function engineFor(id) {
  const e = ENGINES[id];
  return e && e.available ? e : ENGINES['claude-code'];
}
