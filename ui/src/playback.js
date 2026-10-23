// How Orbit's voice comes out of the speakers: its volume. Plain JS so the tests run it in node.

/** Settings → Voice → Volume (0–1) when nothing is saved: a little under full scale, which is loud in earbuds. */
export const DEFAULT_VOLUME = 0.75;

/** The gain for a volume setting: squared, so the slider feels even (half way is about -12 dB). */
export function volumeGain(v) {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
  return x * x;
}

/** The chimes keep their level relative to the voice: as before at the default volume. */
export function chimeLevel(v, base = 0.12) {
  return Math.min(0.2, base * (volumeGain(v) / volumeGain(DEFAULT_VOLUME)));
}
