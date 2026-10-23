// Talking to the avatar: what the pixel buddy and Qubit can be asked to do, the `avatar` tool the
// voice model uses for it, and a local fast path that does it without the model at all.
//
// The catalogue (AVATAR_ACTIONS) is the one list of commands: the tool's enum, the fast path's
// templates, and what each avatar's page implements (ui/src/qubit/director.js COMMANDS and
// ui/src/buddy/engine.js COMMANDS; a test checks they match).
//
// The fast path (matchAvatarCommand): a deterministic matcher on the user's final transcript. When
// the WHOLE utterance is just an avatar command ("do a backflip", "um, Qubit, roll left please"),
// it runs at once and the model is not asked for that turn (no tokens, no wait). It is deliberately
// conservative; anything it isn't sure of goes to the model as usual:
//   - at most FAST_PATH.maxWords words, and nothing about Claude, prompts, code, drafts, sending,
//     sessions, sleeping or questions (NEGATIVE words veto the whole utterance, even fuzzily);
//   - after taking off fillers ("um"), a name or wake word ("hey Qubit"), a polite lead ("can you",
//     "go ahead and") and tail ("please", "for me"), every word left must belong to one command's
//     template (no unknown words at all);
//   - words may be misheard: each word scores 1 when exact (or a known mishearing like "role" for
//     "roll"), else its edit-distance similarity, only for words of 5+ letters ("blackflip" 0.89,
//     "dunce" for "dance" 0.8). The utterance's confidence is its WORST word, and it must reach
//     FAST_PATH.minConfidence (0.85): one doubtful word sends the whole thing to the model.
// Sleep and wake ("go to sleep", "wake up", "take a nap") never take the fast path: they overlap
// with Orbit's own go_to_sleep, so the model decides.
//
// Where the command goes: the desktop shell registers a sink (setAvatarSink) that hands it to the
// avatar's window. Without one (browser mode, most tests) there is no avatar to talk to.

import { getSetting } from './config.js';

export const FAST_PATH = Object.freeze({
  minConfidence: 0.85, // the worst word's score: at least this to act without the model
  minWordScore: 0.8, // below this a word doesn't match a template word at all
  maxWords: 10, // the whole utterance, fillers included
});

/** Every command, with which avatars can do it and a few words for the model and captions. */
export const AVATAR_ACTIONS = Object.freeze({
  backflip: { avatars: ['qubit'], label: 'a backflip' },
  frontflip: { avatars: ['qubit'], label: 'a front flip' },
  roll: { avatars: ['qubit'], label: 'a roll', dir: true },
  jump: { avatars: ['qubit', 'buddy'], label: 'a big jump' },
  hop: { avatars: ['qubit', 'buddy'], label: 'a little hop' },
  grow: { avatars: ['qubit'], label: 'growing bigger for a while' },
  shrink: { avatars: ['qubit'], label: 'back to normal size' },
  celebrate: { avatars: ['qubit', 'buddy'], label: 'a celebration' },
  dance: { avatars: ['qubit', 'buddy'], label: 'a dance' },
  nod: { avatars: ['qubit'], label: 'a nod (yes)' },
  shake: { avatars: ['qubit'], label: 'a head shake (no)' },
  look_around: { avatars: ['qubit', 'buddy'], label: 'a look around' },
  stretch: { avatars: ['qubit', 'buddy'], label: 'a stretch' },
  blink: { avatars: ['qubit'], label: 'a blink' },
  happy: { avatars: ['qubit'], label: 'looking happy' },
  sad: { avatars: ['qubit'], label: 'looking sad' },
  surprised: { avatars: ['qubit'], label: 'looking surprised' },
  curious: { avatars: ['qubit'], label: 'looking curious' },
  wave: { avatars: ['buddy'], label: 'a wave' },
  trip: { avatars: ['buddy'], label: 'tripping over (on purpose)' },
  kick_ball: { avatars: ['buddy'], label: 'kicking a ball' },
  sit: { avatars: ['buddy'], label: 'sitting down for a bit' },
  climb: { avatars: ['buddy'], label: 'climbing onto the prompt box' },
  move: { avatars: ['qubit', 'buddy'], label: 'moving over', dir: true },
  go_home: { avatars: ['qubit', 'buddy'], label: 'going back to his spot' },
  nap: { avatars: ['qubit', 'buddy'], label: 'a short nap (the call stays on)' },
  wake: { avatars: ['qubit', 'buddy'], label: 'waking up from a nap' },
});

export const AVATAR_NAMES = Object.freeze({ qubit: 'Qubit', buddy: 'Buddy' });

