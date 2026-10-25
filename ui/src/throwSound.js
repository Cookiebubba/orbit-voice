// The avatar's throw sound ("Wheee!", ui/public/sounds/wheee.mp3, 1.36 s), played by Orbit's main
// window at the voice volume. One player: it never overlaps itself, and a new throw starts it again
// from the top. Plain JS (the audio element is passed in) so the tests run it in node.

export const THROW_SOUND_URL = '/sounds/wheee.mp3';
export const THROW_SOUND_MS = 1400; // how long it plays (a little over the clip)

export function createThrowSound({ makeAudio = (src) => new Audio(src), gain = (v) => v } = {}) {
  let audio = null;
  let plays = 0;
  return {
    /** Play it (from the start) at voice volume `volume` (0..1). Returns how long it plays, ms. */
    play(volume) {
      try {
        audio ??= makeAudio(THROW_SOUND_URL);
        audio.pause?.();
        audio.currentTime = 0;
        audio.volume = Math.min(1, Math.max(0, Number(gain(Number(volume))) || 0));
        plays++;
        const p = audio.play?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        // no audio device: nothing to do
      }
      return THROW_SOUND_MS;
    },
    get plays() {
      return plays;
    },
  };
}
