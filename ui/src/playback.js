// How Orbit's voice comes out of the speakers: its volume, the release at the end of a reply, and
// when talking over the very end of a reply lets it finish. Plain JS so the tests run it in node.

/** Settings → Voice → Volume (0–1) when nothing is saved: a little under full scale, which is loud in earbuds. */
export const DEFAULT_VOLUME = 0.75;

/** The gain for a volume setting: squared, so the slider feels even (half way is about -12 dB). */
export function volumeGain(v) {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
  return x * x;
}

/** The chimes keep their level relative to the voice: as now at the default volume. */
export function chimeLevel(v, base = 0.12) {
  return Math.min(0.2, base * (volumeGain(v) / volumeGain(DEFAULT_VOLUME)));
}

export const RELEASE_MS = 120;
const QUIET = 0.01; // about -40 dBFS: below this the audio has already ended by itself

/**
 * A natural release for audio that ends abruptly (the last 10 ms still sounding): the waveform
 * mirrored at its end (so it carries on from the very last sample, no jump) under a falling
 * exponential, -48 dB after RELEASE_MS. It is played right after the audio, so it only ever adds
 * to the end, never fades what was said. null when the audio already ends in quiet.
 * `pcm`: Int16Array (or Float32Array in -1..1) of the audio's last part.
 */
export function releaseTail(pcm, rate = 24000, ms = RELEASE_MS) {
  if (!pcm || !pcm.length) return null;
  const scale = pcm instanceof Int16Array ? 1 / 0x8000 : 1;
  const W = Math.min(pcm.length, Math.round(rate / 100));
  let sum = 0;
  for (let i = pcm.length - W; i < pcm.length; i++) sum += (pcm[i] * scale) ** 2;
  if (Math.sqrt(sum / W) < QUIET) return null;
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  const k = Math.log(250) / n;
  for (let t = 0; t < n; t++) {
    // Mirror back and forth across what there is (a short chunk is mirrored again at its start).
    const len = pcm.length;
    const p = t % (2 * len);
    const i = p < len ? len - 1 - p : p - len;
    out[t] = pcm[i] * scale * Math.exp(-k * t);
  }
  return out;
}

/** Talking over a reply's last moments is the user answering it, not stopping it. */
export const FINISH_WITHIN_S = 0.8;

/**
 * The user started talking while Orbit's voice plays: let what's left play out instead of cutting
 * it? Only once the whole reply has arrived (`replyDone`) and just its end is left to hear
 * (`remainingS`, including the output's latency): a real interruption earlier still stops it.
 */
export function letItFinish({ remainingS, replyDone, within = FINISH_WITHIN_S }) {
  return !!replyDone && remainingS > 0 && remainingS <= within;
}
