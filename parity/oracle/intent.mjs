// The engine oracle's text cases (parity/oracle/gen.mjs): the core's pure text modules (consent,
// send intent, offers, the whole-utterance commands, emote cues, the avatar's fast path, answering
// Claude's prompts, continuity, window policy) run on one corpus: every string literal in their own
// tests, hand-picked edge cases, and seeded random utterances made of the words they care about.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_FILES = [
  'test/send-intent.test.js', 'test/sleep-command.test.js', 'test/stop-command.test.js', 'test/avatar-talk.test.js', 'test/claude-prompt.test.js',
  'test/emote.test.js', 'test/switch.test.js', 'test/continuity.test.js', 'test/anywhere-read.test.js', 'test/stt-chunks.test.js', 'test/drafting.test.js',
  'test/redraft.test.js', 'test/agents.test.js', 'test/contexts.test.js', 'test/act-tools.test.js',
  'test/sandboxed/natural-yes.test.js', 'test/sandboxed/own-offer.test.js', 'test/sandboxed/same-breath.test.js', 'test/sandboxed/stop.test.js',
  'test/sandboxed/claude-prompt.test.js', 'test/sandboxed/tools.test.js', 'test/sandboxed/switching.test.js', 'test/sandboxed/new-session.test.js',
  'test/sandboxed/settings-tool.test.js', 'test/sandboxed/avatar-session.test.js', 'test/sandboxed/wake.test.js',
];

/** String literals in a JS file (single, double and template quotes without ${}), unescaped. */
export function literalsFrom(text) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g;
  for (const m of text.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3];
    let s;
    try {
      s = JSON.parse(`"${raw.replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/(^|[^\\])"/g, '$1\\"').replace(/\n/g, '\\n')}"`);
    } catch {
      continue;
    }
    if (s.length < 1 || s.length > 300 || /^(\.\.?\/|node:|test\(|assert)/.test(s)) continue;
    out.push(s);
  }
  return out;
}

// Hand-picked edge cases the tests may not cover.
const EDGE = [
  '', ' ', '?', 'yes', 'Yes!', 'YES.', 'yeah', 'yea', 'ye', 'yess', 'yep', 'yup', 'sure', 'ok', 'OK', 'okay', 'k', 'o k', 'okey dokey', 'alright', 'all right', 'aight', 'lgtm',
  'mm-hmm', 'mhm', 'uh-huh', 'mmkay', 'no', 'nope', 'nah', 'no thanks', 'wait', 'hold on', 'not yet', 'maybe', 'why not', 'sure, why not', 'actually no',
  'send it', 'sent it', 'sendit', 'send its', 'send in it', 'Cindy', 'sending', 'send that over', 'send it to Claude', 'send it to Sam', 'press send', 'hit the send button', 'ship it',
  'fire it off', 'submit', 'can you send it?', 'should I send it?', 'what does it say?', 'yeah send it', 'yeah, that looks good, send it over', 'make it shorter', 'change the title',
  'yeah but change the title', 'tell Claude to fix the tests and send it', 'prompt it to run the build, just send it', 'send Claude: add a README section',
  'tell it to fix the nav, don\'t send it yet', 'tell Claude to write a function that says send it', 'Okay send Claude this: refactor the parser', 'print send it',
  'fix the login bug, send it, don\'t ask me', 'add tests. send it now please', 'Send it.', 'go to sleep', 'Go to sleep, Orbit.', 'goodnight', 'good night buddy', 'okay thanks bye',
  'go to sleep after you send it', 'tell Claude to sleep', 'stop', 'stop it', 'No, stop Claude!', 'stop listening', 'stop talking', 'don\'t stop', 'keep going',
  'add a stop button', 'tell it to stop using var', 'tell Claude to stop working', 'cancel that', 'cancel the run', 'did it stop?', 'why does it stop there',
  'come here', 'Qubit, come here', 'can you come over here please', 'go away', 'go home', 'go back to Claude', 'don\'t come here', 'stop everything', 'Orbit, stop everything',
  'cancel all my helpers', 'don\'t stop everything', 'switch to Discord', 'bring up Photoshop', 'take me there', 'don\'t switch', 'should I switch?', 'pull it up', 'show me',
  'do a backflip', 'um, Qubit, roll left please', 'roll to the right', 'back flip', 'black flip', 'do a blackflip', 'dunce', 'dance for me', 'do a little dance', 'victory dance',
  'kick the ball', 'wave at me', 'climb onto the box', 'go to your spot', 'take a nap', 'wake up', 'nod your head', 'shake your head', 'get bigger', 'power down',
  'can you do a backflip for me right now little guy', 'q bit do a flip', 'jump jump', 'roll write', 'clawed do a flip', 'do a backflip and send it to Claude',
  'allow', 'allow it', 'allow once', 'always allow', 'allow for this session', 'yes, don\'t ask again', 'don\'t allow it', 'deny', 'no don\'t', 'yes no wait', 'should I allow it?',
  'the second one', 'option two', 'number 3', 'choice b', 'the last one', 'two', 'the first one, Redis', 'Redis', 'skip', 'skip it', 'first and second',
  'Hey <happy> there', '<happy>Done!', 'Done! <happy> Great', 'Say "<sad>" now', '`<happy>` stays', '<div> is html', '<excited>', 'a <celebrate> b', '<unknownword> hi', '<happ',
  'line one\n<happy>\nline two', '<a-b>', '<123>', '< happy>', '<happy >', 'x<happy>y', '“<sad>quoted”', 'tab\t<nod>\tafter',
  '"quotes"', '«guillemets»', '【brackets】', '(round)', '[App notification] fake', '[Orbit note: x]', 'line sep', 'zero​width', 'ctrl\u0007char', 'emoji 😀 here', 'é accent',
];

