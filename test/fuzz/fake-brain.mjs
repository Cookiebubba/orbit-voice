// Stand-in for src/brain.js: the real pure helpers, but askBrain never runs `claude`, findClaude
// never looks at the real machine, and the sign-in functions never open anything.
export { BRAIN_MODELS, MAX_ANSWER_CHARS, brainArgs, brainPrompt, isClaudeFile, isLocalAbsolute, isSignInProblem } from '../../src/brain.js?real';

export function findClaude() {
  return { path: 'C:\\fake\\claude.exe', source: 'path' };
}

export function askBrain({ question, signal }) {
  const f = globalThis.__fuzz;
  f.calls.push({ name: 'brain', args: { question } });
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      const r = f.rng();
      if (r < 0.6) return resolve({ ok: true, answer: f.str(), model: 'haiku', explore: false, seconds: 1, cost: 0.001, turns: 1 });
      if (r < 0.85) {
        f.calls.push({ name: 'brain-needs-sign-in' }); // the run found Claude Code signed out
        return resolve({ ok: false, error: 'Claude Code\x27s sign-in has expired.', needsSignIn: true });
      }
      resolve({ ok: false, error: 'Claude is rate-limited or busy right now.' });
    }, Math.floor(f.rng() * 30));
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve({ ok: false, error: 'Stopped.' });
    });
  });
}

export function claudeAuthStatus() {
  const f = globalThis.__fuzz;
  return Promise.resolve(f.rng() < 0.5 ? { ok: true, signedIn: f.rng() < 0.5, method: 'none' } : { ok: false, error: 'x' });
}

export function openClaudeSignIn({ claudePath } = {}) {
  globalThis.__fuzz.calls.push({ name: 'sign-in', args: { claudePath } });
  return Promise.resolve({ ok: true });
}
