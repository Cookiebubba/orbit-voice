// "Send it" in the same breath: did the user's own request also tell Orbit to send the prompt?
//
//   "tell Claude to fix the tests and send it"  → yes: draft "Fix the tests." and send it at once
//   "prompt it to run the build, just send it"  → yes
//   "send Claude: add a README section"         → yes
//   "tell it to fix the nav, don't send it yet" → no (drafted, and Orbit asks as usual)
//   "tell Claude to write a function that says send it" → no: those words are the prompt's
//
// Deterministic on purpose: the send happens only when the user's own words say so here, whatever
// the voice model thinks. Drafting stays the default; anything unclear is a no (Orbit then asks).

/** Normalized for matching: curly quotes straight, spacing collapsed. */
const norm = (s) =>
  String(s || '')
    .normalize('NFKC')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

// The send instruction itself, at the very end of what they said. Its object is the prompt ("it",
// "that", "this", "the prompt") or nothing, maybe "over", "off", "now", "to Claude". "Sent it" is a
// common mishearing of "send it". (Not "ship it": in a request that can be the work, a deploy.)
const OBJ = String.raw`(?:it|that|this|that one|this one|the (?:prompt|message|draft))`;
const AFTER = String.raw`(?:\s+(?:over|off|through|along))?(?:\s+to (?:claude|him))?(?:\s+(?:now|right now|right away|straight away|immediately|asap))?(?:\s+(?:please|for me|thanks|thank you))?`;
const VERB = String.raw`(?:(?:send|sent|submit)(?:\s+${OBJ})?|fire\s+${OBJ}(?:\s+off)?)`;
const LEAD_WORD = String.raw`(?:and|then|and then|so|just|please|go ahead and|go ahead,?|you can|feel free to|don'?t ask(?: me)?,?|no need to (?:ask|confirm),?|without asking,?)`;
const TAIL = new RegExp(String.raw`(^|[\s,.;:!—–-]+)((?:${LEAD_WORD}\s+)*${VERB}${AFTER})[\s.!]*$`, 'i');
// Right before the send words without a break, these make "send it" the words of the work ("print send it").
const CONTENT_VERB = /\b(?:print|log|echo|say|says|said|saying|show|shows|display|output|type|write|return|returns|called|named|labell?ed|titled|reads|text|word|words|phrase|label|button)\s*["']?$/i;
// The send words belong to the prompt's content: what something says or is called.
const CONTENT = /\b(?:says?|saying|said|reads?|called|named|labell?ed|titled|text|words?|phrase|button|label)\s+["']?(?:just\s+)?(?:send|sent|submit)\b/i;
// "send it to Sam", "send it to the server": a recipient other than Claude is the work itself.
const TO_SOMEONE = /\b(?:send|sent|submit)\s+(?:it|that|this|them|the \w+)\s+(?:over\s+)?to\s+(?!claude\b|him\b)\w/i;
// "should I send it?", "can you send it?": a question, not an instruction.
const ASKING = /\b(?:should|shall|would|could|do|does|did|can|will) (?:i|we|you) (?:just )?(?:send|submit)\b|\b(?:want|like) me to (?:just )?(?:send|submit)\b|\b(?:send|submit)\b[^.!]*\?\s*$/i;
// Leading forms: "send Claude: …", "send this to Claude: …", "send Claude a message saying …".
const HEAD = /^(?:(?:ok(?:ay)?|alright|so|hey orbit|orbit)[,\s]+)?(?:please\s+|just\s+|go ahead and\s+)?(?:send|submit)\s+(?:(?:to\s+)?claude|(?:this|the following|a (?:prompt|message))(?:\s+to\s+claude)?|claude (?:this|a (?:prompt|message)))\s*(?::|,|-|—|saying\b|that says\b)\s*(?=\S)/i;
// "…, don't ask me" / "no need to confirm" / "without asking" at the very end, after a send instruction.
const NO_ASK = /(?:^|[\s,.;:—–-]+)(?:(?:don'?t|do not) (?:ask|check with) me(?: first)?|no need to (?:ask|confirm|check)|without (?:asking|confirming|checking))[\s,.;:!—–-]*$/i;
// Words that are only a reply ("okay, send it"), not a request with something to send.
const REPLY_ONLY = /^(?:(?:ok|okay|alright|all right|yes|yeah|yep|yup|sure|cool|great|perfect|good|fine|right|um+|uh+|so|well|now|and|then|please|go|go ahead|do it|looks good|that's good|that's fine)[\s,.!]*)*$/i;

/**
 * { send, rest }: `send` is true when these words tell Orbit to send the prompt they ask for, now;
 * `rest` is the request without the send instruction (what the prompt is made from).
 */
export function sendInstruction(words) {
  const original = norm(words);
  if (!original) return { send: false, rest: '' };
  const no = { send: false, rest: original };
  const head = original.match(HEAD);
  if (head) {
    const rest = original.slice(head[0].length).trim();
    return rest && !/^(?:it|that|this)\b/i.test(rest) && !REPLY_ONLY.test(rest) ? { send: true, rest } : no;
  }
  const s = original.replace(NO_ASK, '');
  const m = s.match(TAIL);
  if (!m) return no;
  const before = s.slice(0, m.index).trim();
  // Nothing (or only "okay") before it: a reply about a draft already made, not a request.
  if (!/[\p{L}\p{N}]/u.test(before) || REPLY_ONLY.test(before)) return no;
  if (ASKING.test(original) || CONTENT.test(original) || TO_SOMEONE.test(original)) return no;
  // "don't send it", "not yet, send it later": a negation right before the send words.
  if (/\b(?:don'?t|do not|never|not|no need to|but)\s*(?:just\s+)?$/i.test(before) || /\b(?:don'?t|do not|never)\b/i.test(m[2].replace(/\b(?:don'?t ask(?: me)?)\b/gi, ''))) return no;
  // No break before it ("print send it"): the words of the work.
  if (!/[,.;:!—–-]/.test(m[1]) && !new RegExp(`^${LEAD_WORD}\\b`, 'i').test(m[2]) && CONTENT_VERB.test(before)) return no;
  // "…tell Claude to send it": Claude is the one sending, so it's the work.
  if (/\b(?:tell|ask|have|get|make|let)\s+(?:claude|it|him)(?:\s+to)?\s*$/i.test(before)) return no;
  return { send: true, rest: before.replace(/[\s,;:—–-]+$/, '').replace(/\s+(?:and|then|and then|so|but)$/i, '').trim() };
}

/** A draft made from words with a send instruction: that instruction taken off its end, if the voice left it in. */
export function withoutSendTail(text) {
  let t = String(text || '');
  // "…, don't ask me." left at the end on its own is for Orbit too.
  const noAsk = t.replace(/[\s.!]+$/, '').replace(NO_ASK, '');
  if (noAsk !== t.replace(/[\s.!]+$/, '') && /[\p{L}\p{N}]/u.test(noAsk)) t = /[.!?]$/.test(noAsk) ? noAsk : `${noAsk}.`;
  const trimmed = t.replace(/[\s.!]+$/, '');
  const bare = trimmed.replace(NO_ASK, '');
  const m = bare.match(TAIL);
  if (!m || CONTENT.test(bare)) return t;
  const raw = bare.slice(0, m.index);
  if (!/[,.;:!—–-]/.test(m[1]) && !new RegExp(`^${LEAD_WORD}\\b`, 'i').test(m[2]) && CONTENT_VERB.test(raw)) return t;
  const before = raw.replace(/[\s,;:—–-]+$/, '').replace(/\s+(?:and|then|and then|so)$/i, '').trim();
  if (!/[\p{L}\p{N}]/u.test(before) || REPLY_ONLY.test(before)) return t;
  return /[.!?]$/.test(before) ? before : `${before}.`;
}
