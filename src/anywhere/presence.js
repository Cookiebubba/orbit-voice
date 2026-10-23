// "Qubit, come here" and "go away" ("Orbit anywhere", phase 4): the fast path that moves the
// conversation (and Qubit) into the window the user is in, or ends his stay in this one, without a
// model turn. Like the avatar's fast path (src/avatar-commands.js), deliberately strict: the whole
// utterance must be just that command (a name, fillers and "please" aside); anything else goes to
// the model, which has the come_here and leave_window tools for other wordings.

const FILLER = /\b(um+|uh+|er+m*|hmm+|ah+|oh|okay|ok|hey|yo|so|well|please|now|real quick|for me|buddy|pal|little guy)\b/gi;
const NAMES = /\b(qubit|cubit|cubic|q bit|orbit|buddy)\b/gi;

const COME = [
  /^(can you |could you |would you )?(come|hop|jump|pop|get) (over )?(here|in here|over|in)$/,
  /^(come|hop|jump|pop) (over )?(to|into|in) (this|my) (window|app|one)$/,
  /^(come|hop) (over )?here$/,
  /^follow me( here)?$/,
  /^come with me$/,
];
// (Never a bare "go" or "you can go": those may be a yes to "Send it?".)
const LEAVE = [
  /^(you can )?(go away|leave)$/,
  /^(leave|get out of) (this|my) (window|app)$/,
  /^go (back )?home$/,
  /^go back to claude$/,
];

/** The words, with fillers, names and punctuation taken out. */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(NAMES, ' ')
    .replace(FILLER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is the whole utterance "come here" or "go away"? `away` (true when he's in a window other than
 * Claude's): only then does "go home" mean leaving this window (at home it's his own trick).
 * Returns 'come_here' | 'leave' | null.
 */
export function matchPresenceCommand(text, { away = false } = {}) {
  const raw = String(text || '');
  if (raw.length > 80 || /\b(don'?t|do not|never|not|stop|tell (claude|it))\b/i.test(raw)) return null;
  const t = normalize(raw);
  if (!t || t.split(' ').length > 7) return null;
  if (COME.some((re) => re.test(t))) return 'come_here';
  if (away && LEAVE.some((re) => re.test(t))) return 'leave';
  return null;
}

/** "Orbit, stop everything" (and only that): every helper stops at once, with no model turn. */
export function isStopEverything(text) {
  const t = normalize(text);
  return /^(stop|cancel|halt|kill) (everything|it all|all (of )?(the |my )?(helpers|tasks|of them|agents)|all)$/.test(t) && !/\b(don'?t|do not|never|not)\b/i.test(String(text));
}
