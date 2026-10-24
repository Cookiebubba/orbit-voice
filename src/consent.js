// Is the user's reply a yes? One small deterministic scorer, used wherever Orbit waits for consent
// (sending a draft, an outward act in another app, a switch Orbit offered, a helper's approval...).
//
// Design (2026-10-24): sending used to need "yes, send it" or a short list of set phrases, and Orbit
// coached those exact words. Now:
//
//   Consent = the user's latest reply, said right after Orbit asked (the callers check the timing:
//   after the draft or question appeared, under a minute old, nothing from an app in between), is
//   affirmative and doesn't negate, hesitate, ask something or change the request.
//
// So any clear yes counts, in the user's own way of saying it, with extra words and speech-to-text
// slop: "yeah", "sure", "do it", "go for it", "looks good", "perfect", "ok send", "mhm", "ship it",
// "yeah that looks good, send it over", "can you send it?", "look for the send button and press it",
// "sent it", "sendit". It stays a no for "no", "wait", "hold on", "not yet", "change...", "make it
// shorter", "what does it say?", "should I send it?", and for anything that isn't a reply at all
// (a new request, a long thought).
//
// How it scores (no phrase lists stacked per caller; one vocabulary, three kinds of words):
//   1. Normalize: lowercase, straight quotes, punctuation to spaces, known mishearings fixed
//      ("sent it" / "sendit" / "send that" → send it). A trailing "?" is kept as a signal.
//   2. A veto ends it: a negation or hesitation ("no", "don't", "not", "wait", "hold on", "maybe",
//      "never mind", "actually", "but"), a change ("change", "instead", "add", "fix", "make it",
//      "shorter", "rewrite"...), or a question that isn't a polite request to send ("what...",
//      "is it...", "should I send it?" are questions; "can you send it?" is a request).
//   3. Then it needs a yes: a send instruction ("send it", "press send", "hit the send button",
//      "ship it", "submit") is enough on its own; an affirmation ("yeah", "sure", "looks good",
//      "go ahead", "mhm") is enough when the rest is only a few words, so a long new thought that
//      happens to start with "yeah" is not taken as a yes.
//
// The model deciding to call the tool is the other half: it has to judge the reply a yes too, and
// this check runs on the transcript of what the user actually said (never the model's own words, a
// notification, a page or a tool result), so the model can't talk itself past it.

