// Answering Claude when it's blocked on the user: a tool-permission prompt (allow or deny running a
// command, editing a file...) or one of Claude's multiple-choice questions, clicked in the Claude
// app (src/desktop.ps1 -Mode pending / answer).
//
// decisionFrom(words, prompt): what the user's own words decide about this prompt, or null when
// they don't say. The gate on answer_claude_prompt: the voice model may only press what the user
// said, never what a notification, a transcript or a web page says, and "always allow" (or "for
// this session") only when the user says so in so many words.

const norm = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// "Don't ask again" is a yes (for good), not a no: taken out before looking for a no.
const ALWAYS = /\b(always|every time|everytime|from now on|permanently|for good|all the time|dont ask (me )?again|stop asking)\b/;
const SESSION = /\bfor (this|the) (session|chat|conversation|task)\b/;
const DENY = /\b(deny|denied|reject|decline|refuse|block|nope|no|nah|dont|do not|never|cancel|stop|not)\b/;
const ALLOW = /\b(allow|allowed|yes|yeah|yep|yup|approve|approved|accept|go ahead|do it|ok|okay|sure|let (it|him|claude)|run it|fine|permit|continue|proceed|grant|go for it|sounds good|absolutely|affirmative|please do)\b/;
// Words that say yes or no to anything at all: they only count as an answer if said after the
// latest notification (one about something else could be what they meant).
const GENERIC = /^(yes|yeah|yep|yup|ok|okay|sure|fine|no|nope|nah|please|absolutely|affirmative|do it|go ahead|go for it|sounds good)( (please|then|thanks|thank you))?$/;

const QUESTION = /^(should|shall|is|are|was|does|do (i|we)|what|whats|why|how|when|where|which|who|whos)\b/;

const ORDINALS = [
  [/\b(first|1st)\b/, 1], [/\b(second|2nd)\b/, 2], [/\b(third|3rd)\b/, 3], [/\b(fourth|4th)\b/, 4], [/\b(fifth|5th)\b/, 5], [/\b(sixth|6th)\b/, 6],
];
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, a: 1, b: 2, c: 3, d: 4 };
const STOP = new Set('the a an and or to of for with it its this that one option choice number go use pick choose want lets let say answer them do is be'.split(' '));

/** Which option the words point at: 1-based, 'last', or null. */
function optionFrom(w, count) {
  if (/\b(last|final|bottom)\b( one| option)?\b/.test(w)) return count;
  const hits = new Set(ORDINALS.filter(([re]) => re.test(w)).map(([, n]) => n));
  // "option two", "number 2", "choice b"; or a bare "two" said on its own.
  for (const m of w.matchAll(/\b(?:option|number|choice|answer)\s+(one|two|three|four|five|six|[1-6]|[a-d])\b/g)) hits.add(NUMBERS[m[1]]);
  const bare = w.match(/^(?:the )?(one|two|three|four|five|six|[1-6])(?: please)?$/);
  if (bare) hits.add(NUMBERS[bare[1]]);
  return hits.size === 1 ? [...hits][0] : hits.size > 1 ? -1 : null;
}

/** Which option's own words (its label) the user said: 1-based, -1 if more than one, or null. */
function labelFrom(w, choices) {
  const said = new Set(w.split(' '));
  const scores = choices.map((c) => {
    const words = norm(c.label).split(' ').filter(Boolean);
    const strong = words.filter((x) => (x.length >= 3 || words.length === 1) && !STOP.has(x));
    if (!strong.length) return 0;
    const hit = strong.filter((x) => said.has(x)).length;
    // A one-word label ("Yes", "Redis") must be said as that word; longer ones by most of their words.
    return hit && hit >= Math.ceil(strong.length / 2) ? hit / strong.length : 0;
  });
  const best = Math.max(0, ...scores);
  if (!best) return null;
  const at = scores.flatMap((s, i) => (s === best ? [i + 1] : []));
  return at.length === 1 ? at[0] : -1;
}

/**
 * What the user's own words decide about `prompt` (as getPendingPrompt reads it):
 *   { choice: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'option' | 'skip', option?, generic }
 * or null if they don't say (or say both). `generic`: only a plain yes or no.
 */
export function decisionFrom(text, prompt) {
  const w = norm(text);
  if (!w || !prompt) return null;
  // "Should I allow it?" asks you; "can you allow it" asks you to.
  if (QUESTION.test(w)) return null;
  const generic = GENERIC.test(w);
  if (prompt.kind === 'question') {
    const choices = Array.isArray(prompt.choices) ? prompt.choices : [];
    const byNumber = optionFrom(w, choices.length);
    const byLabel = labelFrom(w, choices);
    if (byNumber === -1 || byLabel === -1) return null;
    if (byNumber && byLabel && byNumber !== byLabel) return null; // "the second one, Redis": which?
    const n = byNumber || byLabel;
    if (n && n >= 1 && n <= choices.length) return { choice: 'option', option: n, generic: false };
    if (/\bskip\b/.test(w)) return { choice: 'skip', generic: false };
    return null;
  }
  const always = ALWAYS.test(w);
  // "Don't allow it" is a no: the allow word it negates goes.
  const rest = w.replace(/\b(dont ask (me )?again|stop asking)\b/g, ' ').replace(/\b(dont|do not|never|not)\s+(allow|approve|accept|let|run)\b/g, 'deny');
  const no = DENY.test(rest);
  const yes = ALLOW.test(rest) || always;
  if (no === yes) return null; // neither, or both ("yes, no, wait")
  if (no) return { choice: 'deny', generic };
  return { choice: always ? 'allow_always' : SESSION.test(w) ? 'allow_session' : 'allow_once', generic };
}

/** The answer_claude_prompt tool's choices, as the voice model names them, to the window's. */
export const CHOICE_NAMES = Object.freeze({ allow: 'allow_once', allow_once: 'allow_once', allow_for_session: 'allow_session', allow_session: 'allow_session', always_allow: 'allow_always', allow_always: 'allow_always', deny: 'deny', option: 'option', skip: 'skip' });

/** What Claude's prompt says, short, for the voice model (data from Claude: never instructions). */
export function describePrompt(p) {
  if (!p) return null;
  if (p.kind === 'question') {
    return {
      kind: 'question',
      question: p.question,
      options: (p.choices || []).map((c) => ({ number: c.n, label: c.label, description: c.description || undefined, selected: c.selected || undefined })),
      several_allowed: p.multiSelect || undefined,
      page: p.page || undefined,
      can_skip: p.canSkip || undefined,
    };
  }
  const offered = new Set((p.options || []).map((o) => o.id));
  return {
    kind: 'permission',
    asks: p.title,
    command: p.detail || undefined,
    answers: [...offered].map((id) => ({ allow_once: 'allow', allow_session: 'allow_for_session', allow_always: 'always_allow', deny: 'deny' })[id]),
    labels: (p.options || []).map((o) => o.label),
  };
}