/** The commands one avatar can do. */
export const actionsFor = (kind) => Object.keys(AVATAR_ACTIONS).filter((a) => AVATAR_ACTIONS[a].avatars.includes(kind));
export const isAvatarAction = (kind, action) => typeof action === 'string' && Object.hasOwn(AVATAR_ACTIONS, action) && AVATAR_ACTIONS[action].avatars.includes(kind);

// ---------------------------------------------------------------- the sink (the desktop shell)

let sink = null;
let lastRun = null; // { action, dir, at, source }
const runs = []; // when commands ran, the last minute (a model can't spin him forever)
const MAX_PER_MINUTE = 20;
const SAME_COMMAND_MS = 4000; // the fast path and the model asking for the same thing: once

/** The desktop shell's way to the avatar's window: (command) => { ok, error? }. null removes it. */
export function setAvatarSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/** The avatar on screen to talk to: 'qubit' | 'buddy', or null (none chosen, or no desktop shell). */
export function activeAvatar() {
  const k = getSetting('avatar');
  return sink && (k === 'qubit' || k === 'buddy') ? k : null;
}

/**
 * Run a command on the avatar. `source`: 'fast' (the fast path) or 'model' (the tool). The same
 * command from the other source within a few seconds is the same request (Grok may already have
 * asked for it before the fast path heard the words): it runs once.
 */
