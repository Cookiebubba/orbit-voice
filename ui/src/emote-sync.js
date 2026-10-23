// Emotes on time: each cue Qubit's voice writes (<happy> before "Done!") fires when the audio of the
// words after it starts playing, not when the text arrives. The page's audio scheduling (useVoice)
// feeds this; no DOM here, so it runs in node for the tests with a fake audio clock.
//
// Two ways a cue comes in:
//   - On an audio chunk (Claude voice): the engine speaks clause by clause and starts a new chunk at
//     each cue, so the cue fires exactly when that chunk starts playing (offset: 'end' = when it ends,
//     for a cue with no words after it).
//   - As a position in the reply's transcript (Grok): its audio is made on xAI's side, so the bridge
//     strips the cue from the transcript and says where it was (a character offset in the clean
//     text). The text and audio both arrive well ahead of playback, so the position is mapped onto
//     the reply's audio: proportionally over its speech (letters and spaces at one unit, a pause's
//     worth for punctuation; see UNIT), then snapped to the nearest start of speech after a pause, which is
//     where a new sentence or phrase begins (cues mostly come there).
// A cue waits until there's enough to place it (the whole transcript and the audio up to the spot,
// or its end); barge-in or a cancel clears everything pending.

const FRAME_S = 0.01; // the loudness envelope's step
const PAUSE_S = 0.08; // this much quiet before a sound makes it a start of speech
const SNAP_S = 0.7; // a cue after a full stop snaps to a start of speech within this (a comma: 3/4 of it)
const SNAP_NEAR_S = 0.2; // ...mid-phrase, only forward to one this close (after a clear pause: 1.5x)
const DEFAULT_RATE = 0.058; // seconds per weighted character, until a reply has been measured
const COMMIT_S = 0.3; // an estimate from the rate alone is used only this close to when it plays
// Weights of the characters along a reply's speech, calibrated on real Grok replies (see the
// emote commit notes): punctuation stands for the pause it brings, a comma's often as long as a
// full stop's (a full stop's own pause is found by the snap anyway).
const UNIT = { letter: 1, space: 1, stop: 3, comma: 4 };

/** Weighted length of `text` up to `n` characters (see UNIT). */
export function weight(text, n = text.length) {
  let w = 0;
  for (let i = 0; i < Math.min(n, text.length); i++) {
    const c = text[i];
    if (/[.!?]/.test(c)) w += UNIT.stop;
    else if (/[,;:—-]/.test(c)) w += UNIT.comma;
    else if (/\s/.test(c)) w += UNIT.space;
    else w += UNIT.letter;
  }
  return w;
}

/**
 * opts: now() -> the audio clock in seconds (AudioContext time, output latency included);
 * fire(cue, info) -> the emote, now; setTimer(fn, ms) / clearTimer(id) (setTimeout by default).
 */
