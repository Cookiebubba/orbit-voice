// The tool oracle's stand-in for src/brain.js: the real pure helpers, while finding Claude Code,
// asking it, searching and the sign-in are recorded and answered by the oracle's seeded generator.
export * from '../../../src/brain.js?real';

const o = () => globalThis.__oracle;
const answer = (name, args, choices) => {
  const r = choices[Math.floor(o().rng() * choices.length)];
  o().calls.push({ name, args, answer: r });
  return r;
};

export function findClaude() {
  return { path: '/fake/bin/claude', source: 'path' };
}

const STRUCTURED = { spoken: 'It is the cache.', details: 'The cache is stale after a deploy.', files: ['src/cache.js:12'], suggested_prompt: 'Clear the cache after each deploy.', confidence: 'high' };

export async function askBrain({ question, model, explore, cwd, session, claudePath, apiKey }) {
  return answer('brain', { question, model, explore: !!explore, cwd: cwd ?? null, session: session ?? null, claudePath, apiKey: apiKey ? 'set' : '' }, [
    { ok: true, answer: 'It is the cache.\n\nThe cache is stale after a deploy.', structured: STRUCTURED, model, explore: !!explore, seconds: 2.5, cost: 0.01, turns: 3 },
    { ok: true, answer: 'Plain answer.', structured: null, model, explore: !!explore, seconds: 1.5, cost: null, turns: 1 },
    { ok: false, error: 'Claude Code is not signed in. Use Sign in under Settings → Second brain (or ask Grok to open it), or add an Anthropic API key there.', needsSignIn: true },
    { ok: false, error: 'Claude is rate-limited or busy right now. Try again in a bit.', needsSignIn: false },
  ]);
}

export async function searchWeb({ query, claudePath, apiKey }) {
  return answer('search', { query, claudePath, apiKey: apiKey ? 'set' : '' }, [
    { ok: true, spoken: 'It shipped last week.', sources: [{ title: 'Release notes', site: 'example.com', url: 'https://example.com/notes' }], confidence: 'high', seconds: 3.1, cost: 0.02 },
    { ok: true, spoken: 'Maybe.', sources: [], confidence: 'low', seconds: 2, cost: null },
    { ok: false, error: 'Claude Code is not signed in.', needsSignIn: true },
  ]);
}

export async function openClaudeSignIn({ claudePath } = {}) {
  return answer('sign-in', { claudePath }, [{ ok: true }, { ok: false, error: "Couldn't open the Claude Code sign-in: nope" }]);
}

export async function claudeAuthStatus() {
  return { ok: true, signedIn: true, method: 'claude.ai' };
}
