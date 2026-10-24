// Orbit's own idea, drafted on the user's yes.
//
// A draft must be the user's own words (wordsNotSaid in src/tools.js): Orbit never puts words in
// Claude's box that the user didn't say. The one other source it accepts (besides a second-brain
// suggestion the user asked for) is a prompt Orbit itself proposed OUT LOUD and the user accepted:
//
//   Orbit: "I could ask Claude to add retry logic to the upload. Want me to?"
//   User:  "Yeah, good idea."           → draft_prompt "Add retry logic to the upload." is allowed
//
// The rules, in code:
//   - The source is what Orbit actually said: the transcript of its spoken reply (noteSpoken, fed
//     by the bridge from the voice's own audio transcript). Never a window's text, a web page, a
//     notification or a tool result, unless Orbit said those words aloud to the user.
//   - It's a proposal: the reply offers to prompt Claude ("want me to…", "I could ask Claude…"),
//     or the user's words point right back at it ("send that to Claude", "tell it that").
//   - The user accepted it in one of their next two replies, within three minutes, with a clear yes
//     or a request to pass it on (src/consent.js decides; "no", "wait", a question never accept).
//   - Only words from that spoken reply (and the user's own) may be in the draft.
//   - The draft still goes into the box for the user to see, and the normal send confirmation
//     applies, unless their acceptance itself said to send ("yeah, send it to Claude").

import { consentOf } from './consent.js';

export const OFFER_LIMITS = Object.freeze({ windowMs: 3 * 60_000, maxReplies: 2, keep: 8, maxChars: 2000 });

// A reply that offers to prompt Claude.
const OFFERS = /\b(want me to|do you want me to|would you like me to|shall i|should i|i could|i can|i'll|let me|how about i|i'd suggest|i suggest)\b/i;
const ABOUT_CLAUDE = /\b(claude|prompt|send|ask|tell|have it|get it|draft)\b/i;
// The user's words pointing back at what Orbit said: "send that to Claude", "tell it that", "do that".
const REFER = /\b(send|tell|ask|give|pass|prompt|put|draft|write)\b[^.?!]*\b(that|this|it|your idea|the idea|what you (said|suggested))\b|\b(do|try) (that|this|it)\b|\b(good|great|nice) (idea|call|thought)\b/i;
// "No, that's okay, just send it": a polite "no need" to Orbit's own question, then the real answer.
const NO_NEED = /^\s*(no|nah|nope)[\s,.!]+(that'?s|it'?s|that is|it is)\s+(okay|ok|fine|alright|all right|good)[\s,.!]+|^\s*no (worries|need)[\s,.!]+/i;

/** Does this reply accept an offer? { accepts, send } (send: it also said to send it now). */
export function acceptsOffer(words) {
  const raw = String(words || '');
  const stripped = NO_NEED.test(raw) ? raw.replace(NO_NEED, '') : raw;
  if (!/[\p{L}\p{N}]/u.test(stripped)) return { accepts: false, send: false };
  const c = consentOf(stripped);
  if (c.yes) return { accepts: true, send: c.why === 'send' };
  if (c.why === 'negation' || c.why === 'question' || c.why === 'empty') return { accepts: false, send: false };
  // A change ("tell Claude that") that only points back at the offer is still accepting it.
  if (REFER.test(stripped) && !/\b(instead|change|but|except|don'?t|not)\b/i.test(stripped)) return { accepts: true, send: /\b(send|submit)\b/i.test(stripped) };
  return { accepts: false, send: false };
}

export const isOffer = (text) => OFFERS.test(String(text || '')) && ABOUT_CLAUDE.test(String(text || ''));

/**
 * What Orbit said aloud in this call, for offers. `repliesSince(ts)`: how many times the user spoke
 * after `ts` (the bridge counts). `now` for tests.
 */
export function createOfferBook({ now = () => Date.now() } = {}) {
  const spoken = []; // { text, at }
  return {
    /** Orbit finished saying this (its own audio transcript). */
    noteSpoken(text, at = now()) {
      const t = String(text || '').trim();
      if (!/[\p{L}\p{N}]/u.test(t)) return;
      spoken.push({ text: t.slice(0, OFFER_LIMITS.maxChars), at });
      while (spoken.length > OFFER_LIMITS.keep) spoken.shift();
    },
    /**
     * The spoken proposal the user's words (`answer`: { text, at }) accept: { text, at, send } or
     * null. The user's latest reply after Orbit said it, one of their first two replies after it.
     */
    accepted(answer, repliesSince = () => 0) {
      if (!answer?.text || !Number.isFinite(answer.at)) return null;
      const acc = acceptsOffer(answer.text);
      if (!acc.accepts) return null;
      // What Orbit said in the last exchange or two before their words (said after, or over, their
      // words is not what they answered): its offer is in there, or their words point back at it.
      const recent = spoken.filter((r) => r.at < answer.at && answer.at - r.at <= OFFER_LIMITS.windowMs && repliesSince(r.at) <= OFFER_LIMITS.maxReplies);
      if (!recent.length) return null;
      if (!recent.some((r) => isOffer(r.text)) && !REFER.test(answer.text)) return null;
      return { text: recent.map((r) => r.text).join(' '), at: recent[0].at, send: acc.send };
    },
    /** For tests. */
    get size() {
      return spoken.length;
    },
  };
}
