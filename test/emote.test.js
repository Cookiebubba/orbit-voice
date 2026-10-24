// Qubit's feelings while he talks: the voice writes a cue (<happy>) before the words it goes with;
// it is never spoken, shown or kept, and the emote fires when those words play.
//   - src/emote-cues.js: finding and stripping cues, whole or split across streamed deltas
//   - ui/src/emote-sync.js: timing each emote to the audio, on a fake audio clock (synthetic speech,
//     and real Grok replies replayed from test/fixtures/grok-emote-replies.json)
//   - src/claude-voice.js: cues never reach Kitten TTS or the captions; each rides its words' audio
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { CUES, cueName, createCueStream, stripCues, withoutCues, withoutKnownCues } from '../src/emote-cues.js';
import { createEmoteSync, weight } from '../ui/src/emote-sync.js';
import { createClaudeRealtime } from '../src/claude-voice.js';
import { EMOTES } from '../ui/src/qubit/director.js';

// ---------- the cues ----------
test('the cue vocabulary is his own moods and moves only', () => {
  assert.deepEqual(Object.keys(EMOTES).sort(), [...CUES].sort(), 'each cue has an emote, and each emote a cue');
  assert.equal(cueName('Happy'), 'happy');
  assert.equal(cueName('celebrate'), 'excited');
  assert.equal(cueName('think'), 'wonder');
  assert.equal(cueName('dance'), null);
});

test('cues are found and stripped: at the start, in the middle, at the end, with the spaces tidied', () => {
  const r = stripCues('<happy> Done! The tests pass. <curious> Want me to send it? <nod>');
  assert.equal(r.text, 'Done! The tests pass. Want me to send it?');
  assert.deepEqual(r.cues, [
    { cue: 'happy', at: 0 },
    { cue: 'curious', at: r.text.indexOf('Want') },
    { cue: 'nod', at: r.text.length + 1 },
  ]);
  // Grok writes them with no space after, too.
  assert.deepEqual(stripCues('<happy>All good. <sad>Not that.'), { text: 'All good. Not that.', cues: [{ cue: 'happy', at: 0 }, { cue: 'sad', at: 10 }] });
  assert.equal(stripCues('That is <happy> great news').text, 'That is great news');
  assert.equal(stripCues('Hi<wow>there').text, 'Hithere');
  assert.deepEqual(stripCues('Yes. <celebrate> We did it').cues, [{ cue: 'excited', at: 5 }], 'an alias');
});

test('unknown cues are dropped silently, malformed ones are left alone, code and quotes are respected', () => {
  assert.deepEqual(stripCues('<giggle> Okay.'), { text: 'Okay.', cues: [] }, 'an unknown cue: gone, not reported');
  assert.equal(stripCues('if a < b and c > d').text, 'if a < b and c > d', 'comparisons are text');
  assert.equal(stripCues('I <3 it').text, 'I <3 it');
  assert.equal(stripCues('< happy > hm').text, '< happy > hm', 'with spaces it is not a cue');
  assert.deepEqual(stripCues('Type `<happy>` in the box.'), { text: 'Type `<happy>` in the box.', cues: [] }, 'inside code: text');
  assert.deepEqual(stripCues('He said "<sad> oh no" and left. <happy> Fine.'), { text: 'He said "oh no" and left. Fine.', cues: [{ cue: 'happy', at: 26 }] }, 'quoted: gone, not his feeling');
  assert.deepEqual(stripCues('Almost done <happ'), { text: 'Almost done', cues: [] }, 'an unfinished cue at the end: never spoken');
  assert.equal(stripCues('a <').text, 'a <');
  assert.equal(withoutCues('<proud> Shipped.'), 'Shipped.');
  assert.equal(withoutCues(null), null);
});

test('split across streamed deltas at every possible point, a cue comes out the same', () => {
  const texts = ['<happy> Done! The tests pass. <curious> Want me to <nod>send it?', 'Well, <curious> that is odd, because <surprised> the cache was empty.', 'Type `<happy>` and "<sad>" then <wow> go <giggle> on.'];
  for (const whole of texts) {
    const want = stripCues(whole);
    for (let i = 0; i <= whole.length; i++) {
      for (let j = i; j <= whole.length; j += 3) {
        const s = createCueStream();
        const parts = [whole.slice(0, i), whole.slice(i, j), whole.slice(j)].map((p) => s.push(p));
        parts.push(s.end());
        const text = parts.map((p) => p.text).join('').replace(/[ \t]+$/, '');
        assert.equal(text, want.text, `split at ${i},${j}`);
        assert.deepEqual(parts.flatMap((p) => p.cues), want.cues, `split at ${i},${j}`);
      }
    }
  }
});

