// "Stop" for Claude: halting Claude's current run in the session open in the Claude app.
//
//   isStopCommand(text): the whole utterance is only a stop ("stop", "stop it", "no, stop Claude").
//     The bridge's fast path (server.js) presses Stop at once for these while Claude is working,
//     without waiting for the voice model. Strict, like src/sleep-command.js: anything more ("stop
//     it, Claude's going the wrong way") goes to the model, which can call stop_claude.
//   asksToStop(text): do these words (the user's own, latest) ask to stop Claude at all? The gate on
//     stop_claude. Looser, but never: "stop listening" / "stop talking" (that's Orbit: sleep or be
//     quiet), "don't stop", "keep going", or a stop that's work for Claude ("add a stop button",
//     "tell it to stop using var": prompts).

const FILLER = /^(?:u+h*m+|u+h+|e+r+m*|a+h+|h+m+|m{2,})$/;
const norm = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[â€™']/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.test(w));

const STOP_PHRASES = new Set([
  'stop', 'stop it', 'stop that', 'stop this', 'stop now', 'stop claude', 'claude stop', 'stop him', 'stop the run',
  'stop the task', 'stop working', 'stop everything', 'stop all that', 'halt', 'abort', 'abort it', 'interrupt',
  'interrupt it', 'interrupt claude', 'cancel the run', 'cancel that run', 'cancel this run', 'cancel the task',
  'cancel it claude', 'stop stop', 'stop stop stop',
]);
// Said before the stop: "no, stop", "wait, stop it", "that's wrong, stop", "whoa whoa stop".
const LEAD = ['no', 'nope', 'wait', 'whoa', 'woah', 'hey', 'okay', 'ok', 'oh', 'please', 'hold on', 'hang on', 'thats wrong', 'that is wrong', 'wrong', 'no no', 'claude', 'just', 'quick', 'quickly', 'actually'];
const TAIL = ['please', 'now', 'right now', 'immediately', 'claude', 'thanks', 'thank you', 'already', 'asap'];

function strip(words, list, fromEnd) {
  for (let again = true; again && words.length > 1; ) {
    again = false;
    for (const p of list) {
      const pw = p.split(' ');
      const at = fromEnd ? words.slice(-pw.length) : words.slice(0, pw.length);
      if (pw.length < words.length && at.join(' ') === p) {
        words = fromEnd ? words.slice(0, -pw.length) : words.slice(pw.length);
        again = true;
        break;
      }
    }
  }
  return words;
}

/** Is this whole utterance only "stop Claude" (or the like)? */
export function isStopCommand(text) {
  let words = norm(text);
  if (!words.length || words.length > 8) return false;
  words = strip(words, LEAD, false);
  words = strip(words, TAIL, true);
  return STOP_PHRASES.has(words.join(' '));
}

const VERB = String.raw`stop|halt|abort|interrupt|kill|cancel`; // the imperative only: "did it stop?" asks nothing
// "stop" as a noun or a thing to build: a request for Claude to write code, never a stop.
const NOUN_AFTER = String.raw`buttons?|signs?|words?|watch(es)?|loss(es)?|lights?|commands?|hooks?|handlers?|events?|signals?|conditions?|bits?|sequences?|tokens?|codes?|features?|options?|propagation|icons?|states?|functions?|methods?|endpoints?|screens?|menus?|keys?|shortcuts?|animations?|logic|flags?|errors?`;
const STOP_RE = new RegExp(String.raw`\b(${VERB})\b(?!\s+(${NOUN_AFTER})\b)`, 'g');
const FOR_ORBIT = /\b(stop|quit)\s+(listening|talking|speaking|recording|the mic|the microphone)\b/;
const NEGATED = new RegExp(String.raw`\b(dont|do not|never|not|no need to|shouldnt|wont|didnt|doesnt|cant|without)\b(\s+\S+){0,2}?\s+(${VERB})\b|\bkeep (going|working)\b`);
// A question about whether it stopped ("did it stop", "why does it stop there"), not a request.
const STATUS_QUESTION = /^(did|has|is|was|were|why|when|where|how|does|do)\b/;
const ASKS_CLAUDE = /\b((tell|ask|let|have|get|make|instruct)\s+(claude|it|him)|(say|write|type|send)\s+(to\s+)?(claude|it))\b/;
// Gerunds that are Claude's run itself ("stop working", "stop doing that"), not a habit to drop.
const RUN_GERUND = new Set(['working', 'doing', 'going', 'running', 'generating', 'thinking', 'everything', 'that', 'this', 'it', 'now']);

/**
 * Do the user's own words ask to stop Claude's run? `hasDraft`: a draft is waiting, so a bare
 * "cancel that" is about the draft (cancel_draft), not Claude.
 */
export function asksToStop(text, { hasDraft = false } = {}) {
  const w = String(text || '').toLowerCase().replace(/[â€™']/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!w || FOR_ORBIT.test(w) || NEGATED.test(w) || STATUS_QUESTION.test(w)) return false;
  const hits = [...w.matchAll(STOP_RE)];
  if (!hits.length) return false;
  // "Cancel" alone means the draft while there is one, and needs a run to cancel otherwise.
  if (hits.every((h) => h[1] === 'cancel') && (hasDraft || !/\b(run|task|job|claude|work|everything|what (its|it is|hes|he is|claude is) doing)\b/.test(w))) return false;
  // "Tell Claude to stop using var": a habit for Claude to drop, so a prompt.
  if (ASKS_CLAUDE.test(w)) {
    const after = (h) => w.slice(h.index + h[0].length).trim().split(' ')[0] || '';
    if (hits.every((h) => /ing$/.test(after(h)) && !RUN_GERUND.has(after(h)))) return false;
  }
  return true;
}
