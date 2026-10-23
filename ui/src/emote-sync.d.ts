// Types for emote-sync.js (plain JS so the tests run it in node).
export type EmoteSync = {
  audio(id: string, at: number, dur: number, samples?: Float32Array | Int16Array | null, cue?: { name: string; offset?: number | "end" } | null): void;
  text(id: string, delta: string): void;
  textDone(id: string, transcript?: string): void;
  audioDone(id: string): void;
  cue(id: string, name: string, pos: number | "end"): void;
  clear(): void;
  readonly pending: number;
  readonly rate: number;
};
export function weight(text: string, n?: number): number;
export function createEmoteSync(opts: {
  now: () => number;
  fire: (cue: string, info: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}): EmoteSync;
