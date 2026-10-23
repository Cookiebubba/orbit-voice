// Types for playback.js (plain JS so the tests run it in node).
export const DEFAULT_VOLUME: number;
export const RELEASE_MS: number;
export const FINISH_WITHIN_S: number;
export function volumeGain(v: number): number;
export function chimeLevel(v: number, base?: number): number;
export function releaseTail(pcm: Int16Array | Float32Array | null, rate?: number, ms?: number): Float32Array | null;
export function letItFinish(o: { remainingS: number; replyDone: boolean; within?: number }): boolean;