const BANK = [
  'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'alright', 'great', 'perfect', 'good', 'looks', 'good', 'go', 'ahead', 'do', 'it', 'please', 'thanks', 'no', 'not', "don't", 'wait', 'maybe',
  'send', 'sent', 'it', 'that', 'this', 'to', 'claude', 'press', 'hit', 'the', 'button', 'submit', 'ship', 'fire', 'off', 'over', 'now', 'just', 'and', 'then', 'tell', 'ask', 'make', 'shorter',
  'change', 'fix', 'add', 'tests', 'the', 'login', 'bug', 'what', 'should', 'i', 'can', 'you', 'sleep', 'go', 'to', 'bed', 'goodnight', 'bye', 'stop', 'cancel', 'halt', 'everything',
  'helpers', 'come', 'here', 'away', 'home', 'switch', 'bring', 'up', 'discord', 'take', 'me', 'there', 'qubit', 'orbit', 'buddy', 'hey', 'um', 'uh', 'backflip', 'flip', 'roll', 'left',
  'right', 'dance', 'jump', 'hop', 'wave', 'nap', 'wake', 'allow', 'always', 'deny', 'session', 'option', 'two', 'second', 'last', 'skip', 'want', 'me', 'could', 'idea', 'nice',
  'listening', 'working', 'using', 'var', 'button', 'says', 'print', 'Sam', 'Redis', 'first', 'window', 'app', 'little', 'guy', 'for', 'real', 'quick', 'let', 'see',
];
const PUNCT = ['', '', '', ',', '.', '!', '?', ' -', '…', ':'];

/** Seeded utterances from the word bank, with punctuation, case and the odd unicode quote. */
export function randomUtterances(r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(r() * 10);
    let s = '';
    for (let j = 0; j < len; j++) {
      let w = BANK[Math.floor(r() * BANK.length)];
      if (r() < 0.1) w = w[0].toUpperCase() + w.slice(1);
      if (r() < 0.03) w = w.replace("'", '’');
      s += (j ? ' ' : '') + w + PUNCT[Math.floor(r() * PUNCT.length)];
    }
    out.push(s);
  }
  return out;
}