test('a cue the voice slipped into a draft for Claude is taken out; anything else in brackets stays', () => {
  assert.equal(withoutKnownCues('<happy> Fix the login bug.'), 'Fix the login bug.');
  assert.equal(withoutKnownCues('Fix the <proud> tests.\n<nod> Then commit.'), 'Fix the tests.\nThen commit.');
  assert.equal(withoutKnownCues('Wrap it in a <div> and use List<T>.'), 'Wrap it in a <div> and use List<T>.');
});

// ---------- timing (a fake audio clock) ----------
/** A fake clock and timers: run(t) advances to t, firing what's due in order. */
function clock() {
  let now = 0;
  const timers = [];
  let n = 0;
  const c = {
    now: () => now,
    setTimer: (fn, ms) => (timers.push({ id: ++n, at: now + Math.max(0, ms) / 1000, fn }), n),
    clearTimer: (id) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    run(to) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > to) break;
        const x = timers.shift();
        now = Math.max(now, x.at);
        x.fn();
      }
      now = to;
    },
  };
  return c;
}
function syncOn(c) {
  const fired = [];
  const sync = createEmoteSync({ now: c.now, fire: (cue) => fired.push({ cue, t: c.now() }), setTimer: c.setTimer, clearTimer: c.clearTimer });
  return { sync, fired };
}
const ms = (s) => Math.round(s * 1000);

test('Claude voice: each emote fires as its chunk starts playing, also when queued behind earlier speech', () => {
  const c = clock();
  const { sync, fired } = syncOn(c);
  // Three chunks arrive at once at t=0.2 (TTS is quick); they play back to back from 0.23.
  c.run(0.2);
  sync.audio('r1', 0.23, 1.4, null, null);
  sync.audio('r1', 1.63, 0.9, null, { name: 'happy' });
  sync.audio('r1', 2.53, 1.1, null, { name: 'curious' });
  c.run(1.5);
  assert.equal(fired.length, 0, 'nothing yet: the words are still queued behind the first chunk');
  c.run(5);
  assert.deepEqual(fired.map((f) => [f.cue, ms(f.t)]), [['happy', 1630], ['curious', 2530]]);
  // A feeling after the last words: when they end.
  sync.audio('r2', 6, 1, null, null);
  sync.audio('r2', 7, 0, null, { name: 'nod' });
  c.run(9);
  assert.deepEqual(fired.at(-1), { cue: 'nod', t: 7 });
});

test('barge-in or a cancel clears every pending emote', () => {
  const c = clock();
  const { sync, fired } = syncOn(c);
  sync.audio('r1', 0.1, 2, null, null);
  sync.audio('r1', 2.1, 1, null, { name: 'happy' });
  sync.text('r2', 'Hello there. How are you?');
  sync.cue('r2', 'sad', 13);
  assert.ok(sync.pending >= 2);
  c.run(1);
  sync.clear(); // you started talking: playback stops
  c.run(10);
  assert.deepEqual(fired, []);
  assert.equal(sync.pending, 0);
});

/**
 * Synthetic speech, paced like Grok's (measured on its replies): each letter 55 ms of sound, a space
 * 40 ms of sound, a comma 180 ms of quiet and a full stop 380 ms. Returns the samples (24 kHz) and
 * when each word starts.
 */