export function runAvatarCommand({ action, dir } = {}, { source = 'model', now = Date.now() } = {}) {
  const kind = activeAvatar();
  if (!kind) return { ok: false, error: 'There is no avatar on screen (Settings -> Avatar is None).' };
  if (!isAvatarAction(kind, action)) return { ok: false, error: `${AVATAR_NAMES[kind]} can't do that.` };
  const d = AVATAR_ACTIONS[action].dir && (dir === 'left' || dir === 'right') ? dir : undefined;
  if (lastRun && lastRun.action === action && lastRun.dir === d && lastRun.source !== source && now - lastRun.at < SAME_COMMAND_MS) {
    return { ok: true, already: true };
  }
  while (runs.length && now - runs[0] >= 60_000) runs.shift();
  if (runs.length >= MAX_PER_MINUTE) return { ok: false, error: 'That is a lot of tricks in a minute. Give him a moment.' };
  let r;
  try {
    r = sink({ action, ...(d ? { dir: d } : {}) });
  } catch (e) {
    r = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
  if (r?.ok) {
    runs.push(now);
    lastRun = { action, dir: d, at: now, source };
  }
  return r && typeof r === 'object' ? r : { ok: false, error: 'The avatar did not answer.' };
}

/** For tests: forget recent runs. */
export function resetAvatarRuns() {
  lastRun = null;
  runs.length = 0;
}

// ---------------------------------------------------------------- the tool

/** The `avatar` tool for this avatar (only offered while one is on). */
export function avatarToolDef(kind) {
  const name = AVATAR_NAMES[kind];
  const acts = actionsFor(kind);
  return {
    type: 'function',
    name: 'avatar',
    description: `Make ${name} (you, on the Claude window) do something when the user asks: ${acts.map((a) => `${a} = ${AVATAR_ACTIONS[a].label}`).join('; ')}. Only for requests to ${name} himself; work in the user's code always goes to Claude as a prompt.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: acts },
        direction: { type: 'string', enum: ['left', 'right'], description: 'For roll and move: which way. Leave out to let him pick.' },
      },
      required: ['action'],
    },
  };
}

// ---------------------------------------------------------------- the fast path

// Words that put an utterance beyond doubt out of the fast path's reach (matched fuzzily too).
const NEGATIVE = new Set(
  (
    'claude clawed cloud prompt prompts draft drafts send sent sending session sessions code coding file files commit commits test tests ' +
    'bug bugs fix add added animation animations implement feature function tell ask type typed copy paste clipboard git github repo ' +
    'project build error errors app settings button cancel yes no not dont never stop why how what when where which who whose does did ' +
    'is are was were should sleep asleep sleeping goodnight night nap napping wake awake listen listening hang bye goodbye quit mute unmute'
  ).split(' '),
);
const FILLERS = new Set('um umm uh uhh er erm ah ahh hmm hm mm oh okay ok hey yo so alright well now please pls just again'.split(' '));
const NAMES = {
  qubit: new Set(['qubit', 'qubits', 'cubit', 'kubit', 'qbit', 'cubic', 'cubits']),
  any: new Set(['buddy', 'bud', 'orbit', 'pal', 'dude']),
};
const LEADS = ['can you', 'could you', 'would you', 'will you', 'can u', 'go ahead and', 'i want you to', 'i want to see you', 'i want to see', 'let me see you', 'lets see you', 'let me see', 'lets see', 'show me', 'show us', 'try to', 'time to', 'you can', 'little guy', 'little buddy', 'pixel buddy'];
const TAILS = ['for me', 'for us', 'real quick', 'right now', 'little guy', 'little buddy', 'pixel buddy', 'thanks', 'thank you'];
// Two words heard for one ("back flip", "q bit").
const MERGE = new Map([
  ['back flip', 'backflip'], ['back flips', 'backflip'], ['black flip', 'backflip'], ['front flip', 'frontflip'], ['front flips', 'frontflip'],
  ['q bit', 'qubit'], ['cue bit', 'qubit'], ['queue bit', 'qubit'], ['cute bit', 'qubit'], ['barrel roll', 'barrelroll'],
]);
// Inflections and common mishearings: always a full match.
const ALIAS = new Map([
  ['backflips', 'backflip'], ['frontflips', 'frontflip'], ['flips', 'flip'], ['rolls', 'roll'], ['role', 'roll'], ['roles', 'roll'],
  ['jumps', 'jump'], ['hops', 'hop'], ['dances', 'dance'], ['nods', 'nod'], ['write', 'right'], ['rite', 'right'], ['celebrates', 'celebrate'],
  ['stretches', 'stretch'], ['blinks', 'blink'], ['waves', 'wave'], ['bigger', 'bigger'],
]);

// Templates: words separated by spaces; (a|b) alternatives, a trailing ? optional, <dir> left|right.
const ART = '(a|an|the|another|one|some)?';
const DO = '(do|try|pull|throw|give|make)?';
const T = {
  backflip: [`${DO} ${ART} backflip`, '(do)? flip (backwards|backward|back)', `${DO} ${ART} (backwards|backward) flip`],
  frontflip: [`${DO} ${ART} (frontflip|flip)`, '(do)? flip (forward|forwards)', `${DO} ${ART} (forward|forwards) flip`],
  roll: [`${DO} ${ART} (roll|barrelroll) (over|around)? (to)? (the)? <dir>?`, 'roll (over|around)? (to)? (the)? <dir>?'],
  jump: ['jump (up)? (high)?', `${DO} ${ART} (big)? jump`],
  hop: ['(hop|bounce) (up)?', `${DO} ${ART} (little)? (hop|bounce)`],
  grow: ['(get|go|grow|become) (bigger|big|huge|giant|larger|large|tall|taller)', 'grow (up|big|bigger)?', 'power up', 'supersize', 'super size'],
  shrink: ['(get|go|become) (smaller|small|tiny|little)', 'shrink (down|back)?', 'power down', '(go)? back to (your)? normal (size)?'],
  celebrate: ['celebrate', `${DO} ${ART} celebration`, `${DO} ${ART} victory dance`, 'party', 'party time'],
  dance: ['dance', `${DO} ${ART} (little|happy)? dance`, 'boogie', 'bust a move', '(play)? (some)? music'],
  nod: ['nod', 'nod your head'],
  shake: ['shake (your)? head'],
  look_around: ['look around', 'have a look around'],
  stretch: ['stretch', `${DO} ${ART} stretch`, 'yawn'],
  blink: ['blink', 'wink', `${DO} ${ART} (blink|wink)`],
  happy: ['(look|be|get) happy', 'smile'],
  sad: ['(look|be|get) sad'],
  surprised: ['(look|be|act) surprised'],
  curious: ['(look|be|act) curious'],
  wave: ['wave', 'wave (hi|hello)', 'wave at me', `${DO} ${ART} wave`],
  trip: ['trip', 'trip over', 'fall (over|down)'],
  kick_ball: ['kick (a|the)? ball', 'play (with)? (a|the|your)? ball', 'play ball'],
  sit: ['sit (down)?', 'take a seat', 'have a seat'],
  climb: ['climb (up)?', 'climb (on|onto) (the)? box', 'get on the box'],
  move: ['(go|move|walk|hop|run|scoot) (over)? (to)? (the)? <dir>'],
  go_home: ['go home', 'go to your spot', 'back to your spot'],
};

function parseTemplate(src) {
  return src
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const optional = part.endsWith('?');
      const p = optional ? part.slice(0, -1) : part;
      if (p === '<dir>') return { words: ['left', 'right'], optional, capture: 'dir' };
      const words = p.replace(/^\(|\)$/g, '').split('|');
      return { words, optional };
    });
}
const TEMPLATES = Object.entries(T).flatMap(([action, list]) => list.map((src) => ({ action, slots: parseTemplate(src) })));
const TEMPLATE_WORDS = new Set(TEMPLATES.flatMap((t) => t.slots.flatMap((s) => s.words)));

/** Edit distance with transpositions (optimal string alignment). */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** How well a heard word matches a template word: 1 exact (or an alias), else fuzzy for long words. */
export function wordScore(heard, word) {
  if (heard === word || ALIAS.get(heard) === word) return 1;
  if (word.length < 5 || heard.length < 4) return 0;
  return Math.max(0, 1 - editDistance(heard, word) / Math.max(heard.length, word.length));
}

const tokenize = (text) =>
  String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function mergePairs(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const two = i + 1 < tokens.length ? `${tokens[i]} ${tokens[i + 1]}` : null;
    if (two && MERGE.has(two)) {
      out.push(MERGE.get(two));
      i++;
    } else out.push(tokens[i]);
  }
  return out;
}

const startsWithPhrase = (tokens, phrase) => {
  const p = phrase.split(' ');
  return p.length <= tokens.length && p.every((w, i) => tokens[i] === w) ? p.length : 0;
};
const endsWithPhrase = (tokens, phrase) => {
  const p = phrase.split(' ');
  const off = tokens.length - p.length;
  return off >= 0 && p.every((w, i) => tokens[off + i] === w) ? p.length : 0;
};

/** Take fillers, names and polite leads and tails off both ends. */
function strip(tokens, kind) {
  const isName = (w) => NAMES.any.has(w) || (kind === 'qubit' && NAMES.qubit.has(w));
  let t = tokens.slice();
  for (let changed = true; changed && t.length; ) {
    changed = false;
    if (FILLERS.has(t[0]) || isName(t[0])) {
      t = t.slice(1);
      changed = true;
      continue;
    }
    if (t.length > 1 && (FILLERS.has(t.at(-1)) || isName(t.at(-1)))) {
      t = t.slice(0, -1);
      changed = true;
      continue;
    }
    for (const lead of LEADS) {
      const n = startsWithPhrase(t, lead);
      if (n && n < t.length) {
        t = t.slice(n);
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (const tail of TAILS) {
      const n = endsWithPhrase(t, tail);
      if (n && n < t.length) {
        t = t.slice(0, -n);
        changed = true;
        break;
      }
    }
  }
  return t;
}

/** The best way `tokens` fill `slots` (every token used, every required slot filled), or null. */
function fit(tokens, slots) {
  let best = null;
  const go = (ti, si, scores, captures) => {
    if (si === slots.length) {
      if (ti === tokens.length && scores.length) {
        const min = Math.min(...scores);
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        if (!best || min > best.min || (min === best.min && mean > best.mean)) best = { mean, min, captures: { ...captures } };
      }
      return;
    }
    const s = slots[si];
    if (s.optional) go(ti, si + 1, scores, captures);
    if (ti >= tokens.length) return;
    // Multi-word alternatives ("victory dance") take as many tokens as they have words.
    for (const w of s.words) {
      const parts = w.split(' ');
      if (ti + parts.length > tokens.length) continue;
      const sc = parts.map((p, k) => wordScore(tokens[ti + k], p));
      if (sc.some((x) => x < FAST_PATH.minWordScore)) continue;
      const word = ALIAS.get(tokens[ti]) || tokens[ti];
      go(ti + parts.length, si + 1, scores.concat(sc), s.capture ? { ...captures, [s.capture]: s.words.includes(word) ? word : w } : captures);
    }
  };
  go(0, 0, [], {});
  return best;
}

/**
 * Is this whole utterance just a command for the avatar `avatar` ('qubit' | 'buddy')?
 * Returns { action, dir?, confidence } or null. Callers act only at FAST_PATH.minConfidence and up
 * (the result says `sure`).
 */
export function matchAvatarCommand(text, { avatar } = {}) {
  if (avatar !== 'qubit' && avatar !== 'buddy') return null;
  const raw = tokenize(text);
  if (!raw.length || raw.length > FAST_PATH.maxWords) return null;
  const tokens = mergePairs(raw);
  // A veto word anywhere (fuzzily: "clawed" for "claude"), unless it's one of the template words.
  for (const w of tokens) {
    if (NEGATIVE.has(w)) return null;
    if (w.length >= 5 && !TEMPLATE_WORDS.has(w) && [...NEGATIVE].some((n) => n.length >= 5 && wordScore(w, n) >= 0.84)) return null;
  }
  const core = strip(tokens, avatar);
  if (!core.length) return null;
  let best = null;
  for (const t of TEMPLATES) {
    if (!AVATAR_ACTIONS[t.action].avatars.includes(avatar)) continue;
    const f = fit(core, t.slots);
    if (f && (!best || f.min > best.confidence)) best = { action: t.action, dir: f.captures.dir, confidence: Math.round(f.min * 1000) / 1000 };
  }
  if (!best) return null;
  const out = { action: best.action, confidence: best.confidence, sure: best.confidence >= FAST_PATH.minConfidence };
  if (best.dir) out.dir = best.dir;
  return out;
}