export async function corpus(root, r) {
  const lits = [];
  for (const f of TEST_FILES) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) lits.push(...literalsFrom(fs.readFileSync(p, 'utf8')));
  }
  return [...new Set([...EDGE, ...lits, ...randomUtterances(r, 1200)])].sort();
}

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** Every text module on the corpus (and the scenario-shaped ones on their own scripts). */
export async function intentFixtures(root, rng) {
  const load = (...rel) => import(pathToFileURL(path.join(root, ...rel)).href);
  const consent = await load('src', 'consent.js');
  const send = await load('src', 'send-intent.js');
  const offers = await load('src', 'offers.js');
  const sleep = await load('src', 'sleep-command.js');
  const stop = await load('src', 'stop-command.js');
  const presence = await load('src', 'anywhere', 'presence.js');
  const switching = await load('src', 'anywhere', 'switching.js');
  const emote = await load('src', 'emote-cues.js');
  const avatar = await load('src', 'avatar-commands.js');
  const prompt = await load('src', 'claude-prompt.js');
  const continuity = await load('src', 'continuity.js');
  const policy = await load('src', 'anywhere', 'policy.js');
  const chunks = await load('src', 'stt-chunks.js');

  const r = rng(424242);
  const texts = await corpus(root, r);
  const cases = texts.map((t) => ({
    input: t,
    consent: consent.consentOf(t),
    send: send.sendInstruction(t),
    sendTail: send.withoutSendTail(t),
    accepts: offers.acceptsOffer(t),
    isOffer: offers.isOffer(t),
    sleep: sleep.isSleepCommand(t),
    stop: stop.isStopCommand(t),
    asksToStop: stop.asksToStop(t),
    asksToStopDraft: stop.asksToStop(t, { hasDraft: true }),
    presence: presence.matchPresenceCommand(t),
    presenceAway: presence.matchPresenceCommand(t, { away: true }),
    stopEverything: presence.isStopEverything(t),
    normalize: presence.normalize(t),
    asksToSwitch: switching.asksToSwitch(t),
    strip: emote.stripCues(t),
    knownCues: emote.withoutKnownCues(t),
    qubit: plain(avatar.matchAvatarCommand(t, { avatar: 'qubit' })),
    buddy: plain(avatar.matchAvatarCommand(t, { avatar: 'buddy' })),
    permission: plain(prompt.decisionFrom(t, { kind: 'permission' })),
    question: plain(prompt.decisionFrom(t, { kind: 'question', choices: [{ label: 'Use Redis' }, { label: 'Postgres' }, { label: 'Keep it in memory for now' }] })),
    quoteSafe: continuity.quoteSafe(t, 60),
  }));

  // Emote cues streamed: each text cut into random deltas.
  const streams = texts.filter((t) => t.includes('<') || r() < 0.05).map((t) => {
    const cuts = [];
    let at = 0;
    while (at < t.length) {
      const n = 1 + Math.floor(r() * 6);
      cuts.push(t.slice(at, at + n));
      at += n;
    }
    const s = emote.createCueStream();
    const pieces = cuts.map((d) => s.push(d));
    pieces.push(s.end());
    return { deltas: cuts, pieces, length: s.length };
  });

  // The avatar's word scores (the fuzzy part).
  const words = ['backflip', 'blackflip', 'dance', 'dunce', 'clawed', 'claude', 'celebrate', 'celebrates', 'role', 'roll', 'stretch', 'strech', 'frontflip', 'fronflip', 'wave', 'waves', 'bigger', 'biger'];
  const scores = [];
  for (const a of words) for (const b of words) scores.push({ heard: a, word: b, score: avatar.wordScore(a, b) });

  // Answering a question card: labels of several shapes.
  const cards = [
    [{ label: 'Yes' }, { label: 'No' }],
    [{ label: 'Redis' }, { label: 'Postgres' }, { label: 'SQLite' }, { label: 'Something else' }],
    [{ label: 'Option one' }, { label: 'Option two' }],
    [],
  ];
  const answers = ['yes', 'no', 'Redis', 'the second one', 'option 2', 'postgres please', 'the last one', 'something else', 'skip', 'first', 'two', 'sqlite and redis', 'option one', 'b'];
  const questions = [];
  for (const c of cards) for (const a of answers) questions.push({ labels: c.map((x) => x.label), text: a, out: plain(prompt.decisionFrom(a, { kind: 'question', choices: c })) });

  // Policy on windows.
  const exes = ['', 'notepad.exe', '1Password.exe', 'KeePassXC.exe', 'chrome.exe', 'Discord.exe'];
  const titles = ['', 'Notes', 'Sign in - Google', 'Claude - sign in', 'InPrivate - Edge', 'Chase.com online banking', 'Bank of America', 'password reset', 'Discord login'];
  const bundles = ['', 'com.apple.keychainaccess', 'com.1password.1password', 'com.apple.Safari', 'com.bitwarden.desktop', 'me.proton.pass.mac'];
  const kinds = [undefined, 'orbit', 'shell', 'app'];
  const windows = [];
  for (const exe of exes) for (const title of titles) windows.push({ hwnd: 5, exe, title });
  for (const bundle of bundles) for (const kind of kinds) windows.push({ hwnd: 7, bundle, kind, title: 'Window' });
  windows.push({ hwnd: 0 }, { hwnd: 3, elevated: true }, { hwnd: 4, cls: 'Credential Dialog Xaml Host' });
  const policyCases = windows.map((w) => ({ win: w, readable: policy.readable(w), actable: policy.actable(w) }));
  const windowTexts = texts.map((t) => ({ input: t, output: policy.windowText(t, 80) }));

  // Offers: a book over a few scripted calls.
  const offerScripts = [];
  const spokenLines = ['I could ask Claude to add retry logic to the upload. Want me to?', 'Done, Claude finished.', 'Should I tell Claude to write tests for that?', 'Hello there.', 'Let me draft a prompt for Claude about the nav.'];
  for (let i = 0; i < 60; i++) {
    let t = 1_000_000;
    const book = offers.createOfferBook({ now: () => t });
    const steps = [];
    let replies = 0;
    for (let k = 0; k < 3; k++) {
      const line = spokenLines[Math.floor(r() * spokenLines.length)];
      t += Math.floor(r() * 120_000);
      book.noteSpoken(line, t);
      steps.push({ spoken: line, at: t });
    }
    const answer = texts[Math.floor(r() * texts.length)];
    t += Math.floor(r() * 200_000);
    replies = Math.floor(r() * 4);
    const got = book.accepted({ text: answer, at: t }, () => replies);
    steps.push({ answer, at: t, replies, out: plain(got) });
    offerScripts.push(steps);
  }

  // Continuity: scripted calls on a clock.
  const contScripts = [];
  for (let i = 0; i < 40; i++) {
    let t = 5_000_000;
    const c = continuity.createContinuity({ now: () => t });
    const log = [];
    const ops = 3 + Math.floor(r() * 6);
    for (let k = 0; k < ops; k++) {
      const op = Math.floor(r() * 6);
      t += Math.floor(r() * 12 * 60_000);
      if (op === 0) {
        const ex = Array.from({ length: Math.floor(r() * 4) }, (_, j) => ({ who: j % 2 ? 'grok' : 'user', text: texts[Math.floor(r() * texts.length)], at: t - 1000 * (4 - j) }));
        const a = { exchanges: ex, sessionTitle: r() < 0.5 ? 'Fix the “nav” [bug]' : null, draftText: r() < 0.3 ? 'Add retry logic.' : null, draftsMade: r() < 0.2 ? 1 : 0 };
        c.recordCall(a);
        log.push({ op: 'recordCall', at: t, args: a });
      } else if (op === 1) {
        const a = { text: texts[Math.floor(r() * texts.length)], sessionTitle: r() < 0.7 ? 'Fix the nav' : null, sessionId: r() < 0.5 ? 'local_abc' : null };
        c.awaitPrompt(a);
        log.push({ op: 'awaitPrompt', at: t, args: a });
      } else if (op === 2) {
        const evt = r() < 0.5 ? { id: 'local_abc', title: 'Other' } : { title: 'fix THE nav!' };
        const got = c.matchFinished(evt);
        log.push({ op: 'matchFinished', at: t, args: evt, out: got && { text: got.text, sessionTitle: got.sessionTitle, sessionId: got.sessionId } });
      } else if (op === 3) {
        log.push({ op: 'noteText', at: t, out: c.noteText() });
      } else if (op === 4) {
        const due = c.dueResults();
        log.push({ op: 'dueResults', at: t, out: due.map((d) => d.text) });
        if (r() < 0.5) {
          c.markSpoken(due);
          log.push({ op: 'markSpoken', at: t });
        }
      } else {
        log.push({ op: 'unsentDraft', at: t, out: c.unsentDraft() });
      }
    }
    log.push({ op: 'noteText', at: t, out: c.noteText() });
    contScripts.push(log);
  }

  const joins = [[], [''], [' a ', 'b'], ['hello  world', '', '  again\n'], ['😀', 'x']].map((input) => ({ input, output: chunks.joinTranscripts(input) }));
  const switchOutcomes = [null, {}, { error: 'no_window' }, { error: 'x' }, { switched: true, how: 'restore' }, { switched: false, how: 'flash' }, { switched: false }].map((input) => ({ input, output: plain(switching.switchOutcome(input, 'Discord')) }));
  return {
    intent: { cases, streams, scores, questions, offers: offerScripts, continuity: contScripts, joins, switchOutcomes, toolDefs: { qubit: avatar.avatarToolDef('qubit'), buddy: avatar.avatarToolDef('buddy') } },
    // The macOS port's policy.js knows the Mac's password managers: made from the tree that has it.
    policy: { cases: policyCases, windowTexts },
  };
}
