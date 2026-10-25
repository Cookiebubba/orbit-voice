// Types for throwSound.js (plain JS so the tests run it in node).
export const THROW_SOUND_URL: string;
export const THROW_SOUND_MS: number;
export function createThrowSound(opts?: { makeAudio?: (src: string) => HTMLAudioElement; gain?: (v: number) => number }): { play(volume: number): number; readonly plays: number };
