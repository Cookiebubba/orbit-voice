// Emote cues: how Qubit's voice shows feelings while he talks. The voice model may write a cue such
// as <happy> just before the words it belongs to; it is never spoken, shown or kept. This module
// finds and strips cues, in whole text or in a stream of deltas (a cue can arrive split across them),
// and says where each one was in the clean text, so the emote can fire when those words play.
//
// Why angle brackets: tried on Grok's realtime voice (scripts in the commit notes), [happy] and
// *happy* are swallowed by its speech model (not spoken, and gone from the transcript, so Orbit
// can't see them), while <happy> stays in the transcript and is not spoken either, mid-sentence too.
// Claude voice is spoken by Orbit itself, so any form works there; one form for both.
//
// The rules (tested in test/emote-cues.test.js):
//   - A cue is <word>: one word of letters (a hyphen allowed), no spaces. Known cues and their
//     aliases are reported; other words in that form are dropped silently (never spoken).
//   - Inside `code` nothing is a cue (the text stays as it is).
//   - Inside "double quotes" a cue is dropped but not reported (a quote isn't his feeling).
//   - The space a cue leaves behind is collapsed ("Done! <happy> Great" -> "Done! Great").
//   - Streaming: a delta ending in an unfinished "<happ" holds it back until the next one says
//     what it is; at the end, an unfinished cue that could only have been a cue is dropped.

/** What he can show (each maps to his own existing moods and moves; see ui/src/qubit/director.js EMOTES). */
export const CUES = Object.freeze(['happy', 'excited', 'curious', 'surprised', 'proud', 'sad', 'embarrassed', 'nod', 'shake', 'wonder', 'hop']);
const ALIASES = Object.freeze({ celebrate: 'excited', think: 'wonder', thinking: 'wonder', laugh: 'happy', smile: 'happy', yes: 'nod', no: 'shake', wow: 'surprised' });

/** The cue a word names, or null. */
export function cueName(word) {
  const w = String(word || '').toLowerCase();
  return CUES.includes(w) ? w : Object.hasOwn(ALIASES, w) ? ALIASES[w] : null;
}

const CUE_WORD = /^[A-Za-z][A-Za-z-]{0,19}$/;
const MAX_HOLD = 22; // "<" + a 20-letter word + ">"
const QUOTES = new Set(['"', '“', '”']);

/**
 * A streaming stripper. push(delta) -> { text, cues: [{ cue, at }] } where `at` is the cue's offset in
 * all the clean text so far (the first character of the words after it); end() flushes the rest.
 */
export function createCueStream() {
  let held = ''; // an unfinished "<..." from the end of the last delta
  let out = 0; // clean characters emitted so far
  let inCode = false;
  let inQuote = false;
  let eatSpace = false; // a cue was just removed after a space (or at the start): skip one space
  let lastOut = ''; // the last clean character emitted

  function run(src, final) {
    let text = '';
    const cues = [];
    const emit = (s) => {
      for (const c of s) {
        if (eatSpace && /[ \t]/.test(c)) {
          eatSpace = false;
          continue;
        }
        eatSpace = false;
        text += c;
        lastOut = c;
        out++;
      }
    };
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '`') {
        inCode = !inCode;
        emit(c);
        i++;
        continue;
      }
      if (c === '\n') inQuote = false;
      if (!inCode && QUOTES.has(c)) inQuote = !inQuote;
      if (c !== '<' || inCode) {
        emit(c);
        i++;
        continue;
      }
      const close = src.indexOf('>', i + 1);
      if (close < 0) {
        const rest = src.slice(i);
        // Could still become a cue: hold it for the next delta (or drop it at the end).
        if (rest.length <= MAX_HOLD && /^<[A-Za-z-]*$/.test(rest)) {
          if (!final) return { text, cues, held: rest };
          if (rest.length > 1) {
            i = src.length; // an unfinished cue at the very end: never spoken
            continue;
          }
        }
        emit(c);
        i++;
        continue;
      }
      const word = src.slice(i + 1, close);
      if (!CUE_WORD.test(word)) {
        emit(c);
        i++;
        continue;
      }
      // A cue: gone from the text; reported unless quoted or unknown.
      const name = cueName(word);
      if (name && !inQuote) cues.push({ cue: name, at: out });
      // (After a space, an opening quote or bracket, or at the start: the space after it goes too.)
      if (!lastOut || /[\s([{]/.test(lastOut) || (QUOTES.has(lastOut) && inQuote)) eatSpace = true;
      i = close + 1;
    }
    return { text, cues, held: '' };
  }

  return {
    push(delta) {
      const r = run(held + String(delta ?? ''), false);
      held = r.held;
      // A cue right before words not yet here: its offset is where they will start.
      return { text: r.text, cues: r.cues };
    },
    end() {
      const r = run(held, true);
      held = '';
      return { text: r.text, cues: r.cues };
    },
    /** Clean characters so far. */
    get length() {
      return out;
    },
  };
}

/** Strip every cue from whole text: { text, cues: [{ cue, at }] }. */
export function stripCues(text) {
  const s = createCueStream();
  const a = s.push(text);
  const b = s.end();
  return { text: (a.text + b.text).replace(/[ \t]+$/, ''), cues: [...a.cues, ...b.cues] };
}

/** Just the clean text (for captions, logs and the resume note). */
export const withoutCues = (text) => (typeof text === 'string' ? stripCues(text).text : text);

/**
 * Known cues only, out of text that isn't speech (a draft for Claude's box): a safety net in case the
 * voice put one there. Anything else in angle brackets (<div>, <T>) is the user's and stays.
 */
export function withoutKnownCues(text) {
  return String(text ?? '').replace(/([ \t]*)<([A-Za-z][A-Za-z-]{0,19})>([ \t]*)/g, (m, before, word, after, i, all) => {
    if (!cueName(word)) return m;
    const lineStart = i === 0 || all[i - 1] === '\n';
    const lineEnd = i + m.length === all.length || all[i + m.length] === '\n';
    return lineStart || lineEnd ? '' : before || after ? ' ' : '';
  });
}

