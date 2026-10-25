// Types for carousel.js (plain JS so the tests run it in node).
export type CarouselItem = { readonly id: "qubit" | "buddy" | "none"; readonly name: string };
export const CAROUSEL: readonly CarouselItem[];
export function carouselIndex(avatar: string | undefined, items?: readonly CarouselItem[]): number;
export function carouselStep(i: number, dir: number, items?: readonly CarouselItem[]): number;
export function carouselCan(i: number, items?: readonly CarouselItem[]): { prev: boolean; next: boolean; dots: number };
