// "Go to sleep" hangs up at once: no model turn, no goodbye. When the user's whole utterance is a
// sleep command ("go to sleep", "goodnight", "okay, that's all, thanks"), Orbit hangs up itself the
// moment the words are transcribed (the same fast path as avatar commands, see server.js).
//
// Deliberately strict: after taking off fillers ("um"), a name ("hey Orbit"), and a polite lead or
// tail ("okay", "thanks", "you can"), what's left must be exactly one of SLEEP_PHRASES. Anything
// more ("go to sleep after you send it", "tell Claude to sleep") goes to the model as usual, which
// can still call go_to_sleep (and also says nothing).

const SLEEP_PHRASES = new Set([
  'sleep', 'go to sleep', 'go back to sleep', 'go to bed', 'time to sleep', 'nap', 'take a nap',
  'stop listening', 'hang up', 'goodnight', 'good night', 'night', 'night night',
  'bye', 'goodbye', 'good bye', 'bye bye', 'see you', 'see you later',
]);
const FILLER = /^(?:u+h*m+|u+h+|e+r+m*|a+h+|h+m+|m{2,})$/;
const NAMES = new Set(['orbit', 'grok', 'qubit', 'buddy']);
const LEAD = ['hey', 'okay', 'ok', 'alright', 'all right', 'right', 'cool', 'great', 'perfect', 'thanks', 'thank you', 'so', 'and', 'now', 'you can', 'please', 'just', 'go ahead and'];
const TAIL = ['thanks', 'thank you', 'please', 'now', 'for now', 'then', 'buddy', 'orbit', 'grok', 'qubit'];

const norm = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.test(w));

function strip(words, list, fromEnd) {
  for (let again = true; again && words.length; ) {
    again = false;
    if (NAMES.has(fromEnd ? words.at(-1) : words[0])) {
      words = fromEnd ? words.slice(0, -1) : words.slice(1);
      again = true;
      continue;
    }
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

/** Is this whole utterance only "go to sleep" (or the like)? */
export function isSleepCommand(text) {
  let words = norm(text);
  if (!words.length || words.length > 9) return false;
  words = strip(words, LEAD, false);
  words = strip(words, TAIL, true);
  return SLEEP_PHRASES.has(words.join(' '));
}