export function createEmoteSync({ now, fire, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) }) {
  const items = new Map(); // item id -> { chunks, env, text, textDone, audioDone, cues }
  const timers = new Set();
  let rate = DEFAULT_RATE; // learnt from finished replies: seconds per weighted character
  const item = (id) => {
    let it = items.get(id);
    if (!it) {
      it = { chunks: [], env: [], envAt: null, end: null, text: '', textDone: false, audioDone: false, cues: [], peak: 0 };
      items.set(id, it);
      if (items.size > 12) items.delete(items.keys().next().value);
    }
    return it;
  };

  function schedule(cue, at, info) {
    const ms = Math.max(0, (at - now()) * 1000);
    const id = setTimer(() => {
      timers.delete(id);
      fire(cue, info);
    }, ms);
    timers.add(id);
  }

  /** The item's starts of speech (after a pause) and its first and last sound, from its envelope. */
  function speech(it) {
    const th = it.peak * 0.06;
    const onsets = [];
    let first = null;
    let last = null;
    let quiet = Infinity;
    for (let i = 0; i < it.env.length; i++) {
      const t = it.envAt + i * FRAME_S;
      if (it.env[i] > th) {
        if (quiet * FRAME_S >= PAUSE_S && first != null) onsets.push({ t, pause: Math.min(quiet * FRAME_S, 2) });
        if (first == null) first = t;
        last = t + FRAME_S;
        quiet = 0;
      } else quiet++;
    }
    return { onsets, first, last };
  }

  /** Snap time `t` to the best start of speech for words after `kind` ('stop', 'comma' or 'mid'): the onset, or null. */
  function snap(sp, t, kind) {
    let best = null;
    let bestScore = Infinity;
    for (const o of sp.onsets) {
      // (Mid-phrase, never back to where the phrase began: only to a pause the words come after.)
      if (kind === 'mid' && o.t < t - 0.06) continue;
      const reach = kind === 'stop' ? SNAP_S : kind === 'comma' ? SNAP_S * 0.75 : o.pause >= 0.15 ? SNAP_NEAR_S * 1.5 : SNAP_NEAR_S * 0.6;
      const d = Math.abs(o.t - t);
      if (d > reach) continue;
      const score = d - (kind === 'stop' ? 0.8 : 0.4) * Math.min(o.pause, 0.6);
      if (score < bestScore) (best = o), (bestScore = score);
    }
    return best;
  }

  /** Where in the item's audio the words at character `pos` start (null: not yet known). */
  function place(it, pos) {
    if (!it.chunks.length) return null;
    const sp = speech(it);
    const start = sp.first ?? it.chunks[0].at;
    const text = it.text;
    if (pos === 'end' || (it.textDone && !/[\p{L}\p{N}]/u.test(text.slice(pos)))) {
      // Nothing after it: when the speech ends.
      return it.audioDone ? (sp.last ?? it.end) : null;
    }
    if (!/[\p{L}\p{N}]/u.test(text.slice(0, pos))) return start; // before the first word
    const kindAt = (i) => {
      const b = text.slice(0, i).replace(/\s+$/, '');
      return /[.!?]$/.test(b) ? 'stop' : /[,;:—]$/.test(b) ? 'comma' : 'mid';
    };
    if (!(it.textDone && it.audioDone && sp.last != null)) {
      // Not all here yet: an estimate from the speaking rate, used only when those words are about
      // to play (otherwise it waits for the rest, which nearly always comes long before).
      const t = start + weight(text, pos) * rate;
      if (t - now() > COMMIT_S || (t > it.end - 0.05 && !it.audioDone)) {
        it.recheck = Math.min(it.recheck ?? Infinity, t - COMMIT_S);
        return null;
      }
      return snap(sp, t, kindAt(pos))?.t ?? t;
    }
    // The words' share of the reply, over its speech, snapped to where speech starts again.
    const t = start + (weight(text, pos) / Math.max(1, weight(text))) * (sp.last - start);
    return snap(sp, t, kindAt(pos))?.t ?? t;
  }

  function settle(id) {
    const it = items.get(id);
    if (!it) return;
    it.recheck = null;
    it.cues = it.cues.filter((c) => {
      const at = place(it, c.pos);
      if (at == null) return true;
      schedule(c.cue, at, { item: id, pos: c.pos, at });
      return false;
    });
    if (it.cues.length && it.recheck != null && !it.recheckTimer) {
      // Look again when the estimate is about to play (if nothing more has come by then).
      const tid = setTimer(() => {
        timers.delete(tid);
        it.recheckTimer = null;
        settle(id);
      }, Math.max(10, (it.recheck - now()) * 1000));
      it.recheckTimer = tid;
      timers.add(tid);
    }
    if (it.textDone && it.audioDone) {
      const sp = speech(it);
      const w = weight(it.text);
      if (sp.first != null && sp.last - sp.first > 0.6 && w > 10) rate = rate * 0.5 + ((sp.last - sp.first) / w) * 0.5;
    }
  }

  return {
    /**
     * Audio for item `id` was scheduled at `at` (clock seconds) for `dur` seconds. `samples`
     * (Float32Array or Int16Array, 24 kHz) give its loudness envelope; `cue` ({ name, offset }) is
     * an emote that starts with this chunk (Claude voice).
     */
    audio(id, at, dur, samples, cue) {
      const it = item(id);
      it.chunks.push({ at, dur });
      if (cue?.name) schedule(cue.name, cue.offset === 'end' ? at + dur : at + (Number(cue.offset) || 0), { item: id, chunk: it.chunks.length - 1 });
      if (samples?.length) {
        if (it.envAt == null) it.envAt = at;
        const scale = samples instanceof Int16Array ? 1 / 32768 : 1;
        const per = Math.round(samples.length / Math.max(1, dur / FRAME_S));
        // Frames line up with the clock (a gap between chunks is quiet frames).
        const first = Math.round((at - it.envAt) / FRAME_S);
        while (it.env.length < first) it.env.push(0);
        for (let i = 0; i + per <= samples.length; i += per) {
          let s = 0;
          for (let k = 0; k < per; k++) s += (samples[i + k] * scale) ** 2;
          const v = Math.sqrt(s / per);
          it.env.push(v);
          if (v > it.peak) it.peak = v;
        }
      }
      it.end = Math.max(it.end ?? 0, at + dur);
      settle(id);
    },
    /** More of item `id`'s (clean) transcript. */
    text(id, delta) {
      item(id).text += String(delta || '');
      settle(id);
    },
    /** Item `id`'s whole transcript (clean), when it's done. */
    textDone(id, transcript) {
      const it = item(id);
      if (typeof transcript === 'string' && transcript.length >= it.text.length) it.text = transcript;
      it.textDone = true;
      settle(id);
    },
    /** All of item `id`'s audio has come. */
    audioDone(id) {
      const it = items.get(id);
      if (!it) return;
      it.audioDone = true;
      settle(id);
    },
    /** A cue at character `pos` of item `id`'s clean transcript (Grok). */
    cue(id, name, pos) {
      const it = item(id);
      it.cues.push({ cue: name, pos: pos === 'end' ? 'end' : Math.max(0, Number(pos) || 0) });
      settle(id);
    },
    /** Barge-in, a cancel, a hang-up: nothing pending fires. */
    clear() {
      for (const id of timers) clearTimer(id);
      timers.clear();
      items.clear();
    },
    get pending() {
      let n = timers.size;
      for (const it of items.values()) n += it.cues.length;
      return n;
    },
    get rate() {
      return rate;
    },
  };
}
