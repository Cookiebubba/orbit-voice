// Types for shape.js (plain JS so the tests run it in node).
export const ARROW_PATH: string;
export const ARROW_SIZE: { readonly w: number; readonly h: number };
export function css(lch: readonly number[], a?: number): string;
export const PREVIEW: readonly { label: string; mode: string; lch: readonly [number, number, number] }[];