function speak(text) {
  const R = 24000;
  const out = [];
  const starts = [];
  let t = 0;
  let inWord = false;
  const sound = (s, loud) => {
    for (let i = 0; i < Math.round(s * R); i++) out.push(loud ? Math.sin((out.length * 2 * Math.PI * 180) / R) * 0.5 : 0);
    t += s;
  };
  for (const ch of text) {
    if (/[\p{L}\p{N}']/u.test(ch)) {
      if (!inWord) starts.push(t);
      inWord = true;
      sound(0.055, true);
    } else {
      inWord = false;
      if (ch === ' ') sound(0.04, true);
      else if (/[,;:]/.test(ch)) sound(0.18, false);
      else if (/[.!?]/.test(ch)) sound(0.38, false);
    }
  }
  return { samples: Float32Array.from(out), starts, dur: t };
}
const wordIndexAt = (text, pos) => (text.slice(0, pos).match(/[\p{L}\p{N}']+/gu) || []).length;

test('Grok: a cue in the transcript fires when its words play (synthetic speech, text ahead of audio)', () => {
  // (At sentence and phrase starts, where nearly all cues go; mid-phrase ones are measured on real replies below.)
  const raw = '<happy> All the tests passed. <surprised> There is one lint warning left, <curious> in the parser. <proud> That was quick work, <nod> so we can ship.';
  const { text, cues } = stripCues(raw);
  const { samples, starts, dur } = speak(text);
  const c = clock();
  const { sync, fired } = syncOn(c);
  // The transcript comes in three deltas at 0.6 s; the audio in 0.5 s chunks, faster than it plays.
  c.run(0.6);
  const s = createCueStream();
  const parts = [raw.slice(0, 40), raw.slice(40, 90), raw.slice(90)];
  for (const p of parts) {
    const r = s.push(p);
    sync.text('g1', r.text);
    for (const x of r.cues) sync.cue('g1', x.cue, x.at);
  }
  sync.textDone('g1', text);
  const startAt = 0.65;
  const step = 12000;
  for (let i = 0, k = 0; i < samples.length; i += step, k++) {
    c.run(0.6 + k * 0.1);
    const chunk = samples.subarray(i, i + step);
    sync.audio('g1', startAt + i / 24000, chunk.length / 24000, chunk);
  }
  sync.audioDone('g1');
  c.run(startAt + dur + 1);
  assert.equal(fired.length, cues.length);
  for (const [k, x] of cues.entries()) {
    const want = startAt + starts[wordIndexAt(text, x.at)];
    const err = fired[k].t - want;
    const mid = !/[.!?,;:]\s*$/.test(text.slice(0, x.at)) && x.at > 0;
    assert.equal(fired[k].cue, x.cue);
    assert.ok(Math.abs(err) <= (mid ? 0.17 : 0.08), `${x.cue}${mid ? ' (mid-phrase)' : ''}: ${ms(err)} ms from its words`);
  }
});

test('Grok, real replies replayed: each emote within 80 ms of its words at sentence and phrase starts, 170 ms mid-phrase', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/grok-emote-replies.json', import.meta.url), 'utf8'));
  const errs = [];
  for (const reply of fx.replies) {
    const c = clock();
    const { sync, fired } = syncOn(c);
    const s = createCueStream();
    let head = 0;
    let frame = 0; // envelope frames handed over so far
    let start = null;
    for (const [t, type, x] of reply.events) {
      c.run(t / 1000);
      if (type === 'text') {
        const r = s.push(x);
        sync.text('g', r.text);
        for (const q of r.cues) sync.cue('g', q.cue, q.at);
      } else if (type === 'text.done') {
        s.end();
        sync.textDone('g');
      } else if (type === 'audio') {
        // The page schedules each chunk right after the last (or now, if it ran dry).
        const at = Math.max(head, c.now() + 0.03);
        start ??= at;
        const frames = Math.round(x / 240);
        const samples = new Float32Array(frames * 240);
        for (let f = 0; f < frames; f++) samples.fill((reply.envelope[frame + f] || 0) / 10000, f * 240, (f + 1) * 240);
        frame += frames;
        sync.audio('g', at, x / 24000, samples);
        head = at + x / 24000;
      } else if (type === 'done') sync.audioDone('g');
    }
    c.run(c.now() + 30);
    assert.equal(fired.length, reply.words.length, reply.name);
    reply.words.forEach((w, k) => {
      const err = fired[k].t - start - w;
      const mid = reply.midPhrase.includes(k);
      errs.push(Math.abs(err));
      assert.ok(Math.abs(err) <= (mid ? 0.17 : 0.08), `${reply.name} cue ${k} (${fired[k].cue}${mid ? ', mid-phrase' : ''}): ${ms(err)} ms`);
    });
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mean < 0.04, `mean error ${ms(mean)} ms over ${errs.length} cues`);
});

test('the weights the timing uses: punctuation stands for its pause', () => {
  assert.equal(weight('ab c'), 4);
  assert.ok(weight('Hi, there.') > weight('Hi  there '));
});

// ---------- Claude voice: cues never reach the speech engine or the captions ----------
const FILLERS = ['One sec.', 'Let me check.', 'Checking.', 'One moment.', 'Let me think.']; // made ahead, at the start of a call
function fakeSpeech() {
  const vad = { detected: false, segments: [], acceptWaveform() {}, isDetected() { return false; }, isEmpty() { return true; }, front() {}, pop() {}, reset() {} };
  return { said: [], get words() { return this.said.filter((s) => !FILLERS.includes(s)); }, newVad: () => vad, newResampler: () => ({ resample: (f) => f }), async transcribe() { return ''; }, async speak(text) { this.said.push(text); return new Float32Array(240); } };
}
function fakeClaude(reply) {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 0);
    let buf = '';
    child.stdin.on('data', async (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      buf = '';
      const out = (o) => child.stdout.write(`${JSON.stringify(o)}\n`);
      await new Promise((r) => setImmediate(r));
      for (const piece of reply) {
        out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
        await new Promise((r) => setTimeout(r, 2));
      }
      out({ type: 'stream_event', event: { type: 'message_stop' } });
      out({ type: 'result', subtype: 'success', is_error: false, result: reply.join('') });
    });
    return child;
  };
  return { spawnImpl };
}
async function claudeSays(reply) {
  const speech = fakeSpeech();
  const sock = createClaudeRealtime({ claudePath: 'claude', speech, spawnImpl: fakeClaude(reply).spawnImpl });
  const ev = [];
  sock.on('message', (d) => ev.push(JSON.parse(d)));
  await new Promise((r) => sock.once('open', r));
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }));
  sock.send(JSON.stringify({ type: 'response.create' }));
  for (let i = 0; i < 400 && !ev.some((e) => e.type === 'response.done'); i++) await new Promise((r) => setTimeout(r, 5));
  sock.close();
  return { speech, ev };
}

