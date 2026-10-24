// Long speech in pieces a speech-to-text model can take.
//
// Moonshine (sherpa-onnx's quantized base build) returns an EMPTY result for anything longer than
// about 9 seconds (an onnxruntime broadcast error in its decoder, which sherpa-onnx catches and
// answers with nothing), and Whisper takes 30 seconds at most. Orbit's voice detector hands over up
// to 30 seconds of speech at once, so a long sentence simply vanished. Each model has a limit here;
// longer audio is cut at the quietest moment in the last part of each piece (between words, not in
// the middle of one), transcribed piece by piece, and the text joined.

const RATE = 16000;
const FRAME = 320; // 20 ms

/** Loudness of each 20 ms frame (root mean square). */
function frameEnergy(samples, from, to) {
  const out = [];
  for (let i = from; i + FRAME <= to; i += FRAME) {
    let e = 0;
    for (let j = i; j < i + FRAME; j++) e += samples[j] * samples[j];
    out.push({ at: i, e: e / FRAME });
  }
  return out;
}

/**
 * `samples` (16 kHz) split into pieces of at most `maxSeconds`, each cut at the quietest 100 ms
 * between half and all of the limit. Short audio comes back as one piece.
 */
export function splitForStt(samples, maxSeconds, rate = RATE) {
  const max = Math.max(1, Math.floor(maxSeconds * rate));
  const pieces = [];
  let start = 0;
  while (samples.length - start > max) {
    const lo = start + Math.floor(max / 2);
    const hi = start + max;
    const frames = frameEnergy(samples, lo, hi);
    let cut = hi;
    let best = Infinity;
    // 100 ms windows (five frames): the quietest one's middle is the cut.
    for (let k = 0; k + 5 <= frames.length; k++) {
      let e = 0;
      for (let m = k; m < k + 5; m++) e += frames[m].e;
      if (e < best) {
        best = e;
        cut = frames[k + 2].at + FRAME / 2;
      }
    }
    pieces.push(samples.subarray(start, cut));
    start = cut;
  }
  pieces.push(samples.subarray(start));
  return pieces.filter((p) => p.length > rate * 0.1);
}

/** The pieces' texts joined into one transcript (spacing tidied). */
export const joinTranscripts = (texts) =>
  texts
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
