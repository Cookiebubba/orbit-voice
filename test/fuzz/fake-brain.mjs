// Stand-in for src/brain.js: the real pure helpers, but askBrain never runs `claude` and findClaude
// never looks at the real machine.
export { BRAIN_MODELS, MAX_ANSWER_CHARS, brainArgs, brainPrompt, isClaudeFile } from '../../src/brain.js?real';

export function findClaude() {
  return { path: 'C:\\fake\\claude.exe', source: 'path' };
}

export function askBrain({ question, signal }) {
  const f = globalThis.__fuzz;
  f.calls.push({ name: 'brain', args: { question } });
  return new Promise((resolve) => {
    const t = setTimeout(
      () => resolve(f.rng() < 0.7 ? { ok: true, answer: f.str(), model: 'haiku', explore: false, seconds: 1, cost: 0.001, turns: 1 } : { ok: false, error: 'Claude Code is not signed in.' }),
      Math.floor(f.rng() * 30),
    );
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve({ ok: false, error: 'Stopped.' });
    });
  });
}