/** Words of the reply, normalized; and whether it ended in a question mark. */
function prepare(text) {
  let t = String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .trim();
  const asked = /\?\s*$/.test(t);
  t = t
    .replace(/\b(mm+[- ]?h+m+|m+h+m+|uh[- ]?huh|mm[- ]?kay)\b/g, ' mhm ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'(?!(s|t|re|ll|ve|d|m)\b)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Speech to text: "sent it", "sendit", "send its", "send in it" are "send it"; "yeah" has many spellings.
    .replace(/\b(sent|sendit|sendt|sen)\b(?= |$)/g, (m) => (m === 'sendit' ? 'send it' : 'send'))
    .replace(/\bsend (its|in it|ed)\b/g, 'send it')
    .replace(/\b(yea|yah|yeh|ya|ye|yess+|yas|yeap|yap)\b/g, 'yeah')
    .replace(/\b(okey|okie|okey dokey|okie dokie|o k|k)\b/g, 'okay')
    .replace(/\bok\b/g, 'okay')
    .replace(/\b(alright|all right|aight)\b/g, 'alright')
    .replace(/\b(lgtm)\b/g, 'looks good');
  // A reply that is only a known mishearing of "send it" ("Cindy", "sending"), heard right after
  // "Send it?": the whole reply, nothing else.
  if (/^(cindy|sindy|sendy|send a|sending|send at|sinned it|cinda)$/.test(t)) t = 'send it';
  // Fillers and courtesy carry no meaning either way.
  const words = t.split(' ').filter((w) => w && !/^(u+h*m+|u+h+|e+r+m*|a+h+|h+m+|oh|well|so|like|just|now|then|um|uh)$/.test(w));
  return { words, line: ` ${words.join(' ')} `, asked };
}

// Negation and hesitation: any of these and it's not a yes. ("why not" is handled first.)
const NEGATE = / (no|nope|nah|naw|don't|dont|do not|doesn't|didn't|not|never|wait|stop|cancel|scrap|abort|hold on|hang on|hold off|hold up|one sec|one second|a sec|a second|later|maybe|perhaps|probably not|not sure|unsure|i don't know|dunno|never mind|nevermind|forget it|actually|but|although|though|except|rather|hmm|let me think|let me see|i guess|wrong|undo|throw it away|redo) /;
// A change to what's drafted, or more to say: a new request, not an answer.
const CHANGE = / (change|changed|instead|edit|fix|add|also|(?:delete|remove|discard)(?! (?:it|that|this|them) )|plus|another|more|less|make it|make that|shorter|longer|rewrite|reword|rephrase|replace|swap|tweak|update|correct it|first|before|after that|and then|tell it|tell claude|ask it|ask claude|include|mention|say that|type|sleep|goodnight|good night|bye|stop listening|send (?:it|that|this) to (?!claude |him )[a-z]+) /;
// A question word: a question, not an answer ("what does it say?", "how long is it").
const QUESTION = / (what|what's|whats|how|where|who|which|when|why|is it|is that|does it|did it|did you|are you|have you|should i|shall i|should we|do i|do you think|isn't|is this) /;
// A polite request to send is a yes even as a question: "can you send it?", "could you press send?"
const POLITE = /^(?:yeah |okay |alright |sure |so |please )*(?:can|could|would|will|wanna|want to) you (?:please |just |go ahead and |maybe )?(?:try to )?(?:send|submit|press|hit|click|push|ship|fire|go|do it)\b/;
// Sending, said any way: enough on its own.
const SEND = / (send(?: it| that| this| that one| the prompt| the draft| the message)?(?: over| off| through| away| along| now| to claude)*|submit(?: it| that)?|ship it|fire (?:it |that )?(?:off|away)|fire away|hit send|(?:press|hit|click|push|tap)(?: on)? (?:the )?send(?: button)?|press it|hit it|push it|send button(?: and)? press(?:ed)? it|go ahead and send|you can send(?: it)?|post it) /;
// Agreement: enough when the rest of the reply is short.
const AFFIRM = / (yeah|yes|yep|yup|sure|okay|alright|cool|great|perfect|fine|good|nice|awesome|excellent|lovely|brilliant|sweet|absolutely|definitely|certainly|of course|correct|right|exactly|affirmative|indeed|mhm|please|please do|do it|do that|let's do it|let's go|go|go ahead|go for it|go on|proceed|confirm|confirmed|approved|approve|why not|sounds good|sounds great|sounds right|looks good|looks great|looks right|looks fine|that's good|that's great|that's fine|that's it|that's right|that's perfect|that works|works for me|good to go|ready|love it|nailed it|good idea|great idea|yes please|thanks|thank you|make it so|that one) /;
// Words that can go with a yes without making it a new thought.
const EASY = new Set("a an the it that this one is it's its i i'm you your we me my to for of on in and yes yeah okay please thanks thank very really totally pretty much good great looks look sounds sound go ahead now right away buddy orbit qubit claude man dude mate sir yep sure all set do did done let's lets try again button press hit click there's theres there send over off".split(' '));

/**
 * { yes, why }: is this reply a clear yes? `why` names what decided it ('send', 'affirm', or the
 * veto: 'negation', 'change', 'question', 'empty', 'unclear', 'long').
 */
export function consentOf(utterance) {
  const { words, line, asked } = prepare(utterance);
  if (!words.length) return { yes: false, why: 'empty' };
  const l = line.replace(/ why not /g, ' okay ');
  if (NEGATE.test(l)) return { yes: false, why: 'negation' };
  const polite = POLITE.test(l.trim());
  if (!polite && (QUESTION.test(l) || (asked && !SEND.test(l)))) return { yes: false, why: 'question' };
  if (CHANGE.test(l)) return { yes: false, why: 'change' };
  if (SEND.test(l) || polite) return { yes: true, why: 'send' };
  if (!AFFIRM.test(l)) return { yes: false, why: 'unclear' };
  // An affirmation with a few other words ("yeah that's perfect buddy"), not a new long thought.
  const other = words.filter((w) => !EASY.has(w) && !AFFIRM.test(` ${w} `));
  return other.length <= 3 && words.length <= 14 ? { yes: true, why: 'affirm' } : { yes: false, why: 'long' };
}

/** A spoken or typed answer that counts as consent: a clear yes, nothing negated, changed or asked. */
export const isClearYes = (utterance) => consentOf(utterance).yes;
