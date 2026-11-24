// Little UI chimes, made with oscillators (no audio files). Works whether or not voice is on.
import { DEFAULT_VOLUME, chimeLevel } from "./playback.js";
let ctx: AudioContext | null = null;

export type Chime = "wake" | "sleep" | "done";
const NOTES: Record<Chime, number[]> = {
  wake: [523.25, 783.99], // C5 → G5
  sleep: [783.99, 523.25], // G5 → C5
  done: [659.25, 783.99, 1046.5], // E5 → G5 → C6
};

/** When a chime has rung out enough for speech to follow it, seconds. */
export const chimeLength = (kind: Chime) => (NOTES[kind].length - 1) * 0.12 + 0.3;

// The chimes follow Orbit's voice volume (Settings → Voice), staying as loud relative to it as before.
let chimeVolume = chimeLevel(DEFAULT_VOLUME);
export function setChimeVolume(voiceVolume: number) {
  chimeVolume = chimeLevel(voiceVolume);
}

export function playChime(kind: keyof typeof NOTES, volume = chimeVolume) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    NOTES[kind].forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      const t = ctx!.currentTime + i * 0.12;
      o.frequency.value = f;
      o.type = "sine";
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(volume, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
  } catch {
    // no audio device: nothing to do
  }
}
