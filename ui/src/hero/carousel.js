// The avatar carousel on the main page: which avatars it offers and how its controls behave. Plain
// JS so the tests run it in node. Only Qubit for now; the controls already work for more.

/** What the carousel offers (ids are the `avatar` setting's values). */
export const CAROUSEL = Object.freeze([{ id: 'qubit', name: 'Qubit' }]);

/** The entry to show for the `avatar` setting: its own, else the first (an avatar it doesn't offer). */
export function carouselIndex(avatar, items = CAROUSEL) {
  const i = items.findIndex((a) => a.id === avatar);
  return i < 0 ? 0 : i;
}

/** Previous / next from `i` (no wrap), and whether each control does anything. */
export function carouselStep(i, dir, items = CAROUSEL) {
  const n = items.length;
  const next = Math.max(0, Math.min(n - 1, i + dir));
  return next;
}
export const carouselCan = (i, items = CAROUSEL) => ({ prev: i > 0, next: i < items.length - 1, dots: items.length });