test('Claude voice: cues are never spoken or captioned; each starts its own piece, and its emote rides that audio', async () => {
  const { speech, ev } = await claudeSays(['<hap', 'py> Done! The tests pass', ', and <curious> I wonder why it was so fast. <n', 'od> Want me to send it? <proud>']);
  assert.ok(!speech.said.some((s) => /[<>]|happy|curious|\bnod\b|proud/.test(s)), `nothing of a cue is spoken: ${JSON.stringify(speech.said)}`);
  const transcript = ev.filter((e) => e.type === 'response.output_audio_transcript.delta').map((e) => e.delta).join('');
  assert.equal(transcript, 'Done! The tests pass, and I wonder why it was so fast. Want me to send it?');
  assert.equal(ev.find((e) => e.type === 'response.output_audio_transcript.done').transcript, transcript);
  // Each emote is on the first audio of the words after it; the last one, with no words, after them.
  const audio = ev.filter((e) => e.type === 'response.output_audio.delta');
  const withEmote = audio.map((e, i) => [i, e.emote?.name, e.delta.length > 0]).filter((x) => x[1]);
  const pieceOf = (words) => speech.words.findIndex((s) => s.startsWith(words));
  assert.deepEqual(withEmote, [
    [pieceOf('Done!'), 'happy', true],
    [pieceOf('I wonder'), 'curious', true],
    [pieceOf('Want me'), 'nod', true],
    [audio.length - 1, 'proud', false],
  ]);
});

test('Claude voice: a reply with no cues is spoken just as before', async () => {
  const { speech, ev } = await claudeSays(['Claude is idle. ', 'Nothing to do.']);
  assert.deepEqual(speech.words, ['Claude is idle.', 'Nothing to do.']);
  assert.ok(!ev.some((e) => e.emote));
});

test('Grok without the end of its audio yet: a cue still fires on time from the speaking rate, just before its words', () => {
  const c = clock();
  const { sync, fired } = syncOn(c);
  const text = 'One two three four five six seven eight nine ten eleven twelve.';
  c.run(0.1);
  sync.text('g', text);
  sync.textDone('g');
  sync.cue('g', 'nod', text.indexOf('seven'));
  // 3 s of steady sound arrives (no audio.done, ever).
  sync.audio('g', 0.2, 3, new Float32Array(72000).fill(0.3));
  c.run(10);
  assert.equal(fired.length, 1);
  const want = 0.2 + weight(text, text.indexOf('seven')) * sync.rate;
  assert.ok(Math.abs(fired[0].t - want) < 0.02, `at its estimate (${ms(fired[0].t)} ms, want ${ms(want)} ms)`);
});
