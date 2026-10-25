// Types for hero.js (plain JS so the tests run it in node).
export const HERO_TIMING: { readonly firstS: number; readonly everyS: readonly [number, number] };
export const HERO_EMOTES: readonly { name: string; mode?: string; act?: string; hold: number; weight: number; params?: Record<string, unknown> }[];
export function heroMode(v?: Record<string, unknown>): string | null;
export type Hero = {
  tick(dt: number): void;
  setVoice(v: Record<string, unknown>): void;
  poke(): void;
  hit(x: number, y: number): boolean;
  readonly shown: string[];
  readonly live: string | null;
  home: number;
};
export function createHero(q: any, opts?: { seed?: number; home?: number; timing?: Record<string, unknown> }): Hero;
